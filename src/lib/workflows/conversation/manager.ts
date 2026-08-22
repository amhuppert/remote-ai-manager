/**
 * Conversation XState actor lifecycle manager.
 *
 * Manages the lifecycle of conversation XState actors:
 *   - Creates actors with production implementations (.provide())
 *   - Tracks active actors in a globalThis-safe registry (the machine is
 *     long-lived with zero final states; actors leave the registry via
 *     explicit stop, never via terminal output)
 *   - Provides event dispatch for API routes
 *   - Wires runtime state (sendToMachine, stream callbacks)
 *
 * Follows the standard workflow-manager pattern. Queue draining lives in
 * `@/lib/conversations/message-queue-drain`, startup rehydration in
 * `./rehydration`, and project-conversation notification policy in
 * `@/lib/project-conversations/status-notifications`.
 */

import { createActor } from "xstate";
import { conversationMachine, type ConversationActorRef } from "./machine";
import type { ConversationInput, ConversationEvent } from "./types";
import {
  conversationRuntimeKey,
  registerConversationRuntime,
  getConversationRuntime,
  cleanupConversationRuntime,
} from "./runtime-state";
import {
  type ConversationPersistenceAdapter,
  resolveConversationPersistenceAdapter,
} from "./persistence-adapter";
import {
  getRuntime as getRuntimeFromRegistry,
  unregisterRuntime,
} from "@/lib/agent-backends/runtime-registry";
import { createLogger } from "@/lib/logging";
import {
  loadActorInput,
  type EnsureActorInputData,
} from "./actor-input-loader";
import { conversationEventScopeFields } from "@/lib/conversations/project-conversation-scope";
import { admitConversationProfileForTurn } from "@/lib/conversations/profile-admission";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import {
  drainConversationQueue,
  getConversationQueueDeps,
} from "@/lib/conversations/message-queue-drain";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ImagePayload } from "@/lib/images/schemas";
import type { DocumentFeedbackPayload } from "@/lib/conversations/message-content-schemas";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type { FsWritePolicy } from "@/lib/agent-backends/task";

const logger = createLogger("conversation-manager");

// The derived-field mapping lives with the persistence facet that consumes it;
// re-exported here for the manager-level tests that assert its pure behavior.
export {
  applySyncDerivedFields,
  deriveActiveTurnSource,
} from "./persistence-adapter";

export type { EnsureActorInputData };

/** Domain input for one user-facing conversation turn. Machine event names
 * and actor state topology remain private to this lifecycle module. */
export interface ConversationTurnRequest {
  promptText: string;
  images?: ImagePayload[];
  backend: AgentBackendId;
  modelId?: string;
  effort?: string;
  codexFastMode?: boolean;
  autonomous?: boolean;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  waitForBackgroundTasks?: boolean;
  documentFeedback?: DocumentFeedbackPayload;
  askUserQuestionsEnabled?: boolean;
  /**
   * Server-derived filesystem-write envelope for this turn, composed by the
   * graph-workflow implementer dispatch path. Carried explicitly through this
   * hop because absent means unrestricted: a lifecycle module that dropped it
   * would un-confine the lane without any layer reporting a failure.
   */
  fsWritePolicy?: FsWritePolicy;
}

/** Stable public projection of the completed turn. */
export interface ConversationTurnProjection {
  contextTokens: number | null;
  contextWindowMax: number | null;
  structuredOutput?: unknown;
  aborted: boolean;
  compacted: boolean;
  abortReason?: "timeout" | "stalled" | "user" | "shutdown";
  timeoutMs?: number;
  error: string | null;
  backgroundWait?: BackgroundWaitSummary;
}

export type ConversationTurnExecution =
  | { status: "completed"; result: ConversationTurnProjection }
  | {
      status: "failed";
      error: string;
      result: ConversationTurnProjection;
    }
  | {
      status: "rejected";
      reason: "not_ready";
      result: ConversationTurnProjection;
    };

