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
 * Follows the Ralph Loop workflow-manager.ts pattern.
 */

import { createActor, fromPromise, type Snapshot } from "xstate";
import { conversationMachine, type ConversationActorRef } from "./machine";
import type {
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
import { createLogger } from "@/lib/logging";

const logger = createLogger("conversation-manager");

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
          const { mutateConversation } = await import("@/lib/state");
          try {
            await mutateConversation(
              context.projectPath,
              context.sessionName,
              context.conversationId,
              "conversation-manager.syncDerived",
              (c) => {
                c.status = context.status;
                c.pendingQuestionId =
                  context.pendingQuestion?.questionId ?? null;
                c.pendingQuestions = context.pendingQuestion?.questions ?? null;
                c.claudeSessionId = context.claudeSessionId;
                c.transcriptPath = context.transcriptPath;
                c.totalCostUsd = context.totals.totalCostUsd;
                c.totalDurationMs = context.totals.totalDurationMs;
                c.totalTurns = context.totals.totalTurns;
                c.promptCount = context.promptCount;
                if (context.debugMode) {
                  c.debugMode = {
                    active: context.debugMode.active,
                    recording: context.debugMode.recording,
                    logFilePath: context.debugMode.logFilePath,
                    enteredAt: context.debugMode.enteredAt,
                    hypotheses: context.debugMode.hypotheses,
                    instructionsDelivered:
                      context.debugMode.instructionsDelivered,
                    phase: context.debugMode.phase,
                  };
                } else {
                  c.debugMode = null;
                }
              },
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

        void (async () => {
          const { broadcast } = await import("@/lib/sse-broadcaster");
          try {
            broadcast({
              type: "conversation-status",
              projectName: context.projectName,
              sessionName: context.sessionName,
              conversationId: context.conversationId,
              status: context.status as SSEStatus,
            });
          } catch (err) {
            logger.warn("conversation-manager.broadcast_status_failed", {
              conversationId: context.conversationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      },

      broadcastAskQuestion: ({ context }) => {
        if (!context.pendingQuestion) return;
        void (async () => {
          const { broadcast } = await import("@/lib/sse-broadcaster");
          try {
            broadcast({
              type: "ask-question",
              projectName: context.projectName,
              sessionName: context.sessionName,
              conversationId: context.conversationId,
              questionId: context.pendingQuestion!.questionId,
              questions: context.pendingQuestion!.questions,
            });
          } catch (err) {
            logger.warn("conversation-manager.broadcast_ask_failed", {
              conversationId: context.conversationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      },

      broadcastDebugModeStatus: ({ context }) => {
        void (async () => {
          const { broadcast } = await import("@/lib/sse-broadcaster");
          try {
            broadcast({
              type: "debug-mode-status",
              projectName: context.projectName,
              sessionName: context.sessionName,
              conversationId: context.conversationId,
              active: context.debugMode?.active ?? false,
              recording: context.debugMode?.recording ?? false,
            });
          } catch (err) {
            logger.warn("conversation-manager.broadcast_debug_failed", {
              conversationId: context.conversationId,
              error: err instanceof Error ? err.message : String(err),
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
          runtime.releaseSessionLock?.();
          runtime.releaseSessionLock = undefined;
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
            await import("@/lib/push-dispatcher");
          dispatchPushForConversationStatus({
            projectName: context.projectName,
            sessionName: context.sessionName,
            conversationId: context.conversationId,
            status: context.status,
          });
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

/**
 * Ensure a conversation actor exists, creating one if needed.
 * Loads conversation state from the state file to build input.
 */
export async function ensureConversationActor(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<ConversationActorRef> {
  const existing = getConversationActor(
    projectPath,
    sessionName,
    conversationId,
  );
  if (existing) return existing;

  // Load conversation state to build input
  const { readState } = await import("@/lib/state");
  const { getProjectDisplayName } = await import("@/lib/project-resolver");

  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session not found: ${sessionName}`);
  }

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  const projectName = getProjectDisplayName(projectPath);

  return startConversationActor({
    projectPath,
    projectName,
    sessionName,
    worktreePath: session.worktreePath,
    conversationId,
    createdAt: conversation.createdAt,
    forkedFrom: conversation.forkedFrom ?? null,
    role: conversation.role ?? null,
    transcriptPath: conversation.transcriptPath ?? null,
    claudeSessionId: conversation.claudeSessionId ?? null,
    promptCount: conversation.promptCount ?? 0,
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

  actor.stop();
  cleanupConversationRuntime(key);
  getActorRegistry().delete(key);
}

/**
 * Rehydrate conversation actors from persisted snapshots on startup.
 * Returns the number of actors rehydrated.
 */
export async function rehydrateConversationActors(): Promise<number> {
  const { readState } = await import("@/lib/state");
  const { getProjectDisplayName } = await import("@/lib/project-resolver");
  const { restoreConversationSnapshot } = await import("./persistence");

  const state = await readState();
  let count = 0;

  for (const [projectPath, project] of Object.entries(state.projects)) {
    for (const [sessionName, session] of Object.entries(project.sessions)) {
      for (const conversation of session.conversations) {
        if (!conversation.machineSnapshot) continue;

        const snapshot = await restoreConversationSnapshot(
          projectPath,
          sessionName,
          conversation.id,
          1, // expected schema version
        );

        if (!snapshot) continue;

        const key = conversationRuntimeKey(
          projectPath,
          sessionName,
          conversation.id,
        );

        // Skip if already running
        if (getActorRegistry().has(key)) continue;

        try {
          const projectName = getProjectDisplayName(projectPath);

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
              worktreePath: session.worktreePath,
              conversationId: conversation.id,
              createdAt: conversation.createdAt,
              forkedFrom: conversation.forkedFrom ?? null,
              role: conversation.role ?? null,
              transcriptPath: conversation.transcriptPath ?? null,
              claudeSessionId: conversation.claudeSessionId ?? null,
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
    }
  }

  if (count > 0) {
    logger.info("conversation-manager.rehydration_complete", { count });
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
