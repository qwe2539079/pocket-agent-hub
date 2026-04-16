import type { ChannelConnector } from "../../core/types.js";

export class FeishuConnector implements ChannelConnector {
  readonly id = "feishu";

  async start(): Promise<void> {
    console.log("[feishu] connector stub started");
  }
}
