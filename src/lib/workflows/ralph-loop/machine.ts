/**
 * Ralph Loop XState v5 Machine.
 *
 * Models the full autonomous iteration workflow:
 *
 *   planning ─→ generatingPlan ─→ awaitingConfirmation ─→ running ─→ completed
 *                                                           │
 *                                     ┌─────────────────────┤
 *                                     ▼                     ▼
 *                                   paused               halted
 *                                     │
 *                                     └──→ running (on RESUME)
 *
 *   running (compound):
 *     executingIteration ─→ evaluatingExit ─→ executingIteration (continue)
 *                                           ─→ #completed (plan complete)
 *                                           ─→ #halted (cap/circuit/perm/test/stalled)
 *
 * Events:
 *   GENERATE_PLAN     — Trigger plan generation from planning state
 *   PLAN_GENERATED    — Plan generation succeeded (carries tasks)
 *   PLAN_GENERATION_FAILED — Plan generation failed
 *   CONFIRM_PLAN      — User confirms plan, start running
 *   PAUSE             — Pause between iterations
 *   RESUME            — Resume from paused state
 *   ABORT             — Abort from any active state
 */

import { setup, assign, fromPromise } from "xstate";
import type {
  RalphLoopContext,
  RalphLoopInput,
  RalphLoopEvent,
  RalphLoopOutput,
  GeneratePlanInput,
  GeneratePlanOutput,
  RunIterationInput,
  RunIterationOutput,
} from "./types";
import { generatePlanActor, runIterationActor } from "./actors";
import { haltReasonToTerminalStatus } from "@/lib/ralph-loop/exit-detector";

// Guards replicate exit-detector.ts logic inline for XState type safety.
// The pure functions in exit-detector.ts remain the canonical reference.

const SCHEMA_VERSION = 1;

// ============================================================
// Machine Definition
// ============================================================

