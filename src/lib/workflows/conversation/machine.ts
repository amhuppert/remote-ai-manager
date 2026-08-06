/**
 * Conversation XState v5 state machine.
 *
 * Manages the conversation turn lifecycle: prompt submission, resource
 * acquisition, SDK execution, AskUserQuestion handling, and metadata
 * tracking. The machine is long-lived by design and has zero final states.
 *
 * Debug mode is an attached workflow (`src/lib/workflows/debug/`), not a
 * machine concern: API routes drive it through the `DebugAdapter`, which maps
 * lifecycle methods onto `DEBUG_COMMAND` events applied by the pure
 * `applyDebugCommand` reducer; turn outcomes are interpreted by
 * `resolveDebugFinalization`; cleanup verification runs asynchronously via
 * `runDebugCleanupVerification` and reports back as a `DEBUG_COMMAND`. The
 * machine contributes only the attachment points: the flat `debug` state
 * (which parks the conversation between debug turns without queue draining),
 * the finalize branch, and the retry re-entry into the turn spine.
 *
 * State chart:
 *
 * idle ─────────── SUBMIT_PROMPT ───────> acquiringResources
 *  │                                            │
 *  │ DEBUG_COMMAND (enter)                      │ (prepareTurn done)
 *  v                                            v
 * debug (flat; phase lives           executing (compound, invokes
 *  in context.debugMode)             executePrompt or runTaskRun;
 *  │                                 ASK_QUESTION is internal)
 *  │ SUBMIT_PROMPT /                            │
 *  │ DEBUG_COMMAND (retry_turn)  PROMPT_COMPLETED / PROMPT_FAILED / ABORT_TURN
 *  v                                            │
 * acquiringResources                            v
 *                                         finalizingTurn
 *                                               │
 *                      ┌────────────────────────┼──────────────┐
 *                      v                        v              v
 *              waitingForInput               idle            debug
 *            (pendingQuestion set;        (default)     (debugMode active)
 *             drains queue on entry;
 *             any turn claim clears
 *             the question)
 */

import { randomUUID } from "node:crypto";
import { setup, assign, enqueueActions, type ActorRefFrom } from "xstate";
import type {
  ConversationContext,
  ConversationEvent,
  ConversationInput,
  ConversationTurnActive,
  PrepareTurnInput,
  ExecutePromptInput,
  PromptActorResult,
  RunTaskRunInput,
  TaskRunActive,
} from "./types";
import {
  prepareTurnActor,
  executePromptActor,
  runTaskRunActor,
} from "./actors";
import {
  applyDebugCommand,
  clearDebugTurnFailure,
} from "@/lib/workflows/debug/commands";
import { resolveDebugFinalization } from "@/lib/workflows/debug/finalization";
import { runDebugCleanupVerification } from "@/lib/workflows/debug/cleanup-verification";
import { getDefaultDebugAdapter } from "./debug-adapter";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "./runtime-state";
import { createLogger } from "@/lib/logging";

const logger = createLogger("conversation-machine");

// ============================================================
// Helpers
// ============================================================

function extractError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function mintMissingDebugSessionId(conversationId: string): string {
  const debugSessionId = randomUUID();
  logger.info("conversation.debug_session_id_minted", {
    conversationId,
    debugSessionId,
  });
  return debugSessionId;
}

function accumulateTotals(
  current: ConversationContext["totals"],
  result: PromptActorResult,
): ConversationContext["totals"] {
  return {
    totalCostUsd: (current.totalCostUsd ?? 0) + (result.costUsd ?? 0),
    totalDurationMs: (current.totalDurationMs ?? 0) + (result.durationMs ?? 0),
    totalTurns: (current.totalTurns ?? 0) + (result.numTurns ?? 0),
    contextTokens: result.contextTokens ?? current.contextTokens,
    contextWindowMax: result.contextWindow ?? current.contextWindowMax,
  };
}

/** Build the ActiveTurn for a SUBMIT_PROMPT claim. Shared by every state that
 *  can claim a conversation turn (idle, waitingForInput, debug). */
