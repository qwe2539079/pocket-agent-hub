import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../src/agents/codex/adapter.js";
import { ProjectRegistry } from "../src/core/project.js";
import type { HubMessage } from "../src/core/message.js";

function makeMessage(overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    id: "msg-1",
    channel: "feishu",
    senderId: "user-1",
    persona: "dev-control",
    text: "帮我检查当前状态",
    projectId: "demo",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

test("CodexAdapter requires project context for execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-missing-"));
  const adapter = new CodexAdapter(
    { enabled: true, command: "/bin/true", defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([]),
    dir,
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

  const adapter = new CodexAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "codex" },
    ]),
    dir,
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
});

test("CodexAdapter surfaces failed run logs in status output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-codex-fail-"));
  const projectDir = join(dir, "repo");
  await mkdir(projectDir, { recursive: true });
  const commandPath = await writeFakeCodex(dir);

  const adapter = new CodexAdapter(
    { enabled: true, command: commandPath, defaultProfile: "missing", sandboxMode: "danger-full-access" },
    new ProjectRegistry([
      { id: "demo", path: projectDir, description: "demo repo", defaultAgent: "codex" },
    ]),
    dir,
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
