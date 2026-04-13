import type { PortableMcpConfig } from "./portable-mcp";

export type AgentBackendId = "claude" | "codex";

export type AgentSessionRef =
  | { backend: "claude"; sessionId: string }
  | { backend: "codex"; threadId: string };

export interface ConversationBackendCapabilities {
  queueWhileRunning: boolean;
  askUserQuestion: boolean;
  preciseFork: boolean;
  portableMcpAtStart: boolean;
  portableMcpBetweenTurns: boolean;
  contextWindowMetrics: boolean;
}

export interface ConversationToolingOverrides {
  portableMcp?: PortableMcpConfig;
  claudeSdkServers?: Record<string, unknown>;
}
