import type { AgentKind, ChannelKind } from "../config/types.js";
import type { HubMessage, HubResponse } from "./message.js";

export type RunStatus = "running" | "completed" | "failed";

export interface RunSummary {
  runId: string;
  agent: AgentKind;
  sessionId: string;
  actorId: string;
  channel: ChannelKind;
  conversationId?: string;
  projectId: string;
  status: RunStatus;
  prompt: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  finalMessagePreview?: string;
  errorMessage?: string;
  pid?: number;
}

export interface ListRunsOptions {
  actorId?: string;
  status?: RunStatus;
  limit?: number;
}

export interface AgentAdapter {
  readonly id: string;
  handle(message: HubMessage): Promise<HubResponse>;
  listRuns?(options?: ListRunsOptions): Promise<RunSummary[]>;
  getRun?(runId: string): Promise<RunSummary | null>;
  setCurrent?(sessionId: string, runId: string): Promise<void>;
  clearCurrent?(sessionId: string): Promise<void>;
  reconcileZombieRuns?(): Promise<number>;
}

export interface ChannelConnector {
  readonly id: string;
  start(): Promise<void>;
}