export interface ExecuteConversationTurnInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  streamId: string;
  emit(event: string, data: unknown): void;
  turn: ConversationTurnRequest;
  /**
   * Workflow-owned turns serialize behind a conversation turn that is already
   * settling. Interactive sends leave this unset and retain fail-fast busy
   * semantics.
   */
  waitUntilReady?: boolean;
  /**
   * Called once the machine has accepted `SUBMIT_PROMPT`, before the turn is
   * awaited. Must not throw — callers own their failure handling.
   */
  onAccepted?(): void | Promise<void>;
}

export interface EnsureConversationActorDeps {
  loadActorInput(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<EnsureActorInputData>;
}

let _ensureActorDeps: EnsureConversationActorDeps | null = null;

export function setEnsureConversationActorDeps(
  deps: EnsureConversationActorDeps,
): void {
  _ensureActorDeps = deps;
}

export function _resetEnsureConversationActorDepsForTesting(): void {
  _ensureActorDeps = null;
}

async function defaultLoadActorInput(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<EnsureActorInputData> {
  // Dynamic so the state-store / resolver graph stays out of this module's
  // import-time cost, as it was when the loader body lived here.
  const { getSession, getProjectConversation } =
    await import("@/lib/state-store");
  const { getProjectDisplayName } = await import("@/lib/projects/resolver");

  return loadActorInput(
    { getSession, getProjectConversation, getProjectDisplayName },
    projectPath,
    sessionName,
    conversationId,
  );
}

// ============================================================
// Machine Factory Injection
// ============================================================

type MachineFactory = (
  adapter: ConversationPersistenceAdapter,
) => ReturnType<typeof createProvidedMachine>;
let _machineFactory: MachineFactory | null = null;

/**
 * Resolve the machine factory (test override or production `.provide()`). The
 * factory receives the runtime's persistence adapter so the durable-write
 * actions are wired at construction. Exported for the rehydration module, which
 * must restore actors onto the same machine the manager starts fresh actors
 * with (always durable — a persisted snapshot means a real record).
 */
export function getMachineFactory(): MachineFactory {
  return _machineFactory ?? createProvidedMachine;
}

/** Override the machine factory for testing. */
export function setMachineFactory(factory: MachineFactory): void {
  _machineFactory = factory;
}

export function _resetMachineFactoryForTesting(): void {
  _machineFactory = null;
}

// ============================================================
// Actor Registry (globalThis singleton for HMR safety)
// ============================================================

const GLOBAL_KEY = "__cc_conversation_actors" as const;

/**
 * Manager-owned live-actor registry. Exposed for the rehydration module,
 * which restores actors into the same registry; every other caller goes
 * through `getConversationActor`/`hasLiveConversationActor`.
 */
export function getActorRegistry(): Map<string, ConversationActorRef> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, ConversationActorRef>();
  }
  return g[GLOBAL_KEY] as Map<string, ConversationActorRef>;
}

// ============================================================
// Machine Provider (injects production actions)
// ============================================================

/**
 * Build the production-provided machine. The durable-side-effect actions are
 * delegated to the injected {@link ConversationPersistenceAdapter}, so this
 * block no longer imports `mutateConversation` or the state store directly —
 * the adapter (durable or ephemeral) owns every durable side effect. The
 * remaining actions publish SSE / push notifications only.
 *
 * Exported so contract tests can drive the exact production-provided machine
 * (with a chosen adapter) against a real persistence fixture, rather than
 * re-deriving the `.provide()` wiring and risking drift from production.
 */
