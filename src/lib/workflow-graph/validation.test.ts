import { describe, expect, it } from "vitest";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import {
  getEligibleContextIds,
  getEntryContextIds,
  getTerminalContextIds,
  isContextLanded,
  validateResolvedWorkflow,
  validateWorkflowDefinition,
  validateWorkflowRuntimeEdit,
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

  it("rejects empty context-level acceptanceCriteria", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx) =>
        ctx.id === "context-plan" ? { ...ctx, acceptanceCriteria: "" } : ctx,
      ),
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "empty-context-acceptance-criteria" &&
          e.contextId === "context-plan",
      ),
    ).toBe(true);
  });

  it("does not emit the removed validator-AC rule", () => {
    const definition = createWorkflowDefinition();
    const result = validateWorkflowDefinition(definition);
    expect(
      result.errors.some(
        (e) => e.code === "empty-context-validator-acceptance-criteria",
      ),
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
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
  });

  it("requires worktree-isolation upstream to be merged before unlocking downstream", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          isolation: "worktree",
          mergeStatus: "pending",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([]);
  });

  it("unlocks downstream once worktree-isolation upstream reports merged-success", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          isolation: "worktree",
          mergeStatus: "merged-success",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
  });

  it("isContextLanded treats session isolation as landed when completed", () => {
    const baseExecution = createWorkflowExecution();
    const state = {
      ...baseExecution.contextStates["context-plan"]!,
      status: "completed" as const,
      isolation: "session" as const,
      mergeStatus: "not-applicable" as const,
    };
    expect(isContextLanded(state)).toBe(true);
  });

  it("isContextLanded requires merged-success for worktree isolation", () => {
    const baseExecution = createWorkflowExecution();
    const state = {
      ...baseExecution.contextStates["context-plan"]!,
      status: "completed" as const,
      isolation: "worktree" as const,
      mergeStatus: "pending" as const,
    };
    expect(isContextLanded(state)).toBe(false);
    expect(
      isContextLanded({ ...state, mergeStatus: "merged-success" as const }),
    ).toBe(true);
  });

  it("blocks a lane-pinned downstream when upstream output is on an unrelated worktree lane", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      ...baseExecution,
      executionLanes: {
        "lane-up": {
          laneId: "lane-up",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/up",
          branchName: "csm/test-up",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
        "lane-down": {
          laneId: "lane-down",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/down",
          branchName: "csm/test-down",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
      },
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
          completedTaskCount: 1,
        },
        "context-implement": {
          ...baseExecution.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([]);
  });

  it("unlocks a lane-pinned downstream once a join merges the upstream lane into the downstream lane", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      ...baseExecution,
      executionLanes: {
        "lane-up": {
          laneId: "lane-up",
          kind: "worktree",
          status: "merged",
          worktreePath: "/tmp/up",
          branchName: "csm/test-up",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
        "lane-down": {
          laneId: "lane-down",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/down",
          branchName: "csm/test-down",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
      },
      joins: {
        "join-up-down": {
          joinId: "join-up-down",
          kind: "context_merge",
          contextId: null,
          targetLaneId: "lane-down",
          sourceLaneIds: ["lane-up"],
          mergedSourceLaneIds: ["lane-up"],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
          completedAt: "2026-03-27T12:00:00.000Z",
        },
      },
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
          completedTaskCount: 1,
        },
        "context-implement": {
          ...baseExecution.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
  });
});

describe("validateResolvedWorkflow", () => {
  it("passes when every resolved context's implementer effort is supported", () => {
    const resolved = createResolvedWorkflowDefinition();
    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags implementer-effort-unsupported for a claude model that does not support the effort", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              implementer: {
                backend: "claude",
                model: "haiku",
                reasoningEffort: "xhigh",
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "implementer-effort-unsupported" &&
          e.contextId === resolved.executionContexts[0]?.id,
      ),
    ).toBe(true);
  });

  it("flags implementer-effort-unsupported for a codex model that does not support the effort", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              implementer: {
                backend: "codex",
                model: "gpt-5.4",
                reasoningEffort: "minimal",
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "implementer-effort-unsupported" &&
          e.contextId === resolved.executionContexts[0]?.id,
      ),
    ).toBe(true);
  });
});
