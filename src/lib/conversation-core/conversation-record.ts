import { isInTurnQuestionId } from "@/lib/conversations/in-turn-questions";
import { queuedMessageBlocksOrdinaryAdmission } from "@/lib/conversations/message-queue-schemas";
import type { AdmittedConversationProfile } from "@/lib/conversations/profile-admission";
import type {
  AskQuestionItem,
  ConversationState,
} from "@/lib/conversations/schemas";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import {
  toPromptActorResult,
  type TurnExecutionOutcome,
} from "@/lib/conversation-core/turn/turn-result";
import type { RuntimeDebugModeState } from "@/lib/debug-log/schemas";
import {
  applyDebugCommand,
  clearDebugTurnFailure,
  type DebugCommand,
  type DebugCommandEffect,
} from "@/lib/workflows/debug/commands";
import {
  resolveDebugFinalization,
  type DebugFinalization,
  type DebugTurnOutcome,
} from "@/lib/workflows/debug/finalization";
import type { UserTurnRequest } from "./schemas";

/** The conversation row fields a core turn owns. */
export type ConversationRow = Pick<
  ConversationState,
  | "status"
  | "activeTurnSource"
  | "promptCount"
  | "lastActivityAt"
  | "backendRef"
  | "totalCostUsd"
  | "totalDurationMs"
  | "totalTurns"
  | "contextTokens"
  | "contextWindowMax"
  | "unread"
  | "pendingQuestionId"
  | "pendingQuestions"
  | "agentBackend"
  | "debugMode"
  | "turnGeneration"
>;

/**
 * New input waits while an ordinary queued delivery awaits the person's
 * review: whether the earlier work was delivered is still undecided.
 */
export const QUEUE_REVIEW_REQUIRED_MESSAGE =
  "Review queued deliveries before sending another prompt.";

/** A batch of questions an agent asks the person mid-turn. */
export interface QuestionBatch {
  questionId: string;
  questions: AskQuestionItem[];
}

/** Who asked for a turn: a person, or a workflow acting through a seat. */
export type TurnSource = "user" | "workflow";

export type Continuity =
  | { kind: "keep" }
  | { kind: "set"; ref: AgentSessionRef }
  | { kind: "clear" };

/** What one settled turn contributes to its conversation's row. */
export interface TurnSettlement {
  /** A turn that reached the backend counts, whatever its outcome. */
  counted: boolean;
  continuity: Continuity;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindowMax: number | null;
  /**
   * Why a turn that was not stopped by anyone failed, for whoever was not
   * watching; `recorded` when the transcript already explains it.
   */
  failure: { message: string; recorded: boolean } | null;
  /** What a debug turn produced, as debug finalization reads it. */
  debugOutcome: DebugTurnOutcome;
}

/** Pure: the row effect of one turn's normalized outcome. */
export function settlementOf(outcome: TurnExecutionOutcome): TurnSettlement {
  if (outcome.kind === "not_started") {
    return {
      counted: false,
      continuity: { kind: "keep" },
      costUsd: null,
      durationMs: null,
      numTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      // Nothing reached the transcript: the reason must be recorded with it.
      failure:
        outcome.reason === "configuration" && outcome.interruption === undefined
          ? { message: outcome.message, recorded: false }
          : null,
      debugOutcome: { error: outcome.message },
    };
  }
  const result = outcome.result;
  const presented = toPromptActorResult(outcome);
  const debugOutcome: DebugTurnOutcome = {
    ...(presented.structuredOutput !== undefined
      ? { structuredOutput: presented.structuredOutput }
      : {}),
    // A stopped turn failed its phase, as the conversation actor records it.
    error:
      outcome.interruption !== undefined
        ? `Aborted: ${outcome.interruption.reason}`
        : (presented.error ?? null),
  };
  if (result === null) {
    return {
      counted: true,
      continuity: { kind: "keep" },
      costUsd: null,
      durationMs: null,
      numTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      failure: null,
      debugOutcome,
    };
  }
  const call = result.outcome;
  return {
    counted: true,
    // The adapter decides whether its continuation survived the turn.
    continuity:
      result.continuationDisposition === "clear"
        ? { kind: "clear" }
        : result.backendRef !== null
          ? { kind: "set", ref: result.backendRef }
          : { kind: "keep" },
    costUsd: result.usage.costUsd ?? null,
    durationMs: result.usage.durationMs ?? null,
    numTurns:
      call.kind === "completed" || call.kind === "failed"
        ? (call.numTurns ?? null)
        : null,
    contextTokens: result.usage.contextTokens ?? null,
    contextWindowMax: result.usage.contextWindowMax ?? null,
    // The turn engine leaves a notice for a failure nobody stopped.
    failure:
      call.kind === "failed" && outcome.interruption === undefined
        ? { message: call.error.message, recorded: true }
        : null,
    debugOutcome,
  };
}

