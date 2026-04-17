import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../src/agents/codex/adapter.js";
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

test("CodexAdapter requires project context for execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-missing-"));
  const notifications = new NotificationCenter();
  const adapter = new CodexAdapter(
    { enabled: true, command: "/bin/true", defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([]),
    dir,
    notifications,
  );

  const response = await adapter.handle(makeMessage({ projectId: undefined, text: "请帮我修改 README" }));

  assert.match(response.text, /missing project context/);
  assert.equal(response.requiresApproval, true);
});

test("CodexAdapter starts a run and later returns the completed summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-ok-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeCodex(dir);
  const notifications = new NotificationCenter();
  const pushed: string[] = [];
  notifications.registerChannelHandler("feishu", async (_targetId, text) => {
    pushed.push(text);
  });
  notifications.rememberTarget("feishu", "user-1", "chat-1");

  const adapter = new CodexAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "codex" },
    ]),
    dir,
    notifications,
  );

  const start = await adapter.handle(makeMessage({ text: "帮我总结当前仓库状态" }));
  assert.match(start.text, /started task/);

  const running = await adapter.handle(makeMessage({ text: "查看当前项目状态" }));
  assert.match(running.text, /running|completed/);

  const latestPath = join(dir, "codex", "codex:user-1", "latest.json");
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
    return latest.status === "completed";
  });

  const done = await adapter.handle(makeMessage({ text: "查看当前项目状态" }));
  assert.match(done.text, /last task completed/);
  assert.match(done.text, /fake codex summary: 帮我总结当前仓库状态/);
  assert.equal(pushed.length, 2);
  assert.match(pushed[0] ?? "", /task completed/);
  assert.match(pushed[1] ?? "", /completed: demo/);
});

test("CodexAdapter uses the last completed reply as context for follow-up prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-followup-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeCodex(dir);
  const notifications = new NotificationCenter();
  const adapter = new CodexAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "codex" },
    ]),
    dir,
    notifications,
  );

  await adapter.handle(makeMessage({ text: "先总结当前仓库状态", hasDirectives: true }));

  const latestPath = join(dir, "codex", "codex:user-1", "latest.json");
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
    return latest.status === "completed";
  });

  await adapter.handle(makeMessage({ text: "帮我再压缩成一句话", hasDirectives: false }));

  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string, prompt: string };
    return latest.status === "completed" && latest.prompt === "帮我再压缩成一句话";
  });

  const run = JSON.parse(await readFile(latestPath, "utf8"));
  const lastArg = run.args[run.args.length - 1];
  assert.match(lastArg, /Previous assistant reply:/);
  assert.match(lastArg, /fake codex summary: 先总结当前仓库状态/);
  assert.match(lastArg, /User follow-up:/);
  assert.match(lastArg, /帮我再压缩成一句话/);
});

test("CodexAdapter surfaces failed run logs in status output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-fail-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeCodex(dir);
  const notifications = new NotificationCenter();
  const pushed: string[] = [];
  notifications.registerChannelHandler("feishu", async (_targetId, text) => {
    pushed.push(text);
  });
  notifications.rememberTarget("feishu", "user-1", "chat-1");

  const adapter = new CodexAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "codex" },
    ]),
    dir,
    notifications,
  );

  await adapter.handle(makeMessage({ text: "FAIL 请模拟失败任务" }));

  const latestPath = join(dir, "codex", "codex:user-1", "latest.json");
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
    return latest.status === "failed";
  });

  const failed = await adapter.handle(makeMessage({ text: "查看当前项目状态" }));
  assert.match(failed.text, /last task failed/);
  assert.match(failed.text, /simulated codex failure/);
  assert.equal(pushed.length, 2);
  assert.match(pushed[0] ?? "", /task failed/);
  assert.match(pushed[1] ?? "", /failed: demo/);
});

test("CodexAdapter.listRuns returns runs for actor sorted by startedAt with filters honoured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-list-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeCodex(dir);
  const notifications = new NotificationCenter();
  const adapter = new CodexAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "codex" },
    ]),
    dir,
    notifications,
  );

  const latestPath = join(dir, "codex", "codex:user-1", "latest.json");

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

