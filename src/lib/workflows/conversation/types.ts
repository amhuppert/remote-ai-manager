/**
 * Conversation machine types.
 *
 * Defines the context, events, input, output, and actor I/O types
 * for the conversation XState machine.
 */

import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type {
  ConversationStatus,
  ConversationRole,
  ForkedFrom,
  AskQuestionItem,
  AskQuestionAnswer,
  MessageContentBlock,
  TranscriptMessageOrigin,
} from "@/lib/conversations/schemas";
import type {
  DebugHypothesis,
  DebugModePhase,
  DebugModeState,
} from "@/lib/debug-log/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { DebugCleanupResultOutput } from "./debug-schemas";

// ============================================================
// Context
// ============================================================

/** Structured-output contract attached to a turn (JSON Schema enforced by the
 *  agent SDK). Shared by both ActiveTurn variants so callers don't have to
 *  branch on `kind` when only the output format matters. */
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
  /**
   * When true the AgentCall facade's post-dispatch structured-output gate is
   * skipped for this turn. Callers that maintain their own response parser
   * (e.g. the graph-workflow validator's text/raw-JSON/fenced-JSON fallback
   * chain) opt in so a malformed structured payload does not erase the raw
   * text the caller still needs.
   */
  skipStructuredOutputGate?: boolean;
  /**
   * Provenance stamp forwarded onto the persisted assistant TranscriptMessage.
   * Workflow callers set `source: "workflow"` so a single JSONL transcript can
   * distinguish workflow-driven turns from user-driven turns without forking
   * the file. Omit on user-driven turns.
   */
  origin?: TranscriptMessageOrigin;
}

export type ActiveTurn = ConversationTurnActive | TaskRunActive;

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

  // Active turn (set when SUBMIT_PROMPT, cleared on finalize)
  activeTurn: ActiveTurn | null;

  // Pending question (AskUserQuestion)
  pendingQuestion: {
    questionId: string;
    questions: AskQuestionItem[];
  } | null;

  // Debug mode
  debugMode: {
    active: boolean;
    recording: boolean;
    logFilePath: string;
    enteredAt: string;
    hypotheses: DebugHypothesis[];
    reproductionSteps: string[];
    fixSummary: string | null;
    verificationSteps: string[];
    instructionsDelivered: boolean;
    phase: DebugModePhase;
    lastTurnFailed: boolean;
  } | null;

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
      autonomous?: boolean;
      streamId: string;
      outputFormat?: StructuredOutputFormat;
      waitForBackgroundTasks?: boolean;
      queuedDelivery?: QueuedDeliveryMetadata;
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
      skipStructuredOutputGate?: boolean;
      origin?: TranscriptMessageOrigin;
    }
  | { type: "RESOURCES_ACQUIRED"; transcriptPath: string }
  | { type: "RESOURCES_FAILED"; error: string }
  | { type: "BACKEND_INIT"; backendRef: AgentSessionRef }
  | { type: "ASK_QUESTION"; questionId: string; questions: AskQuestionItem[] }
  | {
      type: "ANSWER";
      questionId: string;
      answers: Record<string, AskQuestionAnswer>;
    }
  | { type: "PROMPT_COMPLETED"; result: PromptActorResult }
  | { type: "PROMPT_FAILED"; error: string }
  | { type: "ABORT_TURN"; reason: "timeout" | "user" | "shutdown" }
  | { type: "ENTER_DEBUG_MODE"; logFilePath: string }
  | { type: "EXIT_DEBUG_MODE" }
  | { type: "SET_DEBUG_RECORDING"; recording: boolean }
  | { type: "MARK_REPRODUCED" }
  | { type: "MARK_FIX_VERIFIED" }
  | { type: "MARK_FIX_FAILED" }
  | { type: "REVERT_TO_AWAITING_REPRODUCTION" }
  | { type: "REVERT_TO_AWAITING_VERIFICATION" }
  | { type: "RETRY_DEBUG_TURN" }
  | { type: "CLEAR_DEBUG_LOGS" }
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
   * Persisted debug-mode state to restore when the actor is recreated for
   * an existing conversation (e.g. after a server restart). When `active`
   * is true, the machine starts in the debug compound state at the
   * substate matching `phase`, with context fields hydrated.
   */
  debugMode?: DebugModeState | null;
}

export interface ConversationOutput {
  conversationId: string;
  status: ConversationStatus;
  error: string | null;
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
  abortReason?: "timeout" | "user" | "shutdown";
  timeoutMs?: number;
  error: string | null;
  /**
   * Summary of the bounded background-task wait this turn performed. Present
   * only when a wait actually occurred; absent for every other turn.
   */
  backgroundWait?: BackgroundWaitSummary;
}

/** Input for the executePrompt actor. */
export interface ExecutePromptInput {
  conversationScope?: "session" | "project";
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;
  transcriptPath: string;
  agentBackend: AgentBackendId;
  backendRef: AgentSessionRef | null;
  forkedFrom: ForkedFrom;
  role: ConversationRole;
  promptText: string;
  images: ImagePayload[];
  streamId: string | null;
  modelId: string | null;
  effort: string | null;
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
}

/** Input for the prepareTurn actor (resource acquisition). */
export interface PrepareTurnInput {
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
  skipStructuredOutputGate?: boolean;
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
