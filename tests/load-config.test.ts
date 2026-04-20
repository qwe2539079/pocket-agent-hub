import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/load-config.js";

test("loadConfig merges a local override via extends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-config-"));
  const basePath = join(dir, "base.json");
  const localPath = join(dir, "local.json");

  await writeFile(
    basePath,
    JSON.stringify(
      {
        hostId: "base-host",
        storageDir: "./runtime",
        channels: {
          feishu: {
            enabled: true,
            appId: "base-app-id",
            appSecret: "base-secret",
            mode: "websocket",
            apiBaseUrl: "https://open.feishu.cn",
            websocketUrl: "wss://msg-frontier.feishu.cn/ws/v2",
            reconnectIntervalMs: 5000,
            bindHost: "127.0.0.1",
            port: 8787,
            path: "/feishu/events",
            verificationToken: "base-token",
          },
          weixin: {
            enabled: true,
            gatewayBaseUrl: "http://127.0.0.1:3000",
            token: "wx-token",
            accountId: "wx-account",
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
            defaultAgent: "codex",
          },
        ],
      },
      null,
      2,
    ),
  );

  await writeFile(
    localPath,
    JSON.stringify(
      {
        extends: "./base.json",
        channels: {
          feishu: {
            appId: "local-app-id",
            appSecret: "local-secret",
          },
          weixin: {
            enabled: false,
          },
        },
      },
      null,
      2,
    ),
  );

  const config = await loadConfig(localPath);

  assert.equal(config.hostId, "base-host");
  assert.equal(config.channels.feishu.mode, "websocket");
  assert.equal(config.channels.feishu.appId, "local-app-id");
  assert.equal(config.channels.feishu.appSecret, "local-secret");
  assert.equal(config.channels.feishu.websocketUrl, "wss://msg-frontier.feishu.cn/ws/v2");
  assert.equal(config.channels.weixin.enabled, false);
  assert.equal(config.projects[0]?.id, "pocket-agent-hub");
});

test("loadConfig rejects extends cycles with a clear error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pah-config-cycle-"));
  const aPath = join(dir, "a.json");
  const bPath = join(dir, "b.json");

  await writeFile(aPath, JSON.stringify({ extends: "./b.json" }));
  await writeFile(bPath, JSON.stringify({ extends: "./a.json" }));

  await assert.rejects(
    () => loadConfig(aPath),
    /Config extends cycle detected/,
  );
});