export function createProvidedMachine(adapter: ConversationPersistenceAdapter) {
  return conversationMachine.provide({
    actions: {
      persistSnapshot: ({ context, self }) => {
        adapter.persistSnapshot(context, self);
      },

      syncDerivedFields: ({ context }) => {
        adapter.syncDerivedFields(context);
      },

      broadcastConversationStatus: ({ context }) => {
        // Only broadcast for SSE-valid status values
        const sseStatuses = [
          "running",
          "awaiting",
          "waiting_for_input",
        ] as const;
        type SSEStatus = (typeof sseStatuses)[number];
        if (!sseStatuses.includes(context.status as SSEStatus)) return;

        const promptError =
          context.lastResult?.error ?? context.lastError ?? undefined;

        // Notification persistence is a durable side effect, so it belongs to
        // the adapter — an ephemeral project-compaction lane must not insert a
        // notifications row when it settles to `awaiting`.
        adapter.notifyProjectStatus(context);

        void (async () => {
          const { publishEvent } = await import("@/lib/events/publication");
          const outcome = publishEvent({
            type: "conversation-status",
            ...conversationEventScopeFields(
              context.projectName,
              context.sessionName,
              context.conversationId,
            ),
            status: context.status as SSEStatus,
            ...(promptError ? { error: promptError } : {}),
          });
          if (!outcome.delivered) {
            logger.warn("conversation-manager.broadcast_status_failed", {
              conversationId: context.conversationId,
              error: outcome.error?.message,
            });
          }
        })().catch((err) => {
          logger.warn("conversation-manager.broadcast_status_failed", {
            conversationId: context.conversationId,
            error: getErrorMessage(err),
          });
        });
      },

      broadcastAskQuestion: ({ context }) => {
        if (!context.pendingQuestion) return;
        void (async () => {
          const { publishEvent } = await import("@/lib/events/publication");
          const outcome = publishEvent({
            type: "ask-question",
            ...conversationEventScopeFields(
              context.projectName,
              context.sessionName,
              context.conversationId,
            ),
            questionId: context.pendingQuestion!.questionId,
            questions: context.pendingQuestion!.questions,
          });
          if (!outcome.delivered) {
            logger.warn("conversation-manager.broadcast_ask_failed", {
              conversationId: context.conversationId,
              error: outcome.error?.message,
            });
          }
        })().catch((err) => {
          logger.warn("conversation-manager.broadcast_ask_failed", {
            conversationId: context.conversationId,
            error: getErrorMessage(err),
          });
        });
      },

      broadcastDebugModeStatus: ({ context }) => {
        void (async () => {
          const { getDefaultDebugAdapter } = await import("./debug-adapter");
          const outcome = getDefaultDebugAdapter().publishDebugModeStatus({
            projectName: context.projectName,
            sessionName: context.sessionName,
            conversationId: context.conversationId,
            active: context.debugMode?.active ?? false,
            recording: context.debugMode?.recording ?? false,
          });
          if (!outcome.delivered) {
            logger.warn("conversation-manager.broadcast_debug_failed", {
              conversationId: context.conversationId,
              error: outcome.error?.message,
            });
          }
        })();
      },

      releaseResources: ({ context }) => {
        const key = conversationRuntimeKey(
          context.projectPath,
          context.sessionName,
          context.conversationId,
        );
        const runtime = getConversationRuntime(key);
        if (runtime) {
          runtime.releaseConversationLock?.();
          runtime.releaseConversationLock = undefined;
          runtime.releaseQuerySlot?.();
          runtime.releaseQuerySlot = undefined;
          if (runtime.timeoutHandle) {
            clearTimeout(runtime.timeoutHandle);
            runtime.timeoutHandle = undefined;
          }
        }
      },

      dispatchPushNotification: ({ context }) => {
        void (async () => {
          const { dispatchPushForConversationStatus } =
            await import("@/lib/push-notification/dispatcher");
          dispatchPushForConversationStatus({
            projectName: context.projectName,
            sessionName: context.sessionName,
            conversationId: context.conversationId,
            status: context.status,
            role: context.role,
          });
        })();
      },

      markUnreadOnFinish: ({ context }) => {
        adapter.markUnreadOnFinish(context);
      },

      markReadOnUserTurnStart: ({ context }) => {
        adapter.markReadOnUserTurnStart(context);
      },

      triggerAutoNaming: ({ context }) => {
        adapter.triggerAutoNaming(context);
      },

      drainPendingQueue: ({ context, self }) => {
        // Queue delivery is only for user-interactive conversations (req 10.2);
        // workflow roles own their own turn orchestration.
        if (context.role !== null) return;
        void drainConversationQueue(self, context, getConversationQueueDeps());
      },
    },
  });
}

