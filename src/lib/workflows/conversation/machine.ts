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
 *  ├─ hypothesizing                 ├─ running ◄─── ANSWER ───┐
 *  ├─ awaitingReproduction          │    │                     │
 *  ├─ analyzingEvidence             │    │ ASK_QUESTION        │
 *  ├─ fixing                        │    v                     │
 *  ├─ awaitingVerification          └─ waitingForInput ────────┘
 *  └─ cleanupInstrumentation
 *                                 PROMPT_COMPLETED / PROMPT_FAILED / ABORT_TURN
 *                                             │
 *                                             v
 *                                       finalizingTurn
 *                                             │
 *                                             v
 *                                      idle / debug.*
 */

import { setup, assign, and, type ActorRefFrom } from "xstate";
import type {
  ConversationContext,
  ConversationEvent,
  ConversationInput,
  ConversationOutput,
  PrepareTurnInput,
  ExecutePromptInput,
  PromptActorResult,
} from "./types";
import { prepareTurnActor, executePromptActor } from "./actors";
import type { DebugEvidenceAnalysisOutput } from "./debug-schemas";
import {
  debugHypothesisOutputSchema,
  debugEvidenceAnalysisSchema,
  debugFixResultSchema,
  debugCleanupResultSchema,
} from "./debug-schemas";

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
  },

  guards: {
    isDebugModeActive: ({ context }) => context.debugMode?.active === true,
    isDebugHypothesizing: ({ context }) =>
      context.debugMode?.phase === "hypothesizing",
    isDebugAnalyzing: ({ context }) =>
      context.debugMode?.phase === "analyzing_evidence",
    isDebugFixing: ({ context }) => context.debugMode?.phase === "fixing",
    isDebugAwaitingReproduction: ({ context }) =>
      context.debugMode?.phase === "awaiting_reproduction",
    isDebugAwaitingVerification: ({ context }) =>
      context.debugMode?.phase === "awaiting_verification",
    isDebugCleanup: ({ context }) =>
      context.debugMode?.phase === "cleanup_instrumentation",
    shouldLoopBackToHypothesizing: ({ context }) => {
      const structured = context.lastResult
        ?.structuredOutput as DebugEvidenceAnalysisOutput | null;
      return structured?.recommendedNextStep === "more_instrumentation";
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
  },
}).createMachine({
  id: "conversation",

  context: ({ input }): ConversationContext => ({
    _schemaVersion: 1,
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
    claudeSessionId: input.claudeSessionId,
    forkedFrom: input.forkedFrom,
    role: input.role,
    activeTurn: null,
    pendingQuestion: null,
    debugMode: null,
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
      on: {
        SUBMIT_PROMPT: {
          target: "acquiringResources",
          actions: assign({
            activeTurn: ({ event }) => ({
              promptText: event.promptText,
              images: event.images ?? [],
              modelId: event.modelId ?? null,
              effort: event.effort ?? null,
              autonomous: event.autonomous ?? false,
              startedAt: new Date().toISOString(),
              streamId: event.streamId,
              outputFormat: event.outputFormat,
            }),
            lastError: null,
          }),
        },
        ENTER_DEBUG_MODE: {
          target: "debug",
          actions: [
            assign({
              debugMode: ({ event }) => ({
                active: true,
                recording: false,
                logFilePath: event.logFilePath,
                enteredAt: new Date().toISOString(),
                hypotheses: [],
                instructionsDelivered: false,
                phase: "hypothesizing" as const,
              }),
            }),
            "syncDerivedFields",
            "broadcastDebugModeStatus",
            "persistSnapshot",
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
    // EXECUTING — compound state: invoke stays alive across
    // running ↔ waitingForInput transitions
    // ========================================================
    executing: {
      initial: "running",

      invoke: {
        src: "executePrompt",
        input: ({ context }): ExecutePromptInput => {
          // Explicit outputFormat (e.g. from validator) takes priority over debug-phase-derived
          const outputFormat =
            context.activeTurn?.outputFormat ??
            (() => {
              const phase = context.debugMode?.phase;
              if (phase === "hypothesizing") {
                return {
                  type: "json_schema" as const,
                  schema: debugHypothesisOutputSchema as Record<
                    string,
                    unknown
                  >,
                };
              }
              if (phase === "analyzing_evidence") {
                return {
                  type: "json_schema" as const,
                  schema: debugEvidenceAnalysisSchema as Record<
                    string,
                    unknown
                  >,
                };
              }
              if (phase === "fixing") {
                return {
                  type: "json_schema" as const,
                  schema: debugFixResultSchema as Record<string, unknown>,
                };
              }
              if (phase === "cleanup_instrumentation") {
                return {
                  type: "json_schema" as const,
                  schema: debugCleanupResultSchema as Record<string, unknown>,
                };
              }
              return undefined;
            })();

          return {
            projectPath: context.projectPath,
            projectName: context.projectName,
            sessionName: context.sessionName,
            worktreePath: context.worktreePath,
            conversationId: context.conversationId,
            transcriptPath: context.transcriptPath!,
            claudeSessionId: context.claudeSessionId,
            forkedFrom: context.forkedFrom,
            role: context.role,
            promptText: context.activeTurn!.promptText,
            images: context.activeTurn!.images,
            modelId: context.activeTurn!.modelId,
            effort: context.activeTurn!.effort,
            autonomous: context.activeTurn!.autonomous,
            debugMode: context.debugMode,
            outputFormat,
          };
        },
        onDone: {
          target: "#conversation.finalizingTurn",
          actions: assign({
            lastResult: ({ event }) => event.output,
            claudeSessionId: ({ context, event }) =>
              event.output.sessionId ?? context.claudeSessionId,
          }),
        },
        onError: {
          target: "#conversation.finalizingTurn",
          actions: assign({
            lastError: ({ event }) => extractError(event.error),
          }),
        },
      },

      // Parent-level events — handled in both running and waitingForInput
      on: {
        SDK_INIT: {
          actions: assign({
            claudeSessionId: ({ event }) => event.sessionId,
          }),
        },
        PROMPT_COMPLETED: {
          target: "#conversation.finalizingTurn",
          actions: assign({
            lastResult: ({ event }) => event.result,
            claudeSessionId: ({ context, event }) =>
              event.result.sessionId ?? context.claudeSessionId,
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
      },

      states: {
        running: {
          on: {
            ASK_QUESTION: {
              target: "waitingForInput",
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
        },

        waitingForInput: {
          on: {
            ANSWER: {
              target: "running",
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
        },
      },
    },

    // ========================================================
    // FINALIZING TURN — update metadata, release resources
    // ========================================================
    finalizingTurn: {
      always: [
        // Debug mode: route back to appropriate debug phase
        {
          guard: "isDebugHypothesizing",
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
                debugMode: context.debugMode
                  ? {
                      ...context.debugMode,
                      phase: "awaiting_reproduction" as const,
                      instructionsDelivered: true,
                    }
                  : null,
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "dispatchPushNotification",
            "persistSnapshot",
          ],
        },
        // Evidence analysis: loop back to hypothesizing if more instrumentation needed
        {
          guard: and(["isDebugAnalyzing", "shouldLoopBackToHypothesizing"]),
          target: "debug.hypothesizing",
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
                debugMode: context.debugMode
                  ? {
                      ...context.debugMode,
                      phase: "hypothesizing" as const,
                    }
                  : null,
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
        },
        // Evidence analysis: proceed to fixing (default path)
        {
          guard: "isDebugAnalyzing",
          target: "debug.fixing",
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
                debugMode: context.debugMode
                  ? {
                      ...context.debugMode,
                      phase: "fixing" as const,
                    }
                  : null,
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
        },
        {
          guard: "isDebugFixing",
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
                debugMode: context.debugMode
                  ? {
                      ...context.debugMode,
                      phase: "awaiting_verification" as const,
                    }
                  : null,
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
        },
        // Debug "waiting" phases: follow-up prompts return to same state
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
        // Debug cleanup done: exit debug mode entirely
        {
          guard: "isDebugCleanup",
          target: "idle",
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
                debugMode: null,
              };
            }),
            "syncDerivedFields",
            "releaseResources",
            "broadcastConversationStatus",
            "broadcastDebugModeStatus",
            "persistSnapshot",
          ],
        },
        // Default: not in debug mode
        {
          target: "idle",
          actions: [
            assign(({ context }) => {
              const result = context.lastResult;
              return {
                promptCount:
                  context.activeTurn != null
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
            "persistSnapshot",
          ],
        },
      ],
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
      },

      states: {
        hypothesizing: {
          on: {
            SUBMIT_PROMPT: {
              target: "#conversation.acquiringResources",
              actions: assign({
                activeTurn: ({ event }) => ({
                  promptText: event.promptText,
                  images: event.images ?? [],
                  modelId: event.modelId ?? null,
                  effort: event.effort ?? null,
                  autonomous: event.autonomous ?? false,
                  startedAt: new Date().toISOString(),
                  streamId: event.streamId,
                  outputFormat: event.outputFormat,
                }),
                lastError: null,
              }),
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
            SUBMIT_PROMPT: {
              target: "#conversation.acquiringResources",
              actions: assign({
                activeTurn: ({ event }) => ({
                  promptText: event.promptText,
                  images: event.images ?? [],
                  modelId: event.modelId ?? null,
                  effort: event.effort ?? null,
                  autonomous: event.autonomous ?? false,
                  startedAt: new Date().toISOString(),
                  streamId: event.streamId,
                  outputFormat: event.outputFormat,
                }),
                lastError: null,
              }),
            },
          },
        },

        analyzingEvidence: {
          on: {
            SUBMIT_PROMPT: {
              target: "#conversation.acquiringResources",
              actions: assign({
                activeTurn: ({ event }) => ({
                  promptText: event.promptText,
                  images: event.images ?? [],
                  modelId: event.modelId ?? null,
                  effort: event.effort ?? null,
                  autonomous: event.autonomous ?? false,
                  startedAt: new Date().toISOString(),
                  streamId: event.streamId,
                  outputFormat: event.outputFormat,
                }),
                lastError: null,
              }),
            },
          },
        },

        fixing: {
          on: {
            SUBMIT_PROMPT: {
              target: "#conversation.acquiringResources",
              actions: assign({
                activeTurn: ({ event }) => ({
                  promptText: event.promptText,
                  images: event.images ?? [],
                  modelId: event.modelId ?? null,
                  effort: event.effort ?? null,
                  autonomous: event.autonomous ?? false,
                  startedAt: new Date().toISOString(),
                  streamId: event.streamId,
                  outputFormat: event.outputFormat,
                }),
                lastError: null,
              }),
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
            SUBMIT_PROMPT: {
              target: "#conversation.acquiringResources",
              actions: assign({
                activeTurn: ({ event }) => ({
                  promptText: event.promptText,
                  images: event.images ?? [],
                  modelId: event.modelId ?? null,
                  effort: event.effort ?? null,
                  autonomous: event.autonomous ?? false,
                  startedAt: new Date().toISOString(),
                  streamId: event.streamId,
                  outputFormat: event.outputFormat,
                }),
                lastError: null,
              }),
            },
          },
        },

        cleanupInstrumentation: {
          on: {
            SUBMIT_PROMPT: {
              target: "#conversation.acquiringResources",
              actions: assign({
                activeTurn: ({ event }) => ({
                  promptText: event.promptText,
                  images: event.images ?? [],
                  modelId: event.modelId ?? null,
                  effort: event.effort ?? null,
                  autonomous: event.autonomous ?? false,
                  startedAt: new Date().toISOString(),
                  streamId: event.streamId,
                  outputFormat: event.outputFormat,
                }),
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
