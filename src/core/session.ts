import type { AgentKind, PersonaKind } from "../config/types.js";
import type { FileStore } from "../storage/file-store.js";

export interface SessionRecord {
  id: string;
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
    this.#sessions.set(session.id, session);
    await this.persist();
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.#sessions.get(sessionId);
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