function conversationTurnFromEvent(
  context: ConversationContext,
  event: Extract<ConversationEvent, { type: "SUBMIT_PROMPT" }>,
): ConversationTurnActive {
  return {
    kind: "conversation_turn",
    promptText: event.promptText,
    images: event.images ?? [],
    backend: event.backend ?? context.agentBackend,
    modelId: event.modelId ?? null,
    effort: event.effort ?? null,
    codexFastMode: event.codexFastMode ?? null,
    autonomous: event.autonomous ?? false,
    startedAt: new Date().toISOString(),
    streamId: event.streamId,
    outputFormat: event.outputFormat,
    ...(event.waitForBackgroundTasks ? { waitForBackgroundTasks: true } : {}),
    ...(event.queuedDelivery ? { queuedDelivery: event.queuedDelivery } : {}),
    ...(event.documentFeedback
      ? { documentFeedback: event.documentFeedback }
      : {}),
    ...(event.askUserQuestionsEnabled ? { askUserQuestionsEnabled: true } : {}),
  };
}

/** Build the ActiveTurn for a SUBMIT_TASK_RUN claim. */
function taskRunFromEvent(
  context: ConversationContext,
  event: Extract<ConversationEvent, { type: "SUBMIT_TASK_RUN" }>,
): TaskRunActive {
  return {
    kind: "task_run",
    promptText: event.promptText,
    backend: event.backend ?? context.agentBackend,
    modelId: event.modelId ?? null,
    effort: event.effort ?? null,
    startedAt: new Date().toISOString(),
    ...(event.outputFormat !== undefined
      ? { outputFormat: event.outputFormat }
      : {}),
    ...(event.systemInstructions !== undefined
      ? { systemInstructions: event.systemInstructions }
      : {}),
    ...(event.tooling !== undefined ? { tooling: event.tooling } : {}),
    ...(event.timeoutMs !== undefined ? { timeoutMs: event.timeoutMs } : {}),
    ...(event.fsWritePolicy !== undefined
      ? { fsWritePolicy: event.fsWritePolicy }
      : {}),
    ...(event.structuredOutputTextField !== undefined
      ? { structuredOutputTextField: event.structuredOutputTextField }
      : {}),
    ...(event.origin !== undefined ? { origin: event.origin } : {}),
  };
}

/**
 * Resolve the context `backendRef` after a completed turn — the single owner
 * of continuation disposition for every completed-turn path (executePrompt /
 * runTaskRun onDone, PROMPT_COMPLETED, EXTERNAL_TURN_COMPLETED). The result's
 * `continuationDisposition` is backend continuation policy decided where the
 * turn executed, never by backend identity here. "clear" unconditionally
 * drops the ref: the backend declared the continuation unusable, so the next
 * turn must start fresh — adapters enforce `backendRef: null` alongside it
 * (`turnContinuationSchema`), and honoring a ref here would retry the dead
 * continuation forever. On "retain" a fresher ref from the turn wins, falling
 * back to the prior ref: wiping a resumable ref strands the conversation with
 * a rendered transcript but no agent memory of it.
 */
function resolveCompletedTurnBackendRef(
  context: ConversationContext,
  output: PromptActorResult,
): ConversationContext["backendRef"] {
  if (output.continuationDisposition === "clear") {
    return null;
  }
  return output.backendRef ?? context.backendRef;
}

/**
 * Legality gate for reducer-handled debug commands. Mirrors what the machine
 * would apply so `snapshot.can()` — and therefore the adapter's dispatch
 * result and the API route's 409 — stays truthful.
 */
function isApplicableDebugCommand(
  context: ConversationContext,
  event: Extract<ConversationEvent, { type: "DEBUG_COMMAND" }>,
): boolean {
  return (
    applyDebugCommand(
      context.debugMode,
      event.command,
      new Date().toISOString(),
    ) !== null
  );
}

// ============================================================
// Machine
// ============================================================