// ============================================================
// Public API
// ============================================================

/**
 * Start a new conversation actor.
 * Creates an XState actor, registers runtime state, and starts it.
 * Returns existing actor if one is already running.
 */
export function startConversationActor(
  input: ConversationInput,
): ConversationActorRef {
  const key = conversationRuntimeKey(
    input.projectPath,
    input.sessionName,
    input.conversationId,
  );

  // Return existing if already running
  const existing = getActorRegistry().get(key);
  if (existing) {
    logger.warn("conversation-manager.already_running", {
      conversationId: input.conversationId,
    });
    return existing;
  }

  // Register runtime state
  registerConversationRuntime(key, {
    abortController: new AbortController(),
  });

  const machine = getMachineFactory()(
    resolveConversationPersistenceAdapter(input.persistence),
  );
  const actor = createActor(machine, { input });

  getActorRegistry().set(key, actor);

  // Wire sendToMachine callback so actor implementations can send events
  const runtime = getConversationRuntime(key);
  if (runtime) {
    runtime.sendToMachine = (event) => {
      actor.send(event);
    };
  }

  actor.start();

  logger.info("conversation-manager.actor_started", {
    conversationId: input.conversationId,
    ...scopeRefFromStoreSessionName(input.sessionName),
  });

  return actor;
}

/**
 * Get a running conversation actor.
 */
export function getConversationActor(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): ConversationActorRef | undefined {
  const key = conversationRuntimeKey(projectPath, sessionName, conversationId);
  return getActorRegistry().get(key);
}

/**
 * Whether a live conversation actor owns this conversation. The queue route
 * uses this to decide whether it must run abandoned-delivery recovery itself
 * (no live actor owns the in-flight attempt) before evaluating cancellation.
 */
export function hasLiveConversationActor(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): boolean {
  return getActorRegistry().has(
    conversationRuntimeKey(projectPath, sessionName, conversationId),
  );
}

/**
 * The registry entry's snapshot, or null when the entry can no longer answer
 * for itself — `getSnapshot()` throws, or returns something that is not a
 * machine snapshot (no `can`, no `context`).
 *
 * The registry is a `globalThis` singleton that outlives any one module
 * instance, so an entry can predate the current build or belong to a machine
 * this process no longer recognizes. Callers reach for two things only —
 * `can(event)` to test a transition and `context` to read the binding — and an
 * entry that answers neither is not a usable actor. Returning null lets each
 * caller apply its own recovery instead of taking a `TypeError` from deep
 * inside a best-effort call.
 */
function readUsableSnapshot(
  actor: ConversationActorRef,
): ReturnType<ConversationActorRef["getSnapshot"]> | null {
  let snapshot: unknown;
  try {
    snapshot = actor.getSnapshot();
  } catch {
    return null;
  }
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const candidate = snapshot as { can?: unknown; context?: unknown };
  if (typeof candidate.can !== "function") return null;
  if (typeof candidate.context !== "object" || candidate.context === null) {
    return null;
  }
  return snapshot as ReturnType<ConversationActorRef["getSnapshot"]>;
}

/**
 * Settled = no turn is running and no invoked actor is live. `waitingForInput`
 * counts: the asking turn already finalized, only the pending question remains,
 * so the actor is as safe to drain against or stop/recreate as an idle one.
 */
export function isActorSettled(actor: ConversationActorRef): boolean {
  const value = actor.getSnapshot().value;
  return value === "idle" || value === "waitingForInput";
}

function isTurnBoundary(actor: ConversationActorRef): boolean {
  const value = actor.getSnapshot().value;
  return value === "idle" || value === "waitingForInput" || value === "debug";
}

