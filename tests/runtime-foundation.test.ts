import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppConfig } from "../src/config/types.js";
import type { HubMessage, HubResponse } from "../src/core/message.js";
import { ProjectRegistry } from "../src/core/project.js";
import { HubRouter } from "../src/core/router.js";
import { SessionRegistry } from "../src/core/session.js";
import type { AgentAdapter, ListRunsOptions, NativeSessionSummary, RunSummary } from "../src/core/types.js";
import { PolicyEngine } from "../src/policies/policy-engine.js";
import { AuditLog } from "../src/storage/audit-log.js";
import { FileStore } from "../src/storage/file-store.js";

class EchoClaudeAdapter implements AgentAdapter {
  readonly id = "claude";
  async handle(message: HubMessage): Promise<HubResponse> {
    return {
      sessionId: `${this.id}:${message.senderId}`,
      text: `[claude] received ${message.persona} message: ${message.text}`,
    };
  }
}

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

test("router resolves project aliases and canonicalizes downstream records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-alias-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);
  const config = makeConfig();
  const projects = [
    {
      ...config.projects[0],
      aliases: ["hub"],
    },
  ];
  const router = new HubRouter(
    config,
    new PolicyEngine(),
    new Map([["claude", new EchoClaudeAdapter()]]),
    sessions,
    new ProjectRegistry(projects),
    auditLog,
  );

  await router.route({
    id: "alias-route",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "hello via alias",
    targetAgent: "claude",
    projectId: "hub",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
  });

  const session = sessions.getLatestForConversation("feishu", "user-1", "chat-1");
  assert.equal(session?.projectId, "pocket-agent-hub");

  const raw = await readFile(join(dir, "audit/events.jsonl"), "utf8");
  assert.match(raw, /"projectId":"pocket-agent-hub"/);
  assert.doesNotMatch(raw, /"projectId":"hub"/);
});

