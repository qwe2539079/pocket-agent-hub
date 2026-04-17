import type { AgentKind, ChannelKind, PersonaKind } from "../config/types.js";

export type SessionCommand = "show-current-session" | "reset-session" | "new-session";

export interface HubMessage {
  id: string;
  channel: ChannelKind;
  senderId: string;
  conversationId?: string;
  senderDisplayName?: string;
  persona: PersonaKind;
  text: string;
  targetAgent?: AgentKind;
  projectId?: string;
  timestamp: string;
  hasDirectives?: boolean;
  sessionCommand?: SessionCommand;
}

export interface HubResponse {
  sessionId: string;
  text: string;
  requiresApproval?: boolean;
}
