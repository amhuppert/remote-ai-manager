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
  ClaudeModel,
  EffortLevel,
  ImagePayload,
  MessageContentBlock,
} from "@/types";

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
  claudeSessionId: string | null;
  forkedFrom: ForkedFrom;
  role: ConversationRole;

  // Active turn (set when SUBMIT_PROMPT, cleared on finalize)
  activeTurn: {
    promptText: string;
    images: ImagePayload[];
    modelId: ClaudeModel | null;
    effort: EffortLevel | null;
    autonomous: boolean;
    startedAt: string | null;
    streamId: string | null;
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
    instructionsDelivered: boolean;
    phase: DebugModePhase;
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
      modelId?: ClaudeModel;
      effort?: EffortLevel;
      autonomous?: boolean;
      streamId: string;
    }
  | { type: "RESOURCES_ACQUIRED"; transcriptPath: string }
  | { type: "RESOURCES_FAILED"; error: string }
  | { type: "SDK_INIT"; sessionId: string }
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
  | { type: "CLEAR_DEBUG_LOGS" };

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
  claudeSessionId: string | null;
  promptCount: number;
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
  sessionId: string | null;
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
  claudeSessionId: string | null;
  forkedFrom: ForkedFrom;
  role: ConversationRole;
  promptText: string;
  images: ImagePayload[];
  modelId: ClaudeModel | null;
  effort: EffortLevel | null;
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
