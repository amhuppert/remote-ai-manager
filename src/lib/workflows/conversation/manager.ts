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
import type {
  ConversationContext,
  ConversationInput,
  ConversationEvent,
} from "./types";
import {
  conversationRuntimeKey,
  registerConversationRuntime,
  getConversationRuntime,
  cleanupConversationRuntime,
} from "./runtime-state";
import { persistSnapshotAfterTransition } from "./persistence";
import {
  getRuntime as getRuntimeFromRegistry,
  unregisterRuntime,
} from "@/lib/agent-backends/runtime-registry";
import { createLogger } from "@/lib/logging";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  conversationEventScopeFields,
  isProjectSentinel,
} from "@/lib/conversations/project-conversation-scope";
import type { DebugModeState } from "@/lib/debug-log/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type {
  ForkedFrom,
  ConversationRole,
  ActiveTurnSource,
} from "@/lib/conversations/schemas";
import type { ActiveTurn } from "./types";
import {
  drainConversationQueue,
  getConversationQueueDeps,
} from "@/lib/conversations/message-queue-drain";
import { notifyProjectConversationStatusFromContext } from "@/lib/project-conversations/status-notifications";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ImagePayload } from "@/lib/images/schemas";
import type { DocumentFeedbackPayload } from "@/lib/conversations/message-content-schemas";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";

const logger = createLogger("conversation-manager");

export interface EnsureActorInputData {
  conversationScope?: "session" | "project";
  projectName: string;
  sessionWorktreePath: string;
  /**
   * Marks the actor as a synthetic lane with no persisted ConversationState
   * record (see `ConversationContext.transient`): snapshot persistence and
   * queue draining are skipped. Leave unset for lanes whose conversations
   * exist in the state store.
   */
  transient?: boolean;
  conversation: {
    createdAt: string;
    forkedFrom: ForkedFrom;
    role: ConversationRole;
    transcriptPath: string | null;
    agentBackend: AgentBackendId;
    backendRef: AgentSessionRef | null;
    promptCount: number;
    debugMode: DebugModeState | null;
  };
}

/** Domain input for one user-facing conversation turn. Machine event names
 * and actor state topology remain private to this lifecycle module. */
export interface ConversationTurnRequest {
  promptText: string;
  images?: ImagePayload[];
  backend: AgentBackendId;
  modelId?: string;
  effort?: string;
  autonomous?: boolean;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  waitForBackgroundTasks?: boolean;
  documentFeedback?: DocumentFeedbackPayload;
  askUserQuestionsEnabled?: boolean;
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
  const { getSession } = await import("@/lib/state-store");
  const { getProjectDisplayName } = await import("@/lib/projects/resolver");

  const session = await getSession(projectPath, sessionName);
  if (!session) {
    throw new Error(`Session not found: ${sessionName}`);
  }

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  return {
    conversationScope: "session",
    projectName: getProjectDisplayName(projectPath),
    sessionWorktreePath: session.worktreePath,
    conversation: {
      createdAt: conversation.createdAt,
      forkedFrom: conversation.forkedFrom ?? null,
      role: conversation.role ?? null,
      transcriptPath: conversation.transcriptPath ?? null,
      agentBackend: conversation.agentBackend ?? "claude",
      backendRef: conversation.backendRef ?? null,
      promptCount: conversation.promptCount ?? 0,
      debugMode: conversation.debugMode?.active ? conversation.debugMode : null,
    },
  };
}

// ============================================================
// Machine Factory Injection
// ============================================================

type MachineFactory = () => ReturnType<typeof createProvidedMachine>;
let _machineFactory: MachineFactory | null = null;

/**
 * Resolve the machine factory (test override or production `.provide()`).
 * Exported for the rehydration module, which must restore actors onto the
 * same machine the manager starts fresh actors with.
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
 * Classify the active turn as user- or workflow-driven, or null when no turn
 * is active. `task_run` turns are only dispatched by workflow callers, and
 * conversation_turn turns flagged `autonomous` come from graph-workflow's
 * implementer-runner — both should suppress UI affordances meant for the
 * conversation-panel user (e.g. the Stop button).
 */
export function deriveActiveTurnSource(
  activeTurn: ActiveTurn | null,
): ActiveTurnSource {
  if (!activeTurn) return null;
  if (activeTurn.kind === "task_run") return "workflow";
  return activeTurn.autonomous ? "workflow" : "user";
}

/**
 * Apply machine context fields to a mutable ConversationState.
 * Extracted as a pure function for testability.
 */
export function applySyncDerivedFields(
  context: ConversationContext,
  c: ConversationState,
): void {
  c.status = context.status;
  c.activeTurnSource = deriveActiveTurnSource(context.activeTurn);
  c.pendingQuestionId = context.pendingQuestion?.questionId ?? null;
  c.pendingQuestions = context.pendingQuestion?.questions ?? null;
  c.agentBackend = context.agentBackend;
  c.backendRef = context.backendRef;
  c.transcriptPath = context.transcriptPath;
  c.totalCostUsd = context.totals.totalCostUsd;
  c.totalDurationMs = context.totals.totalDurationMs;
  c.totalTurns = context.totals.totalTurns;
  c.contextTokens = context.totals.contextTokens;
  c.contextWindowMax = context.totals.contextWindowMax;
  c.promptCount = context.promptCount;
  if (context.debugMode) {
    c.debugMode = {
      active: context.debugMode.active,
      recording: context.debugMode.recording,
      logFilePath: context.debugMode.logFilePath,
      enteredAt: context.debugMode.enteredAt,
      hypotheses: context.debugMode.hypotheses,
      reproductionSteps: context.debugMode.reproductionSteps,
      fixSummary: context.debugMode.fixSummary,
      verificationSteps: context.debugMode.verificationSteps,
      instructionsDelivered: context.debugMode.instructionsDelivered,
      phase: context.debugMode.phase,
      lastTurnFailed: context.debugMode.lastTurnFailed,
      debugSessionId: context.debugMode.debugSessionId,
      cleanupVerificationAttempt: context.debugMode.cleanupVerificationAttempt,
    };
  } else {
    c.debugMode = null;
  }
}