/**
 * The debug session a conversation is in, as the debug workflow's reducers
 * take it; null outside debug mode. The core mints a session identity on
 * entry, so an active session without one is a corrupt row.
 */
export function runtimeDebugMode(
  state: ConversationRow["debugMode"],
): RuntimeDebugModeState | null {
  if (state === null || !state.active) return null;
  if (state.debugSessionId === undefined)
    throw new Error("An active debug session has no identity");
  return { ...state, debugSessionId: state.debugSessionId };
}

/**
 * The backend is fixed once the conversation has run, or carries a
 * continuation (a fork's, before its own first prompt): only that backend can
 * resume it.
 */
export function backendLocked(
  row: Pick<ConversationRow, "promptCount" | "backendRef">,
): boolean {
  return row.promptCount > 0 || row.backendRef !== null;
}

/** The continuation a turn on `backend` resumes: the row's own, when it is that backend's. */
export function resumableRef(
  row: Pick<ConversationRow, "backendRef">,
  backend: ConversationState["agentBackend"],
): AgentSessionRef | null {
  return row.backendRef !== null && row.backendRef.backend === backend
    ? row.backendRef
    : null;
}

/** Pure over the row draft: the backend is chosen with the first message and fixed from then on. */
export function applyBackendAdoption(
  row: ConversationRow,
  backend: ConversationState["agentBackend"],
): void {
  if (backendLocked(row)) {
    throw new Error("Cannot change backend after prompts have been sent");
  }
  row.agentBackend = backend;
}

/**
 * Pure over the row draft: the core has taken up the conversation's next
 * turn. It shows running while the turn waits for model capacity, so a
 * person's next message goes to the queue and stop stays offered.
 */
export function applyTurnClaimed(row: ConversationRow, now: string): void {
  row.status = "running";
  row.lastActivityAt = now;
  // A collaboration that released the conversation reclaims it only if no turn was taken up since.
  row.turnGeneration += 1;
}

/** Pure over the row draft: a claim the turn never took up (no turn began) returns the row to idle. */
export function applyClaimEnded(
  row: ConversationRow,
): "waiting_for_input" | "awaiting" | null {
  if (row.status !== "running" || row.activeTurnSource !== null) return null;
  row.status = idleStatus(row);
  return row.status;
}

/**
 * Pure over the row draft: a turn starts. Any input that starts an
 * interactive turn (a message, feedback, a run's notice) supersedes a question
 * left unanswered, as the conversation actor's turn claim does.
 */
export function applyTurnBegin(
  row: ConversationRow,
  source: TurnSource,
  now: string,
): void {
  row.status = "running";
  row.activeTurnSource = source;
  row.lastActivityAt = now;
  if (source !== "user") return;
  // A new turn takes the place of a debug turn that failed.
  const debugMode = runtimeDebugMode(row.debugMode);
  if (debugMode !== null) row.debugMode = clearDebugTurnFailure(debugMode);
  // The person who starts a turn has read the conversation up to it.
  row.unread = false;
  row.pendingQuestionId = null;
  row.pendingQuestions = null;
}

/** Pure over the row draft: the agent asks; refused while another batch is pending. */
export function applyQuestionAsked(
  row: ConversationRow,
  batch: QuestionBatch,
): boolean {
  if (row.pendingQuestionId !== null) return false;
  row.status = "waiting_for_input";
  row.pendingQuestionId = batch.questionId;
  row.pendingQuestions = batch.questions;
  return true;
}

/** With no question pending: running while a turn is, idle otherwise. */
export function statusWithoutQuestion(
  row: ConversationRow,
): "running" | "awaiting" {
  return row.activeTurnSource !== null ? "running" : "awaiting";
}

/** Without a turn: still waiting on an unanswered question, or idle. */
function idleStatus(row: ConversationRow): "waiting_for_input" | "awaiting" {
  return row.pendingQuestionId !== null ? "waiting_for_input" : "awaiting";
}

