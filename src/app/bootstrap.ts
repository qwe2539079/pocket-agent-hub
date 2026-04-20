import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ClaudeAdapter } from "../agents/claude/adapter.js";
import { CodexAdapter } from "../agents/codex/adapter.js";
import { GeminiAdapter } from "../agents/gemini/adapter.js";
import { FeishuConnector } from "../channels/feishu/connector.js";
import { WeixinConnector } from "../channels/weixin/connector.js";
import { loadConfig } from "../config/load-config.js";
import type { AgentKind } from "../config/types.js";
import { ProjectRegistry } from "../core/project.js";
import { HubRouter } from "../core/router.js";
import { SessionRegistry } from "../core/session.js";
import type { AgentAdapter, ChannelConnector } from "../core/types.js";
import { NotificationCenter } from "../notifications/notification-center.js";
import { PolicyEngine } from "../policies/policy-engine.js";
import { AuditLog } from "../storage/audit-log.js";
import { FileStore } from "../storage/file-store.js";

export async function bootstrap(configPath?: string): Promise<void> {
  const absoluteConfigPath = resolve(configPath ?? (await resolveDefaultConfigPath()));
  const config = await loadConfig(absoluteConfigPath);
  const storageDir = resolve(dirname(absoluteConfigPath), config.storageDir);
  const fileStore = new FileStore(storageDir);
  const sessions = new SessionRegistry(fileStore);
  await sessions.hydrate();

  const projects = new ProjectRegistry(config.projects);
  const auditLog = new AuditLog(fileStore);
  const policyEngine = new PolicyEngine();
  const notifications = new NotificationCenter();

  const agents = new Map<AgentKind, AgentAdapter>([
    ["codex", new CodexAdapter(config.agents.codex, projects, storageDir, notifications)],
    ["claude", new ClaudeAdapter(config.agents.claude, projects, storageDir, notifications)],
    ["gemini", new GeminiAdapter(config.agents.gemini, projects, storageDir, notifications)],
  ]);

  for (const adapter of agents.values()) {
    if (!adapter.reconcileZombieRuns) continue;
    try {
      const fixed = await adapter.reconcileZombieRuns();
      if (fixed > 0) {
        console.log(`[hub] reconciled ${fixed} interrupted ${adapter.id} run(s) from previous session`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[hub] reconcile for ${adapter.id} failed, continuing startup: ${message}`);
    }
  }

  const router = new HubRouter(config, policyEngine, agents, sessions, projects, auditLog);
  const connectors: ChannelConnector[] = [];

  if (config.channels.feishu.enabled) {
    connectors.push(new FeishuConnector(config.channels.feishu, router, notifications));
  }

  if (config.channels.weixin.enabled) {
    connectors.push(new WeixinConnector());
  }

  await Promise.all(connectors.map((connector) => connector.start()));

  console.log(`[hub] started on ${config.hostId}`);
  console.log(`[hub] config: ${absoluteConfigPath}`);
  console.log(`[hub] storage: ${storageDir}`);
  console.log(`[hub] projects: ${projects.list().map((project) => project.id).join(", ")}`);
  console.log(`[hub] restored sessions: ${sessions.list().length}`);

  if (process.env.POCKET_AGENT_HUB_SKIP_WARMUP) {
    console.log("[hub] warmup skipped (POCKET_AGENT_HUB_SKIP_WARMUP set)");
    return;
  }

  const warmup = await router.route({
    id: "boot-message",
    channel: "feishu",
    senderId: "system",
    persona: "daily-assistant",
    text: "Hub bootstrap completed.",
    targetAgent: "claude",
    projectId: "pocket-agent-hub",
    timestamp: new Date().toISOString(),
  });
  console.log(`[hub] warmup response: ${warmup.text}`);
}

async function resolveDefaultConfigPath(): Promise<string> {
  const candidates = ["./config/app.config.local.json", "./config/app.config.example.json"];

  for (const candidate of candidates) {
    try {
      await access(resolve(candidate));
      return candidate;
    } catch {
      continue;
    }
  }

  return "./config/app.config.example.json";
}
