import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import {
  ResetExecutionContextError,
  resetExecutionContext,
} from "./reset-context";

// Infrastructure-only mock (module-load-time logger) so the tests can observe
// the transition owner's structured events without touching internal seams.
const logSpy = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpy,
}));

const now = "2026-04-19T00:00:00.000Z";

function makeLaneState(
  contextId: string,
  lane: GraphWorkflowAgentSessionState["lane"],
): GraphWorkflowAgentSessionState {
  return {
    backend: "claude",
    lane,
    contextId,
    workflowConversationId: `conv-${lane}-${contextId}`,
    metrics: {},
    lastUsedAt: now,
  };
}

function buildExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "paused",
    activeContextIds: ["context-implement"],
    contextStates: {
      "context-plan": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-plan",
        status: "completed",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 2,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      "context-implement": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-implement",
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 3,
        consecutiveFailureCount: 2,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      "context-verify": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-verify",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
    },
    taskStates: {
      "task-plan-1": {
        taskId: "task-plan-1",
        contextId: "context-plan",
        order: 1,
        status: "completed",
        summary: "Planned",
        startedAt: now,
        completedAt: now,
        lastConversationId: "conv-plan",
        failureMessage: null,
        failureHistory: [],
      },
      "task-implement-1": {
        taskId: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        status: "completed",
        summary: "Implemented",
        startedAt: now,
        completedAt: now,
        lastConversationId: "conv-impl",
        failureMessage: "nope",
        failureHistory: [{ message: "flaky", timestamp: now }],
      },
      "task-verify-1": {
        taskId: "task-verify-1",
        contextId: "context-verify",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
    },
    laneStates: {
      "context-implement": {
        implementer: makeLaneState("context-implement", "implementer"),
        context_validator: makeLaneState(
          "context-implement",
          "context_validator",
        ),
      },
    },
    haltReason: null,
    completedAt: null,
    machineSnapshot: { state: "paused" },
    ...overrides,
  });
}

