import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter } from "../src/agents/claude/adapter.js";
import { ProjectRegistry } from "../src/core/project.js";
import type { HubMessage } from "../src/core/message.js";
import { NotificationCenter } from "../src/notifications/notification-center.js";

function makeMessage(overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    id: "msg-1",
    channel: "feishu",
    senderId: "user-1",
    conversationId: "chat-1",
    persona: "dev-control",
    text: "帮我检查当前状态",
    projectId: "demo",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

test("ClaudeAdapter requires project context for execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-claude-missing-"));
  const notifications = new NotificationCenter();
  const adapter = new ClaudeAdapter(
    { enabled: true, command: "/bin/true", defaultProfile: "missing", sandboxMode: "workspace-write" },
    new ProjectRegistry([]),
    dir,
    notifications,
  );

  const response = await adapter.handle(makeMessage({ projectId: undefined, text: "请帮我修改 README" }));

  assert.match(response.text, /missing project context/);
  assert.equal(response.requiresApproval, true);
});

test("ClaudeAdapter starts a run and later returns the completed reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-claude-ok-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeClaude(dir);
  const notifications = new NotificationCenter();
  const pushed: string[] = [];
  notifications.registerChannelHandler("feishu", async (_targetId, text) => {
    pushed.push(text);
  });
  notifications.rememberTarget("feishu", "user-1", "chat-1");

  const adapter = new ClaudeAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "workspace-write" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "claude" },
    ]),
    dir,
    notifications,
  );

  const start = await adapter.handle(makeMessage({ text: "请帮我总结仓库状态" }));
  assert.match(start.text, /started task/);

  const latestPath = join(dir, "claude", "claude:user-1", "latest.json");
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
    return latest.status === "completed";
  });

  const done = await adapter.handle(makeMessage({ text: "查看当前项目状态" }));
  assert.match(done.text, /last task completed/);
  assert.match(done.text, /fake claude reply: 请帮我总结仓库状态/);
  assert.equal(pushed.length, 2);
  assert.match(pushed[0] ?? "", /task completed/);
  assert.match(pushed[1] ?? "", /completed: demo/);
});

test("ClaudeAdapter uses the last completed reply as context for follow-up prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-claude-followup-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeClaude(dir);
  const notifications = new NotificationCenter();
  const adapter = new ClaudeAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "workspace-write" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "claude" },
    ]),
    dir,
    notifications,
  );

  await adapter.handle(makeMessage({ text: "先总结当前仓库状态", hasDirectives: true }));

  const latestPath = join(dir, "claude", "claude:user-1", "latest.json");
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
    return latest.status === "completed";
  });

  await adapter.handle(makeMessage({ text: "帮我再压缩成一句话", hasDirectives: false }));

  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string; prompt: string };
    return latest.status === "completed" && latest.prompt === "帮我再压缩成一句话";
  });

  const run = JSON.parse(await readFile(latestPath, "utf8"));
  const lastArg = run.args[run.args.length - 1];
  assert.match(lastArg, /Previous assistant reply:/);
  assert.match(lastArg, /fake claude reply: 先总结当前仓库状态/);
  assert.match(lastArg, /User follow-up:/);
  assert.match(lastArg, /帮我再压缩成一句话/);
});

test("ClaudeAdapter surfaces failed run logs in status output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-claude-fail-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeClaude(dir);
  const notifications = new NotificationCenter();
  const pushed: string[] = [];
  notifications.registerChannelHandler("feishu", async (_targetId, text) => {
    pushed.push(text);
  });
  notifications.rememberTarget("feishu", "user-1", "chat-1");

  const adapter = new ClaudeAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "workspace-write" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "claude" },
    ]),
    dir,
    notifications,
  );

  await adapter.handle(makeMessage({ text: "FAIL 请模拟失败任务" }));

  const latestPath = join(dir, "claude", "claude:user-1", "latest.json");
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
    return latest.status === "failed";
  });

  const failed = await adapter.handle(makeMessage({ text: "查看当前项目状态" }));
  assert.match(failed.text, /last task failed/);
  assert.match(failed.text, /simulated claude failure/);
  assert.equal(pushed.length, 2);
  assert.match(pushed[0] ?? "", /task failed/);
  assert.match(pushed[1] ?? "", /failed: demo/);
});

