/**
 * Circuit Breaker XState v5 Sub-Machine.
 *
 * Wraps the pure-function circuit breaker logic from
 * src/lib/ralph-loop/circuit-breaker.ts in an XState machine
 * with explicit states: closed → halfOpen → open.
 *
 * States:
 *   closed     — Normal operation. Counts consecutive no-progress iterations.
 *   halfOpen   — Probation after hitting noProgressThreshold. One more
 *                no-progress opens; progress returns to closed.
 *   open       — Terminal. Requires external RESET to recover.
 *
 * Events:
 *   ITERATION_RESULT  — Report an iteration outcome (progress/no_progress + optional error).
 *   RESET             — Reset to closed state (user-initiated).
 */

import { setup, assign } from "xstate";

// ============================================================
// Types
// ============================================================

export interface CircuitBreakerMachineContext {
  /** Consecutive iterations with no progress. */
  consecutiveNoProgress: number;
  /** Consecutive iterations with the same error pattern. */
  consecutiveSameError: number;
  /** The last observed error pattern (null if none). */
  lastErrorPattern: string | null;
  /** Iteration number of the last progress detection. */
  lastProgressIteration: number;
  /** Threshold: consecutive no-progress before entering halfOpen. */
  noProgressThreshold: number;
  /** Threshold: consecutive same-error before opening. */
  sameErrorThreshold: number;
}

export interface CircuitBreakerMachineInput {
  noProgressThreshold?: number;
  sameErrorThreshold?: number;
}

export type CircuitBreakerMachineEvent =
  | {
      type: "ITERATION_RESULT";
      classification: "progress" | "no_progress";
      errorPattern?: string;
    }
  | { type: "RESET" };

// ============================================================
// Guards (pure helpers)
// ============================================================

function hasProgress(event: CircuitBreakerMachineEvent): boolean {
  return (
    event.type === "ITERATION_RESULT" && event.classification === "progress"
  );
}

function hasNoProgress(event: CircuitBreakerMachineEvent): boolean {
  return (
    event.type === "ITERATION_RESULT" && event.classification === "no_progress"
  );
}

function sameErrorThresholdReached(
  context: CircuitBreakerMachineContext,
  event: CircuitBreakerMachineEvent,
): boolean {
  if (event.type !== "ITERATION_RESULT" || !event.errorPattern) return false;
  const nextCount =
    event.errorPattern === context.lastErrorPattern
      ? context.consecutiveSameError + 1
      : 1;
  return nextCount >= context.sameErrorThreshold;
}

function noProgressThresholdReached(
  context: CircuitBreakerMachineContext,
  event: CircuitBreakerMachineEvent,
): boolean {
  if (!hasNoProgress(event)) return false;
  return context.consecutiveNoProgress + 1 >= context.noProgressThreshold;
}

// ============================================================
// Machine
// ============================================================

export const circuitBreakerMachine = setup({
  types: {
    context: {} as CircuitBreakerMachineContext,
    events: {} as CircuitBreakerMachineEvent,
    input: {} as CircuitBreakerMachineInput,
  },
  guards: {
    hasProgress: ({ event }) => hasProgress(event),
    hasNoProgress: ({ event }) => hasNoProgress(event),
    sameErrorThresholdReached: ({ context, event }) =>
      sameErrorThresholdReached(context, event),
    noProgressThresholdReached: ({ context, event }) =>
      noProgressThresholdReached(context, event),
  },
  actions: {
    updateCountersOnProgress: assign({
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
      lastProgressIteration: ({ context }) => context.lastProgressIteration + 1,
    }),
    updateCountersOnNoProgress: assign({
      consecutiveNoProgress: ({ context }) => context.consecutiveNoProgress + 1,
      consecutiveSameError: ({ context, event }) => {
        if (event.type !== "ITERATION_RESULT")
          return context.consecutiveSameError;
        if (!event.errorPattern) return 0;
        return event.errorPattern === context.lastErrorPattern
          ? context.consecutiveSameError + 1
          : 1;
      },
      lastErrorPattern: ({ context, event }) => {
        if (event.type !== "ITERATION_RESULT") return context.lastErrorPattern;
        return event.errorPattern ?? null;
      },
    }),
    updateErrorCounters: assign({
      consecutiveSameError: ({ context, event }) => {
        if (event.type !== "ITERATION_RESULT")
          return context.consecutiveSameError;
        if (!event.errorPattern) return 0;
        return event.errorPattern === context.lastErrorPattern
          ? context.consecutiveSameError + 1
          : 1;
      },
      lastErrorPattern: ({ context, event }) => {
        if (event.type !== "ITERATION_RESULT") return context.lastErrorPattern;
        return event.errorPattern ?? null;
      },
    }),
    resetCounters: assign({
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
    }),
  },
}).createMachine({
  id: "circuitBreaker",
  context: ({ input }) => ({
    consecutiveNoProgress: 0,
    consecutiveSameError: 0,
    lastErrorPattern: null,
    lastProgressIteration: 0,
    noProgressThreshold: input.noProgressThreshold ?? 3,
    sameErrorThreshold: input.sameErrorThreshold ?? 5,
  }),
  initial: "closed",
  states: {
    closed: {
      on: {
        ITERATION_RESULT: [
          // Same error threshold → open (highest priority)
          {
            guard: "sameErrorThresholdReached",
            target: "open",
            actions: "updateErrorCounters",
          },
          // No progress threshold reached → halfOpen
          {
            guard: "noProgressThresholdReached",
            target: "halfOpen",
            actions: "updateCountersOnNoProgress",
          },
          // No progress but below threshold → stay closed
          {
            guard: "hasNoProgress",
            actions: "updateCountersOnNoProgress",
          },
          // Progress → reset counters
          {
            guard: "hasProgress",
            actions: "updateCountersOnProgress",
          },
        ],
        RESET: {
          target: "closed",
          actions: "resetCounters",
          reenter: true,
        },
      },
    },

    halfOpen: {
      on: {
        ITERATION_RESULT: [
          // Same error threshold → open
          {
            guard: "sameErrorThresholdReached",
            target: "open",
            actions: "updateErrorCounters",
          },
          // No progress during probation → open
          {
            guard: "hasNoProgress",
            target: "open",
            actions: "updateCountersOnNoProgress",
          },
          // Progress during probation → back to closed
          {
            guard: "hasProgress",
            target: "closed",
            actions: "updateCountersOnProgress",
          },
        ],
        RESET: {
          target: "closed",
          actions: "resetCounters",
        },
      },
    },

    open: {
      type: "final",
    },
  },
});

/**
 * Extract the state name matching CircuitBreakerStateEnum from
 * the machine's current snapshot value.
 */
export function mapMachineStateToEnum(
  value: string,
): "closed" | "half_open" | "open" {
  switch (value) {
    case "halfOpen":
      return "half_open";
    case "closed":
    case "open":
      return value;
    default:
      return "closed";
  }
}
