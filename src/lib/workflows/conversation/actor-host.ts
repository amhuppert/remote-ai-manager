import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";

import { ManagedConversationRuntime } from "./runtime-binding";

import { createActor } from "xstate";
import { conversationMachine, type ConversationActorRef } from "./machine";
import type { ConversationInput } from "./types";
import {
  conversationRuntimeKey,
  type ConversationRuntimeRegistration,
} from "./runtime-state";
import { type ConversationPersistenceAdapter } from "./persistence-adapter";
import { createLogger } from "@/lib/logging";
import { checkpointHoldsOrdinaryAdmission } from "@/lib/conversation-checkpoints/admission";

import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";

import { getErrorMessage } from "@/lib/shared/errors";
import type { ConversationContext } from "./types";
import type { ConversationActorImplementations } from "./actor-implementations";
import { createConversationActors } from "./actors";
import type { ConversationRuntimeState } from "./runtime-state";

const logger = createLogger("conversation-manager");
export interface ConversationMachineDependencies {
  executeDebugCommand(
    address: import("./turn-spec").ConversationAddress,
    command: import("@/lib/workflows/debug/commands").DebugCommand,
  ): Promise<import("./manager").ConversationCommandOutcome>;
  verifyDebugCleanup: typeof import("@/lib/workflows/debug/cleanup-verification").runDebugCleanupVerification;
  loadActors(
    input:
      | import("./types").PrepareTurnInput
      | import("./types").ExecutePromptInput
      | import("./types").RunTaskRunInput
      | import("./types").SettleTurnInput,
  ): Promise<ConversationActorImplementations>;
  getRuntime(key: string): ConversationRuntimeState | undefined;
  drainQueue(context: ConversationContext): void;
}
export function createProvidedMachine(
  adapter: ConversationPersistenceAdapter,
  deps: ConversationMachineDependencies,
) {
  const execution = createConversationActors(deps, adapter);
  return conversationMachine.provide({
    actors: execution.actors,
    actions: {
      cancelTurn: ({ context, event }) => {
        if (event.type !== "ABORT_TURN") return;
        const runtime = deps.getRuntime(
          conversationRuntimeKey(
            context.projectPath,
            conversationTargetStoreSessionName(context.target),
            context.target.conversationId,
          ),
        );
        void runtime?.attempt?.cancel(event.reason);
      },
      cancelDebugCleanupVerification: ({ context }) => {
        const runtime = deps.getRuntime(
          conversationRuntimeKey(
            context.projectPath,
            conversationTargetStoreSessionName(context.target),
            context.target.conversationId,
          ),
        );
        runtime?.debugCleanupVerification?.controller.abort();
      },
      startDebugCleanupVerification: ({ context }) => {
        const debugSessionId = context.debugMode?.debugSessionId;
        if (!debugSessionId) return;

        const key = conversationRuntimeKey(
          context.projectPath,
          conversationTargetStoreSessionName(context.target),
          context.target.conversationId,
        );
        const runtime = deps.getRuntime(key);
        runtime?.debugCleanupVerification?.controller.abort();
        const controller = new AbortController();
        if (runtime) {
          runtime.debugCleanupVerification = { debugSessionId, controller };
        }

        const verification = Promise.resolve().then(() =>
          deps.verifyDebugCleanup({
            worktreePath: context.worktreePath,
            conversationId: context.target.conversationId,
            structuredOutput: context.lastResult?.structuredOutput,
            debugSessionId,
            attempt: context.debugMode?.cleanupVerificationAttempt ?? 0,
            signal: controller.signal,
          }),
        );
        // Exit may be queued before delivery. It waits for verification work,
        // never for a completion command that must run after exit itself.
        const completion = verification.then(() => {});
        if (runtime) {
          runtime.debugVerificationWork ??= new Set();
          runtime.debugVerificationWork.add(completion);
          runtime.debugCleanupVerification = {
            debugSessionId,
            controller,
            completion,
          };
          void completion
            .finally(() => runtime.debugVerificationWork?.delete(completion))
            .catch(() => {});
        }
        void verification
          .then(async (command) => {
            if (controller.signal.aborted || command == null) return;
            const current = deps.getRuntime(key)?.debugCleanupVerification;
            if (
              deps.getRuntime(key) !== runtime ||
              current?.controller !== controller
            )
              return;
            const outcome = await deps.executeDebugCommand(
              { projectPath: context.projectPath, target: context.target },
              command,
            );
            if (runtime?.debugCleanupVerification?.controller === controller)
              runtime.debugCleanupVerification = undefined;
            logger.debug("debug.cleanup_completion_delivered", {
              conversationId: context.target.conversationId,
              debugSessionId,
              command: command.kind,
              outcome: outcome.kind,
            });
          })
          .catch((error) =>
            logger.error("debug.cleanup_verification_failed", {
              conversationId: context.target.conversationId,
              debugSessionId,
              error: getErrorMessage(error),
            }),
          );
      },
      completeTurn: ({ context }) => execution.completeTurn(context),
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

        void adapter
          .afterCommit(context, async () => {
            adapter.notifyProjectStatus(context);
            const { publishEvent } = await import("@/lib/events/publication");
            const outcome = publishEvent({
              type: "conversation-status",
              ...context.target,
              status: context.status as SSEStatus,
              ...(promptError ? { error: promptError } : {}),
            });
            if (!outcome.delivered) {
              logger.warn("conversation-manager.broadcast_status_failed", {
                conversationId: context.target.conversationId,
                error: outcome.error?.message,
              });
            }
          })
          .catch((err) => {
            logger.warn("conversation-manager.broadcast_status_failed", {
              conversationId: context.target.conversationId,
              error: getErrorMessage(err),
            });
          });
      },

      broadcastAskQuestion: ({ context }) => {
        if (!context.pendingQuestion) return;
        void adapter
          .afterCommit(context, async () => {
            const { publishEvent } = await import("@/lib/events/publication");
            const outcome = publishEvent({
              type: "ask-question",
              ...context.target,
              questionId: context.pendingQuestion!.questionId,
              questions: context.pendingQuestion!.questions,
            });
            if (!outcome.delivered) {
              logger.warn("conversation-manager.broadcast_ask_failed", {
                conversationId: context.target.conversationId,
                error: outcome.error?.message,
              });
            }
          })
          .catch((err) => {
            logger.warn("conversation-manager.broadcast_ask_failed", {
              conversationId: context.target.conversationId,
              error: getErrorMessage(err),
            });
          });
      },

      broadcastDebugModeStatus: ({ context }) => {
        void adapter.afterCommit(context, async () => {
          await adapter.whenDurable(context);
          const { getDefaultDebugAdapter } = await import("./debug-adapter");
          const outcome = getDefaultDebugAdapter().publishDebugModeStatus({
            projectName: context.target.projectName,
            sessionName: conversationTargetStoreSessionName(context.target),
            conversationId: context.target.conversationId,
            active: context.debugMode?.active ?? false,
            recording: context.debugMode?.recording ?? false,
          });
          if (!outcome.delivered) {
            logger.warn("conversation-manager.broadcast_debug_failed", {
              conversationId: context.target.conversationId,
              error: outcome.error?.message,
            });
          }
        });
      },

      releaseResources: ({ context }) => {
        const key = conversationRuntimeKey(
          context.projectPath,
          conversationTargetStoreSessionName(context.target),
          context.target.conversationId,
        );
        const runtime = deps.getRuntime(key);
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
        void adapter.afterCommit(context, async () => {
          const { dispatchPushForConversationStatus } =
            await import("@/lib/push-notification/dispatcher");
          dispatchPushForConversationStatus({
            projectName: context.target.projectName,
            sessionName: conversationTargetStoreSessionName(context.target),
            conversationId: context.target.conversationId,
            status: context.status,
            role: context.role,
          });
        });
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

      drainPendingQueue: ({ context }) => {
        // Queue delivery is only for user-interactive conversations (req 10.2);
        // workflow roles own their own turn orchestration.
        if (context.role !== null) return;
        // A checkpoint that owns this host keeps every queued message where it
        // is; the manager drains once the operation reaches a safe outcome.
        if (checkpointHoldsOrdinaryAdmission(context.checkpoint)) return;
        deps.drainQueue(context);
      },
    },
  });
}
export interface ConversationActorHostDependencies {
  registry: Map<string, ConversationActorRef>;
  registerRuntime(key: string, runtime: ConversationRuntimeRegistration): void;
  getRuntime(key: string): ConversationRuntimeState | undefined;
  removeRuntime(key: string): void;
  persistence(mode: "durable" | "ephemeral"): ConversationPersistenceAdapter;
  machine(
    adapter: ConversationPersistenceAdapter,
  ): ReturnType<typeof createProvidedMachine>;
}

