import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter } from "../src/agents/claude/adapter.js";
import type { AppConfig } from "../src/config/types.js";
import { ProjectRegistry } from "../src/core/project.js";
import { HubRouter } from "../src/core/router.js";
import { SessionRegistry } from "../src/core/session.js";
import { PolicyEngine } from "../src/policies/policy-engine.js";
import { AuditLog } from "../src/storage/audit-log.js";
import { FileStore } from "../src/storage/file-store.js";

function makeConfig(): AppConfig {
  return {
    hostId: "test-host",
    storageDir: "./runtime",
    channels: {
      feishu: {
        enabled: true,
        appId: "x",
        appSecret: "x",
        mode: "websocket",
        apiBaseUrl: "https://open.feishu.cn",
        websocketUrl: "wss://msg-frontier.feishu.cn/ws/v2",
        reconnectIntervalMs: 5000,
      },
      weixin: {
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:3000",
        token: "x",
        accountId: "x",
      },
    },
    agents: {
      codex: { enabled: true, command: "codex", defaultProfile: "dev", sandboxMode: "danger-full-access" },
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
    channel: "feishu",
    actorId: "user-1",
    conversationId: "chat-1",
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
  assert.equal(hydrated.getLatestForConversation("feishu", "user-1", "chat-1")?.id, "session-1");
  assert.equal(hydrated.getLatestByActor("feishu", "user-1")?.id, "session-1");
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
      conversationId: "chat-1",
      persona: "daily-assistant",
      text: "hello",
      targetAgent: "claude",
      projectId: "missing-project",
      timestamp: new Date().toISOString(),
      hasDirectives: true,
    }),
  );

  await router.route({
    id: "good-project",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "hello",
    targetAgent: "claude",
    projectId: "pocket-agent-hub",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
  });

  const raw = await readFile(join(dir, "audit/events.jsonl"), "utf8");
  assert.match(raw, /good-project/);
  assert.match(raw, /allowed/);
});

test("router continues the latest active session when follow-up text has no directives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-followup-"));
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

  const first = await router.route({
    id: "first",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "dev-control",
    text: "说明一下这个项目是做什么的？",
    targetAgent: "claude",
    projectId: "pocket-agent-hub",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
  });

  const followup = await router.route({
    id: "followup",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "可以",
    timestamp: new Date().toISOString(),
    hasDirectives: false,
  });

  assert.match(first.text, /received dev-control message/);
  assert.match(followup.text, /received dev-control message: 可以/);
  assert.equal(followup.sessionId, first.sessionId);
});


test("router supports current and reset session commands per conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-session-cmd-"));
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

  const first = await router.route({
    id: "first",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "dev-control",
    text: "说明一下这个项目是做什么的？",
    targetAgent: "claude",
    projectId: "pocket-agent-hub",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
  });

  const current = await router.route({
    id: "current",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/current",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "show-current-session",
  });

  assert.match(current.text, /current session/);
  assert.match(current.text, /Agent: claude/);

  const reset = await router.route({
    id: "reset",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/reset",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "reset-session",
  });

  assert.match(reset.text, /cleared active session/);
  assert.equal(sessions.get(first.sessionId), undefined);
});
