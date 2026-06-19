import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowAgentSessionState,
} from "@/lib/workflows/schemas";
import { resetExecutionContext } from "./reset-context";

const now = "2026-04-19T00:00:00.000Z";

function makeLaneState(
  contextId: string,
  lane: GraphWorkflowAgentSessionState["lane"],
): GraphWorkflowAgentSessionState {
  return {
    engine: "claude",
    lane,
    contextId,
    sessionRef: {
      engine: "claude",
      lane,
      conversationId: `conv-${lane}-${contextId}`,
    },
    lastContextTokens: null,
    lastContextWindowMax: null,
    rotateBeforeNextTurn: false,
    limitEvaluation: "disabled",
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
        pendingApproval: null,
        contextId: "context-plan",
        status: "completed",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 2,
        consecutiveFailureCount: 0,
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
        pendingApproval: null,
        contextId: "context-implement",
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 3,
        consecutiveFailureCount: 2,
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
        pendingApproval: null,
        contextId: "context-verify",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
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

  it("clears lane continuity only for the target context", () => {
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

    expect(next.laneStates["context-implement"]).toBeUndefined();
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

  it("recomputes lanePlan after reset so a stale continuation entry on the target context's parent is refreshed", () => {
    const base = createWorkflowExecution();
    const fanOutDefinition = {
      ...base.workingDefinition,
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
      // Inflate context-implement's task count so the tiebreaker prefers
      // it over context-verify. After resetExecutionContext the plan will
      // be recomputed from this definition.
      tasks: [
        ...base.workingDefinition.tasks,
        {
          id: "task-implement-2",
          contextId: "context-implement",
          order: 2,
          title: "Extra implement step A",
          instructions: "Additional work.",
          source: "user" as const,
        },
        {
          id: "task-implement-3",
          contextId: "context-implement",
          order: 3,
          title: "Extra implement step B",
          instructions: "Additional work.",
          source: "user" as const,
        },
      ],
    };

    const execution = buildExecution({
      workingDefinition: fanOutDefinition,
      // Stale plan asserts context-verify as inheritor. After reset, the
      // recompute must flip it to context-implement based on task count.
      lanePlan: {
        continuationMap: { "context-plan": "context-verify" },
        longestDownstreamPath: {
          "context-plan": 1,
          "context-implement": 0,
          "context-verify": 0,
        },
      },
    });

    const next = resetExecutionContext(execution, "context-implement");

    expect(next.lanePlan.continuationMap["context-plan"]).toBe(
      "context-implement",
    );
    expect(next.lanePlan.longestDownstreamPath["context-plan"]).toBe(1);
  });
});
