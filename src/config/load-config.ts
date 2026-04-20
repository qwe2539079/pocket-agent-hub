import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AppConfig } from "./types.js";

const requiredChannels = ["feishu", "weixin"] as const;
const requiredAgents = ["codex", "claude", "gemini"] as const;
const requiredPersonas = ["dev-control", "daily-assistant"] as const;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type ConfigSource = JsonObject & { extends?: string };

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absolutePath = resolve(configPath);
  const parsed = (await loadConfigSource(absolutePath, new Set())) as Partial<AppConfig>;

  assertConfig(parsed, absolutePath);
  return parsed;
}

async function loadConfigSource(configPath: string, visited: Set<string>): Promise<JsonObject> {
  if (visited.has(configPath)) {
    const chain = [...visited, configPath].join(" -> ");
    throw new Error(`Config extends cycle detected: ${chain}`);
  }
  visited.add(configPath);

  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as ConfigSource;

  if (!parsed.extends) {
    return parsed;
  }

  const parentPath = resolve(dirname(configPath), parsed.extends);
  const parentConfig = await loadConfigSource(parentPath, visited);
  const { extends: _extends, ...overlay } = parsed;

  return mergeObjects(parentConfig, overlay);
}

function mergeObjects(base: JsonObject, overlay: JsonObject): JsonObject {
  const result: JsonObject = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      result[key] = mergeObjects(baseValue, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
