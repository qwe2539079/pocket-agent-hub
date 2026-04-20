export type ChannelKind = "feishu" | "weixin";
export type AgentKind = "codex" | "claude" | "gemini";
export type PersonaKind = "dev-control" | "daily-assistant";
export type PolicyKind = "guarded-dev" | "safe-chat";

export type FeishuTransportMode = "websocket" | "webhook";

export interface FeishuChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  mode: FeishuTransportMode;
  apiBaseUrl?: string;
  websocketUrl?: string;
  reconnectIntervalMs?: number;
  bindHost?: string;
  port?: number;
  path?: string;
  verificationToken?: string;
}

export interface WeixinChannelConfig {
  enabled: boolean;
  gatewayBaseUrl: string;
  token: string;
  accountId: string;
}

export type AgentSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface AgentConfig {
  enabled: boolean;
  command: string;
  defaultProfile: string;
  sandboxMode?: AgentSandboxMode;
}

export interface PersonaConfig {
  allowedAgents: AgentKind[];
  policy: PolicyKind;
  sandboxOverride?: AgentSandboxMode;
}

export interface ProjectConfig {
  id: string;
  path: string;
  description: string;
  defaultAgent: AgentKind;
  aliases?: string[];
}

export interface AppConfig {
  hostId: string;
  storageDir: string;
  channels: {
    feishu: FeishuChannelConfig;
    weixin: WeixinChannelConfig;
  };
  agents: Record<AgentKind, AgentConfig>;
  personas: Record<PersonaKind, PersonaConfig>;
  projects: ProjectConfig[];
}
