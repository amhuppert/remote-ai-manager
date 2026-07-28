/**
 * Conversation machine types.
 *
 * Defines the context, events, input, output, and actor I/O types
 * for the conversation XState machine.
 */

import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type { ContinuationDisposition } from "@/lib/agent-backends/errors";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type {
  ConversationStatus,
  ConversationRole,
  ForkedFrom,
  AskQuestionItem,
  MessageContentBlock,
  TranscriptMessageOrigin,
} from "@/lib/conversations/schemas";
import type { DocumentFeedbackPayload } from "@/lib/conversations/message-content-schemas";
import type {
  DebugModeState,
  RuntimeDebugModeState,
} from "@/lib/debug-log/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { DebugCommand } from "@/lib/workflows/debug/commands";
import type { DebugCleanupResultOutput } from "./debug-schemas";

// ============================================================
// Context
// ============================================================

/** Structured-output contract attached to a turn (JSON Schema transported by
 *  the backend adapter and enforced by the shared post-turn gate). Shared by
 *  both ActiveTurn variants so callers don't have to branch on `kind` when only
 *  the output format matters. */
export interface StructuredOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

/** Marks a turn as a queued next-turn delivery: the claimed queue rows it
 *  delivers and the delivery attempt that claimed them, so the executor can
 *  confirm acceptance and mark those rows delivered under the same attempt. */
export interface QueuedDeliveryMetadata {
  messageIds: string[];
  deliveryAttemptId: string;
}

/** Streaming conversation turn: a user-initiated SUBMIT_PROMPT that flows
 *  through the SDK and emits assistant messages live. `outputFormat` is set
 *  on this variant during Debug Mode phases that require a JSON response. */
export interface ConversationTurnActive {
  kind: "conversation_turn";
  promptText: string;
  images: ImagePayload[];
  backend: AgentBackendId;
  modelId: string | null;
  effort: string | null;
  codexFastMode: boolean | null;
  autonomous: boolean;
  startedAt: string | null;
  streamId: string | null;
  outputFormat?: StructuredOutputFormat;
  /**
   * Opt-in: hold this turn open until its in-flight waitable background tasks
   * settle (or the wait times out). Set only by the graph-workflow implementer
   * runner; unset for every other turn so behavior is unchanged.
   */
  waitForBackgroundTasks?: boolean;
  /** Set only for auto-drained queued next-turn deliveries; unset for normal
   *  user-initiated turns. */
  queuedDelivery?: QueuedDeliveryMetadata;
  /** Structured document-review feedback carried with this turn. When set, the
   *  user-turn transcript records a `document_feedback` block and the
   *  agent-facing prompt text is derived from it when no explicit text was
   *  supplied. Unset for every non-feedback turn. */
  documentFeedback?: DocumentFeedbackPayload;
  /** Effective ask-user-questions availability for this turn (resolved toggle
   *  AND lane-can-ask). Set only by graph-workflow runners; selects the enabled
   *  asking-questions session-instruction variant. Unset for every other turn. */
  askUserQuestionsEnabled?: boolean;
}

/** Single-shot task run: a non-streaming, structured-output execution invoked
 *  by a downstream workflow context. */
export interface TaskRunActive {
  kind: "task_run";
  promptText: string;
  backend: AgentBackendId;
  modelId: string | null;
  effort: string | null;
  startedAt: string | null;
  outputFormat?: StructuredOutputFormat;
  systemInstructions?: string;
  tooling?: PortableMcpConfig;
  timeoutMs?: number;
  /** When set, persist this validated structured-output string field as the
   *  visible assistant text instead of the backend's schema transport text. */
  structuredOutputTextField?: string;
  /**
   * Provenance stamp forwarded onto the persisted assistant TranscriptMessage.
   * Workflow callers set `source: "workflow"` so a single JSONL transcript can
   * distinguish workflow-driven turns from user-driven turns without forking
   * the file. Omit on user-driven turns.
   */
  origin?: TranscriptMessageOrigin;
}

export type ActiveTurn = ConversationTurnActive | TaskRunActive;

/**
 * The construction-time persistence choice for a conversation runtime.
 * `durable` runs the full persistence facet (derived-field sync, snapshot
 * persistence, read/unread transitions); `ephemeral` is inert — a synthetic
 * lane with no `ConversationState` record (compaction, workflow-graph
 * validator) writes nothing to the state store. Required with no default, so a
 * runtime cannot be constructed without deciding.
 */
export type ConversationPersistenceMode = "durable" | "ephemeral";

export interface ConversationContext {
  _schemaVersion: 1;

  // Identity
  conversationScope: "session" | "project";
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;

  // Lifecycle
  createdAt: string;
  lastActivityAt: string;
  status: ConversationStatus;
  promptCount: number;
  transcriptPath: string | null;
  agentBackend: AgentBackendId;
  backendRef: AgentSessionRef | null;
  forkedFrom: ForkedFrom;
  role: ConversationRole;
  /**
   * True for synthetic lanes not backed by a persisted ConversationState
   * record (e.g. compaction's `compaction-<artifactId>` conversations).
   * Teardown skips state-store writes (snapshot persistence) and queue
   * draining for them — there is no row to write and no queue to drain.
   */
  transient?: boolean;

