import type { AgentKind, PersonaKind } from "../../config/types.js";
import type { HubMessage, HubResponse, SessionCommand } from "../../core/message.js";

interface FeishuSenderId {
  open_id?: string;
  union_id?: string;
  user_id?: string;
}

interface FeishuMessageEvent {
  sender?: {
    sender_id?: FeishuSenderId;
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
  };
}

export interface FeishuEventEnvelope {
  type?: string;
  challenge?: string;
  token?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
    create_time?: string;
  };
  event?: FeishuMessageEvent;
}

export interface ParsedFeishuMessage {
  eventId: string;
  chatId: string;
  senderId: string;
  text: string;
  timestamp: string;
}

export function isChallengeEvent(body: FeishuEventEnvelope): boolean {
  return typeof body.challenge === "string" && body.challenge.length > 0;
}

export function assertVerificationToken(body: FeishuEventEnvelope, expectedToken?: string): void {
  if (!expectedToken) {
    return;
  }

  const actual = body.token ?? body.header?.token;
  if (actual !== expectedToken) {
    throw new Error("Invalid Feishu verification token");
  }
}

export function parseFeishuMessage(body: FeishuEventEnvelope): ParsedFeishuMessage | null {
  if (body.header?.event_type !== "im.message.receive_v1") {
    return null;
  }

  const event = body.event;
  const message = event?.message;
  const messageType = message?.message_type;
  if (!message || messageType !== "text") {
    return null;
  }

  const senderId =
    event?.sender?.sender_id?.open_id ??
    event?.sender?.sender_id?.user_id ??
    event?.sender?.sender_id?.union_id;

  if (!senderId || !message.chat_id || !message.message_id || !message.content) {
    return null;
  }

  let text = "";
  try {
    const parsed = JSON.parse(message.content) as { text?: string };
    text = parsed.text?.trim() ?? "";
  } catch {
    return null;
  }

  if (!text) {
    return null;
  }

  return {
    eventId: body.header?.event_id ?? message.message_id,
    chatId: message.chat_id,
    senderId,
    text,
    timestamp: body.header?.create_time ?? message.create_time ?? new Date().toISOString(),
  };
}

export function buildHubMessage(input: ParsedFeishuMessage): HubMessage {
  const command = parseCommandText(input.text);

  return {
    id: input.eventId,
    channel: "feishu",
    senderId: input.senderId,
    conversationId: input.chatId,
    persona: command.persona,
    text: command.text,
    targetAgent: command.targetAgent,
    projectId: command.projectId,
    timestamp: normalizeTimestamp(input.timestamp),
    hasDirectives: command.hasDirectives,
    sessionCommand: command.sessionCommand,
  };
}

export function renderFeishuReply(response: HubResponse): string {
  const lines = [response.text, `\nSession: ${response.sessionId}`];
  if (response.requiresApproval) {
    lines.push("Approval required before applying changes.");
  }
  return lines.join("\n");
}

function parseCommandText(input: string): {
  persona: PersonaKind;
  targetAgent?: AgentKind;
  projectId?: string;
  text: string;
  hasDirectives: boolean;
  sessionCommand?: SessionCommand;
} {
  const tokens = input.trim().split(/\s+/);
  let persona: PersonaKind = "daily-assistant";
  let targetAgent: AgentKind | undefined;
  let projectId: string | undefined;
  let sessionCommand: SessionCommand | undefined;
  const textTokens: string[] = [];
  let hasDirectives = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "/dev") {
      hasDirectives = true;
      persona = "dev-control";
      continue;
    }

    if (token === "/daily") {
      hasDirectives = true;
      persona = "daily-assistant";
      continue;
    }

    if (token === "/codex") {
      hasDirectives = true;
      targetAgent = "codex";
      continue;
    }

    if (token === "/claude") {
      hasDirectives = true;
      targetAgent = "claude";
      continue;
    }

    if (token === "/gemini") {
      hasDirectives = true;
      targetAgent = "gemini";
      continue;
    }

    if (token === "/project" && tokens[index + 1]) {
      hasDirectives = true;
      projectId = tokens[index + 1];
      index += 1;
      continue;
    }

    if (token === "/current") {
      hasDirectives = true;
      sessionCommand = "show-current-session";
      continue;
    }

    if (token === "/reset") {
      hasDirectives = true;
      sessionCommand = "reset-session";
      continue;
    }

    if (token === "/new") {
      hasDirectives = true;
      sessionCommand = "new-session";
      continue;
    }

    textTokens.push(token);
  }

  return {
    persona,
    targetAgent,
    projectId,
    text: textTokens.join(" ").trim() || input.trim(),
    hasDirectives,
    sessionCommand,
  };
}

function normalizeTimestamp(input: string): string {
  if (/^\d+$/.test(input)) {
    const numeric = Number(input);
    if (input.length >= 13) {
      return new Date(numeric).toISOString();
    }
    return new Date(numeric * 1000).toISOString();
  }

  return new Date(input).toISOString();
}
