import type { AgentKind, PersonaKind } from "../config/types.js";

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

  upsert(session: SessionRecord): void {
    this.#sessions.set(session.id, session);
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.#sessions.get(sessionId);
  }

  list(): SessionRecord[] {
    return [...this.#sessions.values()];
  }
}
