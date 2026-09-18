import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type {
  ConversationTurnSpec,
  TaskTurnSpec,
  ConversationTurnRequest,
  TaskTurnRequest,
  QueuedDeliveryMetadata,
} from "./turn-spec";
import type { ConversationDurableSeed } from "./actor-input-loader";
import type { CheckpointActorProjection } from "@/lib/conversation-checkpoints/schemas";
/**
 * Conversation machine types.
 *
 * Defines the context, events, input, output, and actor I/O types
 * for the conversation XState machine.
 */

import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type {
  AgentFailureClassification,
  ContinuationDisposition,
} from "@/lib/agent-backends/errors";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type {
  ConversationStatus,
  ConversationRole,
  ForkedFrom,
  AskQuestionItem,
  MessageContentBlock,
} from "@/lib/conversations/schemas";
import type {
  DebugModeState,
  RuntimeDebugModeState,
} from "@/lib/debug-log/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { DebugCommand } from "@/lib/workflows/debug/commands";
import type { AgentCallStructuredOutputParse } from "@/lib/workflows/primitives/agent-call-vocabulary";

/** Streaming conversation turn: a user-initiated SUBMIT_PROMPT that flows
 *  through the SDK and emits assistant messages live. `outputFormat` is set
 *  on this variant during Debug Mode phases that require a JSON response. */
export interface ConversationTurnActive extends ConversationTurnSpec {
  kind: "conversation_turn";
  startedAt: string | null;
  /** Correlates actor reports to one execution attempt. Rotated on retry. */
  executionAttemptId?: string;
  streamId: string | null;
}

/** Single-shot task run: a non-streaming, structured-output execution invoked
 *  by a downstream workflow context. */
export interface TaskRunActive extends TaskTurnSpec {
  kind: "task_run";
  startedAt: string | null;
  /** See {@link ConversationTurnActive.executionAttemptId}. */
  executionAttemptId?: string;
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
  target: ConversationTarget;

  projectPath: string;

  worktreePath: string;

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

  /**
   * The conversation's active checkpoint operation, as `{operationId, phase}`
   * only. The checkpoint repository is the authority; the manager projects it
   * here so the machine can hold ordinary admission while a checkpoint owns
   * the host, and hydration re-reads the repository rather than trusting a
   * restored snapshot. Absent from a snapshot written before this field
   * existed, so readers treat `undefined` as `null`.
   */
  checkpoint: CheckpointActorProjection | null;
}

// ============================================================
// Events
// ============================================================

export type ConversationEvent =
  | ({
      type: "SUBMIT_PROMPT";
      streamId: string | null;
      executionAttemptId?: string;
    } & ConversationTurnRequest)
  | ({ type: "SUBMIT_TASK_RUN"; executionAttemptId?: string } & TaskTurnRequest)
  | {
      type: "BACKEND_INIT";
      backendRef: AgentSessionRef;
      executionAttemptId?: string;
    }
  | { type: "ASK_QUESTION"; questionId: string; questions: AskQuestionItem[] }
  // Sent by the answer route when a pending question is consumed (answered)
  // while the asking turn is still running, so finalizingTurn's guard sees
  // null and settles to idle instead of waitingForInput.
  | { type: "CLEAR_PENDING_QUESTION"; questionId: string }
  | {
      type: "MODEL_SELECTION_RESOLVED";
      modelSelection: BackendModelSelection;
      executionAttemptId: string;
      acknowledge(): void;
      reject(error: Error): void;
    }
  | {
      type: "ABORT_TURN";
      reason: import("./turn-spec").TurnCancelReason;
      executionAttemptId?: string;
    }
  // The debug workflow's single machine entry point: the debug adapter maps
  // its lifecycle methods onto commands, and the machine applies them with
  // the pure reducer in `@/lib/workflows/debug/commands`.
  | { type: "DEBUG_COMMAND"; command: DebugCommand }
  | { type: "EXTERNAL_TURN_STARTED" }
  | { type: "EXTERNAL_TURN_COMPLETED"; result: PromptActorResult }
  // Sent only by the conversation manager under checkpoint maintenance
  // ownership; boundaries.arch.test.ts refuses the event name anywhere but
  // the manager, the machine and this union. A `ready` projection also
  // clears the retired continuation, so an actor-derived row write can never
  // restore the reference the checkpoint repository cleared in the same
  // readiness commit.
  | {
      type: "CHECKPOINT_PHASE";
      checkpoint: CheckpointActorProjection | null;
      clearContinuation?: true;
    };

// ============================================================
// Input / Output
// ============================================================

export interface ConversationInput extends Omit<
  ConversationDurableSeed,
  "debugMode"
> {
  target: ConversationTarget;

  projectPath: string;

  worktreePath: string;

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
  /**
   * The active checkpoint projection loaded from the checkpoint repository
   * before the actor starts, so a host restored during maintenance or
   * reconciliation holds ordinary admission from its first idle entry.
   * Ephemeral lanes and callers without checkpoint authority pass nothing.
   */
  checkpoint?: CheckpointActorProjection | null;
}

