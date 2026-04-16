export type ChannelKind = "feishu" | "weixin";
export type AgentKind = "codex" | "claude" | "gemini";
export type PersonaKind = "dev-control" | "daily-assistant";
export type PolicyKind = "guarded-dev" | "safe-chat";

export interface FeishuChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  mode: "webhook";
}

export interface WeixinChannelConfig {
  enabled: boolean;
  gatewayBaseUrl: string;
  token: string;
  accountId: string;
}

export interface AgentConfig {
  enabled: boolean;
  command: string;
  defaultProfile: string;
}

export interface PersonaConfig {
  allowedAgents: AgentKind[];
  policy: PolicyKind;
}

export interface ProjectConfig {
  id: string;
  path: string;
  description: string;
  defaultAgent: AgentKind;
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
