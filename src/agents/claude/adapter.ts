import type { HubMessage, HubResponse } from "../../core/message.js";
import type { AgentAdapter } from "../../core/types.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude";

  async handle(message: HubMessage): Promise<HubResponse> {
    return {
      sessionId: `${this.id}:${message.senderId}`,
      text: `[claude] received ${message.persona} message: ${message.text}`
    };
  }
}