function waitForTurnBoundary(actor: ConversationActorRef): Promise<void> {
  const initial = actor.getSnapshot();
  if (initial.status === "error") {
    return Promise.reject(new Error("Conversation lifecycle errored"));
  }
  if (initial.status === "done" || isTurnBoundary(actor)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const subscription = actor.subscribe((snapshot) => {
      if (snapshot.status === "error") {
        subscription.unsubscribe();
        reject(new Error("Conversation lifecycle errored"));
        return;
      }
      if (snapshot.status === "done" || isTurnBoundary(actor)) {
        subscription.unsubscribe();
        resolve();
      }
    });
  });
}

function waitForPromptAcceptance(
  actor: ConversationActorRef,
  event: Extract<ConversationEvent, { type: "SUBMIT_PROMPT" }>,
): Promise<void> {
  const initial = actor.getSnapshot();
  if (initial.status === "error") {
    return Promise.reject(new Error("Conversation lifecycle errored"));
  }
  if (initial.status === "done") {
    return Promise.reject(new Error("Conversation lifecycle stopped"));
  }
  if (initial.can(event)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const subscription = actor.subscribe((snapshot) => {
      if (snapshot.status === "error") {
        subscription.unsubscribe();
        reject(new Error("Conversation lifecycle errored"));
        return;
      }
      if (snapshot.status === "done") {
        subscription.unsubscribe();
        reject(new Error("Conversation lifecycle stopped"));
        return;
      }
      if (snapshot.can(event)) {
        subscription.unsubscribe();
        resolve();
      }
    });
  });
}

function projectTurnResult(
  actor: ConversationActorRef,
): ConversationTurnProjection {
  const context = actor.getSnapshot().context;
  const result = context.lastResult;
  return {
    contextTokens: context.totals.contextTokens,
    contextWindowMax: context.totals.contextWindowMax,
    structuredOutput: result?.structuredOutput,
    aborted: result?.aborted ?? false,
    compacted: result?.compacted ?? false,
    ...(result?.abortReason !== undefined
      ? { abortReason: result.abortReason }
      : {}),
    ...(result?.timeoutMs !== undefined ? { timeoutMs: result.timeoutMs } : {}),
    error: result?.error ?? context.lastError,
    ...(result?.backgroundWait !== undefined
      ? { backgroundWait: result.backgroundWait }
      : {}),
  };
}

/**
 * Ensure a conversation actor exists, creating one if needed.
 * Loads conversation state from the state file to build input.
 *
 * When `options.executionTarget` is supplied, the actor's input
 * `worktreePath` uses `executionTarget.worktreePath` instead of the session's
 * persisted worktreePath. If an actor for this conversation already exists
 * with a different worktreePath in its context, the function:
 *   - stops and recreates it when the actor is idle (safe transition); or
 *   - throws an infrastructure error when the actor is mid-turn (running),
 *     because rebinding a running turn to a different worktree would corrupt
 *     in-flight state.
 */
