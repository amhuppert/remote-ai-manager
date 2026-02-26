import { describe, it, expect } from "vitest";
import {
  evaluate,
  isAllTasksResolved,
  isSuccessfulHalt,
  type ExitEvaluationParams,
} from "./exit-detector";
import type {
  FixPlanTask,
  RalphLoopIterationMeta,
  RalphLoopConfig,
  ReportStatusInput,
} from "@/types";

const defaultConfig: RalphLoopConfig = {
  maxIterations: 20,
  iterationTimeoutMs: 3_600_000,
  contextSoftLimitTokens: 160_000,
  contextHardLimitTokens: 180_000,
  circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
};

function makeTask(overrides: Partial<FixPlanTask> = {}): FixPlanTask {
  return {
    id: "task-1",
    description: "Test task",
    priority: "medium",
    status: "pending",
    createdAt: "2024-01-01T00:00:00Z",
    completedAt: null,
    skipReason: null,
    addedByIteration: null,
    ...overrides,
  };
}

function makeIteration(
  overrides: Partial<RalphLoopIterationMeta> = {},
): RalphLoopIterationMeta {
  return {
    iterationNumber: 1,
    conversationId: "conv-1",
    status: "completed",
    startedAt: "2024-01-01T00:00:00Z",
    completedAt: "2024-01-01T00:01:00Z",
    durationMs: 60000,
    costUsd: 0.5,
    turns: 10,
    gitMetrics: {
      filesChanged: 1,
      linesAdded: 10,
      linesRemoved: 2,
      changedFiles: ["a.ts"],
    },
    statusReport: null,
    tasksCompleted: [],
    tasksSkipped: [],
    tasksAdded: [],
    progressClassification: "progress",
    peakContextTokens: 0,
    ...overrides,
  };
}

function makeStatusReport(
  overrides: Partial<ReportStatusInput> = {},
): ReportStatusInput {
  return {
    status: "in_progress",
    exit_signal: false,
    work_summary: "Did some work",
    work_type: "implementation",
    ...overrides,
  };
}

function makeParams(
  overrides: Partial<ExitEvaluationParams> = {},
): ExitEvaluationParams {
  const currentIteration = makeIteration({ iterationNumber: 1 });
  return {
    fixPlan: [makeTask()],
    iterations: [currentIteration],
    currentIteration,
    circuitBreakerState: "closed",
    config: defaultConfig,
    ...overrides,
  };
}