  // Active turn (set when SUBMIT_PROMPT, cleared on finalize)
  activeTurn: ActiveTurn | null;

  // Pending question (AskUserQuestion)
  pendingQuestion: {
    questionId: string;
    questions: AskQuestionItem[];
  } | null;

  // Debug mode
  debugMode: RuntimeDebugModeState | null;
  /** True until a generated debug-session identity reaches durable state. */
  debugGenerationNeedsPersistence?: boolean;

  // Accumulated totals
  totals: {
    totalCostUsd: number | null;
    totalDurationMs: number | null;
    totalTurns: number | null;
    contextTokens: number | null;
    contextWindowMax: number | null;
  };

  // Last turn results
  lastResult: PromptActorResult | null;
  lastError: string | null;
}

// ============================================================
// Events
// ============================================================

export type ConversationEvent =
  | {
      type: "SUBMIT_PROMPT";
      promptText: string;
      images?: ImagePayload[];
      backend?: AgentBackendId;
      modelId?: string;
      effort?: string;
      codexFastMode?: boolean;
      autonomous?: boolean;
      streamId: string;
      outputFormat?: StructuredOutputFormat;
      waitForBackgroundTasks?: boolean;
      queuedDelivery?: QueuedDeliveryMetadata;
      documentFeedback?: DocumentFeedbackPayload;
      askUserQuestionsEnabled?: boolean;
    }
  | {
      type: "SUBMIT_TASK_RUN";
      promptText: string;
      backend?: AgentBackendId;
      modelId?: string;
      effort?: string;
      outputFormat?: StructuredOutputFormat;
      systemInstructions?: string;
      tooling?: PortableMcpConfig;
      timeoutMs?: number;
      structuredOutputTextField?: string;
      origin?: TranscriptMessageOrigin;
    }
  | { type: "BACKEND_INIT"; backendRef: AgentSessionRef }
  | { type: "ASK_QUESTION"; questionId: string; questions: AskQuestionItem[] }
  // Sent by the answer route when a pending question is consumed (answered)
  // while the asking turn is still running, so finalizingTurn's guard sees
  // null and settles to idle instead of waitingForInput.
  | { type: "CLEAR_PENDING_QUESTION" }
  | { type: "PROMPT_COMPLETED"; result: PromptActorResult }
  | { type: "PROMPT_FAILED"; error: string }
  | { type: "ABORT_TURN"; reason: "timeout" | "user" | "shutdown" }
  // The debug workflow's single machine entry point: the debug adapter maps
  // its lifecycle methods onto commands, and the machine applies them with
  // the pure reducer in `@/lib/workflows/debug/commands`.
  | { type: "DEBUG_COMMAND"; command: DebugCommand }
  | { type: "EXTERNAL_TURN_STARTED" }
  | { type: "EXTERNAL_TURN_COMPLETED"; result: PromptActorResult };

// ============================================================
// Input / Output
// ============================================================

export interface ConversationInput {
  conversationScope?: "session" | "project";
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;
  createdAt: string;
  forkedFrom: ForkedFrom;
  role: ConversationRole;
  transcriptPath: string | null;
  agentBackend: AgentBackendId;
  backendRef: AgentSessionRef | null;
  promptCount: number;
  /**
   * Required construction-time persistence choice. `ephemeral` marks a
   * synthetic lane with no persisted `ConversationState` record and derives
   * {@link ConversationContext.transient}; `durable` is every real
   * conversation. No default — every runtime constructor must decide.
   */
  persistence: ConversationPersistenceMode;
  /**
   * Persisted debug-mode state to restore when the actor is recreated for
   * an existing conversation (e.g. after a server restart). When `active`
   * is true, the machine settles into the debug state with context fields
   * hydrated; the phase lives in `debugMode.phase`.
   */
  debugMode?: DebugModeState | null;
}

// ============================================================
// Actor I/O Types
// ============================================================

/** Output from the prepareTurn actor (resource acquisition). */
export interface PrepareTurnOutput {
  transcriptPath: string;
}

/** Output from the executePrompt actor. */
export interface PromptActorResult {
  backendRef: AgentSessionRef | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  /** Backend-reported per-turn token usage (forwarded from AgentCallUsageMetrics).
   *  Used by the codex continuity service to track lastTurnUsage on validator
   *  lanes. Null when the backend does not report token counts. */
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  contentBlocks: MessageContentBlock[];
  structuredOutput?: unknown;
  /**
   * Full backend-native turn transcript, forwarded from the AgentCall result.
   * Present only for completed `task_run` turns whose backend surfaced
   * intermediate items; consumed by the graph-workflow validator path.
   */
  transcript?: AgentTranscriptEntry[];
  aborted: boolean;
  /** True when the SDK auto-compacted the context at least once this turn. */
  compacted: boolean;
  abortReason?: "timeout" | "stalled" | "user" | "shutdown";
  timeoutMs?: number;
  error: string | null;
  /**
   * Whether the machine may keep falling back to its prior `backendRef` when
   * this turn surfaced none. Backend continuation policy (whether a failed
   * turn invalidates the persisted ref) is decided where the turn executed by
   * the adapter's turn result, never by backend identity in the machine.
   */
  continuationDisposition: ContinuationDisposition;
  /**
   * Summary of the bounded background-task wait this turn performed. Present
   * only when a wait actually occurred; absent for every other turn.
   */
  backgroundWait?: BackgroundWaitSummary;
}

