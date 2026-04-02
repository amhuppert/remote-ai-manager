import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import {
  getEligibleContextIds,
  getEntryContextIds,
  getTerminalContextIds,
  validateWorkflowDefinition,
  validateWorkflowRuntimeEdit,
  validateWorkflowValidatorRemediation,
} from "./validation";

describe("workflow-graph validation", () => {
  it("accepts a valid execution-context DAG", () => {
    const definition = createWorkflowDefinition();
    const result = validateWorkflowDefinition(definition);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(getEntryContextIds(definition)).toEqual(["context-plan"]);
    expect(getTerminalContextIds(definition)).toEqual(["context-verify"]);
  });

  it("rejects cycles, duplicate task ids, and missing references", () => {
    const definition = createWorkflowDefinition({
      tasks: [
        ...createWorkflowDefinition().tasks,
        {
          id: "task-plan-1",
          contextId: "context-missing",
          order: 2,
          title: "Duplicate",
          instructions: "Bad task",
          source: "user",
        },
      ],
      edges: [
        ...createWorkflowDefinition().edges,
        {
          id: "edge-cycle",
          sourceContextId: "context-verify",
          targetContextId: "context-plan",
        },
        {
          id: "edge-missing",
          sourceContextId: "context-plan",
          targetContextId: "context-missing",
        },
      ],
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "duplicate-task-id",
        "unknown-task-context",
        "unknown-edge-target",
        "cycle-detected",
      ]),
    );
  });

  it("rejects moving a task into a running or completed context", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      contextStates: {
        ...baseExecution.contextStates,
        "context-verify": {
          ...baseExecution.contextStates["context-verify"]!,
          status: "completed",
        },
      },
    });

    const result = validateWorkflowRuntimeEdit(definition, execution, {
      operations: [
        {
          type: "move",
          taskId: "task-plan-1",
          targetContextId: "context-verify",
          targetOrder: 1,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("runtime-edit-target-context-locked");
  });

  it("rejects remediation that reopens tasks outside the validating context", () => {
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      taskStates: {
        ...baseExecution.taskStates,
        "task-plan-1": {
          ...baseExecution.taskStates["task-plan-1"]!,
          status: "completed",
          completedAt: "2026-03-27T12:00:00.000Z",
        },
        "task-implement-1": {
          ...baseExecution.taskStates["task-implement-1"]!,
          status: "completed",
          completedAt: "2026-03-27T12:00:00.000Z",
        },
      },
    });

    const result = validateWorkflowValidatorRemediation(
      "context-plan",
      execution,
      {
        pass: false,
        summary: "Wrong task reopened",
        reopenTaskIds: ["task-implement-1"],
        issues: [],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("remediation-task-out-of-scope");
  });

  it("rejects empty task instructions and empty task titles", () => {
    const definition = createWorkflowDefinition({
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          title: "",
          instructions: "",
          source: "user",
        },
        {
          id: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          title: "Has title",
          instructions: "",
          source: "user",
        },
      ],
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);

    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("empty-task-title");
    expect(codes).toContain("empty-task-instructions");

    const instructionErrors = result.errors.filter(
      (e) => e.code === "empty-task-instructions",
    );
    expect(instructionErrors).toHaveLength(2);
    expect(instructionErrors[0]?.taskId).toBe("task-plan-1");
    expect(instructionErrors[1]?.taskId).toBe("task-plan-2");
  });

  it("rejects empty context title", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx) =>
        ctx.id === "context-plan" ? { ...ctx, title: "" } : ctx,
      ),
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "empty-context-title")).toBe(
      true,
    );
  });

  it("rejects empty validator instructions when validator is enabled", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              taskValidation: {
                type: "claude",
                enabled: true,

                agent: { model: "sonnet", reasoningEffort: "medium" },
                instructions: "",
              },
            }
          : ctx,
      ),
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.code === "empty-task-validator-instructions"),
    ).toBe(true);
  });

  it("accepts empty validator instructions when validator is disabled", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              taskValidation: {
                type: "claude",
                enabled: false,

                agent: { model: "sonnet", reasoningEffort: "medium" },
                instructions: "",
              },
            }
          : ctx,
      ),
    });

    const result = validateWorkflowDefinition(definition);
    expect(
      result.errors.some((e) => e.code === "empty-task-validator-instructions"),
    ).toBe(false);
  });

  it("finds all currently eligible contexts for MVP scheduling", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          lastValidationPass: true,
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
  });
});
