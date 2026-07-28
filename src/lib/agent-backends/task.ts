import { z } from "zod";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { ConversationToolingOverrides } from "./types";
import type { AgentTranscriptEntry } from "./transcript";
import type {
  AgentFailureClassification,
  ContinuationDisposition,
} from "./errors";

/**
 * Semantic execution shape for a backend task. `isolated-one-shot` requests a
 * fresh turn with provider-supported isolation controls applied and no
 * continuation reference returned to the caller.
 */
export type AgentTaskExecutionProfile = "standard" | "isolated-one-shot";

/**
 * The CC session a task subprocess is permitted to act as.
 *
 * TRUST CONTRACT — this is a server-side value supplied ONLY by trusted
 * orchestration code (today: the standalone-collaboration production caller,
 * which derives it from the originating session and conversation). It must
 * never be populated from user input, request bodies, prompts, or agent
 * output: its presence opts the subprocess into the CC session environment
 * contract, which hands the child an instance API token and server URL that
 * the runner resolves server-side. Whoever supplies a scope decides which
 * session's data the child can read and write through `cctl`.
 *
 * The scope carries identity only — never credentials, paths, or an arbitrary
 * env map — and unknown keys are stripped, so it cannot be used to smuggle
 * environment variables into a child process.
 */
export const ccTaskSessionScopeSchema = z.object({
  project: z.string().min(1),
  session: z.string().min(1),
  conversationId: z.string().min(1),
});

export type CcTaskSessionScope = z.infer<typeof ccTaskSessionScopeSchema>;

export interface AgentTaskRequest {
  workingDirectory: string;
  prompt: string;
  /** Persistent image files forwarded to backends that accept local images. */
  imagePaths?: readonly string[];
  systemInstructions?: string[];
  modelId?: string;
  reasoningEffort?: string;
  codexFastMode?: boolean;
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
  /**
   * Per-run inactivity bound: with no backend event for this long the run is
   * presumed hung and torn down through the timeout abort path, with the
   * error naming the stall. Unset falls back to the adapter's descriptor
   * default; 0 (or a negative value) disables the bound.
   */
  stallTimeoutMs?: number;
  /**
   * Opt-in CC session identity for the child process — see the trust contract
   * on {@link ccTaskSessionScopeSchema} before supplying it. Absent for every
   * generic and graph-workflow task run, whose child env keeps its ambient
   * `CC_*` neutralized and therefore has no CC identity at all.
   */
  ccSessionScope?: CcTaskSessionScope;
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
