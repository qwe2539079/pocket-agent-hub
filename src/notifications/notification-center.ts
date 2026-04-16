import type { ChannelKind } from "../config/types.js";

export type NotificationHandler = (targetId: string, text: string) => Promise<void>;

export class NotificationCenter {
  readonly #targets = new Map<string, string>();
  readonly #handlers = new Map<ChannelKind, NotificationHandler>();

  registerChannelHandler(channel: ChannelKind, handler: NotificationHandler): void {
    this.#handlers.set(channel, handler);
  }

  rememberTarget(channel: ChannelKind, actorId: string, targetId: string): void {
    this.#targets.set(buildKey(channel, actorId), targetId);
  }

  async notifyActor(channel: ChannelKind, actorId: string, text: string): Promise<boolean> {
    const targetId = this.#targets.get(buildKey(channel, actorId));
    const handler = this.#handlers.get(channel);
    if (!targetId || !handler) {
      return false;
    }

    await handler(targetId, truncateText(text));
    return true;
  }
}

function buildKey(channel: ChannelKind, actorId: string): string {
  return `${channel}:${actorId}`;
}

function truncateText(text: string, maxLength = 3000): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 16)}\n\n[message truncated]`;
}
