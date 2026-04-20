import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  AgentConfig,
  AgentKind,
  AgentSandboxMode,
  ChannelKind,
  PersonaConfig,
  PersonaKind,
} from "../config/types.js";
import { ProjectRegistry } from "../core/project.js";
import type { HubMessage, HubResponse } from "../core/message.js";
import type { AgentAdapter, ListRunsOptions, RunSummary } from "../core/types.js";
import { NotificationCenter } from "../notifications/notification-center.js";

export interface RunRecord {
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

export interface BuildArgsContext {
  prompt: string;
  projectPath: string;
  lastMessagePath: string;
  /** Effective sandbox mode for this run after applying persona overrides. */
  sandboxMode: AgentSandboxMode | undefined;
}

const STATUS_QUERY_KEYWORDS = [
  "查看当前项目状态",
  "查看当前状态",
  "当前项目状态",
  "当前任务状态",
  "当前状态",
  "status",
  "current task",
  "summarize current task",
  "summary",
];

export abstract class RunAdapter implements AgentAdapter {
  abstract readonly id: AgentKind;

  constructor(
    protected readonly config: AgentConfig,
    protected readonly projects: ProjectRegistry,
    protected readonly storageDir: string,
    protected readonly notifications: NotificationCenter,
    protected readonly personas: Partial<Record<PersonaKind, PersonaConfig>> = {},
  ) {}

  /** Build the argv for the agent CLI. Called for every run. */
  protected abstract buildArgs(ctx: BuildArgsContext): Promise<string[]>;

  /**
   * Wire stdout/stderr from the spawned child. Different CLIs capture their
   * reply differently: codex --output-last-message writes the file itself
   * (so the adapter must not pre-open it), while claude -p prints to stdout
   * and we tee it into lastMessagePath. Return a cleanup fn for any extra
   * streams the implementation opened.
   */
  protected abstract attachStdio(
    child: ChildProcess,
    outputStream: WriteStream,
    lastMessagePath: string,
  ): (() => void) | undefined;

  async handle(message: HubMessage): Promise<HubResponse> {
    const sessionId = this.buildSessionId(message.senderId);
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
        text: `[${this.id}] missing project context. Use \`/dev /${this.id} /project <id> ...\`.`,
        requiresApproval: true,
      };
    }

