import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type {
  ConversationTurnSpec,
  TaskTurnSpec,
  ConversationTurnRequest,
  TaskTurnRequest,
  QueuedDeliveryMetadata,
} from "@/lib/conversation-core/turn/turn-spec";
import type { ConversationDurableSeed } from "./actor-input-loader";
import type { CheckpointActorProjection } from "@/lib/conversation-checkpoints/schemas";
import type {
  ConversationPersistenceMode,
  ExecutePromptInput,
  PendingConversationQuestion,
  PromptActorResult,
} from "@/lib/conversation-core/turn/types";
/**
 * Conversation machine types.
 *
 * Defines the context, events, input, output, and actor I/O types
 * for the conversation XState machine.
 */

import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type {
  ConversationStatus,
  ConversationRole,
  ForkedFrom,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type {
  DebugModeState,
  RuntimeDebugModeState,
} from "@/lib/debug-log/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { DebugCommand } from "@/lib/workflows/debug/commands";

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
  pendingQuestion: PendingConversationQuestion | null;

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
      reason: import("@/lib/conversation-core/turn/turn-spec").TurnCancelReason;
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
    }
  // A provider cost settlement that arrived outside any turn result — late
  // billing, a resume-time reconciliation, or agent-level cost no turn owns.
  // The delta joins the in-memory totals so the next derived-field sync
  // writes the new total instead of overwriting the row with a stale one.
  | { type: "COST_SETTLED"; costUsdDelta: number };

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
