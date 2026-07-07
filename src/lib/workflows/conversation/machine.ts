/**
 * Conversation XState v5 state machine.
 *
 * Manages the full conversation lifecycle: prompt submission, resource
 * acquisition, SDK execution, AskUserQuestion handling, metadata tracking,
 * and debug mode as a compound state.
 *
 * State chart:
 *
 * idle ─────────── SUBMIT_PROMPT ───────> acquiringResources
 *  │                                            │
 *  │ ENTER_DEBUG_MODE                           │ (prepareTurn done)
 *  v                                            v
 * debug (compound)                 executing (compound, invokes executePrompt)
 *  ├─ hypothesizing                 │  ASK_QUESTION (internal: records the
 *  ├─ analyzingEvidence             │  pending question; the stream keeps
 *  ├─ awaitingReproduction          │  running until the agent ends its turn)
 *  ├─ awaitingVerification          │
 *  └─ cleanupInstrumentation        │
 *                                 PROMPT_COMPLETED / PROMPT_FAILED / ABORT_TURN
 *                                             │
 *                                             v
 *                                       finalizingTurn
 *                                             │
 *                    ┌────────────────────────┼──────────────┐
 *                    v                        v              v
 *            waitingForInput               idle           debug.*
 *          (pendingQuestion set;        (default)
 *           drains queue on entry;
 *           any turn claim clears
 *           the question)
 */

import { setup, assign, and, type ActorRefFrom } from "xstate";
import type {
  ConversationContext,
  ConversationEvent,
  ConversationInput,
  ConversationOutput,
  ConversationTurnActive,
  PrepareTurnInput,
  ExecutePromptInput,
  PromptActorResult,
  RunTaskRunInput,
  TaskRunActive,
  VerifyCleanupInput,
} from "./types";
import {
  prepareTurnActor,
  executePromptActor,
  runTaskRunActor,
  verifyCleanupActor,
} from "./actors";
import {
  debugEvidenceAnalysisSchema,
  debugHypothesisOutputZodSchema,
  debugCleanupResultZodSchema,
} from "./debug-schemas";
import { getDefaultDebugAdapter } from "./debug-adapter";

// ============================================================
// Helpers
// ============================================================

function extractError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
 *  can claim a conversation turn (idle, waitingForInput, debug.*). */
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
    ...(event.skipStructuredOutputGate !== undefined
      ? { skipStructuredOutputGate: event.skipStructuredOutputGate }
      : {}),
    ...(event.origin !== undefined ? { origin: event.origin } : {}),
  };
}

// ============================================================
// Machine
// ============================================================