function createProvidedMachine() {
  return conversationMachine.provide({
    actions: {
      persistSnapshot: ({ context, self }) => {
        persistSnapshotAfterTransition(context, self);
      },

      syncDerivedFields: ({ context }) => {
        void (async () => {
          const { mutateConversation } = await import("@/lib/state-store");
          try {
            await mutateConversation(
              context.projectPath,
              context.sessionName,
              context.conversationId,
              "conversation-manager.syncDerived",
              (c) => applySyncDerivedFields(context, c),
            );
          } catch (err) {
            logger.warn("conversation-manager.sync_derived_failed", {
              conversationId: context.conversationId,
              error: getErrorMessage(err),
            });
          }
        })();
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

        if (isProjectSentinel(context.sessionName)) {
          void notifyProjectConversationStatusFromContext(context).catch(
            (err) => {
              logger.warn("conversation-manager.project_notification_failed", {
                projectPath: context.projectPath,
                conversationId: context.conversationId,
                status: context.status,
                error: getErrorMessage(err),
              });
            },
          );
        }

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
        void (async () => {
          try {
            const { mutateConversation } = await import("@/lib/state-store");
            const { publishEvent } = await import("@/lib/events/publication");
            const { markUnreadOnFinish } =
              await import("@/lib/conversations/mark-unread");
            await markUnreadOnFinish(
              {
                projectPath: context.projectPath,
                projectName: context.projectName,
                sessionName: context.sessionName,
                conversationId: context.conversationId,
                role: context.role,
              },
              { mutateConversation, publishSessionStatus: publishEvent },
            );
          } catch (err) {
            logger.warn("conversation-manager.mark_unread_failed", {
              conversationId: context.conversationId,
              error: getErrorMessage(err),
            });
          }
        })();
      },

      markReadOnUserTurnStart: ({ context }) => {
        void (async () => {
          try {
            const { mutateConversation } = await import("@/lib/state-store");
            const { publishEvent } = await import("@/lib/events/publication");
            const { markReadOnUserTurnStart } =
              await import("@/lib/conversations/mark-unread");
            await markReadOnUserTurnStart(
              {
                projectPath: context.projectPath,
                projectName: context.projectName,
                sessionName: context.sessionName,
                conversationId: context.conversationId,
                role: context.role,
              },
              { mutateConversation, publishSessionStatus: publishEvent },
            );
          } catch (err) {
            logger.warn("conversation-manager.mark_read_failed", {
              conversationId: context.conversationId,
              error: getErrorMessage(err),
            });
          }
        })();
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

  const machine = getMachineFactory()();
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
    sessionName: input.sessionName,
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

  const requestedWorktreePath = options?.executionTarget?.worktreePath;

  if (existing) {
    if (requestedWorktreePath === undefined) {
      return existing;
    }
    const currentWorktreePath = existing.getSnapshot().context.worktreePath;
    if (currentWorktreePath === requestedWorktreePath) {
      return existing;
    }
    if (!isActorSettled(existing)) {
      logger.error("conversation-manager.execution_target_mismatch_running", {
        conversationId,
        sessionName,
        currentWorktreePath,
        requestedWorktreePath,
      });
      throw new Error(
        `Conversation actor ${conversationId} is running with worktreePath=${currentWorktreePath}; cannot rebind to executionTarget worktreePath=${requestedWorktreePath}`,
      );
    }
    logger.info("conversation-manager.execution_target_mismatch_idle_rebind", {
      conversationId,
      sessionName,
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
    conversationScope: data.conversationScope ?? "session",
    projectPath,
    projectName: data.projectName,
    sessionName,
    worktreePath,
    conversationId,
    transient: data.transient === true,
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

  try {
    const event: Extract<ConversationEvent, { type: "SUBMIT_PROMPT" }> = {
      type: "SUBMIT_PROMPT",
      promptText: input.turn.promptText,
      images: input.turn.images,
      backend: input.turn.backend,
      modelId: input.turn.modelId,
      effort: input.turn.effort,
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
    };

    if (!actor.getSnapshot().can(event)) {
      logger.error("conversation-manager.turn_rejected", {
        conversationId: input.conversationId,
        sessionName: input.sessionName,
        lifecycleState: actor.getSnapshot().value,
      });
      return {
        status: "rejected",
        reason: "not_ready",
        result: projectTurnResult(actor),
      };
    }

    actor.send(event);
    await input.onAccepted?.();
    try {
      await waitForTurnBoundary(actor);
      return { status: "completed", result: projectTurnResult(actor) };
    } catch (err) {
      const error = getErrorMessage(err);
      logger.error("conversation-manager.turn_failed", {
        conversationId: input.conversationId,
        sessionName: input.sessionName,
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
    sessionName,
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
  if (!actor.getSnapshot().can(event)) return false;
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
    try {
      backendRuntime.close();
    } catch (err) {
      logger.warn("conversation-manager.runtime_close_error", {
        conversationId,
        error: String(err),
      });
    }
    unregisterRuntime(conversationId);
  }

  actor.stop();
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
