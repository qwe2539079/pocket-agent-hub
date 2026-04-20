import type { AppConfig, AgentKind, PersonaKind } from "../config/types.js";
import type { PolicyEngine } from "../policies/policy-engine.js";
import type { AuditLog } from "../storage/audit-log.js";
import type { HubMessage, HubResponse } from "./message.js";
import { ProjectRegistry } from "./project.js";
import { SessionRegistry } from "./session.js";
import type { SessionRecord } from "./session.js";
import type { AgentAdapter, NativeSessionSummary, RunSummary } from "./types.js";

export class HubRouter {
  constructor(
    private readonly config: AppConfig,
    private readonly policyEngine: PolicyEngine,
    private readonly agents: Map<AgentKind, AgentAdapter>,
    private readonly sessions: SessionRegistry,
    private readonly projects: ProjectRegistry,
    private readonly auditLog: AuditLog,
  ) {}

  async route(message: HubMessage): Promise<HubResponse> {
    const sessionCommandResponse = await this.handleSessionCommand(message);
    if (sessionCommandResponse) {
      return sessionCommandResponse;
    }

    const resolved = this.resolveMessage(message);
    const personaConfig = this.config.personas[resolved.persona];
    const targetAgent = resolved.targetAgent ?? personaConfig.allowedAgents[0];

    if (!personaConfig.allowedAgents.includes(targetAgent)) {
      await this.auditLog.write({
        id: resolved.id,
        actorId: resolved.senderId,
        channel: resolved.channel,
        persona: resolved.persona,
        targetAgent,
        projectId: resolved.projectId,
        action: "route",
        result: "blocked",
        timestamp: new Date().toISOString(),
      });
      throw new Error(`Agent "${targetAgent}" is not allowed for persona "${resolved.persona}"`);
    }

    if (resolved.projectId) {
      const project = this.projects.get(resolved.projectId);
      if (!project) {
        await this.auditLog.write({
          id: resolved.id,
          actorId: resolved.senderId,
          channel: resolved.channel,
          persona: resolved.persona,
          targetAgent,
          projectId: resolved.projectId,
          action: "route",
          result: "blocked",
          timestamp: new Date().toISOString(),
        });
        throw new Error(`Unknown project "${resolved.projectId}"`);
      }
      // Canonicalize alias → real id so downstream audit/session/adapter
      // see a single identity for the project.
      resolved.projectId = project.id;
    }

    this.policyEngine.assertAllowed({
      persona: resolved.persona,
      policy: personaConfig.policy,
      text: resolved.text,
    });

    const adapter = this.agents.get(targetAgent);
    if (!adapter) {
      throw new Error(`Agent adapter "${targetAgent}" is not registered`);
    }

    const result = await adapter.handle(resolved);
    const now = new Date().toISOString();

    await this.sessions.upsert({
      id: result.sessionId,
      channel: resolved.channel,
      actorId: resolved.senderId,
      conversationId: resolved.conversationId,
      agent: targetAgent,
      persona: resolved.persona,
      projectId: resolved.projectId,
      summary: result.text.slice(0, 120),
      createdAt: now,
      updatedAt: now,
    });

    await this.auditLog.write({
      id: resolved.id,
      actorId: resolved.senderId,
      channel: resolved.channel,
      persona: resolved.persona,
      targetAgent,
      projectId: resolved.projectId,
      action: "route",
      result: "allowed",
      timestamp: now,
    });

    return result;
  }

  private resolveMessage(message: HubMessage): HubMessage {
    if (message.sessionCommand === "new-session") {
      return {
        ...message,
        sessionCommand: undefined,
      };
    }

    if (message.hasDirectives) {
      return message;
    }

    const latestSession =
      this.sessions.getLatestForConversation(message.channel, message.senderId, message.conversationId) ??
      this.sessions.getLatestByActor(message.channel, message.senderId);
    if (!latestSession) {
      return message;
    }

    return {
      ...message,
      persona: latestSession.persona as PersonaKind,
      targetAgent: latestSession.agent,
      projectId: message.projectId ?? latestSession.projectId,
    };
  }

