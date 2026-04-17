import type { AgentKind, ChannelKind, PersonaKind } from "../config/types.js";
import type { FileStore } from "../storage/file-store.js";

export interface SessionRecord {
  id: string;
  channel: ChannelKind;
  actorId: string;
  conversationId?: string;
  agent: AgentKind;
  persona: PersonaKind;
  projectId?: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export class SessionRegistry {
  #sessions = new Map<string, SessionRecord>();

  constructor(private readonly store?: FileStore) {}

  async hydrate(): Promise<void> {
    if (!this.store) {
      return;
    }

    const records = await this.store.readJson<SessionRecord[]>("sessions/index.json");
    if (!records) {
      return;
    }

    for (const session of records) {
      this.#sessions.set(session.id, session);
    }
  }

  async upsert(session: SessionRecord): Promise<void> {
    const existing = this.#sessions.get(session.id);
    this.#sessions.set(session.id, {
      ...session,
      createdAt: existing?.createdAt ?? session.createdAt,
    });
    await this.persist();
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.#sessions.get(sessionId);
  }

  getLatestForConversation(
    channel: ChannelKind,
    actorId: string,
    conversationId?: string,
  ): SessionRecord | undefined {
    return this.list().find(
      (session) =>
        session.channel === channel &&
        session.actorId === actorId &&
        session.conversationId === conversationId,
    );
  }

  getLatestByActor(channel: ChannelKind, actorId: string): SessionRecord | undefined {
    return this.list().find((session) => session.channel === channel && session.actorId === actorId);
  }

  async clearConversation(
    channel: ChannelKind,
    actorId: string,
    conversationId?: string,
  ): Promise<SessionRecord | undefined> {
    const session = this.getLatestForConversation(channel, actorId, conversationId);
    if (!session) {
      return undefined;
    }

    this.#sessions.delete(session.id);
    await this.persist();
    return session;
  }

  list(): SessionRecord[] {
    return [...this.#sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async persist(): Promise<void> {
    if (!this.store) {
      return;
    }

    await this.store.writeJson("sessions/index.json", this.list());
  }
}
