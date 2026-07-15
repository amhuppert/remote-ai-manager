import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowRuntimeEditService } from "./runtime-edits";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
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
          pendingApproval: null,
          pendingUserInput: null,
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
          pendingApproval: null,
          pendingUserInput: null,
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
          pendingApproval: null,
          pendingUserInput: null,
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

    const updated = service.applyAgentTaskAdd(execution, "context-plan", {
      title: "Capture open questions",
      instructions: "Document the unknowns discovered during planning.",
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
          pendingApproval: null,
          pendingUserInput: null,
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
          pendingApproval: null,
          pendingUserInput: null,
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
          pendingApproval: null,
          pendingUserInput: null,
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
      service.applyAgentTaskAdd(execution, "context-implement", {
        title: "Sneak in implementation work",
        instructions: "This should not be allowed.",
      }),
    ).toThrow(
      'Agents can add tasks only to the currently executing context "context-plan"',
    );
  });

  describe("lane plan recompute", () => {
    function fanOutExecution(): GraphWorkflowExecution {
      const base = createWorkflowExecution();
      return createWorkflowExecution({
        status: "paused",
        workingDefinition: {
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
        },
        // Stale plan: marks context-implement as inheritor. Adding tasks to
        // context-verify must flip the tiebreaker so the recompute updates
        // this to context-verify.
        lanePlan: {
          continuationMap: { "context-plan": "context-implement" },
          longestDownstreamPath: {
            "context-plan": 1,
            "context-implement": 0,
            "context-verify": 0,
          },
        },
      });
    }

    it("recomputes lanePlan after applyAgentTaskAdd so a stale continuation entry is rewritten", () => {
      const service = createGraphWorkflowRuntimeEditService({
        createTaskId() {
          return "task-agent-extra";
        },
      });
      const base = fanOutExecution();
      const execution: GraphWorkflowExecution = {
        ...base,
        status: "running",
        activeContextIds: ["context-verify"],
        workingDefinition: {
          ...base.workingDefinition,
          // Enable agent task add on context-verify so applyAgentTaskAdd is
          // permitted to mutate it.
          executionContexts: base.workingDefinition.executionContexts.map(
            (ctx) =>
              ctx.id === "context-verify"
                ? { ...ctx, mutability: { allowAgentTaskAdd: true } }
                : ctx,
          ),
        },
        contextStates: {
          ...base.contextStates,
          "context-verify": {
            ...base.contextStates["context-verify"]!,
            status: "running",
          },
        },
      };

      const updated = service.applyAgentTaskAdd(execution, "context-verify", {
        title: "Verify subtask discovered mid-run",
        instructions: "Cover the newly identified case.",
      });

      // context-verify gains a task, tipping the task-count tiebreaker.
      expect(updated.lanePlan.continuationMap["context-plan"]).toBe(
        "context-verify",
      );
    });
  });
});