  private async handleSessionCommand(message: HubMessage): Promise<HubResponse | null> {
    if (message.sessionCommand === "new-session") {
      const latest = this.latestSessionFor(message);
      if (latest) {
        const adapter = this.agents.get(latest.agent);
        await adapter?.clearCurrent?.(latest.id);
      }
      return null;
    }

    if (message.sessionCommand === "show-current-session") {
      const session = this.latestSessionFor(message);
      if (!session) {
        return {
          sessionId: `system:${message.senderId}`,
          text: "[hub] no active session recorded for this conversation.",
        };
      }

      return {
        sessionId: session.id,
        text:
          `[hub] current session
` +
          `Persona: ${session.persona}
` +
          `Agent: ${session.agent}
` +
          `Project: ${session.projectId ?? "none"}
` +
          `Updated: ${session.updatedAt}
` +
          `Summary: ${session.summary}`,
      };
    }

    if (message.sessionCommand === "reset-session") {
      const cleared = await this.sessions.clearConversation(
        message.channel,
        message.senderId,
        message.conversationId,
      );

      if (cleared) {
        const adapter = this.agents.get(cleared.agent);
        await adapter?.clearCurrent?.(cleared.id);
      }

      return {
        sessionId: cleared?.id ?? `system:${message.senderId}`,
        text: cleared
          ? `[hub] cleared active session ${cleared.id}. The next message will start fresh.`
          : "[hub] no active session to clear for this conversation.",
      };
    }

    if (message.sessionCommand === "list-runs" || message.sessionCommand === "show-running") {
      const agent = this.resolveQueryAgent(message);
      if (!agent) {
        return {
          sessionId: `system:${message.senderId}`,
          text: "[hub] no active agent — specify /codex, /claude, or /gemini first.",
        };
      }

      const adapter = this.agents.get(agent);
      if (!adapter?.listRuns) {
        return {
          sessionId: `${agent}:${message.senderId}`,
          text: `[hub] ${agent} does not expose run history yet.`,
        };
      }

      const status = message.sessionCommand === "show-running" ? "running" : undefined;
      const runs = await adapter.listRuns({
        actorId: message.senderId,
        status,
        limit: 10,
      });

      return {
        sessionId: `${agent}:${message.senderId}`,
        text:
          message.sessionCommand === "show-running"
            ? renderRunningList(runs, agent)
            : renderRunList(runs, agent),
      };
    }

    if (message.sessionCommand === "resume-run") {
      const runId = message.resumeRunId;
      if (!runId) {
        return {
          sessionId: `system:${message.senderId}`,
          text: "[hub] usage: `/resume <run-id>` — run `/list` to find ids.",
        };
      }

      const agent = this.resolveQueryAgent(message);
      if (!agent) {
        return {
          sessionId: `system:${message.senderId}`,
          text: "[hub] no active agent — specify /codex, /claude, or /gemini first.",
        };
      }

      const adapter = this.agents.get(agent);
      if (!adapter?.getRun || !adapter?.setCurrent) {
        return {
          sessionId: `${agent}:${message.senderId}`,
          text: `[hub] ${agent} does not support resume yet.`,
        };
      }

      const run = await adapter.getRun(runId);
      if (!run || run.actorId !== message.senderId) {
        return {
          sessionId: `${agent}:${message.senderId}`,
          text: `[hub] no ${agent} run "${runId}" found for this account.`,
        };
      }

      await adapter.setCurrent(run.sessionId, runId);
      return {
        sessionId: run.sessionId,
        text: renderResumeConfirm(run),
      };
    }

    if (message.sessionCommand === "list-native") {
      const collected: NativeSessionSummary[] = [];
      for (const adapter of this.agents.values()) {
        if (!adapter.listNativeSessions) continue;
        try {
          const list = await adapter.listNativeSessions();
          collected.push(...list);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[hub] listNativeSessions failed for ${adapter.id}: ${msg}`);
        }
      }
      collected.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
      return {
        sessionId: `system:${message.senderId}`,
        text: renderNativeSessionList(collected.slice(0, 10), this.projects),
      };
    }

    if (message.sessionCommand === "takeover-native") {
      const nativeId = message.takeoverSessionId;
      if (!nativeId) {
        return {
          sessionId: `system:${message.senderId}`,
          text: "[hub] usage: `/takeover <session-id>` — run `/desktop` to find ids.",
        };
      }

      let match: NativeSessionSummary | undefined;
      let matchAdapter: AgentAdapter | undefined;
      for (const adapter of this.agents.values()) {
        if (!adapter.listNativeSessions) continue;
        try {
          const list = await adapter.listNativeSessions();
          const hit = list.find((session) => session.sessionId === nativeId);
          if (hit) {
            match = hit;
            matchAdapter = adapter;
            break;
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[hub] listNativeSessions failed for ${adapter.id}: ${msg}`);
        }
      }

      if (!match || !matchAdapter) {
        return {
          sessionId: `system:${message.senderId}`,
          text: `[hub] no desktop session "${nativeId}" found. Run \`/desktop\` to see available sessions.`,
        };
      }

      if (!matchAdapter.setNativeCurrent) {
        return {
          sessionId: `system:${message.senderId}`,
          text: `[hub] ${match.agent} does not support takeover yet.`,
        };
      }

      const project = this.projects.list().find((candidate) => candidate.path === match.cwd);
      if (!project) {
        return {
          sessionId: `system:${message.senderId}`,
          text:
            `[hub] session "${nativeId}" was started in cwd "${match.cwd}", which is not a registered project. ` +
            `Add it to config.projects (with path matching the cwd) before taking over.`,
        };
      }

      const hubSessionId = `${match.agent}:${message.senderId}`;
      await matchAdapter.setNativeCurrent(hubSessionId, nativeId);

      const now = new Date().toISOString();
      await this.sessions.upsert({
        id: hubSessionId,
        channel: message.channel,
        actorId: message.senderId,
        conversationId: message.conversationId,
        agent: match.agent,
        persona: message.persona,
        projectId: project.id,
        summary: `[hub] taking over desktop ${match.agent} session ${nativeId}`,
        createdAt: now,
        updatedAt: now,
      });

      return {
        sessionId: hubSessionId,
        text:
          `[hub] queued takeover of desktop ${match.agent} session ${nativeId}.\n` +
          `Project: ${project.id}\n` +
          `Cwd: ${match.cwd}\n` +
          `Close the session in your desktop terminal before sending the next message, otherwise the two ends may write the same session log concurrently.\n` +
          `Your next non-directive message will continue that session.`,
      };
    }

