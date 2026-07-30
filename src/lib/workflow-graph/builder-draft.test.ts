import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import {
  addContextDependency,
  addExecutionContext,
  addTaskToContext,
  clearContextBlockOverride,
  clearWorkflowConfigOverride,
  deleteExecutionContext,
  disableContextValidator,
  enableContextValidator,
  moveTaskWithinContext,
  setContextBlockOverride,
  setWorkflowConfigOverride,
  updateContextPosition,
} from "./builder-draft";

describe("workflow builder draft helpers", () => {
  it("adds an execution context with only id, title, and empty acceptance criteria", () => {
    const result = addExecutionContext({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });

    expect(result.contextId).toBe("context-4");
    const added = result.definition.executionContexts.at(-1);
    expect(added).toEqual({
      id: "context-4",
      title: "Execution Context 4",
      acceptanceCriteria: "",
    });
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

  it("setContextBlockOverride writes the named block on the matching context", () => {
    const result = setContextBlockOverride(
      createWorkflowDefinition(),
      "context-implement",
      "implementer",
      { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
    );

    const target = result.executionContexts.find(
      (context) => context.id === "context-implement",
    );
    expect(target?.implementer).toEqual({
      backend: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    const other = result.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    expect(other?.implementer).toEqual({
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
    });
  });

  it("round-trips a planRepair context override through set/clear", () => {
    const overridden = setContextBlockOverride(
      createWorkflowDefinition(),
      "context-plan",
      "planRepair",
      { enabled: false, maxAttemptsPerContext: 1 },
    );
    expect(
      overridden.executionContexts.find((c) => c.id === "context-plan")
        ?.planRepair,
    ).toEqual({ enabled: false, maxAttemptsPerContext: 1 });

    const cleared = clearContextBlockOverride(
      overridden,
      "context-plan",
      "planRepair",
    );
    expect(
      cleared.executionContexts.find((c) => c.id === "context-plan")
        ?.planRepair,
    ).toBeUndefined();
  });

  it("clearContextBlockOverride deletes the named block so it inherits", () => {
    const overridden = setContextBlockOverride(
      createWorkflowDefinition(),
      "context-plan",
      "iterationPolicy",
      { maxIterations: 9, continuity: { enabled: false } },
    );

    const cleared = clearContextBlockOverride(
      overridden,
      "context-plan",
      "iterationPolicy",
    );

    const target = cleared.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    expect(target).toBeDefined();
    expect(target?.iterationPolicy).toBeUndefined();
    expect("iterationPolicy" in (target ?? {})).toBe(false);
  });

  it("disableContextValidator writes contextValidator: { kind: 'disabled' }", () => {
    const result = disableContextValidator(
      createWorkflowDefinition(),
      "context-implement",
    );

    const target = result.executionContexts.find(
      (context) => context.id === "context-implement",
    );
    expect(target?.contextValidator).toEqual({ kind: "disabled" });
  });

  it("enableContextValidator clears the override back to inherit", () => {
    const disabled = disableContextValidator(
      createWorkflowDefinition(),
      "context-implement",
    );
    const enabled = enableContextValidator(disabled, "context-implement");

    const target = enabled.executionContexts.find(
      (context) => context.id === "context-implement",
    );
    expect(target?.contextValidator).toBeUndefined();
    expect("contextValidator" in (target ?? {})).toBe(false);
  });

  it("setWorkflowConfigOverride writes the workflow-level block", () => {
    const result = setWorkflowConfigOverride(
      createWorkflowDefinition(),
      "implementer",
      { backend: "claude", model: "sonnet", reasoningEffort: "low" },
    );

    expect(result.workflowConfig.implementer).toEqual({
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "low",
    });
  });

  it("clearWorkflowConfigOverride removes a previously-set workflow block", () => {
    const overridden = setWorkflowConfigOverride(
      createWorkflowDefinition(),
      "iterationPolicy",
      { maxIterations: 7, continuity: { enabled: false } },
    );

    const cleared = clearWorkflowConfigOverride(overridden, "iterationPolicy");

    expect(cleared.workflowConfig.iterationPolicy).toBeUndefined();
    expect("iterationPolicy" in cleared.workflowConfig).toBe(false);
  });
});