export async function ensureConversationActor(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  options?: {
    executionTarget?: Pick<ExecutionTarget, "worktreePath">;
    /**
     * Explicit actor input override for callers that drive transient
     * conversations not backed by a persisted CC conversation record
     * (e.g. graph-workflow validator lanes). When provided, the state-store
     * loader is bypassed and this data is used directly.
     */
    actorInput?: EnsureActorInputData;
  },
): Promise<ConversationActorRef> {
  const existing = getConversationActor(
    projectPath,
    sessionName,
    conversationId,
  );

  // Diagnostic identity (R1.3): the actor registry is session-keyed, so
  // `sessionName` is the sentinel for a project conversation.
  const scopeRef = scopeRefFromStoreSessionName(sessionName);
  const requestedWorktreePath = options?.executionTarget?.worktreePath;

  // An entry that cannot answer for itself is not reusable at all: it cannot be
  // proven to match the requested target, and it cannot be shown to be
  // mid-turn. Discard it and fall through to a fresh build — the alternative is
  // a `TypeError` that halts the whole graph-workflow execution loop on a
  // dispatch the conversation record could have served.
  const existingSnapshot = existing ? readUsableSnapshot(existing) : null;
  if (existing && existingSnapshot === null) {
    logger.warn("conversation-manager.unusable_actor_rebuilt", {
      conversationId,
      ...scopeRef,
      requestedWorktreePath: requestedWorktreePath ?? null,
    });
    stopConversationActor(
      projectPath,
      sessionName,
      conversationId,
      "unusable_actor",
    );
  } else if (existing && existingSnapshot !== null) {
    if (requestedWorktreePath === undefined) {
      return existing;
    }
    const currentWorktreePath = existingSnapshot.context.worktreePath;
    if (currentWorktreePath === requestedWorktreePath) {
      return existing;
    }
    if (!isActorSettled(existing)) {
      logger.error("conversation-manager.execution_target_mismatch_running", {
        conversationId,
        ...scopeRef,
        currentWorktreePath,
        requestedWorktreePath,
      });
      throw new Error(
        `Conversation actor ${conversationId} is running with worktreePath=${currentWorktreePath}; cannot rebind to executionTarget worktreePath=${requestedWorktreePath}`,
      );
    }
    logger.info("conversation-manager.execution_target_mismatch_idle_rebind", {
      conversationId,
      ...scopeRef,
      previousWorktreePath: currentWorktreePath,
      requestedWorktreePath,
    });
    stopConversationActor(
      projectPath,
      sessionName,
      conversationId,
      "execution_target_rebind",
    );
  }

  const data =
    options?.actorInput ??
    (await (_ensureActorDeps?.loadActorInput ?? defaultLoadActorInput)(
      projectPath,
      sessionName,
      conversationId,
    ));

  const worktreePath = requestedWorktreePath ?? data.sessionWorktreePath;

  return startConversationActor({
    conversationScope: data.conversationScope,
    projectPath,
    projectName: data.projectName,
    sessionName,
    worktreePath,
    conversationId,
    persistence: data.persistence,
    createdAt: data.conversation.createdAt,
    forkedFrom: data.conversation.forkedFrom,
    role: data.conversation.role,
    transcriptPath: data.conversation.transcriptPath,
    agentBackend: data.conversation.agentBackend,
    backendRef: data.conversation.backendRef,
    promptCount: data.conversation.promptCount,
    debugMode: data.conversation.debugMode,
  });
}

/** Ensure the lifecycle is ready without exposing its actor implementation. */
export async function ensureConversationLifecycle(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  options?: {
    executionTarget?: Pick<ExecutionTarget, "worktreePath">;
    actorInput?: EnsureActorInputData;
  },
): Promise<void> {
  await ensureConversationActor(
    projectPath,
    sessionName,
    conversationId,
    options,
  );
}

/**
 * Execute and await one conversation turn through the lifecycle module.
 * Stream ownership, machine event translation, settlement detection, and
 * result projection are intentionally hidden from prompt consumers.
 */
