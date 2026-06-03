/**
 * Conversation XState actor lifecycle manager.
 *
 * Manages the lifecycle of conversation XState actors:
 *   - Creates actors with production implementations (.provide())
 *   - Tracks active actors in a globalThis-safe registry
 *   - Handles cleanup on terminal states
 *   - Provides event dispatch for API routes
 *   - Wires runtime state (sendToMachine, stream callbacks)
 *
 * Follows the standard workflow-manager pattern.
 */

import { createActor, fromPromise, type Snapshot } from "xstate";
import { conversationMachine, type ConversationActorRef } from "./machine";
import type {
  ConversationContext,
  ConversationInput,
  ConversationEvent,
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
} from "./types";
import {
  conversationRuntimeKey,
  registerConversationRuntime,
  getConversationRuntime,
  cleanupConversationRuntime,
} from "./runtime-state";
import { persistConversationSnapshot } from "./persistence";
import {
  getRuntime as getRuntimeFromRegistry,
  unregisterRuntime,
} from "@/lib/agent-backends/runtime-registry";
import { createLogger } from "@/lib/logging";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState } from "@/lib/projects/schemas";
import {
  PROJECT_CONVERSATION_SESSION_SENTINEL,
  conversationEventScopeFields,
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
const logger = createLogger("conversation-manager");

export interface EnsureActorInputData {
  projectName: string;
  sessionWorktreePath: string;
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

function getMachineFactory(): MachineFactory {
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

function getActorRegistry(): Map<string, ConversationActorRef> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, ConversationActorRef>();
  }
  return g[GLOBAL_KEY] as Map<string, ConversationActorRef>;
}

// ============================================================
// Machine Provider (injects production actors + actions)
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
    };
  } else {
    c.debugMode = null;
  }
}

