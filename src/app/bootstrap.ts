import { resolve } from "node:path";

import { ClaudeAdapter } from "../agents/claude/adapter.js";
import { CodexAdapter } from "../agents/codex/adapter.js";
import { GeminiAdapter } from "../agents/gemini/adapter.js";
import { FeishuConnector } from "../channels/feishu/connector.js";
import { WeixinConnector } from "../channels/weixin/connector.js";
import { loadConfig } from "../config/load-config.js";
import type { AgentKind } from "../config/types.js";
import { HubRouter } from "../core/router.js";
import { SessionRegistry } from "../core/session.js";
import type { AgentAdapter, ChannelConnector } from "../core/types.js";
import { PolicyEngine } from "../policies/policy-engine.js";

export async function bootstrap(configPath = "./config/app.config.example.json"): Promise<void> {
  const config = await loadConfig(resolve(configPath));
  const sessions = new SessionRegistry();
  const policyEngine = new PolicyEngine();

  const agents = new Map<AgentKind, AgentAdapter>([
    ["codex", new CodexAdapter()],
    ["claude", new ClaudeAdapter()],
    ["gemini", new GeminiAdapter()]
  ]);

  const router = new HubRouter(config, policyEngine, agents, sessions);
  const connectors: ChannelConnector[] = [];

  if (config.channels.feishu.enabled) {
    connectors.push(new FeishuConnector());
  }

  if (config.channels.weixin.enabled) {
    connectors.push(new WeixinConnector());
  }

  await Promise.all(connectors.map((connector) => connector.start()));

  const warmup = await router.route({
    id: "boot-message",
    channel: "feishu",
    senderId: "system",
    persona: "daily-assistant",
    text: "Hub bootstrap completed.",
    targetAgent: "claude",
    timestamp: new Date().toISOString()
  });

  console.log(`[hub] started on ${config.hostId}`);
  console.log(`[hub] warmup response: ${warmup.text}`);
}
