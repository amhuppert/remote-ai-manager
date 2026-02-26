import type { CircuitBreakerState, CircuitBreakerConfig } from "@/types";

export interface IterationProgressResult {
  classification: "progress" | "no_progress";
  errorPattern?: string;
}

/** Create an initial closed circuit breaker state. */
export function createInitialCircuitBreakerState(): CircuitBreakerState {
  return {
    state: "closed",
    consecutiveNoProgress: 0,
    consecutiveSameError: 0,
    lastErrorPattern: null,
    lastProgressIteration: 0,
  };
}

/**
 * Process an iteration result and return the updated circuit breaker state.
 * Pure function: takes current state + iteration result, returns new state.
 */
export function processIteration(
  current: CircuitBreakerState,
  result: IterationProgressResult,
  config: CircuitBreakerConfig,
): CircuitBreakerState {
  const next = { ...current };

  // Track same-error count
  if (result.errorPattern) {
    if (result.errorPattern === current.lastErrorPattern) {
      next.consecutiveSameError = current.consecutiveSameError + 1;
    } else {
      next.consecutiveSameError = 1;
      next.lastErrorPattern = result.errorPattern;
    }

    // Open directly on repeated same error
    if (next.consecutiveSameError >= config.sameErrorThreshold) {
      next.state = "open";
      return next;
    }
  } else {
    next.consecutiveSameError = 0;
    next.lastErrorPattern = null;
  }

  // Handle state transitions based on progress
  switch (current.state) {
    case "closed": {
      if (result.classification === "no_progress") {
        next.consecutiveNoProgress = current.consecutiveNoProgress + 1;
        if (next.consecutiveNoProgress >= config.noProgressThreshold) {
          next.state = "half_open";
        }
      } else {
        next.consecutiveNoProgress = 0;
        next.lastProgressIteration = current.lastProgressIteration + 1;
      }
      break;
    }

    case "half_open": {
      if (result.classification === "no_progress") {
        // Recovery attempt failed — open the breaker
        next.state = "open";
      } else {
        // Recovery succeeded — back to closed
        next.state = "closed";
        next.consecutiveNoProgress = 0;
        next.lastProgressIteration = current.lastProgressIteration + 1;
      }
      break;
    }

    case "open": {
      // Should not receive iterations in open state, but handle gracefully
      break;
    }
  }

  return next;
}

/** Reset the circuit breaker to closed state (user-initiated). */
export function resetCircuitBreaker(): CircuitBreakerState {
  return createInitialCircuitBreakerState();
}