describe("ExitDetector", () => {
  describe("plan_complete", () => {
    it("halts when all tasks are completed", () => {
      const result = evaluate(
        makeParams({
          fixPlan: [
            makeTask({ id: "t1", status: "completed" }),
            makeTask({ id: "t2", status: "completed" }),
          ],
        }),
      );
      expect(result).toEqual({
        action: "halt",
        reason: { type: "plan_complete" },
      });
    });

    it("halts when all tasks are skipped", () => {
      const result = evaluate(
        makeParams({
          fixPlan: [makeTask({ id: "t1", status: "skipped" })],
        }),
      );
      expect(result).toEqual({
        action: "halt",
        reason: { type: "plan_complete" },
      });
    });

    it("halts when tasks are mix of completed and skipped", () => {
      const result = evaluate(
        makeParams({
          fixPlan: [
            makeTask({ id: "t1", status: "completed" }),
            makeTask({ id: "t2", status: "skipped" }),
          ],
        }),
      );
      expect(result).toEqual({
        action: "halt",
        reason: { type: "plan_complete" },
      });
    });

    it("does not halt with empty plan", () => {
      const result = evaluate(makeParams({ fixPlan: [] }));
      expect(result.action).toBe("continue");
    });

    it("does not halt when some tasks are pending", () => {
      const result = evaluate(
        makeParams({
          fixPlan: [
            makeTask({ id: "t1", status: "completed" }),
            makeTask({ id: "t2", status: "pending" }),
          ],
        }),
      );
      expect(result.action).toBe("continue");
    });
  });

  describe("iteration_cap", () => {
    it("halts when iteration number equals max", () => {
      const result = evaluate(
        makeParams({
          currentIteration: makeIteration({ iterationNumber: 20 }),
          config: { ...defaultConfig, maxIterations: 20 },
        }),
      );
      expect(result).toEqual({
        action: "halt",
        reason: { type: "iteration_cap", maxIterations: 20 },
      });
    });

    it("does not halt before reaching max", () => {
      const result = evaluate(
        makeParams({
          currentIteration: makeIteration({ iterationNumber: 19 }),
          config: { ...defaultConfig, maxIterations: 20 },
        }),
      );
      expect(result.action).toBe("continue");
    });
  });

  describe("circuit_breaker", () => {
    it("halts when circuit breaker is open", () => {
      const result = evaluate(makeParams({ circuitBreakerState: "open" }));
      expect(result).toEqual({
        action: "halt",
        reason: { type: "circuit_breaker", reason: "no_progress" },
      });
    });

    it("does not halt when half_open", () => {
      const result = evaluate(makeParams({ circuitBreakerState: "half_open" }));
      expect(result.action).toBe("continue");
    });
  });

  describe("permission_denied", () => {
    it("halts when 2+ consecutive iterations have permission denial", () => {
      const iters = [
        makeIteration({
          iterationNumber: 1,
          statusReport: makeStatusReport({
            status: "blocked",
            work_summary: "Permission denied on file write",
          }),
        }),
        makeIteration({
          iterationNumber: 2,
          statusReport: makeStatusReport({
            status: "blocked",
            work_summary: "Permission denied again",
          }),
        }),
      ];
      const result = evaluate(
        makeParams({
          iterations: iters,
          currentIteration: iters[1],
        }),
      );
      expect(result).toEqual({
        action: "halt",
        reason: { type: "permission_denied" },
      });
    });

    it("does not halt with only 1 permission denial", () => {
      const iters = [
        makeIteration({
          iterationNumber: 1,
          statusReport: makeStatusReport({
            status: "blocked",
            work_summary: "Permission denied",
          }),
        }),
      ];
      const result = evaluate(
        makeParams({
          iterations: iters,
          currentIteration: iters[0],
        }),
      );
      expect(result.action).toBe("continue");
    });

    it("does not halt when non-consecutive", () => {
      const iters = [
        makeIteration({
          iterationNumber: 1,
          statusReport: makeStatusReport({
            status: "blocked",
            work_summary: "Permission denied",
          }),
        }),
        makeIteration({
          iterationNumber: 2,
          statusReport: makeStatusReport({ status: "in_progress" }),
        }),
        makeIteration({
          iterationNumber: 3,
          statusReport: makeStatusReport({
            status: "blocked",
            work_summary: "Permission denied",
          }),
        }),
      ];
      const result = evaluate(
        makeParams({
          iterations: iters,
          currentIteration: iters[2],
        }),
      );
      // The last two are not consecutive permissions
      expect(result.action).toBe("continue");
    });
  });

  describe("test_saturation", () => {
    it("halts when 3+ of last 5 iterations are test-only", () => {
      const iters = Array.from({ length: 5 }, (_, i) =>
        makeIteration({
          iterationNumber: i + 1,
          statusReport: makeStatusReport({
            work_type: i < 3 ? "testing" : "implementation",
          }),
        }),
      );
      const result = evaluate(
        makeParams({
          iterations: iters,
          currentIteration: iters[4],
        }),
      );
      expect(result).toEqual({
        action: "halt",
        reason: { type: "test_saturation" },
      });
    });

    it("does not halt with only 2 test-only in last 5", () => {
      const iters = Array.from({ length: 5 }, (_, i) =>
        makeIteration({
          iterationNumber: i + 1,
          statusReport: makeStatusReport({
            work_type: i < 2 ? "testing" : "implementation",
          }),
        }),
      );
      const result = evaluate(
        makeParams({
          iterations: iters,
          currentIteration: iters[4],
        }),
      );
      expect(result.action).toBe("continue");
    });

    it("does not halt with fewer than 3 iterations", () => {
      const iters = [
        makeIteration({
          iterationNumber: 1,
          statusReport: makeStatusReport({ work_type: "testing" }),
        }),
        makeIteration({
          iterationNumber: 2,
          statusReport: makeStatusReport({ work_type: "testing" }),
        }),
      ];
      const result = evaluate(
        makeParams({
          iterations: iters,
          currentIteration: iters[1],
        }),
      );
      expect(result.action).toBe("continue");
    });
  });

  describe("stalled_exit_signal", () => {
    it("halts when 2+ of last 3 iterations signal exit with unresolved tasks", () => {
      const iters = [
        makeIteration({
          iterationNumber: 1,
          statusReport: makeStatusReport({ exit_signal: true }),
        }),
        makeIteration({
          iterationNumber: 2,
          statusReport: makeStatusReport({ exit_signal: true }),
        }),
      ];
      const result = evaluate(
        makeParams({
          fixPlan: [makeTask({ status: "pending" })],
          iterations: iters,
          currentIteration: iters[1],
        }),
      );
      expect(result).toEqual({
        action: "halt",
        reason: { type: "stalled_exit_signal", remainingTasks: 1 },
      });
    });

    it("does not halt when tasks are all resolved", () => {
      const iters = [
        makeIteration({
          iterationNumber: 1,
          statusReport: makeStatusReport({ exit_signal: true }),
        }),
        makeIteration({
          iterationNumber: 2,
          statusReport: makeStatusReport({ exit_signal: true }),
        }),
      ];
      const result = evaluate(
        makeParams({
          fixPlan: [makeTask({ status: "completed" })],
          iterations: iters,
          currentIteration: iters[1],
        }),
      );
      // Should hit plan_complete first
      expect(result).toEqual({
        action: "halt",
        reason: { type: "plan_complete" },
      });
    });

    it("does not halt with only 1 exit signal in last 3", () => {
      const iters = [
        makeIteration({
          iterationNumber: 1,
          statusReport: makeStatusReport({ exit_signal: false }),
        }),
        makeIteration({
          iterationNumber: 2,
          statusReport: makeStatusReport({ exit_signal: true }),
        }),
        makeIteration({
          iterationNumber: 3,
          statusReport: makeStatusReport({ exit_signal: false }),
        }),
      ];
      const result = evaluate(
        makeParams({
          fixPlan: [makeTask({ status: "pending" })],
          iterations: iters,
          currentIteration: iters[2],
        }),
      );
      expect(result.action).toBe("continue");
    });
  });

  describe("priority ordering", () => {
    it("plan_complete takes priority over iteration_cap", () => {
      const result = evaluate(
        makeParams({
          fixPlan: [makeTask({ status: "completed" })],
          currentIteration: makeIteration({ iterationNumber: 20 }),
          config: { ...defaultConfig, maxIterations: 20 },
        }),
      );
      expect(result).toEqual({
        action: "halt",
        reason: { type: "plan_complete" },
      });
    });

    it("iteration_cap takes priority over circuit_breaker", () => {
      const result = evaluate(
        makeParams({
          currentIteration: makeIteration({ iterationNumber: 20 }),
          config: { ...defaultConfig, maxIterations: 20 },
          circuitBreakerState: "open",
        }),
      );
      expect(result).toEqual({
        action: "halt",
        reason: { type: "iteration_cap", maxIterations: 20 },
      });
    });
  });

  describe("continue", () => {
    it("returns continue when no exit condition met", () => {
      const result = evaluate(makeParams());
      expect(result).toEqual({ action: "continue" });
    });

    it("returns continue with empty iteration history", () => {
      const result = evaluate(
        makeParams({
          iterations: [],
          currentIteration: makeIteration({ iterationNumber: 1 }),
        }),
      );
      expect(result.action).toBe("continue");
    });
  });

  describe("isAllTasksResolved", () => {
    it("returns false for empty plan", () => {
      expect(isAllTasksResolved([])).toBe(false);
    });

    it("returns true when all completed", () => {
      expect(
        isAllTasksResolved([
          makeTask({ status: "completed" }),
          makeTask({ status: "completed" }),
        ]),
      ).toBe(true);
    });

    it("returns true when all skipped", () => {
      expect(isAllTasksResolved([makeTask({ status: "skipped" })])).toBe(true);
    });

    it("returns false when any pending", () => {
      expect(
        isAllTasksResolved([
          makeTask({ status: "completed" }),
          makeTask({ status: "pending" }),
        ]),
      ).toBe(false);
    });
  });

  describe("isSuccessfulHalt", () => {
    it("plan_complete is successful", () => {
      expect(isSuccessfulHalt({ type: "plan_complete" })).toBe(true);
    });

    it("all other reasons are not successful", () => {
      expect(
        isSuccessfulHalt({ type: "iteration_cap", maxIterations: 20 }),
      ).toBe(false);
      expect(
        isSuccessfulHalt({ type: "circuit_breaker", reason: "no_progress" }),
      ).toBe(false);
      expect(isSuccessfulHalt({ type: "permission_denied" })).toBe(false);
      expect(isSuccessfulHalt({ type: "test_saturation" })).toBe(false);
      expect(
        isSuccessfulHalt({ type: "stalled_exit_signal", remainingTasks: 3 }),
      ).toBe(false);
      expect(isSuccessfulHalt({ type: "aborted" })).toBe(false);
    });
  });
});