test("router rejects unknown projects and writes audit log for allowed routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);
  const router = new HubRouter(
    makeConfig(),
    new PolicyEngine(),
    new Map([["claude", new EchoClaudeAdapter()]]),
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
    new Map([["claude", new EchoClaudeAdapter()]]),
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
    new Map([["claude", new EchoClaudeAdapter()]]),
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

class StubCodexAdapter implements AgentAdapter {
  readonly id = "codex";
  runs: RunSummary[] = [];
  clearedSessions: string[] = [];
  setCurrentCalls: Array<{ sessionId: string; runId: string }> = [];

  async handle(message: HubMessage): Promise<HubResponse> {
    return {
      sessionId: `codex:${message.senderId}`,
      text: `stub codex reply: ${message.text}`,
    };
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunSummary[]> {
    return this.runs
      .filter((run) => !options.actorId || run.actorId === options.actorId)
      .filter((run) => !options.status || run.status === options.status)
      .slice(0, options.limit ?? this.runs.length);
  }

  async getRun(runId: string): Promise<RunSummary | null> {
    return this.runs.find((run) => run.runId === runId) ?? null;
  }

  async setCurrent(sessionId: string, runId: string): Promise<void> {
    this.setCurrentCalls.push({ sessionId, runId });
  }

  async clearCurrent(sessionId: string): Promise<void> {
    this.clearedSessions.push(sessionId);
  }
}

function devConfigAllowingCodex(): AppConfig {
  const config = makeConfig();
  config.personas["daily-assistant"].allowedAgents = ["codex", "claude"];
  return config;
}

test("router /list surfaces recent runs from the adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-list-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);
  const stub = new StubCodexAdapter();
  stub.runs = [
    {
      runId: "1000",
      agent: "codex",
      sessionId: "codex:user-1",
      actorId: "user-1",
      channel: "feishu",
      projectId: "pocket-agent-hub",
      status: "completed",
      prompt: "task A",
      startedAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:05.000Z",
    },
    {
      runId: "999",
      agent: "codex",
      sessionId: "codex:user-2",
      actorId: "user-2",
      channel: "feishu",
      projectId: "pocket-agent-hub",
      status: "completed",
      prompt: "other user task",
      startedAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:05.000Z",
    },
  ];

  const router = new HubRouter(
    devConfigAllowingCodex(),
    new PolicyEngine(),
    new Map([["codex", stub]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  const result = await router.route({
    id: "list",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/codex /list",
    targetAgent: "codex",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "list-runs",
  });

  assert.match(result.text, /recent codex runs/);
  assert.match(result.text, /1000 \[completed\]/);
  assert.doesNotMatch(result.text, /999/);
});

test("router /resume validates ownership and calls setCurrent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-resume-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);
  const stub = new StubCodexAdapter();
  stub.runs = [
    {
      runId: "1000",
      agent: "codex",
      sessionId: "codex:user-1",
      actorId: "user-1",
      channel: "feishu",
      projectId: "pocket-agent-hub",
      status: "completed",
      prompt: "task A",
      startedAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:05.000Z",
      finalMessagePreview: "here is the summary",
    },
  ];

  const router = new HubRouter(
    devConfigAllowingCodex(),
    new PolicyEngine(),
    new Map([["codex", stub]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  const ok = await router.route({
    id: "resume-ok",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/codex /resume 1000",
    targetAgent: "codex",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "resume-run",
    resumeRunId: "1000",
  });

  assert.match(ok.text, /queued resume of codex run 1000/);
  assert.equal(ok.sessionId, "codex:user-1");
  assert.deepEqual(stub.setCurrentCalls, [{ sessionId: "codex:user-1", runId: "1000" }]);

  const notYours = await router.route({
    id: "resume-other",
    channel: "feishu",
    senderId: "user-2",
    conversationId: "chat-2",
    persona: "daily-assistant",
    text: "/codex /resume 1000",
    targetAgent: "codex",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "resume-run",
    resumeRunId: "1000",
  });

  assert.match(notYours.text, /no codex run "1000" found for this account/);
  assert.equal(stub.setCurrentCalls.length, 1);

  const missingId = await router.route({
    id: "resume-missing",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/codex /resume",
    targetAgent: "codex",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "resume-run",
  });

  assert.match(missingId.text, /usage: `\/resume <run-id>`/);
});

test("router /list returns empty-state message when adapter has no runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-list-empty-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);
  const stub = new StubCodexAdapter();

  const router = new HubRouter(
    devConfigAllowingCodex(),
    new PolicyEngine(),
    new Map([["codex", stub]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  const result = await router.route({
    id: "list-empty",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/codex /list",
    targetAgent: "codex",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "list-runs",
  });

  assert.match(result.text, /no codex runs recorded yet/);
});

test("router /running returns only running tasks, with empty-state fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-running-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);
  const stub = new StubCodexAdapter();
  stub.runs = [
    {
      runId: "2000",
      agent: "codex",
      sessionId: "codex:user-1",
      actorId: "user-1",
      channel: "feishu",
      projectId: "pocket-agent-hub",
      status: "completed",
      prompt: "already done",
      startedAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:05.000Z",
    },
  ];

  const router = new HubRouter(
    devConfigAllowingCodex(),
    new PolicyEngine(),
    new Map([["codex", stub]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  const empty = await router.route({
    id: "running-empty",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/codex /running",
    targetAgent: "codex",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "show-running",
  });

  assert.match(empty.text, /no codex tasks are currently running/);

  stub.runs.push({
    runId: "2001",
    agent: "codex",
    sessionId: "codex:user-1",
    actorId: "user-1",
    channel: "feishu",
    projectId: "pocket-agent-hub",
    status: "running",
    prompt: "long running task",
    startedAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:00:01.000Z",
  });

  const running = await router.route({
    id: "running-ok",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/codex /running",
    targetAgent: "codex",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "show-running",
  });

  assert.match(running.text, /codex tasks currently running/);
  assert.match(running.text, /2001/);
  assert.doesNotMatch(running.text, /2000/);
});

test("router rejects /list and /resume when no agent can be resolved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-noagent-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);
  const stub = new StubCodexAdapter();

  const router = new HubRouter(
    devConfigAllowingCodex(),
    new PolicyEngine(),
    new Map([["codex", stub]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  const list = await router.route({
    id: "list-no-agent",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/list",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "list-runs",
  });

  assert.match(list.text, /no active agent/);

  const resume = await router.route({
    id: "resume-no-agent",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/resume 1000",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "resume-run",
    resumeRunId: "1000",
  });

  assert.match(resume.text, /no active agent/);
});

test("router reports unsupported when adapter is missing run-history or resume capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-bare-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);

  class BareCodexAdapter implements AgentAdapter {
    readonly id = "codex";
    async handle(message: HubMessage): Promise<HubResponse> {
      return { sessionId: `codex:${message.senderId}`, text: "bare" };
    }
  }

  const router = new HubRouter(
    devConfigAllowingCodex(),
    new PolicyEngine(),
    new Map([["codex", new BareCodexAdapter()]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  const list = await router.route({
    id: "list-unsupported",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/codex /list",
    targetAgent: "codex",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "list-runs",
  });

  assert.match(list.text, /does not expose run history/);

  const resume = await router.route({
    id: "resume-unsupported",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/codex /resume 1000",
    targetAgent: "codex",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "resume-run",
    resumeRunId: "1000",
  });

  assert.match(resume.text, /does not support resume/);
});

test("router /desktop aggregates native sessions from all adapters and maps cwd to project id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-desktop-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);

  class StubClaudeWithNative implements AgentAdapter {
    readonly id = "claude";
    async handle(message: HubMessage): Promise<HubResponse> {
      return { sessionId: `claude:${message.senderId}`, text: "stub" };
    }
    async listNativeSessions(): Promise<NativeSessionSummary[]> {
      return [
        {
          agent: "claude",
          sessionId: "older-session",
          cwd: "/tmp/pocket-agent-hub",
          preview: "older",
          lastActivityAt: "2026-04-18T00:00:00.000Z",
        },
        {
          agent: "claude",
          sessionId: "newer-session",
          cwd: "/does/not/match/any/project",
          preview: "newer on an unregistered path",
          lastActivityAt: "2026-04-19T00:00:00.000Z",
        },
      ];
    }
  }

  const router = new HubRouter(
    makeConfig(),
    new PolicyEngine(),
    new Map([["claude", new StubClaudeWithNative()]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  const result = await router.route({
    id: "desktop",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/desktop",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "list-native",
  });

  assert.match(result.text, /desktop agent sessions/);
  // Newer one listed first.
  const newerIdx = result.text.indexOf("newer-session");
  const olderIdx = result.text.indexOf("older-session");
  assert.ok(newerIdx !== -1 && olderIdx !== -1 && newerIdx < olderIdx);
  // cwd matching ProjectRegistry resolves to project id.
  assert.match(result.text, /project=pocket-agent-hub/);
  // unregistered cwd gets labeled.
  assert.match(result.text, /unregistered/);
  // Takeover hint present.
  assert.match(result.text, /\/takeover/);
});

test("router /takeover validates native session id, maps cwd to project, and calls setNativeCurrent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-takeover-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);

  class StubClaudeTakeover implements AgentAdapter {
    readonly id = "claude";
    setNativeCalls: Array<{ sessionId: string; nativeSessionId: string }> = [];
    async handle(message: HubMessage): Promise<HubResponse> {
      return { sessionId: `claude:${message.senderId}`, text: "stub" };
    }
    async listNativeSessions(): Promise<NativeSessionSummary[]> {
      return [
        {
          agent: "claude",
          sessionId: "aaaa-bbbb",
          cwd: "/tmp/pocket-agent-hub",
          preview: "prev",
          lastActivityAt: "2026-04-19T00:00:00.000Z",
        },
        {
          agent: "claude",
          sessionId: "cccc-dddd",
          cwd: "/does/not/match",
          preview: "prev",
          lastActivityAt: "2026-04-19T00:00:00.000Z",
        },
      ];
    }
    async setNativeCurrent(sessionId: string, nativeSessionId: string): Promise<void> {
      this.setNativeCalls.push({ sessionId, nativeSessionId });
    }
  }

  const stub = new StubClaudeTakeover();
  const router = new HubRouter(
    makeConfig(),
    new PolicyEngine(),
    new Map([["claude", stub]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  const ok = await router.route({
    id: "takeover-ok",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/takeover aaaa-bbbb",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "takeover-native",
    takeoverSessionId: "aaaa-bbbb",
  });

  assert.match(ok.text, /queued takeover of desktop claude session aaaa-bbbb/);
  assert.match(ok.text, /Project: pocket-agent-hub/);
  assert.deepEqual(stub.setNativeCalls, [{ sessionId: "claude:user-1", nativeSessionId: "aaaa-bbbb" }]);
  assert.equal(sessions.get("claude:user-1")?.projectId, "pocket-agent-hub");

  const unregistered = await router.route({
    id: "takeover-unregistered",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/takeover cccc-dddd",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "takeover-native",
    takeoverSessionId: "cccc-dddd",
  });
  assert.match(unregistered.text, /not a registered project/);
  assert.equal(stub.setNativeCalls.length, 1);

  const unknown = await router.route({
    id: "takeover-unknown",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/takeover nothing",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "takeover-native",
    takeoverSessionId: "nothing",
  });
  assert.match(unknown.text, /no desktop session "nothing" found/);

  const missing = await router.route({
    id: "takeover-missing",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/takeover",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "takeover-native",
  });
  assert.match(missing.text, /usage: `\/takeover <session-id>`/);
});

test("router /desktop returns empty-state message when no adapter reports any session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-desktop-empty-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);

  const router = new HubRouter(
    makeConfig(),
    new PolicyEngine(),
    new Map([["claude", new EchoClaudeAdapter()]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  const result = await router.route({
    id: "desktop-empty",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "/desktop",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
    sessionCommand: "list-native",
  });

  assert.match(result.text, /no desktop agent sessions/);
});

test("router /reset forwards clearCurrent to the cleared session's adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-router-reset-"));
  const store = new FileStore(dir);
  const sessions = new SessionRegistry(store);
  const auditLog = new AuditLog(store);
  const stub = new StubCodexAdapter();

  const router = new HubRouter(
    devConfigAllowingCodex(),
    new PolicyEngine(),
    new Map([["codex", stub]]),
    sessions,
    new ProjectRegistry(makeConfig().projects),
    auditLog,
  );

  await router.route({
    id: "first",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "daily-assistant",
    text: "kick off",
    targetAgent: "codex",
    projectId: "pocket-agent-hub",
    timestamp: new Date().toISOString(),
    hasDirectives: true,
  });

  await router.route({
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

  assert.deepEqual(stub.clearedSessions, ["codex:user-1"]);
});
