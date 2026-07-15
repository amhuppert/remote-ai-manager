import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { ConversationToolingOverrides } from "./types";
import type { AgentTranscriptEntry } from "./transcript";
import type {
  AgentFailureClassification,
  ContinuationDisposition,
} from "./errors";

/**
 * Semantic execution shape for a backend task. `isolated-one-shot` requests a
 * fresh, non-persistent turn with inherited tools and provider configuration
 * disabled. An adapter that cannot guarantee the contract returns an explicit
 * unsupported profile result without invoking its provider.
 */
export type AgentTaskExecutionProfile = "standard" | "isolated-one-shot";

export interface AgentTaskRequest {
  workingDirectory: string;
  prompt: string;
  /** Persistent image files forwarded to backends that accept local images. */
  imagePaths?: readonly string[];
  systemInstructions?: string[];
  modelId?: string;
  reasoningEffort?: string;
  resumeRef?: AgentSessionRef | null;
  outputSchema?: Record<string, unknown>;
  timeoutMs: number;
  tooling?: ConversationToolingOverrides;
  executionProfile?: AgentTaskExecutionProfile;
  autonomous: boolean;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  networkAccessEnabled?: boolean;
  webSearchMode?: "disabled" | "cached" | "live";
  additionalDirectories?: string[];
  skipGitRepoCheck?: boolean;
  /**
   * External cancellation signal. When it aborts, the run is torn down through
   * the same AbortController path a timeout uses (the result reports
   * `timedOut`). Lets a job-shaped caller cancel a live run.
   */
  signal?: AbortSignal;
}

export interface AgentTaskResult {
  backendRef?: AgentSessionRef | null;
  text: string | null;
  structuredOutput?: unknown;
  usage: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
    /** Estimated from token usage — backends that report tokens but not USD. */
    costUsd?: number | null;
  } | null;
  error: string | null;
  timedOut: boolean;
  /** Adapter-owned normalized failure verdict; null for a clean run. */
  failure: AgentFailureClassification | null;
  /** Adapter-owned verdict for the returned continuation ref. */
  continuationDisposition: ContinuationDisposition;
  /**
   * Full backend-native turn transcript (codex `ThreadItem`s / claude
   * `SDKMessage`s) wrapped in lossless envelopes. Present when the backend
   * surfaced intermediate items; absent for turns that produced none (e.g. a
   * timed-out or errored run). Consumed by the graph-workflow validator path
   * to persist auditable validator transcripts.
   */
  transcript?: AgentTranscriptEntry[];
}

export interface AgentTaskRunner {
  readonly backend: AgentBackendId;
  run(input: AgentTaskRequest): Promise<AgentTaskResult>;
}
