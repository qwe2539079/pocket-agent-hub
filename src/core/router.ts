import type { AppConfig, AgentKind, PersonaKind } from "../config/types.js";
import type { PolicyEngine } from "../policies/policy-engine.js";
import type { AuditLog } from "../storage/audit-log.js";
import type { HubMessage, HubResponse } from "./message.js";
import { ProjectRegistry } from "./project.js";
import { SessionRegistry } from "./session.js";
import type { AgentAdapter } from "./types.js";

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

    if (resolved.projectId && !this.projects.get(resolved.projectId)) {
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
    if (message.sessionCommand === "show-current-session") {
      const session =
        this.sessions.getLatestForConversation(message.channel, message.senderId, message.conversationId) ??
        this.sessions.getLatestByActor(message.channel, message.senderId);
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

      return {
        sessionId: cleared?.id ?? `system:${message.senderId}`,
        text: cleared
          ? `[hub] cleared active session ${cleared.id}. The next message will start fresh.`
          : "[hub] no active session to clear for this conversation.",
      };
    }

    return null;
  }
}