export async function executeConversationTurn(
  input: ExecuteConversationTurnInput,
): Promise<ConversationTurnExecution> {
  const actor = getConversationActor(
    input.projectPath,
    input.sessionName,
    input.conversationId,
  );
  if (!actor) {
    throw new Error(
      `Conversation lifecycle not found: ${input.conversationId}`,
    );
  }

  attachPromptStream(
    input.projectPath,
    input.sessionName,
    input.conversationId,
    input.streamId,
    input.emit,
  );

  // Diagnostic identity (R1.3) — see `ensureConversationActor`.
  const scopeRef = scopeRefFromStoreSessionName(input.sessionName);

  try {
    const event: Extract<ConversationEvent, { type: "SUBMIT_PROMPT" }> = {
      type: "SUBMIT_PROMPT",
      promptText: input.turn.promptText,
      images: input.turn.images,
      backend: input.turn.backend,
      modelId: input.turn.modelId,
      effort: input.turn.effort,
      codexFastMode: input.turn.codexFastMode,
      autonomous: input.turn.autonomous,
      streamId: input.streamId,
      outputFormat: input.turn.outputFormat,
      ...(input.turn.waitForBackgroundTasks
        ? { waitForBackgroundTasks: true }
        : {}),
      ...(input.turn.documentFeedback
        ? { documentFeedback: input.turn.documentFeedback }
        : {}),
      ...(input.turn.askUserQuestionsEnabled
        ? { askUserQuestionsEnabled: true }
        : {}),
      ...(input.turn.fsWritePolicy !== undefined
        ? { fsWritePolicy: input.turn.fsWritePolicy }
        : {}),
    };

    let waitedForReady = false;
    while (true) {
      const snapshot = actor.getSnapshot();
      if (!snapshot.can(event)) {
        if (input.waitUntilReady !== true) {
          logger.error("conversation-manager.turn_rejected", {
            conversationId: input.conversationId,
            ...scopeRef,
            lifecycleState: snapshot.value,
          });
          return {
            status: "rejected",
            reason: "not_ready",
            result: projectTurnResult(actor),
          };
        }
        if (!waitedForReady) {
          logger.info("conversation-manager.turn_waiting_for_ready", {
            conversationId: input.conversationId,
            ...scopeRef,
            lifecycleState: snapshot.value,
          });
        }
        waitedForReady = true;
        await waitForPromptAcceptance(actor, event);
      }

      // Settle the agent profile BEFORE the prompt reaches the actor (R8/D21).
      // Awaited, and after the acceptance check so a rejected turn does not
      // lock a profile it never ran under. Readiness is checked again after
      // this await so another turn cannot claim the actor in the gap.
      await admitConversationProfileForTurn({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      });

      if (!actor.getSnapshot().can(event)) {
        if (input.waitUntilReady === true) continue;
        logger.error("conversation-manager.turn_rejected", {
          conversationId: input.conversationId,
          ...scopeRef,
          lifecycleState: actor.getSnapshot().value,
        });
        return {
          status: "rejected",
          reason: "not_ready",
          result: projectTurnResult(actor),
        };
      }

      actor.send(event);
      break;
    }
    if (waitedForReady) {
      logger.info("conversation-manager.turn_ready_after_wait", {
        conversationId: input.conversationId,
        ...scopeRef,
      });
    }
    await input.onAccepted?.();
    try {
      await waitForTurnBoundary(actor);
      return { status: "completed", result: projectTurnResult(actor) };
    } catch (err) {
      const error = getErrorMessage(err);
      logger.error("conversation-manager.turn_failed", {
        conversationId: input.conversationId,
        ...scopeRef,
        error,
      });
      return { status: "failed", error, result: projectTurnResult(actor) };
    }
  } finally {
    detachPromptStream(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      input.streamId,
    );
  }
}

/**
 * Ensure the conversation actor is running and deliver any pending queued
 * messages now. Used to route an out-of-band enqueued turn (e.g. the /align
 * authoring turn) into a conversation that may have no in-flight turn — without
 * this the row sits `pending` because in-turn delivery has no live runtime and
 * the next-turn drain only fires on a live actor's idle entry.
 *
 * A freshly started actor drains on its startup idle entry. An actor that was
 * already registered and idle does NOT re-enter idle, so its entry-action drain
 * will not re-fire — drain it explicitly. A busy actor drains when its current
 * turn settles, so it needs no nudge here. Draining is fire-and-forget and a
 * no-op when the queue is empty, so the explicit drain is safe.
 */