/**
 * Pure over the row draft: the named question was answered or withdrawn. An
 * answer's enqueue may already have consumed the marker; only another
 * question's marker refuses.
 */
export function applyQuestionCleared(
  row: ConversationRow,
  questionId: string,
): boolean {
  if (row.pendingQuestionId !== null && row.pendingQuestionId !== questionId)
    return false;
  row.pendingQuestionId = null;
  row.pendingQuestions = null;
  if (row.status === "waiting_for_input")
    row.status = statusWithoutQuestion(row);
  return true;
}

/** Pure over the row draft: the person stopped the conversation; any question pending is moot. */
export function applyQuestionWithdrawn(row: ConversationRow): boolean {
  if (row.pendingQuestionId === null) return false;
  row.pendingQuestionId = null;
  row.pendingQuestions = null;
  row.status = statusWithoutQuestion(row);
  return true;
}

/**
 * Pure over the row draft: a restart ended the turn. A durable question it
 * asked (cctl ask) can still be answered; one asked inside the turn died with
 * the turn's transport. Null, changing nothing, when the row shows no turn:
 * its turn settled the row before the restart reached its attempt.
 */
export function applyTurnInterrupted(
  row: ConversationRow,
  now: string,
): "waiting_for_input" | "awaiting" | null {
  if (row.activeTurnSource === null && row.status !== "running") return null;
  if (isInTurnQuestionId(row.pendingQuestionId)) {
    row.pendingQuestionId = null;
    row.pendingQuestions = null;
  }
  // Only the person's turns run in debug mode: the interrupted one failed its phase, and can be retried.
  const debugMode = runtimeDebugMode(row.debugMode);
  if (debugMode !== null) {
    row.debugMode = resolveDebugFinalization({
      debugMode,
      lastResult: null,
      lastError: "The server restarted while this turn was running",
    }).debugMode;
  }
  row.activeTurnSource = null;
  row.lastActivityAt = now;
  row.status = idleStatus(row);
  return row.status;
}

/** Pure over the row draft: the turn is over; idle again, or still waiting on its question. */
export function applyTurnSettlement(
  row: ConversationRow,
  settlement: TurnSettlement,
  now: string,
  source: TurnSource,
): {
  status: "waiting_for_input" | "awaiting";
  debug: DebugFinalization | null;
} {
  const status = idleStatus(row);
  row.status = status;
  row.activeTurnSource = null;
  row.lastActivityAt = now;
  // In debug mode the debug workflow decides what the person's turn meant.
  const debugMode = source === "user" ? runtimeDebugMode(row.debugMode) : null;
  const debug =
    debugMode === null
      ? null
      : resolveDebugFinalization({
          debugMode,
          lastResult: settlement.debugOutcome,
          lastError: null,
        });
  if (debug !== null) row.debugMode = debug.debugMode;
  // Control returns to the person, who may not have watched the turn finish;
  // in debug mode only a phase advance asks for them.
  if (source === "user")
    row.unread = debug === null || debug.kind === "advance";
  if (settlement.continuity.kind === "set")
    row.backendRef = settlement.continuity.ref;
  if (settlement.continuity.kind === "clear") row.backendRef = null;
  if (!settlement.counted) return { status, debug };
  row.promptCount += 1;
  row.totalCostUsd = (row.totalCostUsd ?? 0) + (settlement.costUsd ?? 0);
  row.totalDurationMs =
    (row.totalDurationMs ?? 0) + (settlement.durationMs ?? 0);
  row.totalTurns = (row.totalTurns ?? 0) + (settlement.numTurns ?? 0);
  row.contextTokens = settlement.contextTokens ?? row.contextTokens;
  row.contextWindowMax = settlement.contextWindowMax ?? row.contextWindowMax;
  return { status, debug };
}

/** Pure over the row draft: a debug command, when legal in the session's phase; null leaves the row untouched. */
export function applyDebugCommandToRow(
  row: Pick<ConversationRow, "debugMode">,
  command: DebugCommand,
  now: string,
): DebugCommandEffect | null {
  const effect = applyDebugCommand(
    runtimeDebugMode(row.debugMode),
    command,
    now,
  );
  if (effect === null) return null;
  row.debugMode = effect.debugMode;
  return effect;
}

