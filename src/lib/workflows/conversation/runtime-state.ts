/**
 * Conversation-scoped runtime state registry for non-serializable data.
 *
 * XState snapshots must be JSON-serializable. AbortControllers, lock release
 * functions, backend runtime handles, stream emitters, etc. cannot live in
 * machine context. Instead, we store them in an external Map keyed by
 * `${projectPath}::${sessionName}::${conversationId}`.
 *
 * Lifecycle:
 * - Registered when the manager (or rehydrator) creates a conversation actor;
 *   individual handles (locks, runtimes, stream emitters) attach per turn
 * - The machine is long-lived with zero final states, so cleanup is explicit:
 *   `cleanupConversationRuntime` runs when the actor is stopped
 *   (`stopConversationActor`, rebind, failed rehydrate), aborting in-flight
 *   work and releasing locks
 */

import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import type { ConversationEvent } from "./types";

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

  /** Timeout handle for prompt execution timeout. */
  timeoutHandle?: ReturnType<typeof setTimeout>;

  /** Callback to send intermediate events to the conversation machine. Registered by the manager before invoking actors. */
  sendToMachine?(event: ConversationEvent): void;

  /** Per-conversation tooling overrides injected by callers (e.g., graph workflow execution tools). Applied to backend runtime on creation. */
  tooling?: ConversationToolingOverrides;

  /** Graph-workflow lane identity injected by the workflow engine for implementer-lane conversations. Threaded into the session env on backend runtime creation so cctl lane commands resolve their execution/context from env. */
  workflowContext?: { executionId: string; contextId: string };

  /** When true, prepareTurnForMachine skips conversation lock acquisition. Used by validator agents whose runtime lifetime is owned by a parent conversation. */
  skipConversationLock?: boolean;

  /** When true, the current turn was started in autonomous mode; interactive
   * ceremonies that need a human in the loop (e.g. session-alignment draft
   * authoring) are denied for the turn. */
  currentTurnAutonomous?: boolean;

  /** Stable id of the visible user message that produced the current turn. */
  currentTurnMessageId?: string;

  /** Cleanup verification owned by the currently active debug session. */
  debugCleanupVerification?: {
    debugSessionId: string;
    controller: AbortController;
  };
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
    state.debugCleanupVerification?.controller.abort();
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

/** Reset state for testing — do not use in production. */
export function _resetForTesting(): void {
  getRegistry().clear();
}