function createProvidedMachine() {
  return conversationMachine.provide({
    actors: {
      prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
        async ({ input }) => {
          const { prepareTurnForMachine } =
            await import("./actor-implementations");
          return prepareTurnForMachine(input);
        },
      ),
      executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          const { executePromptForMachine } =
            await import("./actor-implementations");
          return executePromptForMachine(input);
        },
      ),
    },

    actions: {
      persistSnapshot: ({ context, self }) => {
        try {
          const snapshot = self.getPersistedSnapshot();
          persistConversationSnapshot(
            context.projectPath,
            context.sessionName,
            context.conversationId,
            snapshot as Snapshot<unknown>,
          );
        } catch {
          // fire-and-forget — snapshot persistence should not halt the machine
        }
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
              error: err instanceof Error ? err.message : String(err),
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

        void (async () => {
          const { publishSessionStatus } =
            await import("@/lib/workflows/primitives/default-session-status-bus");
          const outcome = publishSessionStatus({
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
        })();
      },

      broadcastAskQuestion: ({ context }) => {
        if (!context.pendingQuestion) return;
        void (async () => {
          const { publishSessionStatus } =
            await import("@/lib/workflows/primitives/default-session-status-bus");
          const outcome = publishSessionStatus({
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
        })();
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
            const { publishSessionStatus } =
              await import("@/lib/workflows/primitives/default-session-status-bus");
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
              { mutateConversation, publishSessionStatus },
            );
          } catch (err) {
            logger.warn("conversation-manager.mark_unread_failed", {
              conversationId: context.conversationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      },

      markReadOnUserTurnStart: ({ context }) => {
        void (async () => {
          try {
            const { mutateConversation } = await import("@/lib/state-store");
            const { publishSessionStatus } =
              await import("@/lib/workflows/primitives/default-session-status-bus");
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
              { mutateConversation, publishSessionStatus },
            );
          } catch (err) {
            logger.warn("conversation-manager.mark_read_failed", {
              conversationId: context.conversationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
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
    runtime.sendToMachine = (event: Record<string, unknown>) => {
      actor.send(event as unknown as ConversationEvent);
    };
  }

  // Subscribe to state changes for terminal cleanup
  actor.subscribe((snapshot) => {
    if (snapshot.status === "done") {
      logger.info("conversation-manager.actor_terminal", {
        conversationId: input.conversationId,
        status: snapshot.output?.status,
      });

      // Flush final snapshot immediately
      try {
        const persisted = actor.getPersistedSnapshot();
        persistConversationSnapshot(
          input.projectPath,
          input.sessionName,
          input.conversationId,
          persisted as Snapshot<unknown>,
          { immediate: true },
        );
      } catch {
        // best effort
      }

      cleanupConversationRuntime(key);
      getActorRegistry().delete(key);
    }
  });

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

function isActorIdle(actor: ConversationActorRef): boolean {
  return actor.getSnapshot().value === "idle";
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
    executionTarget?: ExecutionTarget;
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
    if (!isActorIdle(existing)) {
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
    projectPath,
    projectName: data.projectName,
    sessionName,
    worktreePath,
    conversationId,
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

/**
 * Decide whether a persisted conversation snapshot is worth restoring into a
 * live actor at startup.
 *
 * The only machine state that can meaningfully resume across a process
 * boundary is "waiting for a permission answer" — i.e. `pendingQuestion` is
 * set in context. A user can still answer that question after a restart, and
 * the actor needs to be live to receive the event.
 *
 * Every other snapshot shape (idle, executing.*, acquiringResources, debug.*,
 * externalExecuting, etc.) is non-resumable: the underlying invoked actor
 * (SDK stream, subprocess) is dead, so the in-machine state is stale. A fresh
 * actor created lazily by `ensureConversationActor` is functionally
 * equivalent — `applySyncDerivedFields` will overwrite any stale
 * `ConversationState.status` ("running"/"waiting_for_input") on the next
 * machine event.
 */
export function shouldRehydrateSnapshot(snapshot: Snapshot<unknown>): boolean {
  if (snapshot.status !== "active") return false;
  const context = (snapshot as { context?: { pendingQuestion?: unknown } })
    .context;
  return context?.pendingQuestion != null;
}

/**
 * A conversation eligible for snapshot rehydration. Session conversations bind
 * to their owning session's worktree; session-less project conversations key on
 * the sentinel session name and bind to the project's repo-root worktree.
 */
export interface RehydrationCandidate {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  conversation: ConversationState;
}

/**
 * Flatten session conversations and session-less project conversations into a
 * single rehydration candidate list. Pure — directly unit-testable.
 */
export function collectRehydrationCandidates(
  state: ManagerState,
  projectConversations: ReadonlyArray<{
    projectPath: string;
    conversation: ConversationState;
  }>,
): RehydrationCandidate[] {
  const candidates: RehydrationCandidate[] = [];
  for (const [projectPath, project] of Object.entries(state.projects)) {
    for (const [sessionName, session] of Object.entries(project.sessions)) {
      for (const conversation of session.conversations) {
        candidates.push({
          projectPath,
          sessionName,
          worktreePath: session.worktreePath,
          conversation,
        });
      }
    }
  }
  for (const { projectPath, conversation } of projectConversations) {
    candidates.push({
      projectPath,
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      worktreePath: projectPath,
      conversation,
    });
  }
  return candidates;
}

export interface RehydrateConversationActorsDeps {
  readState(): Promise<ManagerState>;
  listAllProjectConversations(): Promise<
    { projectPath: string; conversation: ConversationState }[]
  >;
  getProjectDisplayName(projectPath: string): string;
  validateRestoredSnapshot(
    raw: unknown,
    conversationId: string,
    expectedSchemaVersion: number,
  ): Snapshot<unknown> | null;
}

async function defaultRehydrateDeps(): Promise<RehydrateConversationActorsDeps> {
  const stateMod = await import("@/lib/state-store");
  const { getProjectDisplayName } = await import("@/lib/projects/resolver");
  const { validateRestoredSnapshot } = await import("./persistence");
  return {
    readState: stateMod.readState,
    listAllProjectConversations: stateMod.listAllProjectConversations,
    getProjectDisplayName,
    validateRestoredSnapshot,
  };
}

/**
 * Rehydrate conversation actors from persisted snapshots on startup — across
 * both session conversations and session-less project conversations.
 * Returns the number of actors rehydrated.
 */
export async function rehydrateConversationActors(
  deps?: RehydrateConversationActorsDeps,
): Promise<number> {
  const resolved = deps ?? (await defaultRehydrateDeps());
  const [state, projectConversations] = await Promise.all([
    resolved.readState(),
    resolved.listAllProjectConversations(),
  ]);

  let count = 0;
  let skippedNonResumable = 0;

  for (const {
    projectPath,
    sessionName,
    worktreePath,
    conversation,
  } of collectRehydrationCandidates(state, projectConversations)) {
    if (!conversation.machineSnapshot) continue;

    const snapshot = resolved.validateRestoredSnapshot(
      conversation.machineSnapshot,
      conversation.id,
      1, // expected schema version
    );

    if (!snapshot) continue;

    if (!shouldRehydrateSnapshot(snapshot)) {
      skippedNonResumable++;
      continue;
    }

    const key = conversationRuntimeKey(
      projectPath,
      sessionName,
      conversation.id,
    );

    // Skip if already running
    if (getActorRegistry().has(key)) continue;

    try {
      const projectName = resolved.getProjectDisplayName(projectPath);

      // Register runtime state
      registerConversationRuntime(key, {
        abortController: new AbortController(),
      });

      const machine = getMachineFactory()();
      // XState v5 requires `input` even when restoring from snapshot.
      // The snapshot already contains the full context, so input is
      // only used for type satisfaction — it won't override the snapshot.
      const actor = createActor(machine, {
        input: {
          projectPath,
          projectName,
          sessionName,
          worktreePath,
          conversationId: conversation.id,
          createdAt: conversation.createdAt,
          forkedFrom: conversation.forkedFrom ?? null,
          role: conversation.role ?? null,
          transcriptPath: conversation.transcriptPath ?? null,
          agentBackend: conversation.agentBackend ?? "claude",
          backendRef: conversation.backendRef ?? null,
          promptCount: conversation.promptCount ?? 0,
        },
        snapshot: snapshot as ReturnType<(typeof machine)["resolveState"]>,
      });

      getActorRegistry().set(key, actor);

      // Wire sendToMachine
      const runtime = getConversationRuntime(key);
      if (runtime) {
        runtime.sendToMachine = (event: Record<string, unknown>) => {
          actor.send(event as unknown as ConversationEvent);
        };
      }

      // Terminal cleanup subscription
      actor.subscribe((snap) => {
        if (snap.status === "done") {
          cleanupConversationRuntime(key);
          getActorRegistry().delete(key);
        }
      });

      actor.start();
      count++;

      logger.info("conversation-manager.rehydrated", {
        conversationId: conversation.id,
        sessionName,
        projectName,
      });
    } catch (err) {
      logger.error("conversation-manager.rehydrate_failed", {
        conversationId: conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Clean up partial registration
      cleanupConversationRuntime(key);
      getActorRegistry().delete(key);
    }
  }

  if (count > 0 || skippedNonResumable > 0) {
    logger.info("conversation-manager.rehydration_complete", {
      count,
      skippedNonResumable,
    });
  }

  return count;
}

/** Reset for testing — clears all actors and runtime state. */
export function _resetForTesting(): void {
  for (const actor of getActorRegistry().values()) {
    actor.stop();
  }
  getActorRegistry().clear();
}