export const ralphLoopMachine = setup({
  types: {
    context: {} as RalphLoopContext,
    events: {} as RalphLoopEvent,
    input: {} as RalphLoopInput,
    output: {} as RalphLoopOutput,
  },

  actors: {
    generatePlan: generatePlanActor as ReturnType<
      typeof fromPromise<GeneratePlanOutput, GeneratePlanInput>
    >,
    runIteration: runIterationActor as ReturnType<
      typeof fromPromise<RunIterationOutput, RunIterationInput>
    >,
  },

  guards: {
    /** Plan complete — all tasks resolved (completed or skipped). */
    isPlanComplete: ({ context }) => {
      if (!context.lastIterationResult) return false;
      const plan = context.lastIterationResult.updatedFixPlan;
      if (plan.length === 0) return false;
      return plan.every(
        (task) => task.status === "completed" || task.status === "skipped",
      );
    },

    /** Iteration cap reached. */
    isIterationCapReached: ({ context }) => {
      const lastIter = context.iterations[context.iterations.length - 1];
      if (!lastIter) return false;
      return lastIter.iterationNumber >= context.config.maxIterations;
    },

    /** Circuit breaker is open. */
    isCircuitBreakerOpen: ({ context }) => {
      return context.circuitBreaker.state === "open";
    },

    /** Permission denied — 2+ consecutive iterations with permission denial. */
    isPermissionDenied: ({ context }) => {
      const iterations = context.iterations;
      if (iterations.length < 2) return false;
      let consecutive = 0;
      for (let i = iterations.length - 1; i >= 0; i--) {
        const iter = iterations[i];
        if (!iter) break;
        const report = iter.statusReport;
        if (
          report?.status === "blocked" &&
          report.work_summary.toLowerCase().includes("permission")
        ) {
          consecutive++;
          if (consecutive >= 2) return true;
        } else {
          break;
        }
      }
      return false;
    },

    /** Test saturation — 3+ of last 5 iterations are test-only. */
    isTestSaturated: ({ context }) => {
      const iterations = context.iterations;
      const last5 = iterations.slice(-5);
      if (last5.length < 3) return false;
      const testOnlyCount = last5.filter(
        (iter) => iter.statusReport?.work_type === "testing",
      ).length;
      return testOnlyCount >= 3;
    },

    /** Stalled exit signal — 2+ of last 3 signal exit but tasks remain. */
    isStalledExitSignal: ({ context }) => {
      const iterations = context.iterations;
      const last3 = iterations.slice(-3);
      if (last3.length < 2) return false;
      const exitSignalCount = last3.filter(
        (iter) => iter.statusReport?.exit_signal === true,
      ).length;
      if (exitSignalCount < 2) return false;
      const unresolvedCount = context.fixPlan.filter(
        (task) => task.status !== "completed" && task.status !== "skipped",
      ).length;
      return unresolvedCount > 0;
    },

    /** Has tasks in the plan (ready to run without plan generation). */
    hasTasks: ({ context }) => context.fixPlan.length > 0,
  },

  actions: {
    /** Record the start timestamp. */
    recordStart: assign({
      startedAt: () => new Date().toISOString(),
    }),

    /** Set generatingPlan flag. */
    setGeneratingPlan: assign({
      generatingPlan: true,
    }),

    /** Clear generatingPlan flag. */
    clearGeneratingPlan: assign({
      generatingPlan: false,
    }),

    // storeIterationResult and storeIterationError are inline assigns in
    // the onDone/onError handlers (required to access event.output).

    /** Set halt reason for plan_complete. */
    setHaltPlanComplete: assign({
      haltReason: () => ({ type: "plan_complete" as const }),
      completedAt: () => new Date().toISOString(),
    }),

    /** Set halt reason for iteration_cap. */
    setHaltIterationCap: assign({
      haltReason: ({ context }) => ({
        type: "iteration_cap" as const,
        maxIterations: context.config.maxIterations,
      }),
      completedAt: () => new Date().toISOString(),
    }),

    /** Set halt reason for circuit_breaker. */
    setHaltCircuitBreaker: assign({
      haltReason: () => ({
        type: "circuit_breaker" as const,
        reason: "no_progress" as const,
      }),
      completedAt: () => new Date().toISOString(),
    }),

    /** Set halt reason for permission_denied. */
    setHaltPermissionDenied: assign({
      haltReason: () => ({ type: "permission_denied" as const }),
      completedAt: () => new Date().toISOString(),
    }),

    /** Set halt reason for test_saturation. */
    setHaltTestSaturation: assign({
      haltReason: () => ({ type: "test_saturation" as const }),
      completedAt: () => new Date().toISOString(),
    }),

    /** Set halt reason for stalled_exit_signal. */
    setHaltStalledExitSignal: assign({
      haltReason: ({ context }) => ({
        type: "stalled_exit_signal" as const,
        remainingTasks: context.fixPlan.filter(
          (t) => t.status !== "completed" && t.status !== "skipped",
        ).length,
      }),
      completedAt: () => new Date().toISOString(),
    }),

    /** Set halt reason for abort. */
    setAborted: assign({
      haltReason: () => ({ type: "aborted" as const }),
      completedAt: () => new Date().toISOString(),
    }),

    /** No-op action for SSE broadcasting — overridden via .provide() in production. */
    broadcastWorkflowStatus: () => {},

    /** No-op action for SSE iteration-complete broadcast. */
    broadcastIterationComplete: () => {},

    /** No-op action for SSE circuit-breaker broadcast. */
    broadcastCircuitBreaker: () => {},

    /** No-op action for persisting snapshot. */
    persistSnapshot: () => {},
  },
}).createMachine({
  id: "ralphLoop",
  context: ({ input }) => ({
    _schemaVersion: SCHEMA_VERSION,
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    startedAt: new Date().toISOString(),
    completedAt: null,
    objective: input.objective,
    config: input.config,
    fixPlan: input.fixPlan,
    iterations: input.iterations ?? [],
    circuitBreaker: input.circuitBreaker ?? {
      state: "closed",
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
      lastProgressIteration: 0,
    },
    haltReason: null,
    generatingPlan: false,
    totalCostUsd: input.totalCostUsd ?? 0,
    totalDurationMs: input.totalDurationMs ?? 0,
    worktreePath: input.worktreePath,
    peakContextTokens: 0,
    lastIterationResult: null,
  }),

  initial: "planning",

  // Global ABORT handler: works from any non-final state
  on: {
    ABORT: {
      target: ".aborted",
      actions: "setAborted",
    },
  },

  states: {
    // ──────────────────────────────────────────────────────
    // Planning: initial state, user can generate plan or skip
    // ──────────────────────────────────────────────────────
    planning: {
      on: {
        GENERATE_PLAN: {
          target: "generatingPlan",
          actions: "setGeneratingPlan",
        },
        // If plan already has tasks, user can confirm directly
        CONFIRM_PLAN: {
          guard: "hasTasks",
          target: "running",
          actions: "recordStart",
        },
      },
    },

    // ──────────────────────────────────────────────────────
    // Generating Plan: invoke plan generation actor
    // ──────────────────────────────────────────────────────
    generatingPlan: {
      invoke: {
        src: "generatePlan",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          worktreePath: context.worktreePath,
          objective: context.objective,
          existingFixPlan: context.fixPlan,
        }),
        onDone: {
          target: "awaitingConfirmation",
          actions: [
            assign({
              fixPlan: ({ context, event }) => [
                ...context.fixPlan,
                ...event.output.tasks,
              ],
              generatingPlan: false,
            }),
          ],
        },
        onError: {
          target: "awaitingConfirmation",
          actions: "clearGeneratingPlan",
        },
      },
    },

    // ──────────────────────────────────────────────────────
    // Awaiting Confirmation: wait for user to confirm plan
    // ──────────────────────────────────────────────────────
    awaitingConfirmation: {
      on: {
        CONFIRM_PLAN: {
          target: "running",
          actions: "recordStart",
        },
        GENERATE_PLAN: {
          target: "generatingPlan",
          actions: "setGeneratingPlan",
        },
      },
    },

    // ──────────────────────────────────────────────────────
    // Running: compound state with iteration sub-states
    // ──────────────────────────────────────────────────────
    running: {
      entry: "broadcastWorkflowStatus",

      on: {
        PAUSE: {
          target: "paused",
          actions: "persistSnapshot",
        },
      },

      initial: "executingIteration",
      states: {
        executingIteration: {
          invoke: {
            src: "runIteration",
            input: ({ context }) => ({
              projectPath: context.projectPath,
              sessionName: context.sessionName,
              projectName: context.projectName,
              worktreePath: context.worktreePath,
              objective: context.objective,
              fixPlan: context.fixPlan,
              config: context.config,
              iterationNumber: context.iterations.length + 1,
              previousIterations: context.iterations,
            }),
            onDone: {
              target: "evaluatingExit",
              actions: [
                assign({
                  lastIterationResult: ({ event }) => event.output,
                  iterations: ({ context, event }) => [
                    ...context.iterations,
                    event.output.iteration,
                  ],
                  fixPlan: ({ event }) => event.output.updatedFixPlan,
                  circuitBreaker: ({ event }) =>
                    event.output.updatedCircuitBreaker,
                  totalCostUsd: ({ context, event }) =>
                    context.totalCostUsd + event.output.iteration.costUsd,
                  totalDurationMs: ({ context, event }) =>
                    context.totalDurationMs + event.output.iteration.durationMs,
                  peakContextTokens: ({ context, event }) =>
                    Math.max(
                      context.peakContextTokens,
                      event.output.iteration.peakContextTokens,
                    ),
                }),
                "broadcastIterationComplete",
                "broadcastCircuitBreaker",
                "persistSnapshot",
              ],
            },
            onError: {
              target: "evaluatingExit",
              actions: assign({
                lastIterationResult: () => null,
              }),
            },
          },
        },

        evaluatingExit: {
          always: [
            // Priority 1: Plan complete → completed (success)
            {
              guard: "isPlanComplete",
              target: "#ralphLoop.completed",
              actions: "setHaltPlanComplete",
            },
            // Priority 2: Iteration cap → halted
            {
              guard: "isIterationCapReached",
              target: "#ralphLoop.halted",
              actions: "setHaltIterationCap",
            },
            // Priority 3: Circuit breaker open → halted
            {
              guard: "isCircuitBreakerOpen",
              target: "#ralphLoop.halted",
              actions: "setHaltCircuitBreaker",
            },
            // Priority 4: Permission denied → halted
            {
              guard: "isPermissionDenied",
              target: "#ralphLoop.halted",
              actions: "setHaltPermissionDenied",
            },
            // Priority 5: Test saturation → halted
            {
              guard: "isTestSaturated",
              target: "#ralphLoop.halted",
              actions: "setHaltTestSaturation",
            },
            // Priority 6: Stalled exit signal → halted
            {
              guard: "isStalledExitSignal",
              target: "#ralphLoop.halted",
              actions: "setHaltStalledExitSignal",
            },
            // Default: continue to next iteration
            {
              target: "executingIteration",
            },
          ],
        },
      },
    },

    // ──────────────────────────────────────────────────────
    // Paused: waiting for user to resume
    // ──────────────────────────────────────────────────────
    paused: {
      entry: "broadcastWorkflowStatus",
      on: {
        RESUME: {
          target: "running",
        },
      },
    },

    // ──────────────────────────────────────────────────────
    // Terminal States
    // ──────────────────────────────────────────────────────
    completed: {
      type: "final",
      entry: ["broadcastWorkflowStatus", "persistSnapshot"],
    },

    halted: {
      type: "final",
      entry: ["broadcastWorkflowStatus", "persistSnapshot"],
    },

    aborted: {
      type: "final",
      entry: ["broadcastWorkflowStatus", "persistSnapshot"],
    },
  },

  output: ({ context }) => ({
    status: context.haltReason
      ? haltReasonToTerminalStatus(context.haltReason)
      : ("halted" as const),
    haltReason: context.haltReason,
    iterations: context.iterations,
    totalCostUsd: context.totalCostUsd,
    totalDurationMs: context.totalDurationMs,
  }),
});