test("CodexAdapter.setCurrent seeds the next prompt from the resumed run, not latest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-resume-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeCodex(dir);
  const notifications = new NotificationCenter();
  const adapter = new CodexAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "codex" },
    ]),
    dir,
    notifications,
  );

  const latestPath = join(dir, "codex", "codex:user-1", "latest.json");

  await adapter.handle(makeMessage({ text: "早期任务：帮我写 A", hasDirectives: true }));
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string; prompt: string };
    return latest.status === "completed" && latest.prompt === "早期任务：帮我写 A";
  });
  const [runA] = await adapter.listRuns({ actorId: "user-1", limit: 1 });

  await new Promise((resolve) => setTimeout(resolve, 15));
  await adapter.handle(makeMessage({ text: "较新任务：帮我写 B", hasDirectives: true }));
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string; prompt: string };
    return latest.status === "completed" && latest.prompt === "较新任务：帮我写 B";
  });

  await adapter.setCurrent("codex:user-1", runA.runId);

  await new Promise((resolve) => setTimeout(resolve, 15));
  await adapter.handle(makeMessage({ text: "基于之前答复再改一下", hasDirectives: false }));
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string; prompt: string };
    return latest.status === "completed" && latest.prompt === "基于之前答复再改一下";
  });

  const run = JSON.parse(await readFile(latestPath, "utf8"));
  const lastArg = run.args[run.args.length - 1];
  assert.match(lastArg, /fake codex summary: 早期任务：帮我写 A/);
  assert.doesNotMatch(lastArg, /fake codex summary: 较新任务：帮我写 B/);

  const currentPath = join(dir, "codex", "codex:user-1", "current.json");
  await assert.rejects(() => readFile(currentPath, "utf8"));
});

test("CodexAdapter.clearCurrent removes the pointer and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-clear-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeCodex(dir);
  const notifications = new NotificationCenter();
  const adapter = new CodexAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "codex" },
    ]),
    dir,
    notifications,
  );

  const latestPath = join(dir, "codex", "codex:user-1", "latest.json");
  await adapter.handle(makeMessage({ text: "随便一个任务", hasDirectives: true }));
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
    return latest.status === "completed";
  });

  const [run] = await adapter.listRuns({ actorId: "user-1", limit: 1 });
  await adapter.setCurrent("codex:user-1", run.runId);

  const currentPath = join(dir, "codex", "codex:user-1", "current.json");
  const pointer = JSON.parse(await readFile(currentPath, "utf8"));
  assert.equal(pointer.runId, run.runId);

  await adapter.clearCurrent("codex:user-1");
  await assert.rejects(() => readFile(currentPath, "utf8"));

  await adapter.clearCurrent("codex:user-1");
});

test("CodexAdapter.reconcileZombieRuns marks interrupted runs as failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-zombie-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const notifications = new NotificationCenter();
  const adapter = new CodexAdapter(
    { enabled: true, command: "/bin/true", defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "codex" },
    ]),
    dir,
    notifications,
  );

  const sessionId = "codex:user-1";
  const runId = "1700000000000";
  const runDir = join(dir, "codex", sessionId, runId);
  await mkdir(runDir, { recursive: true });
  const runPath = join(runDir, "run.json");
  const latestPath = join(dir, "codex", sessionId, "latest.json");

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
    outputPath: join(runDir, "codex.log"),
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

async function writeFakeCodex(baseDir: string): Promise<string> {
  const scriptPath = join(baseDir, "fake-codex.mjs");
  const script = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const prompt = args[args.length - 1] ?? "";
await new Promise((resolve) => setTimeout(resolve, 50));
if (prompt.includes("FAIL")) {
  console.error("simulated codex failure");
  process.exit(2);
}
if (outputPath) {
  await writeFile(outputPath, \`fake codex summary: \${prompt}\n\`, "utf8");
}
console.log("fake codex completed");
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
