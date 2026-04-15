import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "./test-fixtures";
import {
  GraphWorkflowRuntimeEditValidationError,
  createGraphWorkflowRuntimeEditService,
} from "./runtime-edits";

describe("graph workflow runtime edit service", () => {
  it("appends agent-created tasks to the active execution context", () => {
    const service = createGraphWorkflowRuntimeEditService({
      createTaskId() {
        return "task-agent-1";
      },
    });
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      contextStates: {
        "context-plan": {
          contextId: "context-plan",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
        },
        "context-implement": {
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
        },
        "context-verify": {
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
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
  });

  it("rejects agent task creation outside the currently executing context", () => {
    const service = createGraphWorkflowRuntimeEditService();
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      contextStates: {
        "context-plan": {
          contextId: "context-plan",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
        },
        "context-implement": {
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
        },
        "context-verify": {
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
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

  it("applies user add, update, reorder, move, and remove edits atomically", () => {
    let taskIdCounter = 0;
    const service = createGraphWorkflowRuntimeEditService({
      createTaskId() {
        taskIdCounter += 1;
        return `task-user-${taskIdCounter}`;
      },
    });
    const execution = createWorkflowExecution({
      status: "running",
      contextStates: {
        ...createWorkflowExecution().contextStates,
        "context-plan": {
          ...createWorkflowExecution().contextStates["context-plan"]!,
          totalTaskCount: 2,
          completedTaskCount: 1,
        },
        "context-implement": {
          ...createWorkflowExecution().contextStates["context-implement"]!,
          status: "pending",
          totalTaskCount: 2,
        },
      },
      workingDefinition: {
        ...createWorkflowExecution().workingDefinition,
        tasks: [
          {
            id: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            title: "Inspect code",
            instructions: "Read the relevant files.",
            source: "user",
          },
          {
            id: "task-plan-2",
            contextId: "context-plan",
            order: 2,
            title: "Write plan",
            instructions: "Document the plan.",
            source: "user",
          },
          {
            id: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            title: "Write code",
            instructions: "Implement the feature.",
            source: "user",
          },
          {
            id: "task-implement-2",
            contextId: "context-implement",
            order: 2,
            title: "Add tests",
            instructions: "Cover the new behavior.",
            source: "user",
          },
          {
            id: "task-verify-1",
            contextId: "context-verify",
            order: 1,
            title: "Run checks",
            instructions: "Verify behavior.",
            source: "user",
          },
        ],
      },
      taskStates: {
        ...createWorkflowExecution().taskStates,
        "task-plan-1": {
          ...createWorkflowExecution().taskStates["task-plan-1"]!,
          status: "completed",
          completedAt: "2026-03-27T16:40:00.000Z",
        },
        "task-plan-2": {
          taskId: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
        "task-implement-1": {
          ...createWorkflowExecution().taskStates["task-implement-1"]!,
        },
        "task-implement-2": {
          taskId: "task-implement-2",
          contextId: "context-implement",
          order: 2,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      },
    });

    const updated = service.applyUserEdits(execution, {
      operations: [
        {
          type: "add",
          contextId: "context-plan",
          title: "Capture unresolved questions",
          instructions: "List the open questions before implementation.",
          metadata: {
            source: "user",
          },
        },
        {
          type: "update",
          taskId: "task-implement-1",
          title: "Implement the feature carefully",
          metadata: {
            area: "backend",
          },
        },
        {
          type: "reorder",
          contextId: "context-implement",
          orderedTaskIds: ["task-implement-2", "task-implement-1"],
        },
        {
          type: "move",
          taskId: "task-plan-2",
          targetContextId: "context-implement",
          targetOrder: 2,
        },
        {
          type: "remove",
          taskId: "task-verify-1",
        },
      ],
    });

    expect(
      updated.workingDefinition.tasks
        .filter((task) => task.contextId === "context-plan")
        .map((task) => ({ id: task.id, order: task.order })),
    ).toEqual([
      { id: "task-plan-1", order: 1 },
      { id: "task-user-1", order: 2 },
    ]);
    expect(
      updated.workingDefinition.tasks
        .filter((task) => task.contextId === "context-implement")
        .sort((left, right) => left.order - right.order)
        .map((task) => ({ id: task.id, order: task.order })),
    ).toEqual([
      { id: "task-implement-2", order: 1 },
      { id: "task-plan-2", order: 2 },
      { id: "task-implement-1", order: 3 },
    ]);
    expect(
      updated.workingDefinition.tasks.find(
        (task) => task.id === "task-verify-1",
      ),
    ).toBeUndefined();
    expect(updated.taskStates["task-user-1"]).toMatchObject({
      contextId: "context-plan",
      order: 2,
      status: "pending",
    });
    expect(updated.taskStates["task-plan-2"]).toMatchObject({
      contextId: "context-implement",
      order: 2,
    });
    expect(updated.taskStates["task-verify-1"]).toBeUndefined();
    expect(
      updated.workingDefinition.tasks.find(
        (task) => task.id === "task-implement-1",
      ),
    ).toMatchObject({
      title: "Implement the feature carefully",
      metadata: {
        area: "backend",
      },
    });
  });

  it("rejects user runtime edits that try to change locked tasks", () => {
    const service = createGraphWorkflowRuntimeEditService();
    const execution = createWorkflowExecution({
      status: "running",
      taskStates: {
        ...createWorkflowExecution().taskStates,
        "task-plan-1": {
          ...createWorkflowExecution().taskStates["task-plan-1"]!,
          status: "completed",
          completedAt: "2026-03-27T16:40:00.000Z",
        },
      },
    });

    expect(() =>
      service.applyUserEdits(execution, {
        operations: [
          {
            type: "update",
            taskId: "task-plan-1",
            title: "Illegally edited task",
          },
        ],
      }),
    ).toThrow(GraphWorkflowRuntimeEditValidationError);
  });

  it.each(["paused", "halted", "aborted"] as const)(
    "allows user runtime edits while execution is %s",
    (status) => {
      const service = createGraphWorkflowRuntimeEditService();
      const execution = createWorkflowExecution({
        status,
        taskStates: {
          ...createWorkflowExecution().taskStates,
          "task-plan-1": {
            ...createWorkflowExecution().taskStates["task-plan-1"]!,
            status: "pending",
          },
        },
      });

      const updated = service.applyUserEdits(execution, {
        operations: [
          {
            type: "update",
            taskId: "task-plan-1",
            instructions: "Read the relevant files and summarize the risks.",
          },
        ],
      });

      expect(
        updated.workingDefinition.tasks.find(
          (task) => task.id === "task-plan-1",
        )?.instructions,
      ).toBe("Read the relevant files and summarize the risks.");
    },
  );
});
