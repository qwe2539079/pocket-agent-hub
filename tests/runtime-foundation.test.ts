import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter } from "../src/agents/claude/adapter.js";
import { ProjectRegistry } from "../src/core/project.js";
import { HubRouter } from "../src/core/router.js";
import { SessionRegistry } from "../src/core/session.js";
import { PolicyEngine } from "../src/policies/policy-engine.js";
import { AuditLog } from "../src/storage/audit-log.js";
import { FileStore } from "../src/storage/file-store.js";
import type { AppConfig } from "../src/config/types.js";

function makeConfig(): AppConfig {
  return {
    hostId: "test-host",
    storageDir: "./runtime",
    channels: {
      feishu: {
        enabled: true,
        appId: "x",
        appSecret: "x",
        mode: "webhook",
      },
      weixin: {
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:3000",
        token: "x",
        accountId: "x",
      },
    },
    agents: {
      codex: { enabled: true, command: "codex", defaultProfile: "dev" },
      claude: { enabled: true, command: "claude", defaultProfile: "dev" },
      gemini: { enabled: false, command: "gemini", defaultProfile: "research" },
    },
    personas: {
      "dev-control": {
        allowedAgents: ["codex", "claude", "gemini"],
        policy: "guarded-dev",
      },
      "daily-assistant": {
        allowedAgents: ["claude"],
        policy: "safe-chat",
      },
    },
    projects: [
      {
        id: "pocket-agent-hub",
        path: "/tmp/pocket-agent-hub",
        description: "test project",
        defaultAgent: "claude",
      },
    ],
  };
}

test("session registry persists sessions to disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-session-"));
  const store = new FileStore(dir);
  const registry = new SessionRegistry(store);

  await registry.upsert({
    id: "session-1",
    agent: "claude",
    persona: "daily-assistant",
    projectId: "pocket-agent-hub",
    summary: "hello",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
  });

  const hydrated = new SessionRegistry(store);
  await hydrated.hydrate();

  assert.equal(hydrated.get("session-1")?.summary, "hello");
});

test("router rejects unknown projects and writes audit log for allowed routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);
  const router = new HubRouter(
    makeConfig(),
    new PolicyEngine(),
    new Map([["claude", new ClaudeAdapter()]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  await assert.rejects(() =>
    router.route({
      id: "bad-project",
      channel: "feishu",
      senderId: "user-1",
      persona: "daily-assistant",
      text: "hello",
      targetAgent: "claude",
      projectId: "missing-project",
      timestamp: new Date().toISOString(),
    }),
  );

  await router.route({
    id: "good-project",
    channel: "feishu",
    senderId: "user-1",
    persona: "daily-assistant",
    text: "hello",
    targetAgent: "claude",
    projectId: "pocket-agent-hub",
    timestamp: new Date().toISOString(),
  });

  const raw = await readFile(join(dir, "audit/events.jsonl"), "utf8");
  assert.match(raw, /good-project/);
  assert.match(raw, /allowed/);
});
