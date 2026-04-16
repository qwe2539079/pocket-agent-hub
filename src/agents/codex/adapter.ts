import type { HubMessage, HubResponse } from "../../core/message.js";
import type { AgentAdapter } from "../../core/types.js";

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";

  async handle(message: HubMessage): Promise<HubResponse> {
    return {
      sessionId: buildSessionId(this.id, message.senderId),
      text: `[codex] queued request for project "${message.projectId ?? "default"}": ${message.text}`,
      requiresApproval: message.text.includes("/apply")
    };
  }
}

function buildSessionId(agent: string, senderId: string): string {
  return `${agent}:${senderId}`;
}
