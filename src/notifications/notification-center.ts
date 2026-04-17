import type { ChannelKind } from "../config/types.js";

export type NotificationHandler = (targetId: string, text: string) => Promise<void>;
export interface NotificationOptions {
  conversationId?: string;
  signalText?: string;
}

export class NotificationCenter {
  readonly #targets = new Map<string, string>();
  readonly #handlers = new Map<ChannelKind, NotificationHandler>();

  registerChannelHandler(channel: ChannelKind, handler: NotificationHandler): void {
    this.#handlers.set(channel, handler);
  }

  rememberTarget(channel: ChannelKind, actorId: string, targetId: string, conversationId?: string): void {
    this.#targets.set(buildKey(channel, actorId), targetId);
    if (conversationId) {
      this.#targets.set(buildKey(channel, actorId, conversationId), targetId);
    }
  }

  async notifyActor(
    channel: ChannelKind,
    actorId: string,
    text: string,
    options: NotificationOptions = {},
  ): Promise<boolean> {
    const targetId =
      (options.conversationId
        ? this.#targets.get(buildKey(channel, actorId, options.conversationId))
        : undefined) ?? this.#targets.get(buildKey(channel, actorId));
    const handler = this.#handlers.get(channel);
    if (!targetId || !handler) {
      return false;
    }

    await handler(targetId, truncateText(text));
    if (options.signalText) {
      await handler(targetId, truncateText(options.signalText, 500));
    }
    return true;
  }
}

function buildKey(channel: ChannelKind, actorId: string, conversationId?: string): string {
  return conversationId ? `${channel}:${actorId}:${conversationId}` : `${channel}:${actorId}`;
}

function truncateText(text: string, maxLength = 3000): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 16)}\n\n[message truncated]`;
}
