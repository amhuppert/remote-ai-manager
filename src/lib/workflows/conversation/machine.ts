import { normalizeTurn } from "./turn-spec";
import { conversationTotals } from "./actor-input-loader";
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
 *  │ DEBUG_COMMAND (retry_turn)  invoke completion / ABORT_TURN
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
import {
  setup,
  assign,
  enqueueActions,
  and,
  not,
  type ActorRefFrom,
} from "xstate";
import {
  checkpointHoldsExternalAdmission,
  checkpointHoldsOrdinaryAdmission,
} from "@/lib/conversation-checkpoints/admission";
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
  settleTurnActor,
  executePromptActor,
  runTaskRunActor,
} from "./actors";
import {
  applyDebugCommand,
  clearDebugTurnFailure,
} from "@/lib/workflows/debug/commands";
import { resolveDebugFinalization } from "@/lib/workflows/debug/finalization";
import { getDefaultDebugAdapter } from "./debug-adapter";
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
  const { type: _type, streamId, executionAttemptId, ...request } = event;
  return {
    ...normalizeTurn(
      { ...request, kind: "conversation_turn" },
      context.agentBackend,
    ),
    startedAt: new Date().toISOString(),
    streamId,
    executionAttemptId: executionAttemptId ?? randomUUID(),
  };
}

/** Build the ActiveTurn for a SUBMIT_TASK_RUN claim. */
function taskRunFromEvent(
  context: ConversationContext,
  event: Extract<ConversationEvent, { type: "SUBMIT_TASK_RUN" }>,
): TaskRunActive {
  const { type: _type, executionAttemptId, ...request } = event;
  return {
    ...normalizeTurn({ ...request, kind: "task_run" }, context.agentBackend),
    startedAt: new Date().toISOString(),
    executionAttemptId: executionAttemptId ?? randomUUID(),
  };
}

type ModelSelectionResolvedEvent = Extract<
  ConversationEvent,
  { type: "MODEL_SELECTION_RESOLVED" }
>;

function createModelSelectionResolutionReporter(
  send: (event: ModelSelectionResolvedEvent) => void,
  executionAttemptId: string,
): (
  modelSelection: ModelSelectionResolvedEvent["modelSelection"],
) => Promise<void> {
  return (modelSelection) =>
    new Promise<void>((acknowledge, reject) => {
      send({
        type: "MODEL_SELECTION_RESOLVED",
        modelSelection,
        executionAttemptId,
        acknowledge,
        reject,
      });
    });
}

