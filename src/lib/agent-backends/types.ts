import type { PortableMcpConfig } from "./portable-mcp";
import type { ClaudeRuntimeCapabilityConfig } from "@/lib/agent-capabilities/claude-runtime-translator";
import type { CodexRuntimeCapabilityConfig } from "@/lib/agent-capabilities/codex-runtime-translator";

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
  claudeCapabilityConfig?: ClaudeRuntimeCapabilityConfig;
  /**
   * Translated Codex capability config seeded into the runtime at creation.
   * Codex builds its options per-turn, so seeding flows into every turn's
   * `CodexOptions.config` and naturally promotes any `staged-next-turn`
   * cascade rows at the next turn boundary.
   */
  codexCapabilityConfig?: CodexRuntimeCapabilityConfig;
}
