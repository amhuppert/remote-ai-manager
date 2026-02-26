import { describe, it, expect } from "vitest";
import {
  processIteration,
  resetCircuitBreaker,
  createInitialCircuitBreakerState,
  type IterationProgressResult,
} from "./circuit-breaker";
import type { CircuitBreakerConfig } from "@/types";

const defaultConfig: CircuitBreakerConfig = {
  noProgressThreshold: 3,
  sameErrorThreshold: 5,
};

function progress(): IterationProgressResult {
  return { classification: "progress" };
}

function noProgress(): IterationProgressResult {
  return { classification: "no_progress" };
}

function errorResult(pattern: string): IterationProgressResult {
  return { classification: "no_progress", errorPattern: pattern };
}

describe("CircuitBreaker", () => {
  describe("initial state", () => {
    it("starts in closed state with zeroed counters", () => {
      const state = createInitialCircuitBreakerState();
      expect(state.state).toBe("closed");
      expect(state.consecutiveNoProgress).toBe(0);
      expect(state.consecutiveSameError).toBe(0);
      expect(state.lastErrorPattern).toBeNull();
    });
  });

  describe("CLOSED state", () => {
    it("stays closed on progress", () => {
      const state = createInitialCircuitBreakerState();
      const next = processIteration(state, progress(), defaultConfig);
      expect(next.state).toBe("closed");
      expect(next.consecutiveNoProgress).toBe(0);
    });

    it("increments no-progress counter on no progress", () => {
      const state = createInitialCircuitBreakerState();
      const next = processIteration(state, noProgress(), defaultConfig);
      expect(next.state).toBe("closed");
      expect(next.consecutiveNoProgress).toBe(1);
    });

    it("resets no-progress counter on progress after no-progress", () => {
      let state = createInitialCircuitBreakerState();
      state = processIteration(state, noProgress(), defaultConfig);
      state = processIteration(state, noProgress(), defaultConfig);
      expect(state.consecutiveNoProgress).toBe(2);
      state = processIteration(state, progress(), defaultConfig);
      expect(state.consecutiveNoProgress).toBe(0);
      expect(state.state).toBe("closed");
    });

    it("transitions to HALF_OPEN when no-progress threshold reached", () => {
      let state = createInitialCircuitBreakerState();
      state = processIteration(state, noProgress(), defaultConfig);
      state = processIteration(state, noProgress(), defaultConfig);
      expect(state.state).toBe("closed");
      state = processIteration(state, noProgress(), defaultConfig);
      expect(state.state).toBe("half_open");
    });

    it("respects custom threshold", () => {
      const config: CircuitBreakerConfig = {
        noProgressThreshold: 1,
        sameErrorThreshold: 5,
      };
      let state = createInitialCircuitBreakerState();
      state = processIteration(state, noProgress(), config);
      expect(state.state).toBe("half_open");
    });
  });

  describe("HALF_OPEN state", () => {
    function toHalfOpen() {
      let state = createInitialCircuitBreakerState();
      for (let i = 0; i < 3; i++) {
        state = processIteration(state, noProgress(), defaultConfig);
      }
      expect(state.state).toBe("half_open");
      return state;
    }

    it("transitions to OPEN when recovery iteration shows no progress", () => {
      const state = toHalfOpen();
      const next = processIteration(state, noProgress(), defaultConfig);
      expect(next.state).toBe("open");
    });

    it("transitions back to CLOSED when recovery iteration shows progress", () => {
      const state = toHalfOpen();
      const next = processIteration(state, progress(), defaultConfig);
      expect(next.state).toBe("closed");
      expect(next.consecutiveNoProgress).toBe(0);
    });
  });

  describe("same-error detection", () => {
    it("tracks consecutive same-error count", () => {
      let state = createInitialCircuitBreakerState();
      state = processIteration(state, errorResult("ERR_A"), defaultConfig);
      expect(state.consecutiveSameError).toBe(1);
      state = processIteration(state, errorResult("ERR_A"), defaultConfig);
      expect(state.consecutiveSameError).toBe(2);
    });

    it("resets counter when error pattern changes", () => {
      let state = createInitialCircuitBreakerState();
      state = processIteration(state, errorResult("ERR_A"), defaultConfig);
      state = processIteration(state, errorResult("ERR_A"), defaultConfig);
      expect(state.consecutiveSameError).toBe(2);
      state = processIteration(state, errorResult("ERR_B"), defaultConfig);
      expect(state.consecutiveSameError).toBe(1);
      expect(state.lastErrorPattern).toBe("ERR_B");
    });

    it("resets counter on non-error iteration", () => {
      let state = createInitialCircuitBreakerState();
      state = processIteration(state, errorResult("ERR_A"), defaultConfig);
      state = processIteration(state, errorResult("ERR_A"), defaultConfig);
      state = processIteration(state, progress(), defaultConfig);
      expect(state.consecutiveSameError).toBe(0);
      expect(state.lastErrorPattern).toBeNull();
    });

    it("opens breaker when same-error threshold reached", () => {
      let state = createInitialCircuitBreakerState();
      for (let i = 0; i < 5; i++) {
        state = processIteration(state, errorResult("ERR_X"), defaultConfig);
      }
      expect(state.state).toBe("open");
    });

    it("opens breaker from half_open on same-error threshold", () => {
      let state = createInitialCircuitBreakerState();
      // Get to half_open via no-progress
      for (let i = 0; i < 3; i++) {
        state = processIteration(state, noProgress(), defaultConfig);
      }
      expect(state.state).toBe("half_open");
      // Same errors should still be tracked
      for (let i = 0; i < 5; i++) {
        state = processIteration(state, errorResult("ERR_Y"), {
          ...defaultConfig,
          sameErrorThreshold: 5,
        });
        if (state.state === "open") break;
      }
      expect(state.state).toBe("open");
    });
  });

  describe("reset", () => {
    it("resets to initial closed state", () => {
      const state = resetCircuitBreaker();
      expect(state.state).toBe("closed");
      expect(state.consecutiveNoProgress).toBe(0);
      expect(state.consecutiveSameError).toBe(0);
      expect(state.lastErrorPattern).toBeNull();
      expect(state.lastProgressIteration).toBe(0);
    });
  });
});