export const conversationMachine = setup({
  types: {
    context: {} as ConversationContext,
    events: {} as ConversationEvent,
    input: {} as ConversationInput,
    output: {} as ConversationOutput,
  },

  actors: {
    prepareTurn: prepareTurnActor,
    executePrompt: executePromptActor,
    runTaskRun: runTaskRunActor,
    verifyCleanup: verifyCleanupActor,
  },

  guards: {
    isActiveTurnTaskRun: ({ context }) =>
      context.activeTurn?.kind === "task_run",
    isDebugModeActive: ({ context }) => context.debugMode?.active === true,
    isDebugHypothesizing: ({ context }) =>
      context.debugMode?.phase === "hypothesizing",
    isDebugAnalyzing: ({ context }) =>
      context.debugMode?.phase === "analyzing_evidence",
    isDebugAwaitingReproduction: ({ context }) =>
      context.debugMode?.phase === "awaiting_reproduction",
    isDebugAwaitingVerification: ({ context }) =>
      context.debugMode?.phase === "awaiting_verification",
    isDebugCleanup: ({ context }) =>
      context.debugMode?.phase === "cleanup_instrumentation",
    isDebugErrorRestore: ({ context }) =>
      context.debugMode?.lastTurnFailed === true,
    // Phase advancement gate: both backends surface a missing/invalid
    // structured response as `structuredOutput == null`. Codex never sets
    // `error` for schema-divergent replies, so the structuredOutput half
    // is the single load-bearing condition; the error half is belt-and-
    // suspenders for SDK-level failures. See
    // .kiro/research/codex-output-format-parity.md.
    lastTurnProducedStructuredOutput: ({ context }) =>
      context.lastResult?.error == null &&
      context.lastResult?.structuredOutput != null,
    analysisOutcomeIsFixApplied: ({ context }) => {
      const parsed = debugEvidenceAnalysisSchema.safeParse(
        context.lastResult?.structuredOutput,
      );
      return parsed.success && parsed.data.outcome === "fix_applied";
    },
    analysisOutcomeIsMoreInstrumentation: ({ context }) => {
      const parsed = debugEvidenceAnalysisSchema.safeParse(
        context.lastResult?.structuredOutput,
      );
      return parsed.success && parsed.data.outcome === "more_instrumentation";
    },
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
    drainPendingQueue: () => {},
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
    transient: input.transient === true,
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
          }
        : null,
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
      always: [
        {
          guard: and(["isDebugModeActive", "isDebugErrorRestore"]),
          target: "debug.error",
        },
        {
          guard: and(["isDebugModeActive", "isDebugHypothesizing"]),
          target: "debug.hypothesizing",
        },
        {
          guard: and(["isDebugModeActive", "isDebugAwaitingReproduction"]),
          target: "debug.awaitingReproduction",
        },
        {
          guard: and(["isDebugModeActive", "isDebugAnalyzing"]),
          target: "debug.analyzingEvidence",
        },
        {
          guard: and(["isDebugModeActive", "isDebugAwaitingVerification"]),
          target: "debug.awaitingVerification",
        },
        {
          guard: and(["isDebugModeActive", "isDebugCleanup"]),
          target: "debug.cleanupInstrumentation",
        },
      ],
      on: {
        SUBMIT_PROMPT: {
          target: "acquiringResources",
          actions: assign({
            activeTurn: ({ context, event }) =>
              conversationTurnFromEvent(context, event),
            pendingQuestion: null,
            lastError: null,
          }),
        },
        SUBMIT_TASK_RUN: {
          target: "acquiringResources",
          actions: assign({
            activeTurn: ({ context, event }) =>
              taskRunFromEvent(context, event),
            pendingQuestion: null,
            lastError: null,
          }),
        },
        ENTER_DEBUG_MODE: {
          target: "debug",
          actions: [
            assign({
              debugMode: ({ event }) => ({
                active: true,
                recording: true,
                logFilePath: event.logFilePath,
                enteredAt: new Date().toISOString(),
                hypotheses: [],
                reproductionSteps: [],
                fixSummary: null,
                verificationSteps: [],
                instructionsDelivered: false,
                phase: "hypothesizing" as const,
                lastTurnFailed: false,
              }),
            }),
            "syncDerivedFields",
            "broadcastDebugModeStatus",
            "persistSnapshot",
          ],
        },
        EXTERNAL_TURN_STARTED: {
          target: "externalExecuting",
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
              event.result.backendRef ?? context.backendRef,
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
      ],
      invoke: {
        src: "prepareTurn",
        input: ({ context }): PrepareTurnInput => ({
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
              event.result.backendRef ?? context.backendRef,
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
                // On error: Codex's threadId is unrecoverable when `codex exec`
                // exits non-zero, so clear it to force a fresh thread next turn.
                // Claude session IDs are server-side at Anthropic and a transient
                // QuerySession failure (subprocess crash, idle TTL) does not
                // invalidate them — preserve the last-known ref so the next turn
                // can attempt `resume:`. Wiping it strands the conversation with
                // a rendered transcript but no agent memory of it.
                backendRef: ({ context, event }) => {
                  if (event.output.error && context.agentBackend === "codex") {
                    return event.output.backendRef ?? null;
                  }
                  return event.output.backendRef ?? context.backendRef;
                },
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
                ...(activeTurn.skipStructuredOutputGate !== undefined
                  ? {
                      skipStructuredOutputGate:
                        activeTurn.skipStructuredOutputGate,
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
                backendRef: ({ context, event }) => {
                  if (event.output.error && context.agentBackend === "codex") {
                    return event.output.backendRef ?? null;
                  }
                  return event.output.backendRef ?? context.backendRef;
                },
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
        // Debug mode: phase-advancing transitions only fire when the turn
        // produced a valid structured output. Otherwise we route to
        // debug.error so the user can retry without losing the prior phase.
        {
          guard: and([
            "isDebugHypothesizing",
            "lastTurnProducedStructuredOutput",
          ]),
          target: "debug.awaitingReproduction",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              const hypothesisParsed = debugHypothesisOutputZodSchema.safeParse(
                result?.structuredOutput,
              );
              const hypothesisPayload = hypothesisParsed.success
                ? hypothesisParsed.data
                : undefined;
              return {
                promptCount: context.promptCount + 1,
                totals: result
                  ? accumulateTotals(context.totals, result)
                  : context.totals,
                activeTurn: null,
                status: "awaiting" as const,
                lastActivityAt: new Date().toISOString(),
                debugMode: context.debugMode
                  ? {
                      ...context.debugMode,
                      phase: "awaiting_reproduction" as const,
                      instructionsDelivered: true,
                      hypotheses:
                        hypothesisPayload?.hypotheses ??
                        context.debugMode.hypotheses,
                      reproductionSteps:
                        hypothesisPayload?.reproductionSteps ??
                        context.debugMode.reproductionSteps,
                    }
                  : null,
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
        // Evidence analysis returned outcome="fix_applied" → agent already
        // applied a fix in this same turn; advance to awaitingVerification
        // and persist fixSummary + verificationSteps for deterministic
        // rendering by the UI.
        {
          guard: and([
            "isDebugAnalyzing",
            "lastTurnProducedStructuredOutput",
            "analysisOutcomeIsFixApplied",
          ]),
          target: "debug.awaitingVerification",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              const parsed = debugEvidenceAnalysisSchema.safeParse(
                result?.structuredOutput,
              );
              const fixApplied =
                parsed.success && parsed.data.outcome === "fix_applied"
                  ? parsed.data
                  : null;
              return {
                promptCount: context.promptCount + 1,
                totals: result
                  ? accumulateTotals(context.totals, result)
                  : context.totals,
                activeTurn: null,
                status: "awaiting" as const,
                lastActivityAt: new Date().toISOString(),
                debugMode: context.debugMode
                  ? {
                      ...context.debugMode,
                      phase: "awaiting_verification" as const,
                      fixSummary:
                        fixApplied?.fixSummary ?? context.debugMode.fixSummary,
                      verificationSteps:
                        fixApplied?.verificationSteps ??
                        context.debugMode.verificationSteps,
                    }
                  : null,
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
        // Evidence analysis returned outcome="more_instrumentation" → agent
        // proposes a fresh hypothesis set + reproduction steps; loop back
        // to awaitingReproduction so the user can re-run the scenario.
        {
          guard: and([
            "isDebugAnalyzing",
            "lastTurnProducedStructuredOutput",
            "analysisOutcomeIsMoreInstrumentation",
          ]),
          target: "debug.awaitingReproduction",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              const parsed = debugEvidenceAnalysisSchema.safeParse(
                result?.structuredOutput,
              );
              const moreInstrumentation =
                parsed.success && parsed.data.outcome === "more_instrumentation"
                  ? parsed.data
                  : null;
              return {
                promptCount: context.promptCount + 1,
                totals: result
                  ? accumulateTotals(context.totals, result)
                  : context.totals,
                activeTurn: null,
                status: "awaiting" as const,
                lastActivityAt: new Date().toISOString(),
                debugMode: context.debugMode
                  ? {
                      ...context.debugMode,
                      phase: "awaiting_reproduction" as const,
                      hypotheses:
                        moreInstrumentation?.hypotheses ??
                        context.debugMode.hypotheses,
                      reproductionSteps:
                        moreInstrumentation?.reproductionSteps ??
                        context.debugMode.reproductionSteps,
                      // Returning to evidence-gathering invalidates any prior
                      // fix attempt; clear it so stale data doesn't leak into
                      // the next awaitingVerification cycle.
                      fixSummary: null,
                      verificationSteps: [],
                    }
                  : null,
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
        // Debug cleanup turn returned a structured response — defer the
        // success/failure decision to the verifyingCleanup substate, which
        // cross-checks the agent's report against the persisted manifest.
        // activeTurn is preserved so RETRY_DEBUG_TURN from debug.error (after
        // a failed verifyCleanup) can re-run the same cleanup prompt.
        {
          guard: and(["isDebugCleanup", "lastTurnProducedStructuredOutput"]),
          target: "debug.verifyingCleanup",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              return {
                promptCount: context.promptCount + 1,
                totals: result
                  ? accumulateTotals(context.totals, result)
                  : context.totals,
                status: "awaiting" as const,
                lastActivityAt: new Date().toISOString(),
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
        },
        // Phase-advancing turn failed (no structured output / error). Route
        // to debug.error preserving phase + activeTurn so the user can RETRY.
        {
          guard: ({ context }) =>
            context.debugMode?.active === true &&
            (context.debugMode.phase === "hypothesizing" ||
              context.debugMode.phase === "analyzing_evidence" ||
              context.debugMode.phase === "cleanup_instrumentation"),
          target: "debug.error",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              return {
                promptCount: context.promptCount + 1,
                totals: result
                  ? accumulateTotals(context.totals, result)
                  : context.totals,
                status: "awaiting" as const,
                lastActivityAt: new Date().toISOString(),
                lastError:
                  context.lastError ??
                  result?.error ??
                  "Turn did not produce a valid structured response",
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
        },
        // Debug "waiting" phases: follow-up prompts return to same state.
        // These phases never produce structuredOutput (no schema), so they
        // are not gated.
        {
          guard: "isDebugAwaitingReproduction",
          target: "debug.awaitingReproduction",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              return {
                promptCount: context.promptCount + 1,
                totals: result
                  ? accumulateTotals(context.totals, result)
                  : context.totals,
                activeTurn: null,
                status: "awaiting" as const,
                lastActivityAt: new Date().toISOString(),
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
        },
        {
          guard: "isDebugAwaitingVerification",
          target: "debug.awaitingVerification",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              return {
                promptCount: context.promptCount + 1,
                totals: result
                  ? accumulateTotals(context.totals, result)
                  : context.totals,
                activeTurn: null,
                status: "awaiting" as const,
                lastActivityAt: new Date().toISOString(),
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
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
          actions: assign({
            activeTurn: ({ context, event }) =>
              conversationTurnFromEvent(context, event),
            pendingQuestion: null,
            lastError: null,
          }),
        },
        SUBMIT_TASK_RUN: {
          target: "acquiringResources",
          actions: assign({
            activeTurn: ({ context, event }) =>
              taskRunFromEvent(context, event),
            pendingQuestion: null,
            lastError: null,
          }),
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
    // DEBUG — compound state for debug workflow
    // ========================================================
    debug: {
      initial: "hypothesizing",

      on: {
        EXIT_DEBUG_MODE: {
          target: "idle",
          actions: [
            assign({
              debugMode: null,
            }),
            "syncDerivedFields",
            "broadcastDebugModeStatus",
            "persistSnapshot",
          ],
        },
        SET_DEBUG_RECORDING: {
          actions: [
            assign({
              debugMode: ({ context, event }) =>
                context.debugMode
                  ? { ...context.debugMode, recording: event.recording }
                  : null,
            }),
            "syncDerivedFields",
            "broadcastDebugModeStatus",
            "persistSnapshot",
          ],
        },
        CLEAR_DEBUG_LOGS: {
          // Side-effect only; state unchanged.
          // The actual file clear is handled by the API route.
        },
        // Lifted from each substate. The transition body is identical across
        // hypothesizing / awaiting_reproduction / analyzing_evidence /
        // awaiting_verification / cleanup_instrumentation / error,
        // so define it once at the parent and let the child substates inherit.
        SUBMIT_PROMPT: {
          target: "#conversation.acquiringResources",
          actions: assign({
            activeTurn: ({ context, event }) =>
              conversationTurnFromEvent(context, event),
            pendingQuestion: null,
            lastError: null,
          }),
        },
      },

      states: {
        hypothesizing: {
          on: {
            // Strategy B rollback: when MARK_FIX_FAILED → re-hypothesize
            // dispatch fails to send the follow-up prompt, the client undoes
            // the phase advance by sending REVERT_TO_AWAITING_VERIFICATION.
            REVERT_TO_AWAITING_VERIFICATION: {
              target: "awaitingVerification",
              actions: [
                assign({
                  debugMode: ({ context }) =>
                    context.debugMode
                      ? {
                          ...context.debugMode,
                          phase: "awaiting_verification" as const,
                        }
                      : null,
                }),
                "syncDerivedFields",
                "persistSnapshot",
              ],
            },
          },
        },

        awaitingReproduction: {
          on: {
            MARK_REPRODUCED: {
              target: "analyzingEvidence",
              actions: [
                assign({
                  debugMode: ({ context }) =>
                    context.debugMode
                      ? {
                          ...context.debugMode,
                          phase: "analyzing_evidence" as const,
                        }
                      : null,
                }),
                "syncDerivedFields",
                "persistSnapshot",
              ],
            },
          },
        },

        analyzingEvidence: {
          on: {
            REVERT_TO_AWAITING_REPRODUCTION: {
              target: "awaitingReproduction",
              actions: [
                assign({
                  debugMode: ({ context }) =>
                    context.debugMode
                      ? {
                          ...context.debugMode,
                          phase: "awaiting_reproduction" as const,
                        }
                      : null,
                }),
                "syncDerivedFields",
                "persistSnapshot",
              ],
            },
          },
        },

        awaitingVerification: {
          on: {
            MARK_FIX_VERIFIED: {
              target: "cleanupInstrumentation",
              actions: [
                assign({
                  debugMode: ({ context }) =>
                    context.debugMode
                      ? {
                          ...context.debugMode,
                          phase: "cleanup_instrumentation" as const,
                        }
                      : null,
                }),
                "syncDerivedFields",
                "persistSnapshot",
              ],
            },
            // User has tested the agent's claimed fix and confirmed the bug
            // still reproduces. Loop back to hypothesizing so the agent can
            // form a fresh hypothesis set (treating the prior fix as
            // refuted). fixSummary is preserved for the re-hypothesize
            // prompt, which references the prior attempt; verificationSteps
            // are cleared because they pertained to the failed fix.
            MARK_FIX_FAILED: {
              target: "hypothesizing",
              actions: [
                assign({
                  debugMode: ({ context }) =>
                    context.debugMode
                      ? {
                          ...context.debugMode,
                          phase: "hypothesizing" as const,
                          verificationSteps: [],
                        }
                      : null,
                }),
                "syncDerivedFields",
                "persistSnapshot",
              ],
            },
          },
        },

        cleanupInstrumentation: {
          on: {
            REVERT_TO_AWAITING_VERIFICATION: {
              target: "awaitingVerification",
              actions: [
                assign({
                  debugMode: ({ context }) =>
                    context.debugMode
                      ? {
                          ...context.debugMode,
                          phase: "awaiting_verification" as const,
                        }
                      : null,
                }),
                "syncDerivedFields",
                "persistSnapshot",
              ],
            },
          },
        },

        // Cross-checks the agent's debugCleanupResultOutput against the
        // persisted instrumentation manifest. Only on a passing verification
        // does the conversation leave debug mode and physically delete the
        // manifest. A failing verification routes to debug.error with a
        // structured remediation message so the agent can be re-prompted.
        verifyingCleanup: {
          invoke: {
            src: "verifyCleanup",
            input: ({ context }): VerifyCleanupInput => {
              const parsed = debugCleanupResultZodSchema.safeParse(
                context.lastResult?.structuredOutput,
              );
              const cleanup = parsed.success
                ? parsed.data
                : {
                    removedInstrumentation: false,
                    filesModified: [],
                    grepVerificationPassed: false,
                    acknowledgesManifestDeletionContract: false,
                    notes: "Cleanup payload failed schema validation.",
                  };
              return {
                worktreePath: context.worktreePath,
                conversationId: context.conversationId,
                cleanup,
              };
            },
            onDone: [
              {
                guard: ({ event }) => event.output.ok === true,
                target: "#conversation.idle",
                actions: [
                  assign({
                    debugMode: null,
                    activeTurn: null,
                  }),
                  "syncDerivedFields",
                  "broadcastConversationStatus",
                  "broadcastDebugModeStatus",
                  "persistSnapshot",
                ],
              },
              {
                target: "error",
                actions: [
                  assign(({ event }) => ({
                    lastError: event.output.remediationPrompt,
                  })),
                  "syncDerivedFields",
                  "broadcastConversationStatus",
                  "persistSnapshot",
                ],
              },
            ],
            onError: {
              target: "error",
              actions: [
                assign({
                  lastError: ({ event }) =>
                    `Cleanup verification failed: ${extractError(event.error)}`,
                }),
                "syncDerivedFields",
                "broadcastConversationStatus",
                "persistSnapshot",
              ],
            },
          },
        },

        // Reached when a phase-advancing turn produced no valid structured
        // output. Phase is preserved so RETRY re-runs the same turn against
        // the same schema. SUBMIT_PROMPT (inherited from the parent debug
        // state) replaces the failed turn with a new prompt; EXIT_DEBUG_MODE
        // is also inherited from the parent debug state.
        // The lastTurnFailed flag is toggled on entry/exit so that on
        // actor rehydration (server restart) the idle.always restoration
        // routes back into debug.error rather than the bare phase substate.
        error: {
          entry: assign({
            debugMode: ({ context }) =>
              context.debugMode
                ? { ...context.debugMode, lastTurnFailed: true }
                : null,
          }),
          exit: assign({
            debugMode: ({ context }) =>
              context.debugMode
                ? { ...context.debugMode, lastTurnFailed: false }
                : null,
          }),
          on: {
            RETRY_DEBUG_TURN: {
              guard: ({ context }) => context.activeTurn != null,
              target: "#conversation.acquiringResources",
              actions: assign({
                lastError: null,
              }),
            },
          },
        },
      },
    },
  },

  output: ({ context }): ConversationOutput => ({
    conversationId: context.conversationId,
    status: context.status,
    error: context.lastError,
  }),
});

/** Type alias for the conversation actor reference. */
export type ConversationActorRef = ActorRefFrom<typeof conversationMachine>;