test("ClaudeAdapter.listRuns filters by actor and status, sorted by startedAt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-claude-list-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeClaude(dir);
  const notifications = new NotificationCenter();
  const adapter = new ClaudeAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "workspace-write" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "claude" },
    ]),
    dir,
    notifications,
  );

  const latestPath = join(dir, "claude", "claude:user-1", "latest.json");

  await adapter.handle(makeMessage({ text: "第一条任务", hasDirectives: true }));
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string; prompt: string };
    return latest.status === "completed" && latest.prompt === "第一条任务";
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  await adapter.handle(makeMessage({ text: "第二条任务", hasDirectives: true }));
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string; prompt: string };
    return latest.status === "completed" && latest.prompt === "第二条任务";
  });

  const runs = await adapter.listRuns({ actorId: "user-1" });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].prompt, "第二条任务");
  assert.equal(runs[1].prompt, "第一条任务");

  const limited = await adapter.listRuns({ actorId: "user-1", limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].prompt, "第二条任务");

  const other = await adapter.listRuns({ actorId: "user-2" });
  assert.equal(other.length, 0);
});

test("ClaudeAdapter.setCurrent seeds the next prompt from the resumed run, then clears the pointer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-claude-resume-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeClaude(dir);
  const notifications = new NotificationCenter();
  const adapter = new ClaudeAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "workspace-write" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "claude" },
    ]),
    dir,
    notifications,
  );

  const latestPath = join(dir, "claude", "claude:user-1", "latest.json");

  await adapter.handle(makeMessage({ text: "早期任务：写 A", hasDirectives: true }));
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string; prompt: string };
    return latest.status === "completed" && latest.prompt === "早期任务：写 A";
  });
  const [runA] = await adapter.listRuns({ actorId: "user-1", limit: 1 });

  await new Promise((resolve) => setTimeout(resolve, 15));
  await adapter.handle(makeMessage({ text: "较新任务：写 B", hasDirectives: true }));
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string; prompt: string };
    return latest.status === "completed" && latest.prompt === "较新任务：写 B";
  });

  await adapter.setCurrent("claude:user-1", runA.runId);

  await new Promise((resolve) => setTimeout(resolve, 15));
  await adapter.handle(makeMessage({ text: "基于之前答复再改一下", hasDirectives: false }));
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string; prompt: string };
    return latest.status === "completed" && latest.prompt === "基于之前答复再改一下";
  });

  const run = JSON.parse(await readFile(latestPath, "utf8"));
  const lastArg = run.args[run.args.length - 1];
  assert.match(lastArg, /fake claude reply: 早期任务：写 A/);
  assert.doesNotMatch(lastArg, /fake claude reply: 较新任务：写 B/);

  const currentPath = join(dir, "claude", "claude:user-1", "current.json");
  await assert.rejects(() => readFile(currentPath, "utf8"));
});

