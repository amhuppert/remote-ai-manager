import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowRuntimeEditService } from "./runtime-edits";

const UNBOUND_EXECUTION_CONTRACT = {
  validateOperation: () => ({ ok: true as const }),
  accountabilityCoverageGroups: [],
};

describe("graph workflow runtime edit service", () => {
  it("appends agent-created tasks to the active execution context", () => {
    const service = createGraphWorkflowRuntimeEditService({
      createTaskId() {
        return "task-agent-1";
      },
    });
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      contextStates: {
        "context-plan": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-plan",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
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
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
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
    });

    const { execution: updated, added } = service.applyAgentTaskAdd(
      execution,
      "context-plan",
      {
        title: "Capture open questions",
        instructions: "Document the unknowns discovered during planning.",
      },
      UNBOUND_EXECUTION_CONTRACT,
    );

    // Pure helper: the observability payload is returned as DATA (the caller
    // emits `task.added_by_agent` post-commit, outside the write-queue lock).
    expect(added).toEqual({
      executionId: execution.id,
      contextId: "context-plan",
      taskId: "task-agent-1",
      title: "Capture open questions",
      instructionsLength: "Document the unknowns discovered during planning."
        .length,
    });

    expect(
      updated.workingDefinition.tasks
        .filter((task) => task.contextId === "context-plan")
        .map((task) => ({
          id: task.id,
          order: task.order,
          source: task.source,
        })),
    ).toEqual([
      {
        id: "task-plan-1",
        order: 1,
        source: "user",
      },
      {
        id: "task-agent-1",
        order: 2,
        source: "agent",
      },
    ]);
    expect(updated.taskStates["task-agent-1"]).toMatchObject({
      taskId: "task-agent-1",
      contextId: "context-plan",
      order: 2,
      status: "pending",
    });
    expect(updated.contextStates["context-plan"]?.totalTaskCount).toBe(2);
    // The lane-agent path is an accepted live edit, so it bumps liveRevision.
    expect(execution.liveRevision).toBe(1);
    expect(updated.liveRevision).toBe(2);
  });

  it("rejects agent task creation outside the currently executing context", () => {
    const service = createGraphWorkflowRuntimeEditService();
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      contextStates: {
        "context-plan": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-plan",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
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
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
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
    });

    expect(() =>
      service.applyAgentTaskAdd(
        execution,
        "context-implement",
        {
          title: "Sneak in implementation work",
          instructions: "This should not be allowed.",
        },
        UNBOUND_EXECUTION_CONTRACT,
      ),
    ).toThrow(
      'Agents can add tasks only to the currently executing context "context-plan"',
    );
  });
});
