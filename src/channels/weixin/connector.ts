import type { ChannelConnector } from "../../core/types.js";

export class WeixinConnector implements ChannelConnector {
  readonly id = "weixin";

  async start(): Promise<void> {
    console.log("[weixin] connector stub started");
  }
}