/** What settling a turn decided beyond the row's own fields. */
export interface TurnSettled {
  /** The debug workflow's reading of a person's turn in debug mode; null otherwise. */
  debug: DebugFinalization | null;
}

export interface ConversationIdentity {
  projectPath: string;
  /** The session-keyed storage name; the project sentinel for a project conversation. */
  storeSessionName: string;
  conversationId: string;
}

/** The conversation row as a core turn reads and records it. */
export interface ConversationRecordPort {
  read(identity: ConversationIdentity): Promise<{
    agentBackend: ConversationState["agentBackend"];
    backendRef: AgentSessionRef | null;
    promptCount: number;
    transcriptPath: string | null;
    debugMode: ConversationRow["debugMode"];
    /** A question the agent asked that still waits for its answer. */
    pendingQuestionId: string | null;
    /** A collaboration that holds the conversation. */
    owner: ConversationState["owner"];
  } | null>;
  /** The core took up the conversation's next turn: running from now, though it may still wait for capacity. */
  claimTurn(identity: ConversationIdentity): Promise<void>;
  /** The claimed turn is over: idle again unless a turn began (its settlement already returned the row to idle). */
  endClaim(identity: ConversationIdentity): Promise<void>;
  /** The conversation is running a turn now; published to every client. */
  beginTurn(identity: ConversationIdentity, source: TurnSource): Promise<void>;
  /** Settles the conversation's profile for this turn: locked from now on, bound to what the agent runs as. */
  admitProfile(
    identity: ConversationIdentity,
  ): Promise<AdmittedConversationProfile>;
  /** A conversation that has not run yet takes the backend its first message chose. */
  adoptBackend(
    identity: ConversationIdentity,
    backend: ConversationState["agentBackend"],
  ): Promise<void>;
  /** The backend announced a continuation mid-turn: a restart must still be able to resume it. */
  recordContinuity(
    identity: ConversationIdentity,
    ref: AgentSessionRef,
  ): Promise<void>;
  /**
   * A person's message will not start (a restart dropped it, or a hold stopped
   * it): the whole message goes back to them for review, to send again or
   * discard, saying why. Repeatable for one `cause`, which a crash mid-recovery
   * replays.
   */
  recordWithdrawn(
    identity: ConversationIdentity,
    unsent: { cause: string; request: UserTurnRequest; reason: string },
  ): Promise<void>;
  /** A restart interrupted this conversation's turn: idle again, with a notice explaining why. */
  recordInterrupted(identity: ConversationIdentity): Promise<void>;
  /** Synchronous, so a stop can answer at once whether there is anything to stop. */
  hasPendingQuestion(identity: ConversationIdentity): boolean;
  /** The person stopped the conversation: its pending question is withdrawn. False when none was pending. */
  withdrawQuestion(identity: ConversationIdentity): Promise<boolean>;
  /** Applies the settlement to the row and publishes the conversation's idle status. */
  settleTurn(
    identity: ConversationIdentity,
    settlement: TurnSettlement,
    source: TurnSource,
  ): Promise<TurnSettled>;
}

/** Why the conversation row holds work back. */
export type RowHoldCode = "owned" | "queue_review" | "debug_mode";

/**
 * The admission rules the conversation row decides, the same for every entry
 * (a person's message, a queued delivery, a workflow's task, a conversation
 * command, a claim): a collaboration owns every turn but its own claim;
 * queued deliveries awaiting review hold everything but the queue's own
 * deliveries; debug mode lets the person keep talking and holds tasks,
 * commands and claims until it ends. The queue decides itself which of its
 * deliveries review and debug mode hold.
 */
export function conversationHoldRefusal(
  row: Pick<ConversationState, "owner" | "debugMode" | "pendingQueue">,
  turn: "message" | "delivery" | "task" | "command" | "claim",
): { code: RowHoldCode; message: string } | null {
  if (row.owner !== null && turn !== "claim") {
    return {
      code: "owned",
      message: `A collaboration (workflow "${row.owner.workflowId}") holds this conversation; send your message once it ends, or stop it`,
    };
  }
  if (turn === "delivery") return null;
  if (row.pendingQueue.some(queuedMessageBlocksOrdinaryAdmission)) {
    return { code: "queue_review", message: QUEUE_REVIEW_REQUIRED_MESSAGE };
  }
  if (row.debugMode?.active === true && turn !== "message") {
    return { code: "debug_mode", message: "Exit debug mode first" };
  }
  return null;
}