// ============================================================
// Actor I/O Types
// ============================================================

/** Output from the prepareTurn actor (resource acquisition). */
export interface PrepareTurnOutput {
  transcriptPath: string;
}

/**
 * The structured-output gate's bounded-repair spend on a refused turn.
 *
 * `attempts` is repair turns actually run (0 when the gate refused the first
 * answer outright); `maxAttempts` is the budget in force for that call, which
 * is the facade default unless the request declared its own.
 */
export interface StructuredOutputGateRepair {
  attempts: number;
  maxAttempts: number;
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
   * Where the shared structured-output gate found the payload it accepted.
   * Present only when the gate ran AND passed; forwarded verbatim from the
   * AgentCall outcome so callers that persist an output can record its
   * provenance without re-deriving it.
   */
  structuredOutputParse?: AgentCallStructuredOutputParse;
  /**
   * The gate's per-issue validator errors when it REFUSED the turn (each
   * prefixed with the failing instance path). Present only for a
   * `schema_validation` failure — `error` carries the same information as one
   * joined sentence, which callers that need to address individual issues
   * cannot use.
   */
  structuredOutputIssues?: string[];
  /**
   * What the gate's own bounded repair spent before refusing, and the budget it
   * was spent against. Present only for a `schema_validation` failure whose
   * details carried both. A caller reporting why an output was refused needs
   * this to distinguish "the model missed once" from "the gate re-asked and the
   * model missed again".
   */
  structuredOutputRepair?: StructuredOutputGateRepair;
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
   * Neutral classification of the failure named by `error`, as the backend
   * classified the error VALUE. Present whenever the turn failed through the
   * AgentCall boundary; absent for a clean turn and for failures projected
   * without one. Callers must prefer it over re-classifying `error`, which no
   * longer carries the facts the verdict was made from (an undelivered prompt,
   * a provider error code).
   */
  failure?: AgentFailureClassification;
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
  executionAttemptId?: string;
  turn: ConversationTurnSpec;
  /**
   * The runtime's construction-time persistence choice, threaded from
   * {@link ConversationInput.persistence} into every invoked actor so an actor
   * running for a synthetic (`ephemeral`) lane cannot perform a durable
   * state-store write. Required (no default) so a newly added actor input must
   * decide, exactly like the runtime constructor.
   */
  persistence: ConversationPersistenceMode;
  target: ConversationTarget;

  projectPath: string;

  worktreePath: string;

  transcriptPath: string;
  agentBackend: AgentBackendId;
  backendRef: AgentSessionRef | null;
  /** Completed prior turns. A fresh runtime with `promptCount > 0` but no
   *  `backendRef` cannot resume — the agent starts with no memory of the
   *  transcript, which is worth a loud log signal. */
  promptCount: number;
  forkedFrom: ForkedFrom;
  role: ConversationRole;
  streamId: string | null;
  /**
   * The manager's checkpoint projection at dispatch. A `ready` projection
   * makes this turn the checkpoint's delivery: a fresh runtime with no resume
   * handle, seeded from the frozen payload ahead of the user's input. Absent
   * or null for every other turn.
   */
  checkpoint?: CheckpointActorProjection | null;
  /** Report the final admitted selection before provider dispatch so the
   *  machine can make restart replay independent of mutable defaults. */
  onModelSelectionResolved(
    modelSelection: BackendModelSelection,
  ): Promise<void>;
  debugMode: ConversationContext["debugMode"];
}

/** Input for the prepareTurn actor (resource acquisition). */
export interface PrepareTurnInput {
  executionAttemptId?: string;
  /** Construction-time persistence choice (see {@link ExecutePromptInput.persistence}). */
  persistence: ConversationPersistenceMode;
  projectPath: string;
  target: ConversationTarget;

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
  executionAttemptId?: string;
  turn: TaskTurnSpec;
  /** Construction-time persistence choice (see {@link ExecutePromptInput.persistence}). */
  persistence: ConversationPersistenceMode;
  projectPath: string;
  target: ConversationTarget;
  role: ConversationRole;

  worktreePath: string;

  agentBackend: AgentBackendId;
  /** Persisted backend session ref captured by prior turns on this actor.
   *  Forwarded to the runner as `resumeRef` to preserve Codex thread
   *  continuity / Claude session continuity across calls. */
  backendRef: AgentSessionRef | null;
  /** See {@link ExecutePromptInput.onModelSelectionResolved}. */
  onModelSelectionResolved(
    modelSelection: BackendModelSelection,
  ): Promise<void>;
}

/** Attempt-scoped finalization preserves the claim until dispatch has stopped. */
export interface FinalizeQueuedDeliveryInput {
  projectPath: string;
  target: ConversationTarget;

  persistence: ConversationInput["persistence"];
  queuedDelivery: QueuedDeliveryMetadata;
}

export interface SettleTurnInput extends Omit<
  FinalizeQueuedDeliveryInput,
  "queuedDelivery"
> {
  executionAttemptId?: string;
  queuedDelivery?: QueuedDeliveryMetadata;
}
