import type { HubMessage, HubResponse } from "../../core/message.js";
import type { AgentAdapter } from "../../core/types.js";

export class GeminiAdapter implements AgentAdapter {
  readonly id = "gemini";

  async handle(message: HubMessage): Promise<HubResponse> {
    return {
      sessionId: `${this.id}:${message.senderId}`,
      text: `[gemini] placeholder adapter accepted message: ${message.text}`
    };
  }
}
