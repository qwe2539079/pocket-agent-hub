import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AgentConfig, ChannelKind } from "../../config/types.js";
import { ProjectRegistry } from "../../core/project.js";
import type { HubMessage, HubResponse } from "../../core/message.js";
import type { AgentAdapter, ListRunsOptions, RunSummary } from "../../core/types.js";
import { NotificationCenter } from "../../notifications/notification-center.js";

interface CodexRunRecord {
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

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  #profileChecked = false;
  #profileAvailable = false;

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
        text: '[codex] missing project context. Use `/dev /codex /project <id> ...`.',
        requiresApproval: true,
      };
    }

    const project = this.projects.get(message.projectId);
    if (!project) {
      return {
        sessionId,
        text: `[codex] unknown project "${message.projectId}".`,
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
        `[codex] started task for project "${project.id}".\n` +
        `Run: ${run.id}\n` +
        `Prompt: ${message.text}\n` +
        `Use \`/dev /codex /project ${project.id} 查看当前项目状态\` to check progress.`,
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
      throw new Error(`Unknown codex run: ${runId}`);
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

      const updated: CodexRunRecord = {
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
  ): Promise<CodexRunRecord> {
    const runId = `${Date.now()}`;
    const runDir = resolve(this.storageDir, "codex", sessionId, runId);
    const outputPath = resolve(runDir, "codex.log");
    const lastMessagePath = resolve(runDir, "last-message.txt");
    await mkdir(runDir, { recursive: true });

    const args = await this.buildArgs(projectPath, lastMessagePath, executionPrompt);
    const now = new Date().toISOString();
    const run: CodexRunRecord = {
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

    child.stdout?.pipe(outputStream);
    child.stderr?.pipe(outputStream);

    child.on("error", (error) => {
      void this.finishRun(sessionId, {
        ...run,
        status: "failed",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        errorMessage: error.message,
      }).finally(() => {
        outputStream.end();
      });
    });

    child.on("close", (code) => {
      void this.completeRunFromDisk(sessionId, run, code).finally(() => {
        outputStream.end();
      });
    });

    return run;
  }

  private async buildExecutionPrompt(
    message: HubMessage,
    sessionId: string,
    latestRun: CodexRunRecord | null,
    projectId: string,
  ): Promise<string> {
    if (message.hasDirectives) {
      return message.text;
    }

    let seed: CodexRunRecord | null = null;

    const pointer = await this.readCurrent(sessionId);
    if (pointer) {
      const resumed = await this.readRunById(pointer.runId);
      // /resume is one-shot: consume the pointer whether or not the run is usable
      await this.clearCurrent(sessionId);
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

  private async buildArgs(projectPath: string, lastMessagePath: string, prompt: string): Promise<string[]> {
    const args = ["exec", "-C", projectPath];

    if (await this.hasConfiguredProfile()) {
      args.push("--profile", this.config.defaultProfile);
    }

    args.push("--sandbox", this.config.sandboxMode ?? "danger-full-access");
    args.push("--output-last-message", lastMessagePath, prompt);
    return args;
  }

  private async hasConfiguredProfile(): Promise<boolean> {
    if (this.#profileChecked) {
      return this.#profileAvailable;
    }

    this.#profileChecked = true;
    const configPath = resolve(process.env.HOME ?? "", ".codex", "config.toml");

    try {
      const raw = await readFile(configPath, "utf8");
      this.#profileAvailable = raw.includes(`[profiles.${this.config.defaultProfile}]`);
    } catch {
      this.#profileAvailable = false;
    }

    return this.#profileAvailable;
  }

  private async completeRunFromDisk(
    sessionId: string,
    run: CodexRunRecord,
    code: number | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    let finalMessage: string | undefined;
    try {
      finalMessage = (await readFile(run.lastMessagePath, "utf8")).trim() || undefined;
    } catch {
      finalMessage = undefined;
    }

    const nextRun: CodexRunRecord = {
      ...run,
      status: code === 0 ? "completed" : "failed",
      exitCode: code,
      updatedAt: now,
      completedAt: now,
      finalMessage,
      errorMessage: code === 0 ? undefined : `Codex exited with code ${code}`,
    };

    await this.finishRun(sessionId, nextRun);
  }

  private async finishRun(sessionId: string, run: CodexRunRecord): Promise<void> {
    await this.writeRun(run);
    await this.writeLatestRun(sessionId, run);
    await this.notifyRunFinished(run);
  }

  private async notifyRunFinished(run: CodexRunRecord): Promise<void> {
    const notificationText =
      run.status === "completed"
        ? `[codex] task completed.\nProject: ${run.projectId}\nRun: ${run.id}\n\n${run.finalMessage ?? "Codex finished, but no final message was captured."}`
        : `[codex] task failed.\nProject: ${run.projectId}\nRun: ${run.id}\nError: ${run.errorMessage ?? `exit code ${run.exitCode ?? "unknown"}`}\n\n${await this.readLogTail(run.outputPath) || "No log output captured."}`;

    try {
      await this.notifications.notifyActor(run.channel, run.actorId, notificationText, {
        conversationId: run.conversationId,
        signalText:
          run.status === "completed"
            ? `[codex] completed: ${run.projectId} · ${run.id}`
            : `[codex] failed: ${run.projectId} · ${run.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[codex] failed to send completion notification: ${message}`);
    }
  }

  private async renderStatus(
    requestedProjectId: string | undefined,
    latestRun: CodexRunRecord | null,
  ): Promise<string> {
    if (!latestRun) {
      return "[codex] no recorded task yet for this session.";
    }

    if (requestedProjectId && latestRun.projectId !== requestedProjectId) {
      return `[codex] latest recorded task belongs to project "${latestRun.projectId}", not "${requestedProjectId}".`;
    }

    if (latestRun.status === "running") {
      return (
        `[codex] task is still running.\n` +
        `Project: ${latestRun.projectId}\n` +
        `Run: ${latestRun.id}\n` +
        `Started: ${latestRun.startedAt}\n` +
        `Prompt: ${latestRun.prompt}`
      );
    }

    if (latestRun.status === "completed") {
      return (
        `[codex] last task completed.\n` +
        `Project: ${latestRun.projectId}\n` +
        `Run: ${latestRun.id}\n` +
        `Completed: ${latestRun.completedAt ?? latestRun.updatedAt}\n\n` +
        `${latestRun.finalMessage ?? "Codex finished, but no final message was captured."}`
      );
    }

    const logTail = await this.readLogTail(latestRun.outputPath);
    return (
      `[codex] last task failed.\n` +
      `Project: ${latestRun.projectId}\n` +
      `Run: ${latestRun.id}\n` +
      `Error: ${latestRun.errorMessage ?? `exit code ${latestRun.exitCode ?? "unknown"}`}\n\n` +
      `${logTail || "No log output captured."}`
    );
  }

  private async readLatestRun(sessionId: string): Promise<CodexRunRecord | null> {
    return this.readJson<CodexRunRecord>(resolve(this.storageDir, "codex", sessionId, "latest.json"));
  }

  private async writeLatestRun(sessionId: string, run: CodexRunRecord): Promise<void> {
    await this.writeJson(resolve(this.storageDir, "codex", sessionId, "latest.json"), run);
  }

  private async writeRun(run: CodexRunRecord): Promise<void> {
    await this.writeJson(resolve(this.storageDir, "codex", run.sessionId, run.id, "run.json"), run);
  }

  private async readCurrent(sessionId: string): Promise<CurrentRunPointer | null> {
    return this.readJson<CurrentRunPointer>(this.currentPath(sessionId));
  }

  private currentPath(sessionId: string): string {
    return resolve(this.storageDir, "codex", sessionId, "current.json");
  }

  private async readRunById(runId: string): Promise<CodexRunRecord | null> {
    const all = await this.scanAllRuns();
    return all.find((run) => run.id === runId) ?? null;
  }

  private async scanAllRuns(): Promise<CodexRunRecord[]> {
    const base = resolve(this.storageDir, "codex");
    let sessionNames: string[];
    try {
      const entries = await readdir(base, { withFileTypes: true });
      sessionNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    const runs: CodexRunRecord[] = [];
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
        const run = await this.readJson<CodexRunRecord>(resolve(sessionPath, runName, "run.json"));
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

function toRunSummary(run: CodexRunRecord): RunSummary {
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
    agent: "codex",
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
