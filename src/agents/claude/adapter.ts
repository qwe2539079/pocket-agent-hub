import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AgentConfig, AgentSandboxMode, ChannelKind } from "../../config/types.js";
import { ProjectRegistry } from "../../core/project.js";
import type { HubMessage, HubResponse } from "../../core/message.js";
import type { AgentAdapter, ListRunsOptions, RunSummary } from "../../core/types.js";
import { NotificationCenter } from "../../notifications/notification-center.js";

interface ClaudeRunRecord {
  id: string;
  sessionId: string;
  channel: ChannelKind;
  actorId: string;
  conversationId?: string;
  projectId: string;
  projectPath: string;
  prompt: string;
  status: "running" | "completed" | "failed";
  command: string;
  args: string[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  exitCode?: number | null;
  pid?: number;
  outputPath: string;
  lastMessagePath: string;
  finalMessage?: string;
  errorMessage?: string;
}

interface CurrentRunPointer {
  runId: string;
  setAt: string;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude";

  constructor(
    private readonly config: AgentConfig,
    private readonly projects: ProjectRegistry,
    private readonly storageDir: string,
    private readonly notifications: NotificationCenter,
  ) {}

  async handle(message: HubMessage): Promise<HubResponse> {
    const sessionId = buildSessionId(this.id, message.senderId);
    const latestRun = await this.readLatestRun(sessionId);

    if (isStatusQuery(message.text)) {
      return {
        sessionId,
        text: await this.renderStatus(message.projectId, latestRun),
      };
    }

    if (!message.projectId) {
      return {
        sessionId,
        text: '[claude] missing project context. Use `/dev /claude /project <id> ...`.',
        requiresApproval: true,
      };
    }

    const project = this.projects.get(message.projectId);
    if (!project) {
      return {
        sessionId,
        text: `[claude] unknown project "${message.projectId}".`,
        requiresApproval: true,
      };
    }

    const executionPrompt = await this.buildExecutionPrompt(message, sessionId, latestRun, project.id);

    const run = await this.startRun(
      message.channel,
      message.senderId,
      message.conversationId,
      sessionId,
      project.id,
      project.path,
      message.text,
      executionPrompt,
    );

    return {
      sessionId,
      text:
        `[claude] started task for project "${project.id}".\n` +
        `Run: ${run.id}\n` +
        `Prompt: ${message.text}\n` +
        `Use \`/dev /claude /project ${project.id} 查看当前项目状态\` to check progress.`,
      requiresApproval: false,
    };
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunSummary[]> {
    const runs = await this.scanAllRuns();
    const filtered = runs
      .filter((run) => !options.actorId || run.actorId === options.actorId)
      .filter((run) => !options.status || run.status === options.status)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const sliced = typeof options.limit === "number" ? filtered.slice(0, options.limit) : filtered;
    return sliced.map((run) => toRunSummary(run));
  }

  async getRun(runId: string): Promise<RunSummary | null> {
    const run = await this.readRunById(runId);
    return run ? toRunSummary(run) : null;
  }

  async setCurrent(sessionId: string, runId: string): Promise<void> {
    const run = await this.readRunById(runId);
    if (!run) {
      throw new Error(`Unknown claude run: ${runId}`);
    }
    if (run.sessionId !== sessionId) {
      throw new Error(`Run ${runId} does not belong to session ${sessionId}`);
    }
    await this.writeJson(this.currentPath(sessionId), {
      runId,
      setAt: new Date().toISOString(),
    } satisfies CurrentRunPointer);
  }

  async clearCurrent(sessionId: string): Promise<void> {
    const path = this.currentPath(sessionId);
    try {
      await rm(path);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async reconcileZombieRuns(): Promise<number> {
    const runs = await this.scanAllRuns();
    let fixed = 0;
    const now = new Date().toISOString();

    for (const run of runs) {
      if (run.status !== "running") continue;
      if (!run.pid) continue;

      let alive = true;
      try {
        process.kill(run.pid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          alive = false;
        }
      }
      if (alive) continue;

      const updated: ClaudeRunRecord = {
        ...run,
        status: "failed",
        exitCode: run.exitCode ?? null,
        completedAt: run.completedAt ?? now,
        updatedAt: now,
        errorMessage: run.errorMessage ?? "Interrupted: hub restarted while this run was active.",
      };

      await this.writeRun(updated);
      const latest = await this.readLatestRun(run.sessionId);
      if (latest && latest.id === run.id) {
        await this.writeLatestRun(run.sessionId, updated);
      }
      fixed += 1;
    }

    return fixed;
  }

  private async startRun(
    channel: ChannelKind,
    actorId: string,
    conversationId: string | undefined,
    sessionId: string,
    projectId: string,
    projectPath: string,
    prompt: string,
    executionPrompt: string,
  ): Promise<ClaudeRunRecord> {
    const runId = `${Date.now()}`;
    const runDir = resolve(this.storageDir, "claude", sessionId, runId);
    const outputPath = resolve(runDir, "claude.log");
    const lastMessagePath = resolve(runDir, "last-message.txt");
    await mkdir(runDir, { recursive: true });

    const args = this.buildArgs(executionPrompt);
    const now = new Date().toISOString();
    const run: ClaudeRunRecord = {
      id: runId,
      sessionId,
      channel,
      actorId,
      conversationId,
      projectId,
      projectPath,
      prompt,
      status: "running",
      command: this.config.command,
      args,
      startedAt: now,
      updatedAt: now,
      outputPath,
      lastMessagePath,
    };

    await this.writeRun(run);
    await this.writeLatestRun(sessionId, run);

    const outputStream = createWriteStream(outputPath, { flags: "a" });
    const lastMessageStream = createWriteStream(lastMessagePath, { flags: "w" });
    const child = spawn(this.config.command, args, {
      cwd: projectPath,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    run.pid = child.pid;
    run.updatedAt = new Date().toISOString();
    await this.writeRun(run);
    await this.writeLatestRun(sessionId, run);

    // stdout is claude's final reply. Tee it into both the combined log and the
    // dedicated last-message file so status queries and notifications can show
    // just the reply without parsing the log.
    child.stdout?.on("data", (chunk) => {
      outputStream.write(chunk);
      lastMessageStream.write(chunk);
    });
    child.stderr?.pipe(outputStream);

    const endStreams = () => {
      outputStream.end();
      lastMessageStream.end();
    };

    child.on("error", (error) => {
      void this.finishRun(sessionId, {
        ...run,
        status: "failed",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        errorMessage: error.message,
      }).finally(endStreams);
    });

    child.on("close", (code) => {
      void this.completeRunFromDisk(sessionId, run, code).finally(endStreams);
    });

    return run;
  }

  private async buildExecutionPrompt(
    message: HubMessage,
    sessionId: string,
    latestRun: ClaudeRunRecord | null,
    projectId: string,
  ): Promise<string> {
    if (message.hasDirectives) {
      return message.text;
    }

    let seed: ClaudeRunRecord | null = null;

    // /resume is one-shot: atomically rename-then-read so concurrent turns can't both consume the same pointer.
    const pointer = await this.consumeCurrent(sessionId);
    if (pointer) {
      const resumed = await this.readRunById(pointer.runId);
      if (resumed) {
        seed = resumed;
      }
    }

    if (!seed) {
      seed = latestRun;
    }

    if (!seed || seed.projectId !== projectId || seed.status !== "completed" || !seed.finalMessage) {
      return message.text;
    }

    return [
      `You are continuing an existing mobile chat session for project "${projectId}".`,
      "",
      "Previous assistant reply:",
      seed.finalMessage,
      "",
      "User follow-up:",
      message.text,
      "",
      "Answer the follow-up directly. If the user asks to summarize, compress, translate, rewrite, or continue the previous answer, operate on the previous assistant reply above.",
    ].join("\n");
  }

  private buildArgs(prompt: string): string[] {
    const args = ["-p", "--output-format", "text"];
    const permissionMode = mapSandboxToPermissionMode(this.config.sandboxMode);
    if (permissionMode) {
      args.push("--permission-mode", permissionMode);
    }
    args.push(prompt);
    return args;
  }

  private async completeRunFromDisk(
    sessionId: string,
    run: ClaudeRunRecord,
    code: number | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    let finalMessage: string | undefined;
    try {
      finalMessage = (await readFile(run.lastMessagePath, "utf8")).trim() || undefined;
    } catch {
      finalMessage = undefined;
    }

    const nextRun: ClaudeRunRecord = {
      ...run,
      status: code === 0 ? "completed" : "failed",
      exitCode: code,
      updatedAt: now,
      completedAt: now,
      finalMessage,
      errorMessage: code === 0 ? undefined : `Claude exited with code ${code}`,
    };

    await this.finishRun(sessionId, nextRun);
  }

  private async finishRun(sessionId: string, run: ClaudeRunRecord): Promise<void> {
    await this.writeRun(run);
    await this.writeLatestRun(sessionId, run);
    await this.notifyRunFinished(run);
  }

  private async notifyRunFinished(run: ClaudeRunRecord): Promise<void> {
    const notificationText =
      run.status === "completed"
        ? `[claude] task completed.\nProject: ${run.projectId}\nRun: ${run.id}\n\n${run.finalMessage ?? "Claude finished, but no reply was captured."}`
        : `[claude] task failed.\nProject: ${run.projectId}\nRun: ${run.id}\nError: ${run.errorMessage ?? `exit code ${run.exitCode ?? "unknown"}`}\n\n${await this.readLogTail(run.outputPath) || "No log output captured."}`;

    try {
      await this.notifications.notifyActor(run.channel, run.actorId, notificationText, {
        conversationId: run.conversationId,
        signalText:
          run.status === "completed"
            ? `[claude] completed: ${run.projectId} · ${run.id}`
            : `[claude] failed: ${run.projectId} · ${run.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[claude] failed to send completion notification: ${message}`);
    }
  }

  private async renderStatus(
    requestedProjectId: string | undefined,
    latestRun: ClaudeRunRecord | null,
  ): Promise<string> {
    if (!latestRun) {
      return "[claude] no recorded task yet for this session.";
    }

    if (requestedProjectId && latestRun.projectId !== requestedProjectId) {
      return `[claude] latest recorded task belongs to project "${latestRun.projectId}", not "${requestedProjectId}".`;
    }

    if (latestRun.status === "running") {
      return (
        `[claude] task is still running.\n` +
        `Project: ${latestRun.projectId}\n` +
        `Run: ${latestRun.id}\n` +
        `Started: ${latestRun.startedAt}\n` +
        `Prompt: ${latestRun.prompt}`
      );
    }

    if (latestRun.status === "completed") {
      return (
        `[claude] last task completed.\n` +
        `Project: ${latestRun.projectId}\n` +
        `Run: ${latestRun.id}\n` +
        `Completed: ${latestRun.completedAt ?? latestRun.updatedAt}\n\n` +
        `${latestRun.finalMessage ?? "Claude finished, but no reply was captured."}`
      );
    }

    const logTail = await this.readLogTail(latestRun.outputPath);
    return (
      `[claude] last task failed.\n` +
      `Project: ${latestRun.projectId}\n` +
      `Run: ${latestRun.id}\n` +
      `Error: ${latestRun.errorMessage ?? `exit code ${latestRun.exitCode ?? "unknown"}`}\n\n` +
      `${logTail || "No log output captured."}`
    );
  }

  private async readLatestRun(sessionId: string): Promise<ClaudeRunRecord | null> {
    return this.readJson<ClaudeRunRecord>(resolve(this.storageDir, "claude", sessionId, "latest.json"));
  }

  private async writeLatestRun(sessionId: string, run: ClaudeRunRecord): Promise<void> {
    await this.writeJson(resolve(this.storageDir, "claude", sessionId, "latest.json"), run);
  }

  private async writeRun(run: ClaudeRunRecord): Promise<void> {
    await this.writeJson(resolve(this.storageDir, "claude", run.sessionId, run.id, "run.json"), run);
  }

  private async consumeCurrent(sessionId: string): Promise<CurrentRunPointer | null> {
    const path = this.currentPath(sessionId);
    const claimed = `${path}.consumed-${process.pid}-${Date.now()}`;
    try {
      await rename(path, claimed);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
    try {
      const raw = await readFile(claimed, "utf8");
      return JSON.parse(raw) as CurrentRunPointer;
    } catch {
      return null;
    } finally {
      await rm(claimed).catch(() => {});
    }
  }

  private currentPath(sessionId: string): string {
    return resolve(this.storageDir, "claude", sessionId, "current.json");
  }

  private async readRunById(runId: string): Promise<ClaudeRunRecord | null> {
    const all = await this.scanAllRuns();
    return all.find((run) => run.id === runId) ?? null;
  }

  private async scanAllRuns(): Promise<ClaudeRunRecord[]> {
    const base = resolve(this.storageDir, "claude");
    let sessionNames: string[];
    try {
      const entries = await readdir(base, { withFileTypes: true });
      sessionNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    const runs: ClaudeRunRecord[] = [];
    for (const sessionName of sessionNames) {
      const sessionPath = resolve(base, sessionName);
      let runNames: string[];
      try {
        const entries = await readdir(sessionPath, { withFileTypes: true });
        runNames = entries
          .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        continue;
      }

      for (const runName of runNames) {
        const run = await this.readJson<ClaudeRunRecord>(resolve(sessionPath, runName, "run.json"));
        if (run) runs.push(run);
      }
    }
    return runs;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "w");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.close();
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async readLogTail(path: string): Promise<string> {
    try {
      const raw = await readFile(path, "utf8");
      return raw.trim().split(/\r?\n/).slice(-20).join("\n");
    } catch {
      return "";
    }
  }
}

function buildSessionId(agent: string, senderId: string): string {
  return `${agent}:${senderId}`;
}

function isStatusQuery(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "查看当前项目状态",
    "查看当前状态",
    "当前项目状态",
    "当前任务状态",
    "当前状态",
    "status",
    "current task",
    "summarize current task",
    "summary",
  ].some((keyword) => normalized.includes(keyword.toLowerCase()));
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

function toRunSummary(run: ClaudeRunRecord): RunSummary {
  const startedMs = Date.parse(run.startedAt);
  const endedMs = run.completedAt ? Date.parse(run.completedAt) : undefined;
  const durationMs =
    endedMs !== undefined && !Number.isNaN(endedMs) && !Number.isNaN(startedMs)
      ? endedMs - startedMs
      : undefined;

  const trimmed = run.finalMessage?.trim();
  const preview = trimmed
    ? trimmed.length > 80
      ? `${trimmed.slice(0, 80)}…`
      : trimmed
    : undefined;

  return {
    runId: run.id,
    agent: "claude",
    sessionId: run.sessionId,
    actorId: run.actorId,
    channel: run.channel,
    conversationId: run.conversationId,
    projectId: run.projectId,
    status: run.status,
    prompt: run.prompt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    durationMs,
    exitCode: run.exitCode,
    finalMessagePreview: preview,
    errorMessage: run.errorMessage,
    pid: run.pid,
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