export async function ensureConversationActorAndDrain(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<void> {
  const existing = getConversationActor(
    projectPath,
    sessionName,
    conversationId,
  );
  const actor = await ensureConversationActor(
    projectPath,
    sessionName,
    conversationId,
  );
  const explicitDrain = Boolean(existing) && isActorSettled(actor);
  logger.info("conversation-manager.ensure_and_drain", {
    ...scopeRefFromStoreSessionName(sessionName),
    conversationId,
    hadExistingActor: Boolean(existing),
    explicitDrain,
  });
  if (explicitDrain) {
    void drainConversationQueue(
      actor,
      actor.getSnapshot().context,
      getConversationQueueDeps(),
    );
  }
}

/**
 * Send an event to a running conversation actor.
 * Returns false if no actor exists.
 */
export function sendConversationEvent(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  event: ConversationEvent,
): boolean {
  const actor = getConversationActor(projectPath, sessionName, conversationId);
  if (!actor) return false;
  // Every caller treats a refusal as tolerable and a throw as a bug: the lane
  // answer route has already recorded the answer by the time it fires here, so
  // propagating would turn a succeeded answer into a 500 the operator reads as
  // "nothing happened". An entry that cannot be interrogated refuses exactly
  // like a dead one, and is evicted so the next ensure-and-drain rebuilds a
  // usable actor instead of finding the same broken entry.
  const snapshot = readUsableSnapshot(actor);
  if (!snapshot) {
    logger.error("conversation-manager.incompatible_snapshot", {
      conversationId,
      ...scopeRefFromStoreSessionName(sessionName),
      eventType: event.type,
    });
    stopConversationActor(
      projectPath,
      sessionName,
      conversationId,
      "incompatible_snapshot",
    );
    return false;
  }
  if (!snapshot.can(event)) return false;
  actor.send(event);
  return true;
}

/**
 * Attach a prompt stream emit callback to a conversation's runtime state.
 */
export function attachPromptStream(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  _streamId: string, // eslint-disable-line @typescript-eslint/no-unused-vars -- reserved for per-stream tracking
  emit: (event: string, data: unknown) => void,
): void {
  const key = conversationRuntimeKey(projectPath, sessionName, conversationId);
  const runtime = getConversationRuntime(key);
  if (runtime) {
    runtime.streamEmit = emit;
  }
}

/**
 * Detach a prompt stream emit callback from a conversation's runtime state.
 */
export function detachPromptStream(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  _streamId: string, // eslint-disable-line @typescript-eslint/no-unused-vars -- reserved for per-stream tracking
): void {
  const key = conversationRuntimeKey(projectPath, sessionName, conversationId);
  const runtime = getConversationRuntime(key);
  if (runtime) {
    runtime.streamEmit = undefined;
  }
}

/**
 * Stop a conversation actor.
 */
export function stopConversationActor(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  reason: string,
): void {
  const key = conversationRuntimeKey(projectPath, sessionName, conversationId);
  const actor = getActorRegistry().get(key);
  if (!actor) return;

  logger.info("conversation-manager.stopping_actor", {
    conversationId,
    reason,
  });

  // Close and unregister the backend runtime if one exists
  const backendRuntime = getRuntimeFromRegistry(conversationId);
  if (backendRuntime) {
    // Stopping an actor is a synchronous eviction — it orders no destructive
    // follow-up work — so teardown runs to completion in the background and a
    // failure is recorded instead of surfacing as an unhandled rejection.
    try {
      void backendRuntime.close().catch((err: unknown) => {
        logger.warn("conversation-manager.runtime_close_error", {
          conversationId,
          error: String(err),
        });
      });
    } catch (err) {
      logger.warn("conversation-manager.runtime_close_error", {
        conversationId,
        error: String(err),
      });
    }
    unregisterRuntime(conversationId);
  }

  // Unregistering has to happen even when the actor refuses to stop: the entry
  // being discarded is often the one that has already proved unusable, and
  // leaving it in a `globalThis` registry would make every later lookup find
  // the same broken actor with no way to evict it.
  try {
    actor.stop();
  } catch (err) {
    logger.warn("conversation-manager.actor_stop_error", {
      conversationId,
      reason,
      error: String(err),
    });
  }
  cleanupConversationRuntime(key);
  getActorRegistry().delete(key);
}

/** Reset for testing — clears all actors and runtime state. */
export function _resetForTesting(): void {
  for (const actor of getActorRegistry().values()) {
    actor.stop();
  }
  getActorRegistry().clear();
}