    return null;
  }

  private latestSessionFor(message: HubMessage): SessionRecord | undefined {
    return (
      this.sessions.getLatestForConversation(message.channel, message.senderId, message.conversationId) ??
      this.sessions.getLatestByActor(message.channel, message.senderId)
    );
  }

  private resolveQueryAgent(message: HubMessage): AgentKind | undefined {
    return message.targetAgent ?? this.latestSessionFor(message)?.agent;
  }
}

function renderRunList(runs: RunSummary[], agent: AgentKind): string {
  if (runs.length === 0) {
    return `[hub] no ${agent} runs recorded yet.`;
  }

  const lines = [`[hub] recent ${agent} runs (most recent first):`];
  for (const run of runs) {
    lines.push(
      `- ${run.runId} [${run.status}] project=${run.projectId} started=${run.startedAt}`,
    );
    lines.push(`  ${truncate(run.prompt, 80)}`);
  }
  lines.push("");
  lines.push("Use `/resume <run-id>` to seed your next message from that run's reply.");
  return lines.join("\n");
}

function renderRunningList(runs: RunSummary[], agent: AgentKind): string {
  if (runs.length === 0) {
    return `[hub] no ${agent} tasks are currently running.`;
  }

  const lines = [`[hub] ${agent} tasks currently running:`];
  for (const run of runs) {
    lines.push(`- ${run.runId} project=${run.projectId} started=${run.startedAt}`);
    lines.push(`  ${truncate(run.prompt, 80)}`);
  }
  return lines.join("\n");
}

function renderResumeConfirm(run: RunSummary): string {
  const lines = [
    `[hub] queued resume of ${run.agent} run ${run.runId}.`,
    `Project: ${run.projectId}`,
    `Status: ${run.status}`,
  ];
  if (run.finalMessagePreview) {
    lines.push(`Preview: ${run.finalMessagePreview}`);
  }
  lines.push("Your next non-directive message will continue from this run's reply.");
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function renderNativeSessionList(sessions: NativeSessionSummary[], projects: ProjectRegistry): string {
  if (sessions.length === 0) {
    return "[hub] no desktop agent sessions found on this workstation.";
  }

  const lines = ["[hub] desktop agent sessions (most recent first):"];
  for (const session of sessions) {
    const project = projects.list().find((candidate) => candidate.path === session.cwd);
    const projectLabel = project ? project.id : `${session.cwd} [unregistered]`;
    const activity = session.lastActivityAt ? ` lastActivity=${session.lastActivityAt}` : "";
    lines.push(`- ${session.agent} ${session.sessionId} project=${projectLabel}${activity}`);
    if (session.preview) {
      lines.push(`  ${truncate(session.preview, 80)}`);
    }
  }
  lines.push("");
  lines.push("Use `/takeover <session-id>` to continue one from this chat. Close the desktop session first.");
  return lines.join("\n");
}
