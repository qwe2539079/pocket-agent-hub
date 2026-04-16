import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AppConfig } from "./types.js";

const requiredChannels = ["feishu", "weixin"] as const;
const requiredAgents = ["codex", "claude", "gemini"] as const;
const requiredPersonas = ["dev-control", "daily-assistant"] as const;

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absolutePath = resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<AppConfig>;

  assertConfig(parsed, absolutePath);
  return parsed;
}

function assertConfig(config: Partial<AppConfig>, configPath: string): asserts config is AppConfig {
  if (!config.hostId) {
    throw new Error(`Missing "hostId" in ${configPath}`);
  }

  if (!config.storageDir) {
    throw new Error(`Missing "storageDir" in ${configPath}`);
  }

  if (!config.channels) {
    throw new Error(`Missing "channels" in ${configPath}`);
  }

  for (const channel of requiredChannels) {
    if (!config.channels[channel]) {
      throw new Error(`Missing channel config "${channel}" in ${configPath}`);
    }
  }

  if (!config.agents) {
    throw new Error(`Missing "agents" in ${configPath}`);
  }

  for (const agent of requiredAgents) {
    if (!config.agents[agent]) {
      throw new Error(`Missing agent config "${agent}" in ${configPath}`);
    }
  }

  if (!config.personas) {
    throw new Error(`Missing "personas" in ${configPath}`);
  }

  for (const persona of requiredPersonas) {
    if (!config.personas[persona]) {
      throw new Error(`Missing persona config "${persona}" in ${configPath}`);
    }
  }

  if (!config.projects || config.projects.length === 0) {
    throw new Error(`Missing non-empty "projects" in ${configPath}`);
  }
}
