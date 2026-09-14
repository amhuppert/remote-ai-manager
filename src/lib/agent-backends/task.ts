import { z } from "zod";
import type {
  ExecutionIntent,
  TaskExecutionProfile,
} from "./execution-admission";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { ConversationToolingOverrides } from "./types";
import type { AgentTranscriptEntry } from "./transcript";
import type {
  AgentFailureClassification,
  ContinuationDisposition,
} from "./errors";
import type { BackendModelSelection } from "./schemas";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";

/**
 * Semantic execution shape for a backend task. `isolated-one-shot` requests a
 * fresh turn with provider-supported isolation controls applied and no
 * continuation reference returned to the caller.
 */
export type AgentTaskExecutionProfile = TaskExecutionProfile;

/**
 * The CC session a task subprocess is permitted to act as.
 *
 * TRUST CONTRACT — this is a server-side value supplied ONLY by trusted
 * orchestration code, derived from its persisted session and conversation. It must
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

/**
 * The filesystem-write envelope a task run executes under.
 *
 * SERVER-DERIVED ONLY: like {@link ccTaskSessionScopeSchema} this is composed by
 * orchestration code from the lane's role, never from prompts, agent output, or
 * request bodies — a policy an agent could author would be a policy it could
 * widen. Absent means the run is unrestricted, so a layer that drops the field
 * silently un-restricts the lane; every hop between the composing dispatch site
 * and the runner carries it explicitly for that reason.
 *
 * `allowWrite` names the only paths the run may mutate; `denyWrite` names paths
 * that stay unwritable even if a backend's allowlist is additive over its own
 * defaults. Both are canonical absolute paths — the composer realpath-normalizes
 * them so enforcement compares the same bytes the OS will.
 *
 * `allowWrite` is ORDERED and adapters read that order: the first entry is the
 * run's own writable root (a backend that must relocate the run's working
 * directory out of an unwritable tree uses it), and the last is where the run's
 * temp files belong. A one-entry allowlist collapses both onto the same path,
 * which is the correct degenerate case rather than a special one.
 */
export const fsWritePolicySchema = z.object({
  mode: z.literal("allowlist"),
  allowWrite: z.array(z.string().min(1)),
  denyWrite: z.array(z.string().min(1)),
});

export type FsWritePolicy = z.infer<typeof fsWritePolicySchema>;

export interface AgentTaskRequest extends ExecutionIntent {
  workingDirectory: string;
  prompt: string;
  /** Persistent image files forwarded to backends that accept local images. */
  imagePaths?: readonly string[];
  systemInstructions?: string[];
  modelSelection: BackendModelSelection;
  resumeRef?: AgentSessionRef | null;
  /** Server-owned host identity for locating resumed conversation state. Does
   * not grant the child CC API access; ccSessionScope owns that opt-in. */
  conversationTarget?: ConversationTarget;
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
  /**
   * Server-derived filesystem-write envelope for this run (see
   * {@link fsWritePolicySchema}). Absent leaves the run unrestricted, which is
   * the default without a policy. An adapter declaring "enforced" translates
   * this onto its native mechanism; "instruction-only" delivers agent guidance.
   */
  fsWritePolicy?: FsWritePolicy;
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
