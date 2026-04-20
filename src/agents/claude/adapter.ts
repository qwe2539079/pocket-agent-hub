import type { ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type { AgentKind, AgentSandboxMode } from "../../config/types.js";
import type { NativeSessionSummary } from "../../core/types.js";
import { RunAdapter, type BuildArgsContext } from "../run-adapter.js";

const NATIVE_PREVIEW_MAX = 100;
const NATIVE_SCAN_LINE_LIMIT = 40;

export class ClaudeAdapter extends RunAdapter {
  readonly id: AgentKind = "claude";

  protected async buildArgs({ prompt, sandboxMode }: BuildArgsContext): Promise<string[]> {
    const args = ["-p", "--output-format", "text"];
    const permissionMode = mapSandboxToPermissionMode(sandboxMode);
    if (permissionMode) {
      args.push("--permission-mode", permissionMode);
    }
    args.push(prompt);
    return args;
  }

  protected attachStdio(
    child: ChildProcess,
    outputStream: WriteStream,
    lastMessagePath: string,
  ): (() => void) | undefined {
    // claude -p prints the reply to stdout. Tee into the log (stdout+stderr
    // combined) and a dedicated last-message file so status queries and
    // notifications can quote the reply without parsing the log.
    const lastMessageStream = createWriteStream(lastMessagePath, { flags: "w" });
    child.stdout?.on("data", (chunk) => {
      outputStream.write(chunk);
      lastMessageStream.write(chunk);
    });
    child.stderr?.pipe(outputStream);
    return () => lastMessageStream.end();
  }

  async listNativeSessions(): Promise<NativeSessionSummary[]> {
    const root = claudeNativeSessionsDir();
    let projectDirs: string[];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(root, entry.name));
    } catch {
      return [];
    }

    const summaries: NativeSessionSummary[] = [];
    for (const projectDir of projectDirs) {
      let files: string[];
      try {
        const entries = await readdir(projectDir, { withFileTypes: true });
        files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => entry.name);
      } catch {
        continue;
      }

      for (const fileName of files) {
        const filePath = resolve(projectDir, fileName);
        const summary = await scanJsonlSession(filePath, fileName);
        if (summary) {
          summaries.push(summary);
        }
      }
    }

    summaries.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    return summaries;
  }
}

function claudeNativeSessionsDir(): string {
  const override = process.env.POCKET_AGENT_HUB_CLAUDE_SESSIONS_DIR;
  if (override) return override;
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? resolve(process.env.HOME ?? "", ".claude");
  return resolve(configDir, "projects");
}

async function scanJsonlSession(filePath: string, fileName: string): Promise<NativeSessionSummary | null> {
  const sessionId = fileName.replace(/\.jsonl$/, "");

  let cwd: string | undefined;
  let preview: string | undefined;
  let linesRead = 0;

  try {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        linesRead += 1;
        if (linesRead > NATIVE_SCAN_LINE_LIMIT) break;
        if (!line.trim()) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed === null) continue;
        const entry = parsed as { cwd?: unknown; type?: unknown; message?: unknown };

        if (!cwd && typeof entry.cwd === "string" && entry.cwd.length > 0) {
          cwd = entry.cwd;
        }

        if (!preview && entry.type === "user") {
          const text = extractUserText(entry.message);
          if (text) {
            preview = text.length > NATIVE_PREVIEW_MAX ? `${text.slice(0, NATIVE_PREVIEW_MAX)}…` : text;
          }
        }

        if (cwd && preview) break;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch {
    return null;
  }

  if (!cwd) {
    return null;
  }

  let lastActivityAt: string | undefined;
  try {
    const stats = await stat(filePath);
    lastActivityAt = stats.mtime.toISOString();
  } catch {
    lastActivityAt = undefined;
  }

  return {
    agent: "claude",
    sessionId,
    cwd,
    preview,
    lastActivityAt,
  };
}

function extractUserText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return stripCommandTags(content).trim() || undefined;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        const cleaned = stripCommandTags(text).trim();
        if (cleaned) return cleaned;
      }
    }
  }
  return undefined;
}

function stripCommandTags(raw: string): string {
  return raw.replace(/<command-[^>]+>[\s\S]*?<\/command-[^>]+>/g, "").replace(/<[^>]+>/g, "");
}

function mapSandboxToPermissionMode(mode: AgentSandboxMode | undefined): string | undefined {
  switch (mode) {
    case "danger-full-access":
      return "bypassPermissions";
    case "workspace-write":
      return "acceptEdits";
    case "read-only":
      return "plan";
    default:
      return undefined;
  }
}
