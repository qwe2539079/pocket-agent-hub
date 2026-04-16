import type { AppConfig, AgentKind } from "../config/types.js";
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
    const personaConfig = this.config.personas[message.persona];
    const targetAgent = message.targetAgent ?? personaConfig.allowedAgents[0];

    if (!personaConfig.allowedAgents.includes(targetAgent)) {
      await this.auditLog.write({
        id: message.id,
        actorId: message.senderId,
        channel: message.channel,
        persona: message.persona,
        targetAgent,
        projectId: message.projectId,
        action: "route",
        result: "blocked",
        timestamp: new Date().toISOString(),
      });
      throw new Error(`Agent "${targetAgent}" is not allowed for persona "${message.persona}"`);
    }

    if (message.projectId && !this.projects.get(message.projectId)) {
      await this.auditLog.write({
        id: message.id,
        actorId: message.senderId,
        channel: message.channel,
        persona: message.persona,
        targetAgent,
        projectId: message.projectId,
        action: "route",
        result: "blocked",
        timestamp: new Date().toISOString(),
      });
      throw new Error(`Unknown project "${message.projectId}"`);
    }

    this.policyEngine.assertAllowed({
      persona: message.persona,
      policy: personaConfig.policy,
      text: message.text,
    });

    const adapter = this.agents.get(targetAgent);
    if (!adapter) {
      throw new Error(`Agent adapter "${targetAgent}" is not registered`);
    }

    const result = await adapter.handle(message);
    const now = new Date().toISOString();

    await this.sessions.upsert({
      id: result.sessionId,
      agent: targetAgent,
      persona: message.persona,
      projectId: message.projectId,
      summary: result.text.slice(0, 120),
      createdAt: now,
      updatedAt: now,
    });

    await this.auditLog.write({
      id: message.id,
      actorId: message.senderId,
      channel: message.channel,
      persona: message.persona,
      targetAgent,
      projectId: message.projectId,
      action: "route",
      result: "allowed",
      timestamp: now,
    });

    return result;
  }
}