export function createConversationActorHost(
  deps: ConversationActorHostDependencies,
) {
  function create(
    input: ConversationInput,
    snapshot?: ReturnType<ConversationActorRef["getPersistedSnapshot"]>,
  ): ConversationActorRef {
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    const existing = deps.registry.get(key);
    if (existing) return existing;
    deps.registerRuntime(key, {
      abortController: new AbortController(),
      managed: new ManagedConversationRuntime(input.target.conversationId),
    });
    try {
      const actor = createActor(
        deps.machine(deps.persistence(input.persistence)),
        { input, ...(snapshot ? { snapshot } : {}) },
      );
      deps.registry.set(key, actor);
      const runtime = deps.getRuntime(key);
      if (runtime) runtime.sendToMachine = (event) => actor.send(event);
      return actor;
    } catch (error) {
      deps.removeRuntime(key);
      throw error;
    }
  }
  /**
   * In-flight exclusive sections by runtime key. Actor creation, startup
   * restore and on-demand application of the checkpoint restart rules all
   * run inside one, so none of them can observe a conversation between
   * another's ownership check and its effect.
   */
  const exclusives = new Map<string, Promise<unknown>>();
  async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    let pending = exclusives.get(key);
    while (pending !== undefined) {
      await pending.catch(() => undefined);
      pending = exclusives.get(key);
    }
    const run = work();
    exclusives.set(key, run);
    try {
      return await run;
    } finally {
      if (exclusives.get(key) === run) exclusives.delete(key);
    }
  }
  return {
    create,
    /**
     * Run `work` while no other exclusive section for `key` runs. A waiter
     * that finds the section taken re-checks after the holder finishes, so a
     * failed holder never fails its waiters.
     */
    exclusive,
    start(input: ConversationInput) {
      const actor = create(input);
      actor.start();
      logger.info("conversation-manager.actor_started", {
        conversationId: input.target.conversationId,
        ...scopeRefFromStoreSessionName(
          conversationTargetStoreSessionName(input.target),
        ),
      });
      return actor;
    },
    get(key: string) {
      return deps.registry.get(key);
    },
    has(key: string) {
      return deps.registry.has(key);
    },
    entries() {
      return [...deps.registry.entries()];
    },
    remove(key: string, expected: ConversationActorRef) {
      if (deps.registry.get(key) !== expected) return;
      deps.registry.delete(key);
      deps.removeRuntime(key);
    },
  };
}
export type ConversationActorHost = ReturnType<
  typeof createConversationActorHost
>;

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
export function readUsableSnapshot(
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