    const project = this.projects.get(message.projectId);
    if (!project) {
      return {
        sessionId,
        text: `[${this.id}] unknown project "${message.projectId}".`,
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
      message.persona,
    );

    return {
      sessionId,
      text:
        `[${this.id}] started task for project "${project.id}".\n` +
        `Run: ${run.id}\n` +
        `Prompt: ${message.text}\n` +
        `Use \`/dev /${this.id} /project ${project.id} 查看当前项目状态\` to check progress.`,
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
    return sliced.map((run) => this.toRunSummary(run));
  }

  async getRun(runId: string): Promise<RunSummary | null> {
    const run = await this.readRunById(runId);
    return run ? this.toRunSummary(run) : null;
  }

  async setCurrent(sessionId: string, runId: string): Promise<void> {
    const run = await this.readRunById(runId);
    if (!run) {
      throw new Error(`Unknown ${this.id} run: ${runId}`);
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

      const updated: RunRecord = {
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

  protected buildSessionId(senderId: string): string {
    return `${this.id}:${senderId}`;
  }

  protected async startRun(
    channel: ChannelKind,
    actorId: string,
    conversationId: string | undefined,
    sessionId: string,
    projectId: string,
    projectPath: string,
    prompt: string,
    executionPrompt: string,
    persona: PersonaKind,
  ): Promise<RunRecord> {
    const runId = `${Date.now()}`;
    const runDir = resolve(this.storageDir, this.id, sessionId, runId);
    const outputPath = resolve(runDir, `${this.id}.log`);
    const lastMessagePath = resolve(runDir, "last-message.txt");
    await mkdir(runDir, { recursive: true });

    const sandboxMode = this.personas[persona]?.sandboxOverride ?? this.config.sandboxMode;
    const args = await this.buildArgs({ prompt: executionPrompt, projectPath, lastMessagePath, sandboxMode });
    const now = new Date().toISOString();
    const run: RunRecord = {
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
    const child = spawn(this.config.command, args, {
      cwd: projectPath,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    run.pid = child.pid;
    run.updatedAt = new Date().toISOString();
    await this.writeRun(run);
    await this.writeLatestRun(sessionId, run);

    const stdioCleanup = this.attachStdio(child, outputStream, lastMessagePath);

    const endStreams = () => {
      outputStream.end();
      stdioCleanup?.();
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

  protected async buildExecutionPrompt(
    message: HubMessage,
    sessionId: string,
    latestRun: RunRecord | null,
    projectId: string,
  ): Promise<string> {
    if (message.hasDirectives) {
      return message.text;
    }

    let seed: RunRecord | null = null;

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

  private async completeRunFromDisk(
    sessionId: string,
    run: RunRecord,
    code: number | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    let finalMessage: string | undefined;
    try {
      finalMessage = (await readFile(run.lastMessagePath, "utf8")).trim() || undefined;
    } catch {
      finalMessage = undefined;
    }

    const nextRun: RunRecord = {
      ...run,
      status: code === 0 ? "completed" : "failed",
      exitCode: code,
      updatedAt: now,
      completedAt: now,
      finalMessage,
      errorMessage: code === 0 ? undefined : `${capitalize(this.id)} exited with code ${code}`,
    };

    await this.finishRun(sessionId, nextRun);
  }

  private async finishRun(sessionId: string, run: RunRecord): Promise<void> {
    await this.writeRun(run);
    await this.writeLatestRun(sessionId, run);
    await this.notifyRunFinished(run);
  }

  private async notifyRunFinished(run: RunRecord): Promise<void> {
    const notificationText =
      run.status === "completed"
        ? `[${this.id}] task completed.\nProject: ${run.projectId}\nRun: ${run.id}\n\n${run.finalMessage ?? `${capitalize(this.id)} finished, but no final message was captured.`}`
        : `[${this.id}] task failed.\nProject: ${run.projectId}\nRun: ${run.id}\nError: ${run.errorMessage ?? `exit code ${run.exitCode ?? "unknown"}`}\n\n${await this.readLogTail(run.outputPath) || "No log output captured."}`;

    try {
      await this.notifications.notifyActor(run.channel, run.actorId, notificationText, {
        conversationId: run.conversationId,
        signalText:
          run.status === "completed"
            ? `[${this.id}] completed: ${run.projectId} · ${run.id}`
            : `[${this.id}] failed: ${run.projectId} · ${run.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[${this.id}] failed to send completion notification ` +
          `(run=${run.id} actor=${run.actorId} channel=${run.channel}` +
          `${run.conversationId ? ` conv=${run.conversationId}` : ""}): ${message}`,
      );
    }
  }

  private async renderStatus(
    requestedProjectId: string | undefined,
    latestRun: RunRecord | null,
  ): Promise<string> {
    if (!latestRun) {
      return `[${this.id}] no recorded task yet for this session.`;
    }

    if (requestedProjectId && latestRun.projectId !== requestedProjectId) {
      return `[${this.id}] latest recorded task belongs to project "${latestRun.projectId}", not "${requestedProjectId}".`;
    }

    if (latestRun.status === "running") {
      return (
        `[${this.id}] task is still running.\n` +
        `Project: ${latestRun.projectId}\n` +
        `Run: ${latestRun.id}\n` +
        `Started: ${latestRun.startedAt}\n` +
        `Prompt: ${latestRun.prompt}`
      );
    }

    if (latestRun.status === "completed") {
      return (
        `[${this.id}] last task completed.\n` +
        `Project: ${latestRun.projectId}\n` +
        `Run: ${latestRun.id}\n` +
        `Completed: ${latestRun.completedAt ?? latestRun.updatedAt}\n\n` +
        `${latestRun.finalMessage ?? `${capitalize(this.id)} finished, but no final message was captured.`}`
      );
    }

    const logTail = await this.readLogTail(latestRun.outputPath);
    return (
      `[${this.id}] last task failed.\n` +
      `Project: ${latestRun.projectId}\n` +
      `Run: ${latestRun.id}\n` +
      `Error: ${latestRun.errorMessage ?? `exit code ${latestRun.exitCode ?? "unknown"}`}\n\n` +
      `${logTail || "No log output captured."}`
    );
  }

  private async readLatestRun(sessionId: string): Promise<RunRecord | null> {
    return this.readJson<RunRecord>(resolve(this.storageDir, this.id, sessionId, "latest.json"));
  }

  private async writeLatestRun(sessionId: string, run: RunRecord): Promise<void> {
    await this.writeJson(resolve(this.storageDir, this.id, sessionId, "latest.json"), run);
  }

  private async writeRun(run: RunRecord): Promise<void> {
    await this.writeJson(resolve(this.storageDir, this.id, run.sessionId, run.id, "run.json"), run);
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
    return resolve(this.storageDir, this.id, sessionId, "current.json");
  }

  private async readRunById(runId: string): Promise<RunRecord | null> {
    const all = await this.scanAllRuns();
    return all.find((run) => run.id === runId) ?? null;
  }

  private async scanAllRuns(): Promise<RunRecord[]> {
    const base = resolve(this.storageDir, this.id);
    let sessionNames: string[];
    try {
      const entries = await readdir(base, { withFileTypes: true });
      sessionNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    const runs: RunRecord[] = [];
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
        const run = await this.readJson<RunRecord>(resolve(sessionPath, runName, "run.json"));
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

  private toRunSummary(run: RunRecord): RunSummary {
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
      agent: this.id,
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
}

function isStatusQuery(text: string): boolean {
  const normalized = text.toLowerCase();
  return STATUS_QUERY_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