export const conversationMachine = setup({
  types: {
    context: {} as ConversationContext,
    events: {} as ConversationEvent,
    input: {} as ConversationInput,
  },

  actors: {
    prepareTurn: prepareTurnActor,
    executePrompt: executePromptActor,
    runTaskRun: runTaskRunActor,
  },

  guards: {
    isActiveTurnTaskRun: ({ context }) =>
      context.activeTurn?.kind === "task_run",
  },

  actions: {
    // Stubs overridden via .provide() in manager
    persistSnapshot: () => {},
    syncDerivedFields: () => {},
    broadcastConversationStatus: () => {},
    broadcastAskQuestion: () => {},
    broadcastDebugModeStatus: () => {},
    releaseResources: () => {},
    dispatchPushNotification: () => {},
    markUnreadOnFinish: () => {},
    markReadOnUserTurnStart: () => {},
    triggerAutoNaming: () => {},
    drainPendingQueue: () => {},
    cancelDebugCleanupVerification: ({ context }) => {
      const runtime = getConversationRuntime(
        conversationRuntimeKey(
          context.projectPath,
          context.sessionName,
          context.conversationId,
        ),
      );
      runtime?.debugCleanupVerification?.controller.abort();
      if (runtime) runtime.debugCleanupVerification = undefined;
    },
    persistRestoredDebugGeneration: enqueueActions(({ context, enqueue }) => {
      if (!context.debugGenerationNeedsPersistence) return;
      enqueue.assign({ debugGenerationNeedsPersistence: false });
      enqueue("syncDerivedFields");
      enqueue("persistSnapshot");
    }),

    /** Single owner of the SUBMIT_PROMPT turn claim (idle, waitingForInput,
     *  debug). Clears the previous turn's result with the error — an abort
     *  mid-turn sets only lastError, and a surviving stale success would be
     *  returned as the aborted turn's outcome — and clears the debug
     *  failed-turn flag: any claim replaces the failed turn, so the error
     *  presentation must not survive it. */
    claimConversationTurn: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "SUBMIT_PROMPT") return;
      enqueue.assign({
        activeTurn: conversationTurnFromEvent(context, event),
        pendingQuestion: null,
        debugMode: clearDebugTurnFailure(context.debugMode),
        lastResult: null,
        lastError: null,
      });
    }),

    /** SUBMIT_TASK_RUN counterpart of `claimConversationTurn`. */
    claimTaskRun: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "SUBMIT_TASK_RUN") return;
      enqueue.assign({
        activeTurn: taskRunFromEvent(context, event),
        pendingQuestion: null,
        lastResult: null,
        lastError: null,
      });
    }),

    /** Apply a reducer-handled debug command and fire the side effects it
     *  selects. Transition guards already established legality, so a null
     *  effect is simply ignored. */
    applyDebugCommandEffect: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "DEBUG_COMMAND") return;
      const effect = applyDebugCommand(
        context.debugMode,
        event.command,
        new Date().toISOString(),
      );
      if (!effect) return;
      if (event.command.kind === "enter" || event.command.kind === "exit") {
        enqueue("cancelDebugCleanupVerification");
      }
      enqueue.assign({
        debugMode: effect.debugMode,
        ...(effect.clearActiveTurn ? { activeTurn: null } : {}),
        ...(effect.lastError !== undefined
          ? { lastError: effect.lastError }
          : {}),
      });
      enqueue("syncDerivedFields");
      if (effect.broadcastConversationStatus) {
        enqueue("broadcastConversationStatus");
      }
      if (effect.broadcastDebugModeStatus) {
        enqueue("broadcastDebugModeStatus");
      }
      enqueue("persistSnapshot");
    }),

    /** Settle a turn that finalized while debug mode is active. The debug
     *  workflow decides what the outcome means (`resolveDebugFinalization`);
     *  this action applies shared turn accounting, maps the decision kind
     *  onto side effects (user notification only on a phase advance), and
     *  starts async cleanup verification when the cleanup turn produced a
     *  structured report. `activeTurn` is preserved on `verify_cleanup` and
     *  `turn_failed` so a retry can re-run the same prompt. */
    finalizeDebugTurn: enqueueActions(({ context, enqueue }) => {
      const debugMode = context.debugMode;
      if (!debugMode?.active) return;
      const result = context.lastResult;
      const decision = resolveDebugFinalization({
        debugMode,
        lastResult: result
          ? { structuredOutput: result.structuredOutput, error: result.error }
          : null,
        lastError: context.lastError,
      });
      const preserveActiveTurn =
        decision.kind === "verify_cleanup" || decision.kind === "turn_failed";
      enqueue.assign({
        promptCount: context.promptCount + 1,
        totals: result
          ? accumulateTotals(context.totals, result)
          : context.totals,
        status: "awaiting" as const,
        lastActivityAt: new Date().toISOString(),
        debugMode: decision.debugMode,
        ...(preserveActiveTurn ? {} : { activeTurn: null }),
        ...(decision.kind === "turn_failed"
          ? { lastError: decision.lastError }
          : {}),
      });
      enqueue("syncDerivedFields");
      enqueue("releaseResources");
      enqueue("broadcastConversationStatus");
      if (decision.kind === "advance") {
        enqueue("dispatchPushNotification");
        enqueue("markUnreadOnFinish");
      }
      enqueue("persistSnapshot");
      if (decision.kind === "verify_cleanup") {
        enqueue("startDebugCleanupVerification");
      }
    }),

    /** Fire-and-forget cleanup verification. The default implementation is
     *  production-real (the debug workflow module owns the verify logic);
     *  tests override it via `.provide()` to inject a fake verifier. The
     *  outcome re-enters the machine as a DEBUG_COMMAND stamped with this
     *  attempt, so the reducer drops it if a newer cleanup attempt has
     *  superseded it by the time it resolves. This action runs after
     *  finalizeDebugTurn's assign, so `debugMode` already carries the
     *  attempt the verify_cleanup decision stamped for this turn. */
    startDebugCleanupVerification: ({ context, self }) => {
      const debugSessionId = context.debugMode?.debugSessionId;
      if (!debugSessionId) return;

      const key = conversationRuntimeKey(
        context.projectPath,
        context.sessionName,
        context.conversationId,
      );
      const runtime = getConversationRuntime(key);
      runtime?.debugCleanupVerification?.controller.abort();
      const controller = new AbortController();
      if (runtime) {
        runtime.debugCleanupVerification = { debugSessionId, controller };
      }

      void runDebugCleanupVerification({
        worktreePath: context.worktreePath,
        conversationId: context.conversationId,
        structuredOutput: context.lastResult?.structuredOutput,
        debugSessionId,
        attempt: context.debugMode?.cleanupVerificationAttempt ?? 0,
        signal: controller.signal,
      }).then((command) => {
        if (controller.signal.aborted || command == null) return;
        const current = getConversationRuntime(key)?.debugCleanupVerification;
        if (current && current.controller !== controller) return;
        if (runtime) runtime.debugCleanupVerification = undefined;
        self.send({ type: "DEBUG_COMMAND", command });
      });
    },
  },
}).createMachine({
  id: "conversation",

  context: ({ input }): ConversationContext => ({
    _schemaVersion: 1,
    conversationScope: input.conversationScope ?? "session",
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    worktreePath: input.worktreePath,
    conversationId: input.conversationId,
    createdAt: input.createdAt,
    lastActivityAt: input.createdAt,
    status: input.promptCount === 0 ? "new" : "awaiting",
    promptCount: input.promptCount,
    transcriptPath: input.transcriptPath,
    agentBackend: input.agentBackend,
    backendRef: input.backendRef,
    forkedFrom: input.forkedFrom,
    role: input.role,
    transient: input.persistence === "ephemeral",
    activeTurn: null,
    pendingQuestion: null,
    debugMode:
      input.debugMode && input.debugMode.active
        ? {
            active: input.debugMode.active,
            recording: input.debugMode.recording,
            logFilePath: input.debugMode.logFilePath,
            enteredAt: input.debugMode.enteredAt,
            hypotheses: input.debugMode.hypotheses,
            reproductionSteps: input.debugMode.reproductionSteps,
            fixSummary: input.debugMode.fixSummary,
            verificationSteps: input.debugMode.verificationSteps,
            instructionsDelivered: input.debugMode.instructionsDelivered,
            phase: input.debugMode.phase,
            lastTurnFailed: input.debugMode.lastTurnFailed,
            debugSessionId:
              input.debugMode.debugSessionId ??
              mintMissingDebugSessionId(input.conversationId),
            cleanupVerificationAttempt:
              input.debugMode.cleanupVerificationAttempt,
          }
        : null,
    debugGenerationNeedsPersistence:
      input.debugMode?.active === true && !input.debugMode.debugSessionId,
    totals: {
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
    },
    lastResult: null,
    lastError: null,
  }),

  initial: "idle",

  states: {
    // ========================================================
    // IDLE — waiting for prompt or debug mode entry
    // ========================================================
    idle: {
      // idle is the settled resting state a conversation reaches after a turn
      // finalizes (finalizingTurn → idle) and at startup. Draining here is the
      // canonical "settled user-submit point where a new turn can start": the
      // manager's provided action claims any pending queue batch and dispatches
      // it as the next turn. The default stub is a no-op.
      entry: [{ type: "drainPendingQueue" }],
      // An active debugMode (restored from input, or just entered via
      // DEBUG_COMMAND) parks the conversation in the debug state.
      always: [
        {
          guard: ({ context }) => context.debugMode?.active === true,
          target: "debug",
        },
      ],
      on: {
        SUBMIT_PROMPT: {
          target: "acquiringResources",
          actions: "claimConversationTurn",
        },
        SUBMIT_TASK_RUN: {
          target: "acquiringResources",
          actions: "claimTaskRun",
        },
        // Only `enter` is legal here (the reducer refuses everything else
        // while debug mode is inactive); the always-transition above then
        // routes into the debug state.
        DEBUG_COMMAND: {
          guard: ({ context, event }) =>
            isApplicableDebugCommand(context, event),
          actions: "applyDebugCommandEffect",
        },
        EXTERNAL_TURN_STARTED: {
          target: "externalExecuting",
        },
        // Stop with nothing to stop. The machine is already settled, so this is
        // a reconciliation, not a transition: it re-asserts the settled status
        // onto the persisted row and the SSE stream. A conversation whose row
        // was left on "running" by a turn that died without settling (or by a
        // process that exited mid-transition) reads as permanently busy, and
        // Stop is where the user goes to fix that. Internal (no target) so the
        // resting state's entry — the pending-queue drain — does not re-run.
        ABORT_TURN: {
          actions: ["syncDerivedFields", "broadcastConversationStatus"],
        },
      },
    },

    // ========================================================
    // EXTERNAL EXECUTING — Claude Code auto-continuation turn
    // (e.g., response to <task-notification> from a background
    // Bash task completing). No caller-initiated prompt.
    // ========================================================
    externalExecuting: {
      entry: [
        assign({
          status: "running" as const,
          lastActivityAt: () => new Date().toISOString(),
          lastError: null,
        }),
        "syncDerivedFields",
        "broadcastConversationStatus",
      ],
      on: {
        EXTERNAL_TURN_COMPLETED: {
          target: "#conversation.finalizingTurn",
          actions: assign({
            lastResult: ({ event }) => event.result,
            backendRef: ({ context, event }) =>
              resolveCompletedTurnBackendRef(context, event.result),
          }),
        },
        // An external turn is not caller-initiated, so nothing on the CC side
        // holds a handle that can force its completion: if the backend never
        // sends one, this state is a dead end that reads as a permanently
        // "running" conversation. Stop is the user's only exit, so it settles
        // the turn here exactly as it does in `executing`.
        ABORT_TURN: {
          target: "#conversation.finalizingTurn",
          actions: assign({
            lastError: ({ event }) => `Aborted: ${event.reason}`,
            pendingQuestion: null,
          }),
        },
      },
    },

    // ========================================================
    // ACQUIRING RESOURCES — lock + semaphore + transcript
    // ========================================================
    acquiringResources: {
      entry: [
        assign({
          status: "running" as const,
          lastActivityAt: () => new Date().toISOString(),
        }),
        "syncDerivedFields",
        "broadcastConversationStatus",
        "markReadOnUserTurnStart",
        "triggerAutoNaming",
      ],
      invoke: {
        src: "prepareTurn",
        input: ({ context }): PrepareTurnInput => ({
          persistence: context.transient ? "ephemeral" : "durable",
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          conversationId: context.conversationId,
          worktreePath: context.worktreePath,
          transcriptPath: context.transcriptPath,
        }),
        onDone: {
          target: "executing",
          actions: [
            assign({
              transcriptPath: ({ event }) => event.output.transcriptPath,
            }),
            "syncDerivedFields",
          ],
        },
        onError: {
          target: "finalizingTurn",
          actions: assign({
            lastError: ({ event }) => extractError(event.error),
          }),
        },
      },
    },

    // ========================================================
    // EXECUTING — compound state that branches on activeTurn.kind:
    //   - conversation_turn → invokes the streaming `executePrompt` actor.
    //     ASK_QUESTION is an internal transition: it records the pending
    //     question without tearing down the long-lived stream; the agent is
    //     expected to end its turn, and finalizingTurn then routes to the
    //     top-level waitingForInput state.
    //   - task_run → invokes the single-shot `runTaskRun` actor; no
    //     mid-turn ask-user.
    // The discriminator is `kind` only — `outputFormat` is consumed by both
    // branches (Debug Mode uses it on the streaming path) and must not gate
    // dispatch selection.
    // ========================================================
    executing: {
      initial: "dispatching",

      // Parent-level events apply across both branches so the existing
      // streaming control flow is byte-for-byte unchanged.
      on: {
        // Persist immediately: the SDK announces its session id seconds into
        // the turn, but the turn may run for minutes. If the server dies
        // mid-turn before the ref is durable, the next turn cannot `resume:`
        // and the agent silently loses all prior context.
        BACKEND_INIT: {
          actions: [
            assign({
              backendRef: ({ event }) => event.backendRef,
            }),
            "syncDerivedFields",
            "persistSnapshot",
          ],
        },
        PROMPT_COMPLETED: {
          target: "#conversation.finalizingTurn",
          actions: assign({
            lastResult: ({ event }) => event.result,
            backendRef: ({ context, event }) =>
              resolveCompletedTurnBackendRef(context, event.result),
          }),
        },
        PROMPT_FAILED: {
          target: "#conversation.finalizingTurn",
          actions: assign({
            lastError: ({ event }) => event.error,
          }),
        },
        ABORT_TURN: {
          target: "#conversation.finalizingTurn",
          actions: assign({
            lastError: ({ event }) => `Aborted: ${event.reason}`,
            pendingQuestion: null,
          }),
        },
        // The pending question was consumed (answered) mid-turn; the turn keeps
        // running and finalizingTurn will settle to idle instead of
        // waitingForInput.
        CLEAR_PENDING_QUESTION: {
          guard: ({ context }) => context.pendingQuestion != null,
          actions: [
            assign({
              status: "running" as const,
              pendingQuestion: null,
            }),
            "syncDerivedFields",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
        },
      },

      states: {
        // Eager dispatcher: routes to the correct actor branch based on
        // `activeTurn.kind`. XState v5 cannot dynamically select `invoke.src`,
        // so the branch is expressed structurally as sibling substates.
        dispatching: {
          always: [
            {
              guard: "isActiveTurnTaskRun",
              target: "taskRun",
            },
            { target: "conversationTurn" },
          ],
        },

        conversationTurn: {
          on: {
            // Internal transition: the stream invoke stays alive. The ASK
            // side effects (persist, SSE, push) all fire here; the turn keeps
            // running until the agent ends it.
            ASK_QUESTION: {
              actions: [
                assign({
                  status: "waiting_for_input" as const,
                  pendingQuestion: ({ event }) => ({
                    questionId: event.questionId,
                    questions: event.questions,
                  }),
                }),
                "syncDerivedFields",
                "broadcastConversationStatus",
                "broadcastAskQuestion",
                "dispatchPushNotification",
                "persistSnapshot",
              ],
            },
          },

          invoke: {
            src: "executePrompt",
            input: ({ context }): ExecutePromptInput => {
              const activeTurn = context.activeTurn;
              if (activeTurn?.kind !== "conversation_turn") {
                throw new Error(
                  "executePrompt requires an active conversation_turn",
                );
              }

              // Explicit outputFormat (e.g. from validator) takes priority over
              // debug-phase-derived format.
              const outputFormat =
                activeTurn.outputFormat ??
                getDefaultDebugAdapter().resolveOutputFormat(
                  context.debugMode?.phase,
                );

              return {
                persistence: context.transient ? "ephemeral" : "durable",
                conversationScope: context.conversationScope,
                projectPath: context.projectPath,
                projectName: context.projectName,
                sessionName: context.sessionName,
                worktreePath: context.worktreePath,
                conversationId: context.conversationId,
                transcriptPath: context.transcriptPath!,
                agentBackend: context.agentBackend,
                backendRef: context.backendRef,
                promptCount: context.promptCount,
                forkedFrom: context.forkedFrom,
                role: context.role,
                promptText: activeTurn.promptText,
                images: activeTurn.images,
                streamId: activeTurn.streamId,
                modelId: activeTurn.modelId,
                effort: activeTurn.effort,
                codexFastMode: activeTurn.codexFastMode,
                autonomous: activeTurn.autonomous,
                debugMode: context.debugMode,
                outputFormat,
                ...(activeTurn.waitForBackgroundTasks
                  ? { waitForBackgroundTasks: true }
                  : {}),
                ...(activeTurn.queuedDelivery
                  ? { queuedDelivery: activeTurn.queuedDelivery }
                  : {}),
                ...(activeTurn.documentFeedback
                  ? { documentFeedback: activeTurn.documentFeedback }
                  : {}),
                ...(activeTurn.askUserQuestionsEnabled
                  ? { askUserQuestionsEnabled: true }
                  : {}),
              };
            },
            onDone: {
              target: "#conversation.finalizingTurn",
              actions: assign({
                lastResult: ({ event }) => event.output,
                backendRef: ({ context, event }) =>
                  resolveCompletedTurnBackendRef(context, event.output),
              }),
            },
            onError: {
              target: "#conversation.finalizingTurn",
              actions: assign({
                lastError: ({ event }) => extractError(event.error),
              }),
            },
          },
        },

        taskRun: {
          invoke: {
            src: "runTaskRun",
            input: ({ context }): RunTaskRunInput => {
              const activeTurn = context.activeTurn;
              if (activeTurn?.kind !== "task_run") {
                throw new Error("runTaskRun requires an active task_run");
              }
              return {
                persistence: context.transient ? "ephemeral" : "durable",
                projectPath: context.projectPath,
                projectName: context.projectName,
                sessionName: context.sessionName,
                worktreePath: context.worktreePath,
                conversationId: context.conversationId,
                agentBackend: activeTurn.backend,
                backendRef: context.backendRef,
                promptText: activeTurn.promptText,
                modelId: activeTurn.modelId,
                effort: activeTurn.effort,
                ...(activeTurn.outputFormat !== undefined
                  ? { outputFormat: activeTurn.outputFormat }
                  : {}),
                ...(activeTurn.systemInstructions !== undefined
                  ? { systemInstructions: activeTurn.systemInstructions }
                  : {}),
                ...(activeTurn.tooling !== undefined
                  ? { tooling: activeTurn.tooling }
                  : {}),
                ...(activeTurn.timeoutMs !== undefined
                  ? { timeoutMs: activeTurn.timeoutMs }
                  : {}),
                ...(activeTurn.fsWritePolicy !== undefined
                  ? { fsWritePolicy: activeTurn.fsWritePolicy }
                  : {}),
                ...(activeTurn.structuredOutputTextField !== undefined
                  ? {
                      structuredOutputTextField:
                        activeTurn.structuredOutputTextField,
                    }
                  : {}),
                ...(activeTurn.origin !== undefined
                  ? { origin: activeTurn.origin }
                  : {}),
              };
            },
            onDone: {
              target: "#conversation.finalizingTurn",
              actions: assign({
                lastResult: ({ event }) => event.output,
                backendRef: ({ context, event }) =>
                  resolveCompletedTurnBackendRef(context, event.output),
              }),
            },
            onError: {
              target: "#conversation.finalizingTurn",
              actions: assign({
                lastError: ({ event }) => extractError(event.error),
              }),
            },
          },
        },
      },
    },

    // ========================================================
    // FINALIZING TURN — update metadata, release resources
    // ========================================================
    finalizingTurn: {
      always: [
        // Debug mode: the attached debug workflow interprets the turn
        // outcome (advance / follow-up / verify-cleanup / failed) and the
        // conversation parks back in the debug state.
        {
          guard: ({ context }) => context.debugMode?.active === true,
          target: "debug",
          actions: "finalizeDebugTurn",
        },
        // A question survived the turn: the agent registered it (cctl ask)
        // and ended its turn. Settle turn metadata but keep the pending
        // question and its waiting_for_input status — the answer arrives as
        // the next queued user message. No dispatchPushNotification here: the
        // ASK_QUESTION transition already pushed "needs your input" and this
        // transition must not re-fire a conflicting status push.
        {
          guard: ({ context }) => context.pendingQuestion != null,
          target: "waitingForInput",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              return {
                promptCount:
                  context.activeTurn != null || result != null
                    ? context.promptCount + 1
                    : context.promptCount,
                totals: result
                  ? accumulateTotals(context.totals, result)
                  : context.totals,
                activeTurn: null,
                status: "waiting_for_input" as const,
                lastActivityAt: new Date().toISOString(),
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "markUnreadOnFinish",
            "persistSnapshot",
          ],
        },
        // Default: not in debug mode, no pending question
        {
          target: "idle",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              return {
                promptCount:
                  context.activeTurn != null || result != null
                    ? context.promptCount + 1
                    : context.promptCount,
                totals: result
                  ? accumulateTotals(context.totals, result)
                  : context.totals,
                activeTurn: null,
                status: "awaiting" as const,
                lastActivityAt: new Date().toISOString(),
                pendingQuestion: null,
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "dispatchPushNotification",
            "markUnreadOnFinish",
            "persistSnapshot",
          ],
        },
      ],
    },

    // ========================================================
    // WAITING FOR INPUT — no turn is running; a question pends.
    // Entered from finalizingTurn when the asking turn ended with its
    // question unanswered. Draining here keeps queued user messages (an
    // answer or a redirect) from stalling; claiming ANY turn clears the
    // pending question — the answer consumed it, or a fresh user prompt
    // supersedes it and the panel dismisses via the status SSE.
    // ========================================================
    waitingForInput: {
      entry: [{ type: "drainPendingQueue" }],
      on: {
        SUBMIT_PROMPT: {
          target: "acquiringResources",
          actions: "claimConversationTurn",
        },
        SUBMIT_TASK_RUN: {
          target: "acquiringResources",
          actions: "claimTaskRun",
        },
        // An explicit user "stop" has no turn to abort here; it clears the
        // pending question — after a stop the next input comes from the user
        // anyway, so the question is moot.
        ABORT_TURN: {
          target: "idle",
          actions: [
            assign({
              pendingQuestion: null,
              status: "awaiting" as const,
              lastActivityAt: () => new Date().toISOString(),
            }),
            "syncDerivedFields",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
        },
        // A graph-workflow lane answer records on the execution record without
        // queueing a message, so no SUBMIT_PROMPT drain settles this parked
        // turn. The answer route clears the marker directly, settling the
        // conversation to idle.
        CLEAR_PENDING_QUESTION: {
          target: "idle",
          actions: [
            assign({
              pendingQuestion: null,
              status: "awaiting" as const,
              lastActivityAt: () => new Date().toISOString(),
            }),
            "syncDerivedFields",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
        },
      },
    },

    // ========================================================
    // DEBUG — the attached debug workflow's parking state. The
    // phase lives in context.debugMode; phase legality is the
    // reducer's legality table, not machine topology. No queue
    // drain on entry: debug settle points must not auto-claim
    // queued messages as debug turns — draining resumes when
    // exiting debug mode settles the conversation back to idle.
    // ========================================================
    debug: {
      entry: "persistRestoredDebugGeneration",
      // Leaving debug mode (exit command, passed cleanup verification)
      // clears debugMode; the conversation settles back to idle.
      always: [
        {
          guard: ({ context }) => context.debugMode?.active !== true,
          target: "idle",
        },
      ],
      on: {
        SUBMIT_PROMPT: {
          target: "acquiringResources",
          actions: "claimConversationTurn",
        },
        DEBUG_COMMAND: [
          // retry_turn re-enters the turn spine with the preserved failed
          // turn (same prompt, same phase, same structured-output schema).
          {
            guard: ({ context, event }) =>
              event.command.kind === "retry_turn" &&
              context.debugMode?.lastTurnFailed === true &&
              context.activeTurn != null,
            target: "acquiringResources",
            actions: assign({
              debugMode: ({ context }) =>
                clearDebugTurnFailure(context.debugMode),
              lastResult: null,
              lastError: null,
            }),
          },
          {
            guard: ({ context, event }) =>
              isApplicableDebugCommand(context, event),
            actions: "applyDebugCommandEffect",
          },
        ],
      },
    },
  },
});

/** Type alias for the conversation actor reference. */
export type ConversationActorRef = ActorRefFrom<typeof conversationMachine>;
