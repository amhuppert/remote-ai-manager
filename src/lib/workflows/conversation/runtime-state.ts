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

import type { WorkflowLaneIdentity } from "@/lib/agent-backends/conversation";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import type { CheckpointOperation } from "@/lib/conversation-checkpoints/schemas";
import { ManagedConversationRuntime } from "./runtime-binding";
import type { TurnAttempt } from "./turn-attempt";
import type { ConversationEvent } from "./types";

/**
 * A checkpoint operation's ownership of one host, held by the conversation
 * manager from reservation until the operation reaches a safe outcome. While
 * present, ordinary admission, queue drain, rebind and stop wait on it; a
 * reconciliation hold keeps it present until an explicit repair releases it.
 * Only the manager sets or clears `runtime.maintenance`; every other reader
 * treats its presence as the hold and never settles, aborts or releases it.
 */
export interface ConversationCheckpointMaintenance {
  readonly requestId: string;
  /** Null until the repository admitted the operation. */
  operationId: string | null;
  /**
   * The recovery-required operation this build supersedes, or null for an
   * ordinary checkpoint. A failed or cancelled recovery build hands the host
   * back to it: `operationId` is re-pointed at it and the hold stays.
   */
  readonly recovers: string | null;
  /**
   * Whether the owned close may retry a recorded close failure through
   * `ManagedConversationRuntime.reconcileClose()`. Only a reconcile or a
   * recovery does; an ordinary checkpoint never reopens a failed close.
   */
  readonly retryClose: boolean;
  /**
   * The in-process progression, not the durable operation phase the
   * repository owns: `publishing` spans the actor's `ready` projection until
   * its row and snapshot receipts settle and the hold is released;
   * `reconciling` spans an explicit reconcile's deterministic repair.
   */
  phase:
    | "reserving"
    | "building"
    | "retiring"
    | "publishing"
    | "reconciling"
    | "needs_reconciliation"
    | "persistence_failed";
  /**
   * Whether the operation's outcome reached the repository. `undurable` means
   * the outcome write itself failed: the durable phase still says what the
   * operation was doing, nothing may treat the work as finished, and only the
   * reconcile owner or a restart may release the host.
   */
  outcome: "pending" | "durable" | "undurable";
  /** Cancels a build that has not frozen its payload; ignored afterwards. */
  readonly controller: AbortController;
  /**
   * Settles with the operation's durable outcome — or null when admission was
   * refused before an operation existed. Never rejects, so disposal can wait
   * on it unconditionally.
   */
  readonly work: Promise<CheckpointOperation | null>;
  /** Resolves when ordinary admission may resume. */
  readonly released: Promise<void>;
}

export interface ConversationRuntimeState {
  attempt?: TurnAttempt;
  /** Checkpoint maintenance that owns this host; see `ConversationCheckpointMaintenance`. */
  maintenance?: ConversationCheckpointMaintenance;
  /**
   * Every queue drain in flight for this host. A checkpoint reservation
   * yields to all of them: each drain's claim finishes and its submission or
   * command dispatch completes before the checkpoint observes the host, so a
   * claimed batch is never bounced back to pending or dispatched under
   * maintenance. A set, because drains overlap — a nudge that finds the
   * queue already claimed finishes at once while the earlier drain is still
   * dispatching.
   */
  readonly queueDrains: Set<Promise<void>>;
  stopping?: Promise<void>;
  stopFailure?: unknown;
  disposing?: boolean;
  command?: Promise<unknown>;
  reconciliation?: Promise<void>;
  durabilityFailure?: {
    context: import("./types").ConversationContext;
    error: unknown;
    attempt?: TurnAttempt;
  };
  admission?: {
    token: symbol;
    settled: Promise<void>;
    cancelled: boolean;
    cancel(): void;
    release(): void;
  };

  /** AbortController for cancelling in-flight SDK queries. */
  abortController: AbortController;

  /** Release function for the per-conversation single-flight lock. */
  releaseConversationLock?: () => void;

  /** Release function for the global query slot semaphore. */
  releaseQuerySlot?: () => void;

  /** Backend lifetime owned by this host. */
  managed: ManagedConversationRuntime;

  /** SSE stream emit callback for the current HTTP prompt-stream response. */
  streamEmit?: (event: string, data: unknown) => void;

  /** Timeout handle for prompt execution timeout. */
  timeoutHandle?: ReturnType<typeof setTimeout>;

  /** Callback to send intermediate events to the conversation machine. Registered by the manager before invoking actors. */
  sendToMachine?(event: ConversationEvent): void;

  /** Per-conversation tooling overrides injected by callers (e.g., graph workflow execution tools). Applied to backend runtime on creation. */
  tooling?: ConversationToolingOverrides;

  /** Graph-workflow lane identity injected by the workflow engine for implementer-lane conversations. Threaded into the session env on backend runtime creation so cctl lane commands resolve their execution/context from env. */
  workflowContext?: WorkflowLaneIdentity;

  /** When true, the current turn was started in autonomous mode; interactive
   * ceremonies that need a human in the loop (e.g. session-alignment draft
   * authoring) are denied for the turn. */
  currentTurnAutonomous?: boolean;

  /** Stable id of the visible user message that produced the current turn. */
  currentTurnMessageId?: string;

  debugVerificationWork?: Set<Promise<unknown>>;

  /** Cleanup verification owned by the currently active debug session. */
  debugCleanupVerification?: {
    debugSessionId: string;
    controller: AbortController;
    completion?: Promise<unknown>;
  };
}

const GLOBAL_KEY = "__cc_conversation_runtime_state" as const;

function getRegistry(): Map<string, ConversationRuntimeState> {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: Map<string, ConversationRuntimeState>;
  };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, ConversationRuntimeState>();
  }
  return g[GLOBAL_KEY];
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
/**
 * What a caller supplies at registration; the registry adds the collections
 * every runtime owns from birth, on the same object so the caller's reference
 * stays the registered state.
 */
export type ConversationRuntimeRegistration = Omit<
  ConversationRuntimeState,
  "queueDrains"
> &
  Partial<Pick<ConversationRuntimeState, "queueDrains">>;

export function registerConversationRuntime(
  key: string,
  state: ConversationRuntimeRegistration,
): void {
  getRegistry().set(
    key,
    Object.assign(state, {
      queueDrains: state.queueDrains ?? new Set<Promise<void>>(),
    }),
  );
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
export function _resetForTesting(): void {
  getRegistry().clear();
}
