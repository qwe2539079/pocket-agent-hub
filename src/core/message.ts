import type { AgentKind, ChannelKind, PersonaKind } from "../config/types.js";

export interface HubMessage {
  id: string;
  channel: ChannelKind;
  senderId: string;
  senderDisplayName?: string;
  persona: PersonaKind;
  text: string;
  targetAgent?: AgentKind;
  projectId?: string;
  timestamp: string;
}

export interface HubResponse {
  sessionId: string;
  text: string;
  requiresApproval?: boolean;
}
