import type {
  AgentBackendId,
  AgentSessionRef,
  ConversationToolingOverrides,
} from "./types";

export interface AgentTaskRequest {
  workingDirectory: string;
  prompt: string;
  systemInstructions?: string[];
  modelId?: string;
  reasoningEffort?: string;
  resumeRef?: AgentSessionRef | null;
  outputSchema?: Record<string, unknown>;
  timeoutMs: number;
  tooling?: ConversationToolingOverrides;
  autonomous: boolean;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  networkAccessEnabled?: boolean;
  webSearchMode?: "disabled" | "cached" | "live";
  additionalDirectories?: string[];
  skipGitRepoCheck?: boolean;
}

export interface AgentTaskResult {
  backendRef?: AgentSessionRef | null;
  text: string | null;
  structuredOutput?: unknown;
  usage: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
  } | null;
  error: string | null;
  timedOut: boolean;
}

export interface AgentTaskRunner {
  readonly backend: AgentBackendId;
  run(input: AgentTaskRequest): Promise<AgentTaskResult>;
}