/**
 * Resolve the context `backendRef` after a completed turn — the single owner
 * of continuation disposition for every completed-turn path (executePrompt /
 * runTaskRun onDone, EXTERNAL_TURN_COMPLETED). The result's
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
    settleTurn: settleTurnActor,
    executePrompt: executePromptActor,
    runTaskRun: runTaskRunActor,
  },

  guards: {
    isActiveTurnTaskRun: ({ context }) =>
      context.activeTurn?.kind === "task_run",
    /**
     * Ordinary admission is held while a checkpoint operation owns this
     * conversation: building, retiring, delivering or awaiting reconciliation.
     * A `ready` checkpoint releases it — the next ordinary turn is what
     * delivers the seed.
     */
    checkpointHoldsAdmission: ({ context }) =>
      checkpointHoldsOrdinaryAdmission(context.checkpoint),
    /**
     * A provider-initiated turn is admitted while a checkpoint is still
     * building — the provider already started it, and the build yields to it
     * at its freeze fence — and refused once the runtime is being retired or
     * replaced.
     */
    checkpointHoldsExternalAdmission: ({ context }) =>
      checkpointHoldsExternalAdmission(context.checkpoint),
  },

  actions: {
    // Runtime effects are supplied by the actor host.
    persistSnapshot: () => {},
    syncDerivedFields: () => {},
    broadcastConversationStatus: () => {},
    broadcastAskQuestion: () => {},
    broadcastDebugModeStatus: () => {},
    releaseResources: () => {},
    completeTurn: () => {},
    cancelTurn: () => {},
    dispatchPushNotification: () => {},
    markUnreadOnFinish: () => {},
    markReadOnUserTurnStart: () => {},
    triggerAutoNaming: () => {},
    drainPendingQueue: () => {},
    rejectInactiveModelSelectionResolution: ({ context, event }) => {
      if (event.type !== "MODEL_SELECTION_RESOLVED") return;
      logger.warn("conversation.model_selection_resolution_stale", {
        conversationId: context.target.conversationId,
        modelId: event.modelSelection.modelId,
        currentExecutionAttemptId:
          context.activeTurn?.executionAttemptId ?? null,
        reportedExecutionAttemptId: event.executionAttemptId,
      });
      event.reject(
        new Error(
          "Resolved model selection belongs to an inactive execution attempt.",
        ),
      );
    },
    cancelDebugCleanupVerification: () => {},
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

    accountTurn: assign(({ context }) => ({
      promptCount:
        context.activeTurn != null || context.lastResult != null
          ? context.promptCount + 1
          : context.promptCount,
      totals: context.lastResult
        ? accumulateTotals(context.totals, context.lastResult)
        : context.totals,
      lastActivityAt: new Date().toISOString(),
    })),
    finishTurn: enqueueActions(({ enqueue }) => {
      enqueue("syncDerivedFields");
      enqueue("completeTurn");
      enqueue("broadcastConversationStatus");
    }),

    /** Settle a turn that finalized while debug mode is active. The debug
     *  workflow decides what the outcome means (`resolveDebugFinalization`);
     *  this action maps the decision kind onto side effects (user notification
     *  only on a phase advance), and
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
        status: "awaiting" as const,
        debugMode: decision.debugMode,
        ...(preserveActiveTurn ? {} : { activeTurn: null }),
        ...(decision.kind === "turn_failed"
          ? { lastError: decision.lastError }
          : {}),
      });
      enqueue("finishTurn");
      if (decision.kind === "advance") {
        enqueue("dispatchPushNotification");
        enqueue("markUnreadOnFinish");
      }
      enqueue("persistSnapshot");
      if (decision.kind === "verify_cleanup") {
        enqueue("startDebugCleanupVerification");
      }
    }),

    startDebugCleanupVerification: () => {},

    /** The manager's checkpoint projection; `ready` retires the continuation. */
    applyCheckpointPhase: assign(({ context, event }) => {
      if (event.type !== "CHECKPOINT_PHASE") return {};
      return {
        checkpoint: event.checkpoint,
        backendRef:
          event.checkpoint?.phase === "ready" ? null : context.backendRef,
      };
    }),
  },
}).createMachine({
  id: "conversation",

  context: ({ input }): ConversationContext => ({
    _schemaVersion: 1,
    target: input.target,

    projectPath: input.projectPath,

    worktreePath: input.worktreePath,

    createdAt: input.createdAt,
    lastActivityAt: input.lastActivityAt,
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
              mintMissingDebugSessionId(input.target.conversationId),
            cleanupVerificationAttempt:
              input.debugMode.cleanupVerificationAttempt,
          }
        : null,
    debugGenerationNeedsPersistence:
      input.debugMode?.active === true && !input.debugMode.debugSessionId,
    totals: conversationTotals(input),
    lastResult: null,
    lastError: null,
    checkpoint: input.checkpoint ?? null,
  }),

  initial: "idle",

  on: {
    MODEL_SELECTION_RESOLVED: {
      actions: "rejectInactiveModelSelectionResolution",
    },
    // Targetless on purpose: a projection change must not re-enter the
    // resting state, whose entry action drains the queue.
    CHECKPOINT_PHASE: {
      actions: ["applyCheckpointPhase", "syncDerivedFields", "persistSnapshot"],
    },
  },

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
          guard: not("checkpointHoldsAdmission"),
          target: "acquiringResources",
          actions: "claimConversationTurn",
        },
        SUBMIT_TASK_RUN: {
          guard: not("checkpointHoldsAdmission"),
          target: "acquiringResources",
          actions: "claimTaskRun",
        },
        // Only `enter` is legal here (the reducer refuses everything else
        // while debug mode is inactive); the always-transition above then
        // routes into the debug state.
        DEBUG_COMMAND: {
          guard: and([
            not("checkpointHoldsAdmission"),
            ({ context, event }) => isApplicableDebugCommand(context, event),
          ]),
          actions: "applyDebugCommandEffect",
        },
        // A backend auto-continuation during a checkpoint build is admitted
        // and the build yields to it; once the runtime is being retired or
        // replaced the start is refused, since no live runtime remains for it.
        EXTERNAL_TURN_STARTED: {
          guard: not("checkpointHoldsExternalAdmission"),
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
          guard: ({ context, event }) =>
            event.executionAttemptId === undefined ||
            event.executionAttemptId === context.activeTurn?.executionAttemptId,
          target: "#conversation.finalizingTurn",
          actions: [
            "cancelTurn",
            assign({
              lastError: ({ event }) => `Aborted: ${event.reason}`,
              pendingQuestion: null,
            }),
          ],
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
      on: {
        ABORT_TURN: {
          guard: ({ context, event }) =>
            event.executionAttemptId === undefined ||
            event.executionAttemptId === context.activeTurn?.executionAttemptId,
          target: "finalizingTurn",
          actions: "cancelTurn",
        },
      },
      invoke: {
        src: "prepareTurn",
        input: ({ context }): PrepareTurnInput => ({
          executionAttemptId: context.activeTurn?.executionAttemptId,
          persistence: context.transient ? "ephemeral" : "durable",
          projectPath: context.projectPath,
          target: context.target,

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
        // Internal transition: the execution invoke stays alive. The ASK
        // side effects (persist, SSE, push) all fire here; the turn keeps
        // running until the agent ends it.
        ASK_QUESTION: {
          guard: ({ context }) =>
            context.activeTurn?.kind === "conversation_turn" ||
            (!context.transient &&
              context.target.scope === "session" &&
              context.role === "validator"),
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
        // Persist immediately: the SDK announces its session id seconds into
        // the turn, but the turn may run for minutes. If the server dies
        // mid-turn before the ref is durable, the next turn cannot `resume:`
        // and the agent silently loses all prior context.
        BACKEND_INIT: {
          guard: ({ context, event }) =>
            event.executionAttemptId === undefined ||
            event.executionAttemptId === context.activeTurn?.executionAttemptId,
          actions: [
            assign({
              backendRef: ({ event }) => event.backendRef,
            }),
            "syncDerivedFields",
            "persistSnapshot",
          ],
        },
        ABORT_TURN: {
          guard: ({ context, event }) =>
            event.executionAttemptId === undefined ||
            event.executionAttemptId === context.activeTurn?.executionAttemptId,
          target: "#conversation.finalizingTurn",
          actions: [
            "cancelTurn",
            assign({
              lastError: ({ event }) => `Aborted: ${event.reason}`,
              pendingQuestion: null,
            }),
          ],
        },
        // The pending question was consumed (answered) mid-turn; the turn keeps
        // running and finalizingTurn will settle to idle instead of
        // waitingForInput.
        CLEAR_PENDING_QUESTION: {
          guard: ({ context, event }) =>
            context.pendingQuestion?.questionId === event.questionId,
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
        MODEL_SELECTION_RESOLVED: [
          {
            guard: ({ context, event }) =>
              context.activeTurn?.executionAttemptId ===
              event.executionAttemptId,
            actions: [
              assign({
                activeTurn: ({ context, event }) => {
                  const activeTurn = context.activeTurn;
                  if (activeTurn === null) return null;
                  return {
                    ...activeTurn,
                    modelSelection: event.modelSelection,
                  };
                },
              }),
              "syncDerivedFields",
              "persistSnapshot",
              ({ event }) => event.acknowledge(),
            ],
          },
          {
            actions: "rejectInactiveModelSelectionResolution",
          },
        ],
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
          invoke: {
            src: "executePrompt",
            input: ({ context, self }): ExecutePromptInput => {
              const activeTurn = context.activeTurn;
              if (activeTurn?.kind !== "conversation_turn") {
                throw new Error(
                  "executePrompt requires an active conversation_turn",
                );
              }
              if (activeTurn.executionAttemptId === undefined) {
                throw new Error(
                  "executePrompt requires an active execution attempt",
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
                turn: { ...activeTurn, outputFormat },
                executionAttemptId: activeTurn.executionAttemptId,
                persistence: context.transient ? "ephemeral" : "durable",
                target: context.target,

                projectPath: context.projectPath,

                worktreePath: context.worktreePath,

                transcriptPath: context.transcriptPath!,
                agentBackend: context.agentBackend,
                backendRef: context.backendRef,
                promptCount: context.promptCount,
                forkedFrom: context.forkedFrom,
                role: context.role,
                streamId: activeTurn.streamId,
                checkpoint: context.checkpoint ?? null,
                onModelSelectionResolved:
                  createModelSelectionResolutionReporter(
                    (event) => self.send(event),
                    activeTurn.executionAttemptId,
                  ),
                debugMode: context.debugMode,
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
            input: ({ context, self }): RunTaskRunInput => {
              const activeTurn = context.activeTurn;
              if (activeTurn?.kind !== "task_run") {
                throw new Error("runTaskRun requires an active task_run");
              }
              if (activeTurn.executionAttemptId === undefined) {
                throw new Error(
                  "runTaskRun requires an active execution attempt",
                );
              }
              return {
                turn: activeTurn,
                executionAttemptId: activeTurn.executionAttemptId,
                persistence: context.transient ? "ephemeral" : "durable",
                projectPath: context.projectPath,
                target: context.target,
                role: context.role,

                worktreePath: context.worktreePath,

                agentBackend: activeTurn.backend,
                backendRef: context.backendRef,
                onModelSelectionResolved:
                  createModelSelectionResolutionReporter(
                    (event) => self.send(event),
                    activeTurn.executionAttemptId,
                  ),
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
    finalizingTurn: { always: "settlingQueuedDelivery" },
    settlingQueuedDelivery: {
      invoke: {
        src: "settleTurn",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          target: context.target,
          persistence: context.transient
            ? ("ephemeral" as const)
            : ("durable" as const),
          executionAttemptId: context.activeTurn?.executionAttemptId,
          queuedDelivery:
            context.activeTurn?.kind === "conversation_turn"
              ? context.activeTurn.queuedDelivery
              : undefined,
        }),
        onDone: {
          target: "applyingTurnResult",
          actions: assign(({ context, event }) =>
            event.output
              ? {
                  lastResult: event.output,
                  backendRef: resolveCompletedTurnBackendRef(
                    context,
                    event.output,
                  ),
                }
              : {},
          ),
        },
        onError: {
          target: "applyingTurnResult",
          actions: assign({
            lastError: ({ event }) => extractError(event.error),
          }),
        },
      },
    },
    applyingTurnResult: {
      entry: ["accountTurn", "releaseResources"],
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
            assign({ activeTurn: null, status: "waiting_for_input" }),
            "finishTurn",
            "markUnreadOnFinish",
            "persistSnapshot",
          ],
        },
        // Default: not in debug mode, no pending question
        {
          target: "idle",
          actions: [
            assign({
              activeTurn: null,
              status: "awaiting",
              pendingQuestion: null,
            }),
            "finishTurn",
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
          guard: not("checkpointHoldsAdmission"),
          target: "acquiringResources",
          actions: "claimConversationTurn",
        },
        SUBMIT_TASK_RUN: {
          guard: not("checkpointHoldsAdmission"),
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
          guard: ({ context, event }) =>
            context.pendingQuestion?.questionId === event.questionId,
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
          guard: not("checkpointHoldsAdmission"),
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
              activeTurn: ({ context }) =>
                context.activeTurn
                  ? { ...context.activeTurn, executionAttemptId: randomUUID() }
                  : null,
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
