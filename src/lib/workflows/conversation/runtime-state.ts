/**
 * Conversation-scoped runtime state registry for non-serializable data.
 *
 * XState snapshots must be JSON-serializable. AbortControllers, lock release
 * functions, backend runtime handles, stream emitters, etc. cannot live in
 * machine context. Instead, we store them in an external Map keyed by
 * `${projectPath}::${sessionName}::${conversationId}`.
 *
 * Lifecycle:
 * - Created when a conversation actor starts a prompt turn
 * - Cleaned up when the turn completes or the actor reaches a terminal state
 */

import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import type { AskQuestionAnswer } from "@/lib/conversations/schemas";

export interface ConversationRuntimeState {
  /** AbortController for cancelling in-flight SDK queries. */
  abortController: AbortController;

  /** Release function for the per-conversation single-flight lock. */
  releaseConversationLock?: () => void;

  /** Release function for the global query slot semaphore. */
  releaseQuerySlot?: () => void;

  /** Active backend runtime instance (reused across prompts). */
  backendRuntime?: ConversationBackendRuntime;

  /** SSE stream emit callback for the current HTTP prompt-stream response. */
  streamEmit?: (event: string, data: unknown) => void;

  /** Deferred resolver for pending AskUserQuestion. */
  activeQuestionResolver?: {
    resolve: (answers: Record<string, AskQuestionAnswer>) => void;
    reject: (reason: unknown) => void;
  };

  /** Timeout handle for prompt execution timeout. */
  timeoutHandle?: ReturnType<typeof setTimeout>;

  /** Callback to send intermediate events to the conversation machine. Registered by the manager before invoking actors. */
  sendToMachine?: (event: Record<string, unknown>) => void;

  /** Per-conversation tooling overrides injected by callers (e.g., graph workflow execution tools). Applied to backend runtime on creation. */
  tooling?: ConversationToolingOverrides;

  /** When true, prepareTurnForMachine skips conversation lock acquisition. Used by validator agents whose runtime lifetime is owned by a parent conversation. */
  skipConversationLock?: boolean;

  /** When true, the current turn was started in autonomous mode; the
   * AskUserQuestion MCP tool returns a denial result instead of blocking. */
  currentTurnAutonomous?: boolean;

  /** Stable id of the visible user message that produced the current turn. */
  currentTurnMessageId?: string;
}

const GLOBAL_KEY = "__cc_conversation_runtime_state" as const;

function getRegistry(): Map<string, ConversationRuntimeState> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, ConversationRuntimeState>();
  }
  return g[GLOBAL_KEY] as Map<string, ConversationRuntimeState>;
}

/** Build a consistent key for a conversation runtime instance. */
export function conversationRuntimeKey(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): string {
  return `${projectPath}::${sessionName}::${conversationId}`;
}

/** Register runtime state for a conversation. */
export function registerConversationRuntime(
  key: string,
  state: ConversationRuntimeState,
): void {
  getRegistry().set(key, state);
}

/** Retrieve runtime state for a conversation. */
export function getConversationRuntime(
  key: string,
): ConversationRuntimeState | undefined {
  return getRegistry().get(key);
}

/** Remove runtime state, abort in-flight operations, and release resources. */
export function cleanupConversationRuntime(key: string): void {
  const state = getRegistry().get(key);
  if (state) {
    state.abortController.abort();
    state.releaseConversationLock?.();
    state.releaseQuerySlot?.();
    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
    }
    getRegistry().delete(key);
  }
}

/** Check if a conversation has active runtime state. */
export function hasConversationRuntime(key: string): boolean {
  return getRegistry().has(key);
}

/** Get all registered conversation runtime keys (for diagnostics). */
export function getRegisteredConversationKeys(): string[] {
  return [...getRegistry().keys()];
}

/**
 * Whether a conversation currently has a pending AskUserQuestion resolver
 * installed (a turn is blocked waiting for a human answer). Read by the
 * session-tools supervisor's pending-question guard so proactive recovery
 * never orphans a validly pending question.
 */
export function hasActiveQuestionResolver(key: string): boolean {
  return getRegistry().get(key)?.activeQuestionResolver !== undefined;
}

/**
 * Reject the active question resolver for a conversation, if one is installed.
 * Returns true when a pending resolver was rejected and cleared.
 */
export function rejectActiveQuestionResolver(
  key: string,
  reason: string,
): boolean {
  const state = getRegistry().get(key);
  const resolver = state?.activeQuestionResolver;
  if (!state || !resolver) return false;
  state.activeQuestionResolver = undefined;
  resolver.reject(new Error(reason));
  return true;
}

/** Reset state for testing — do not use in production. */
export function _resetForTesting(): void {
  getRegistry().clear();
}
