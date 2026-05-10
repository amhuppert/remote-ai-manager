/**
 * Conversation machine types.
 *
 * Defines the context, events, input, output, and actor I/O types
 * for the conversation XState machine.
 */

import type {
  ConversationStatus,
  ConversationRole,
  ForkedFrom,
  AskQuestionItem,
  DebugHypothesis,
  DebugModePhase,
  DebugModeState,
  ImagePayload,
  MessageContentBlock,
  AgentBackendId,
  AgentSessionRef,
} from "@/types";
import type { DebugCleanupResultOutput } from "./debug-schemas";

// ============================================================
// Context
// ============================================================

export interface ConversationContext {
  _schemaVersion: 1;

  // Identity
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
  activeTurn: {
    promptText: string;
    images: ImagePayload[];
    backend: AgentBackendId;
    modelId: string | null;
    effort: string | null;
    autonomous: boolean;
    startedAt: string | null;
    streamId: string | null;
    outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  } | null;

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
      outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
    }
  | { type: "RESOURCES_ACQUIRED"; transcriptPath: string }
  | { type: "RESOURCES_FAILED"; error: string }
  | { type: "BACKEND_INIT"; backendRef: AgentSessionRef }
  | { type: "ASK_QUESTION"; questionId: string; questions: AskQuestionItem[] }
  | { type: "ANSWER"; questionId: string; answers: Record<string, string> }
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
  contentBlocks: MessageContentBlock[];
  structuredOutput?: unknown;
  aborted: boolean;
  error: string | null;
}

/** Input for the executePrompt actor. */
export interface ExecutePromptInput {
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
  modelId: string | null;
  effort: string | null;
  autonomous: boolean;
  debugMode: ConversationContext["debugMode"];
  outputFormat?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  };
}

/** Input for the prepareTurn actor (resource acquisition). */
export interface PrepareTurnInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
  transcriptPath: string | null;
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
