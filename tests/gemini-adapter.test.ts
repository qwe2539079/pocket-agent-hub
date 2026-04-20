import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GeminiAdapter } from "../src/agents/gemini/adapter.js";
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

test("GeminiAdapter starts a run and returns the reply from stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-gemini-ok-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeGemini(dir);
  const notifications = new NotificationCenter();
  const pushed: string[] = [];
  notifications.registerChannelHandler("feishu", async (_targetId, text) => {
    pushed.push(text);
  });
  notifications.rememberTarget("feishu", "user-1", "chat-1");

  const adapter = new GeminiAdapter(
    { enabled: true, command: commandPath, defaultProfile: "research" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "gemini" },
    ]),
    dir,
    notifications,
  );

  const start = await adapter.handle(makeMessage({ text: "解释 Gemini 是什么" }));
  assert.match(start.text, /started task/);

  const latestPath = join(dir, "gemini", "gemini:user-1", "latest.json");
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
    return latest.status === "completed";
  });

  const done = await adapter.handle(makeMessage({ text: "查看当前项目状态" }));
  assert.match(done.text, /last task completed/);
  assert.match(done.text, /fake gemini reply: 解释 Gemini 是什么/);
  assert.equal(pushed.length, 2);
  assert.match(pushed[0] ?? "", /task completed/);

  const run = JSON.parse(await readFile(latestPath, "utf8")) as { args: string[] };
  assert.deepEqual(run.args.slice(0, 2), ["-p", "解释 Gemini 是什么"]);
});

test("GeminiAdapter surfaces failed run logs in status output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-gemini-fail-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeGemini(dir);
  const notifications = new NotificationCenter();
  const adapter = new GeminiAdapter(
    { enabled: true, command: commandPath, defaultProfile: "research" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "gemini" },
    ]),
    dir,
    notifications,
  );

  await adapter.handle(makeMessage({ text: "FAIL 模拟失败" }));

  const latestPath = join(dir, "gemini", "gemini:user-1", "latest.json");
  await waitFor(async () => {
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as { status: string };
    return latest.status === "failed";
  });

  const failed = await adapter.handle(makeMessage({ text: "查看当前项目状态" }));
  assert.match(failed.text, /last task failed/);
  assert.match(failed.text, /simulated gemini failure/);
});

async function writeFakeGemini(baseDir: string): Promise<string> {
  const scriptPath = join(baseDir, "fake-gemini.mjs");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1] ?? "";
await new Promise((resolve) => setTimeout(resolve, 50));
if (prompt.includes("FAIL")) {
  process.stderr.write("simulated gemini failure\\n");
  process.exit(3);
}
process.stdout.write(\`fake gemini reply: \${prompt}\\n\`);
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