describe("resetExecutionContext", () => {
  it("resets context and task state to execution-start defaults when paused", () => {
    const execution = buildExecution();

    const next = resetExecutionContext(execution, "context-implement");

    expect(next.contextStates["context-implement"]).toEqual({
      contextId: "context-implement",
      status: "pending",
      totalTaskCount: 1,
      completedTaskCount: 0,
      iterationCount: 0,
      consecutiveFailureCount: 0,
      consecutiveCandidateMismatchCount: 0,
      worktreePath: null,
      branchName: null,
      isolation: "session",
      batchId: null,
      laneId: null,
      joinId: null,
      mergeStatus: "not-applicable",
      cleanupStatus: "not-applicable",
      lastMergeError: null,
      pendingApproval: null,
      pendingUserInputs: {},
      skipReason: null,
      landingIntent: null,
      reviewOrigin: null,
    });
    expect(next.taskStates["task-implement-1"]).toEqual({
      taskId: "task-implement-1",
      contextId: "context-implement",
      order: 1,
      status: "pending",
      summary: null,
      startedAt: null,
      completedAt: null,
      lastConversationId: null,
      failureMessage: null,
      failureHistory: [],
    });
  });

  it("leaves sibling contexts and tasks untouched", () => {
    const execution = buildExecution();

    const next = resetExecutionContext(execution, "context-implement");

    expect(next.contextStates["context-plan"]).toEqual(
      execution.contextStates["context-plan"],
    );
    expect(next.contextStates["context-verify"]).toEqual(
      execution.contextStates["context-verify"],
    );
    expect(next.taskStates["task-plan-1"]).toEqual(
      execution.taskStates["task-plan-1"],
    );
    expect(next.taskStates["task-verify-1"]).toEqual(
      execution.taskStates["task-verify-1"],
    );
  });

  it("preserves the target and sibling conversations", () => {
    const execution = buildExecution({
      laneStates: {
        "context-implement": {
          implementer: makeLaneState("context-implement", "implementer"),
        },
        "context-plan": {
          context_validator: makeLaneState("context-plan", "context_validator"),
        },
      },
    });

    const next = resetExecutionContext(execution, "context-implement");

    expect(next.laneStates["context-implement"]).toEqual(
      execution.laneStates["context-implement"],
    );
    expect(next.laneStates["context-plan"]?.["context_validator"]).toEqual(
      execution.laneStates["context-plan"]?.["context_validator"],
    );
  });

  it("leaves workflow status paused, clears haltReason, completedAt, and machineSnapshot", () => {
    const execution = buildExecution({
      status: "halted",
      haltReason: {
        type: "max_iterations",
        contextId: "context-implement",
        iterationCount: 3,
        summary: null,
      },
      completedAt: now,
      machineSnapshot: { stale: true },
    });

    const next = resetExecutionContext(execution, "context-implement");

    expect(next.status).toBe("paused");
    expect(next.haltReason).toBeNull();
    expect(next.completedAt).toBeNull();
    expect(next.machineSnapshot).toBeNull();
  });

  it("clears activeContextId unconditionally so the workflow has no active iteration", () => {
    const hit = resetExecutionContext(
      buildExecution({ activeContextIds: ["context-implement"] }),
      "context-implement",
    );
    expect(hit.activeContextIds).toEqual([]);

    const miss = resetExecutionContext(
      buildExecution({ activeContextIds: ["context-plan"] }),
      "context-implement",
    );
    expect(miss.activeContextIds).toEqual([]);

    const unset = resetExecutionContext(
      buildExecution({ activeContextIds: [] }),
      "context-implement",
    );
    expect(unset.activeContextIds).toEqual([]);
  });

  it("allows reset from both paused and halted statuses", () => {
    for (const status of ["paused", "halted"] as const) {
      const next = resetExecutionContext(
        buildExecution({ status }),
        "context-implement",
      );
      expect(next.status).toBe("paused");
    }
  });

  it("rejects reset when the workflow is actively running", () => {
    expect(() =>
      resetExecutionContext(
        buildExecution({ status: "running" }),
        "context-implement",
      ),
    ).toThrow(/paused|halted/i);
  });

  it("rejects reset when the workflow is completed", () => {
    expect(() =>
      resetExecutionContext(
        buildExecution({ status: "completed" }),
        "context-implement",
      ),
    ).toThrow(/paused|halted/i);
  });

  it("rejects reset when the target context is already completed", () => {
    expect(() =>
      resetExecutionContext(buildExecution(), "context-plan"),
    ).toThrow(/completed/i);
  });

  it("rejects reset when the target context is unknown", () => {
    expect(() =>
      resetExecutionContext(buildExecution(), "context-missing"),
    ).toThrow(/not found|unknown/i);
  });

  describe("transition ownership", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("resets a paused-execution context to pending through the transition owner WITHOUT logging in the critical section", () => {
      const next = resetExecutionContext(
        buildExecution({ status: "paused" }),
        "context-implement",
      );

      expect(next.contextStates["context-implement"]!.status).toBe("pending");
      // The transition owner runs inside a write-queue reducer, so it is pure —
      // no logging I/O (`no-slow-work-in-critical-section`, Design 3.1/3.3).
      expect(logSpy.debug).not.toHaveBeenCalled();
      expect(logSpy.info).not.toHaveBeenCalled();
      expect(logSpy.warn).not.toHaveBeenCalled();
      expect(logSpy.error).not.toHaveBeenCalled();
    });

    it("resets a halted-execution context to pending through the transition owner WITHOUT logging in the critical section", () => {
      const next = resetExecutionContext(
        buildExecution({ status: "halted" }),
        "context-implement",
      );

      expect(next.contextStates["context-implement"]!.status).toBe("pending");
      expect(logSpy.debug).not.toHaveBeenCalled();
      expect(logSpy.info).not.toHaveBeenCalled();
      expect(logSpy.warn).not.toHaveBeenCalled();
      expect(logSpy.error).not.toHaveBeenCalled();
    });

    it("rejects a completed context via the owner's legality check while keeping the reset error contract, and does NOT log in the critical section", () => {
      expect(() =>
        resetExecutionContext(buildExecution(), "context-plan"),
      ).toThrow(ResetExecutionContextError);

      // The illegal transition throws (the error carries from/to/contextId/reason)
      // but does NOT log — the mutation seam's owner reconstructs the log
      // post-abort, outside the write-queue lock.
      expect(logSpy.error).not.toHaveBeenCalled();
      expect(logSpy.debug).not.toHaveBeenCalled();
      expect(logSpy.info).not.toHaveBeenCalled();
      expect(logSpy.warn).not.toHaveBeenCalled();
    });

    // D4 R4.2: a skip is irreversible within the execution. Reset is the only
    // operator-facing way back to `pending`, so it must refuse a skipped
    // context with the same typed error a completed one gets — and say which
    // status refused it, because "completed" would be a lie about the branch.
    it("rejects a skipped context with a typed error naming the skip", () => {
      const execution = buildExecution();
      const skipped = {
        ...execution,
        contextStates: {
          ...execution.contextStates,
          "context-verify": {
            ...execution.contextStates["context-verify"]!,
            status: "skipped" as const,
            skipReason: {
              edgeEvaluations: [
                {
                  edgeId: "edge-implement-verify",
                  verdict: "inactive" as const,
                },
              ],
              at: "2026-08-04T10:00:00.000Z",
            },
          },
        },
      };

      expect(() => resetExecutionContext(skipped, "context-verify")).toThrow(
        ResetExecutionContextError,
      );
      expect(() => resetExecutionContext(skipped, "context-verify")).toThrow(
        /skipped and cannot be reset/,
      );
      expect(logSpy.error).not.toHaveBeenCalled();
    });
  });
});
