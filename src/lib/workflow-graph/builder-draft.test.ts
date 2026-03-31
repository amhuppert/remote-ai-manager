import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import {
  addContextDependency,
  addExecutionContext,
  addTaskToContext,
  deleteExecutionContext,
  moveTaskWithinContext,
  updateContextPosition,
} from "./builder-draft";

describe("workflow builder draft helpers", () => {
  it("adds an execution context with a layout position", () => {
    const result = addExecutionContext({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });

    expect(result.contextId).toBe("context-4");
    expect(result.definition.executionContexts.at(-1)?.title).toBe(
      "Execution Context 4",
    );
    expect(result.layout.contextPositions["context-4"]).toEqual({
      x: 1080,
      y: 0,
    });
  });

  it("removes an execution context together with its tasks and edges", () => {
    const result = deleteExecutionContext(
      {
        definition: createWorkflowDefinition(),
        layout: createWorkflowLayout(),
      },
      "context-implement",
    );

    expect(
      result.definition.executionContexts.map((context) => context.id),
    ).toEqual(["context-plan", "context-verify"]);
    expect(result.definition.tasks.map((task) => task.contextId)).toEqual([
      "context-plan",
      "context-verify",
    ]);
    expect(result.definition.edges).toEqual([]);
    expect(result.layout.contextPositions["context-implement"]).toBeUndefined();
  });

  it("rejects duplicate or cyclic dependencies", () => {
    const duplicate = addContextDependency(
      createWorkflowDefinition(),
      "context-plan",
      "context-implement",
    );
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors[0]?.code).toBe("duplicate-edge");

    const cycle = addContextDependency(
      createWorkflowDefinition(),
      "context-verify",
      "context-plan",
    );
    expect(cycle.ok).toBe(false);
    expect(cycle.errors[0]?.code).toBe("cycle-detected");
  });

  it("adds tasks and preserves ordered reordering within the selected context", () => {
    const withTask = addTaskToContext(
      createWorkflowDefinition(),
      "context-plan",
    );
    expect(
      withTask.definition.tasks
        .filter((task) => task.contextId === "context-plan")
        .map((task) => [task.id, task.order, task.title]),
    ).toEqual([
      ["task-plan-1", 1, "Inspect code"],
      ["task-context-plan-2", 2, "New Task 2"],
    ]);

    const reordered = moveTaskWithinContext(
      withTask.definition,
      "context-plan",
      "task-context-plan-2",
      "up",
    );

    expect(
      reordered.tasks
        .filter((task) => task.contextId === "context-plan")
        .map((task) => [task.id, task.order]),
    ).toEqual([
      ["task-context-plan-2", 1],
      ["task-plan-1", 2],
    ]);
  });

  it("updates execution-context positions without mutating other nodes", () => {
    const result = updateContextPosition(
      createWorkflowLayout(),
      "context-verify",
      { x: 900, y: 120 },
    );

    expect(result.contextPositions["context-verify"]).toEqual({
      x: 900,
      y: 120,
    });
    expect(result.contextPositions["context-plan"]).toEqual({ x: 0, y: 0 });
  });
});
