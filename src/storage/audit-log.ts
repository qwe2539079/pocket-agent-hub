import type { AgentKind, PersonaKind } from "../config/types.js";
import type { FileStore } from "./file-store.js";

export interface AuditEvent {
  id: string;
  actorId: string;
  channel: string;
  persona: PersonaKind;
  targetAgent: AgentKind;
  projectId?: string;
  action: string;
  result: "allowed" | "blocked";
  timestamp: string;
}

export class AuditLog {
  constructor(private readonly store: FileStore) {}

  async write(event: AuditEvent): Promise<void> {
    await this.store.appendJsonLine("audit/events.jsonl", event);
  }
}