test("ClaudeAdapter.reconcileZombieRuns marks interrupted runs as failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-claude-zombie-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const notifications = new NotificationCenter();
  const adapter = new ClaudeAdapter(
    { enabled: true, command: "/bin/true", defaultProfile: "missing", sandboxMode: "workspace-write" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "claude" },
    ]),
    dir,
    notifications,
  );

  const sessionId = "claude:user-1";
  const runId = "1700000000000";
  const runDir = join(dir, "claude", sessionId, runId);
  await mkdir(runDir, { recursive: true });
  const runPath = join(runDir, "run.json");
  const latestPath = join(dir, "claude", sessionId, "latest.json");

  const record = {
    id: runId,
    sessionId,
    channel: "feishu",
    actorId: "user-1",
    conversationId: "chat-1",
    projectId: "demo",
    projectPath: projectDir,
    prompt: "pretend task",
    status: "running",
    command: "/bin/true",
    args: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputPath: join(runDir, "claude.log"),
    lastMessagePath: join(runDir, "last-message.txt"),
    pid: 99999999,
  };
  await writeFile(runPath, JSON.stringify(record, null, 2), "utf8");
  await writeFile(latestPath, JSON.stringify(record, null, 2), "utf8");

  const fixed = await adapter.reconcileZombieRuns();
  assert.equal(fixed, 1);

  const afterRun = JSON.parse(await readFile(runPath, "utf8")) as { status: string; errorMessage?: string };
  assert.equal(afterRun.status, "failed");
  assert.match(afterRun.errorMessage ?? "", /hub restarted/);

  const afterLatest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
  assert.equal(afterLatest.status, "failed");

  const fixed2 = await adapter.reconcileZombieRuns();
  assert.equal(fixed2, 0);
});

test("ClaudeAdapter.listNativeSessions scans ~/.claude/projects jsonl files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-claude-native-"));
  const sessionsDir = join(dir, "projects");
  const projectA = join(sessionsDir, "-home-demo-project-a");
  const projectB = join(sessionsDir, "-home-demo-project-b");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  const sessionA = "11111111-1111-1111-1111-111111111111";
  const sessionB = "22222222-2222-2222-2222-222222222222";

  await writeFile(
    join(projectA, `${sessionA}.jsonl`),
    [
      JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: sessionA }),
      JSON.stringify({ type: "user", cwd: "/home/demo/project-a", message: { role: "user", content: "第一个会话的第一句" } }),
      JSON.stringify({ type: "assistant", cwd: "/home/demo/project-a", message: { role: "assistant", content: "reply" } }),
    ].join("\n") + "\n",
    "utf8",
  );

  await writeFile(
    join(projectB, `${sessionB}.jsonl`),
    [
      JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: sessionB }),
      JSON.stringify({
        type: "user",
        cwd: "/home/demo/project-b",
        message: {
          role: "user",
          content: [
            { type: "text", text: "<command-name>/slash</command-name>\n第二个会话关于什么" },
          ],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  // Make A older than B so sort can be asserted.
  const { utimes } = await import("node:fs/promises");
  const now = Date.now();
  await utimes(join(projectA, `${sessionA}.jsonl`), new Date(now - 60_000), new Date(now - 60_000));
  await utimes(join(projectB, `${sessionB}.jsonl`), new Date(now), new Date(now));

  const prior = process.env.POCKET_AGENT_HUB_CLAUDE_SESSIONS_DIR;
  process.env.POCKET_AGENT_HUB_CLAUDE_SESSIONS_DIR = sessionsDir;
  try {
    const adapter = new ClaudeAdapter(
      { enabled: true, command: "claude", defaultProfile: "x" },
      new ProjectRegistry([]),
      dir,
      new NotificationCenter(),
    );
    const sessions = await adapter.listNativeSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, sessionB);
    assert.equal(sessions[0].cwd, "/home/demo/project-b");
    assert.match(sessions[0].preview ?? "", /第二个会话/);
    assert.doesNotMatch(sessions[0].preview ?? "", /command-name/);
    assert.equal(sessions[1].sessionId, sessionA);
    assert.equal(sessions[1].preview, "第一个会话的第一句");
  } finally {
    if (prior === undefined) delete process.env.POCKET_AGENT_HUB_CLAUDE_SESSIONS_DIR;
    else process.env.POCKET_AGENT_HUB_CLAUDE_SESSIONS_DIR = prior;
  }
});

async function writeFakeClaude(baseDir: string): Promise<string> {
  const scriptPath = join(baseDir, "fake-claude.mjs");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1] ?? "";
await new Promise((resolve) => setTimeout(resolve, 50));
if (prompt.includes("FAIL")) {
  process.stderr.write("simulated claude failure\\n");
  process.exit(2);
}
process.stdout.write(\`fake claude reply: \${prompt}\\n\`);
process.exit(0);
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}
