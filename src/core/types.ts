import type { HubMessage, HubResponse } from "./message.js";

export interface AgentAdapter {
  readonly id: string;
  handle(message: HubMessage): Promise<HubResponse>;
}

export interface ChannelConnector {
  readonly id: string;
  start(): Promise<void>;
}