/** Input for the executePrompt actor. */
export interface ExecutePromptInput {
  /**
   * The runtime's construction-time persistence choice, threaded from
   * {@link ConversationInput.persistence} into every invoked actor so an actor
   * running for a synthetic (`ephemeral`) lane cannot perform a durable
   * state-store write. Required (no default) so a newly added actor input must
   * decide, exactly like the runtime constructor.
   */
  persistence: ConversationPersistenceMode;
  conversationScope?: "session" | "project";
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;
  transcriptPath: string;
  agentBackend: AgentBackendId;
  backendRef: AgentSessionRef | null;
  /** Completed prior turns. A fresh runtime with `promptCount > 0` but no
   *  `backendRef` cannot resume — the agent starts with no memory of the
   *  transcript, which is worth a loud log signal. */
  promptCount: number;
  forkedFrom: ForkedFrom;
  role: ConversationRole;
  promptText: string;
  images: ImagePayload[];
  streamId: string | null;
  modelId: string | null;
  effort: string | null;
  codexFastMode: boolean | null;
  autonomous: boolean;
  debugMode: ConversationContext["debugMode"];
  outputFormat?: StructuredOutputFormat;
  /**
   * Opt-in: hold this turn open until its in-flight waitable background tasks
   * settle (or the wait times out). Forwarded to the backend turn input. Set
   * only by the graph-workflow implementer runner.
   */
  waitForBackgroundTasks?: boolean;
  /** Set only for auto-drained queued next-turn deliveries; forwarded so the
   *  executor can confirm acceptance and mark the claimed queue rows delivered.
   *  Unset for normal user-initiated turns. */
  queuedDelivery?: QueuedDeliveryMetadata;
  /** Structured document-review feedback for this turn. When set, the user-turn
   *  transcript records a `document_feedback` block and the agent-facing prompt
   *  text is derived from it when `promptText` is empty. Unset otherwise. */
  documentFeedback?: DocumentFeedbackPayload;
  /** Effective ask-user-questions availability for this turn (resolved toggle
   *  AND lane-can-ask). Selects the enabled asking-questions session-instruction
   *  variant. Set only by graph-workflow runners; unset for every other turn. */
  askUserQuestionsEnabled?: boolean;
}

/** Input for the prepareTurn actor (resource acquisition). */
export interface PrepareTurnInput {
  /** Construction-time persistence choice (see {@link ExecutePromptInput.persistence}). */
  persistence: ConversationPersistenceMode;
  projectPath: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
  transcriptPath: string | null;
}

/** Input for the runTaskRunTurn actor. Single-shot, non-streaming variant of
 *  the prompt execution path used when a downstream workflow context drives a
 *  `task_run` ActiveTurn. Carries only the fields required by the AgentCall
 *  primitive's `task_run` request; field set is intentionally narrower than
 *  ExecutePromptInput because there is no SDK streaming, no image flow, and
 *  no debug-mode context. */
export interface RunTaskRunInput {
  /** Construction-time persistence choice (see {@link ExecutePromptInput.persistence}). */
  persistence: ConversationPersistenceMode;
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;
  agentBackend: AgentBackendId;
  /** Persisted backend session ref captured by prior turns on this actor.
   *  Forwarded to the runner as `resumeRef` to preserve Codex thread
   *  continuity / Claude session continuity across calls. */
  backendRef: AgentSessionRef | null;
  promptText: string;
  modelId: string | null;
  effort: string | null;
  outputFormat?: StructuredOutputFormat;
  systemInstructions?: string;
  tooling?: PortableMcpConfig;
  timeoutMs?: number;
  /** See {@link TaskRunActive.structuredOutputTextField}. */
  structuredOutputTextField?: string;
  /** Forwarded onto the appended assistant TranscriptMessage so workflow-driven
   *  turns are distinguishable from user-driven turns in the shared JSONL. */
  origin?: TranscriptMessageOrigin;
}

/** Input for the verifyCleanup actor. */
export interface VerifyCleanupInput {
  worktreePath: string;
  conversationId: string;
  cleanup: DebugCleanupResultOutput;
}

/** Output from the verifyCleanup actor. */
export interface VerifyCleanupOutput {
  ok: boolean;
  failedConditions: string[];
  missingFiles: string[];
  remediationPrompt: string | null;
}
