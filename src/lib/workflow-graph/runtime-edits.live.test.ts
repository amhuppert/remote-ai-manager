import { describe, expect, it } from "vitest";
import { createWorkflowExecution, makeProfileSnapshot } from "./test-fixtures";
import {
  applyLiveExecutionEdits,
  type LiveEditDeps,
  type ResolvedContextConfig,
} from "./runtime-edits";
import type {
  GraphWorkflowExecution,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import { workflowLiveEditOperationSchema } from "@/lib/workflows/edit-schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import { createSpecExecutionContract } from "@/lib/specs/execution-contract";

const RESOLVED_DEFAULTS: ResolvedContextConfig = {
  implementer: {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    profileSnapshot: makeProfileSnapshot(),
    agent: { backend: "claude", model: "opus", reasoningEffort: "medium" },
  },
  contextValidator: { enabled: false, assignments: [] },
  scriptValidator: { commands: [] },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  mutability: { allowAgentTaskAdd: false },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: { value: true, source: "global" },
    secondAgent: {
      value: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      source: "global",
    },
    negotiationRounds: { value: 3, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
  },
  agentValidation: {
    implementer: { value: { mode: "all", except: [] }, source: "global" },
    contextValidator: {
      value: { mode: "only", commands: [] },
      source: "global",
    },
  },
};

function makeDeps(overrides: Partial<LiveEditDeps> = {}): LiveEditDeps {
  let counter = 0;
  return {
    createTaskId: () => `task-minted-${(counter += 1)}`,
    resolvedGlobalDefaults: () => RESOLVED_DEFAULTS,
    validationCommandPreflight: () => ({
      commandCosts: { typecheck: 2, test: 5 },
      concurrencyLimit: 8,
    }),
    snapshotFor: (assignment) => makeProfileSnapshot({ ...assignment.profile }),
    now: () => "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function pendingTaskState(
  taskId: string,
  contextId: string,
  order: number,
): GraphWorkflowTaskState {
  return {
    taskId,
    contextId,
    order,
    status: "pending",
    summary: null,
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
  };
}

function apply(
  execution: GraphWorkflowExecution,
  operations: WorkflowLiveEditOperation[],
  deps: LiveEditDeps = makeDeps(),
) {
  return applyLiveExecutionEdits(execution, { operations }, deps);
}

describe("applyLiveExecutionEdits — task + context ops", () => {
  it("refuses a locked-path mutation before changing the execution", () => {
    const base = createWorkflowExecution({ status: "paused" });
    const execution = createWorkflowExecution({
      status: "paused",
      workingDefinition: {
        ...base.workingDefinition,
        lockedRegions: [
          {
            paths: ["/executionContexts/context-implement/acceptanceCriteria"],
            sourceUri: "contract://criteria/R17.4",
            reason: "Acceptance criteria are contract-derived",
          },
        ],
      },
    });
    const before = structuredClone(execution);

    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        acceptanceCriteria: "Weakened downstream criteria",
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("region_locked");
    expect(result.issues[0]).toMatchObject({
      code: "region_locked",
      operationIndex: 0,
      field: "/executionContexts/context-implement/acceptanceCriteria",
    });
    expect(result.issues[0]?.message).toContain(
      "amend at source contract://criteria/R17.4",
    );
    expect(execution).toEqual(before);
  });

  it("allows an unlocked execution-only config edit beside a locked contract path", () => {
    const base = createWorkflowExecution({ status: "paused" });
    const execution = createWorkflowExecution({
      status: "paused",
      workingDefinition: {
        ...base.workingDefinition,
        lockedRegions: [
          {
            paths: ["/executionContexts/context-implement/acceptanceCriteria"],
            sourceUri: "contract://criteria/R17.4",
            reason: "Acceptance criteria are contract-derived",
          },
        ],
      },
    });

    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        iterationPolicy: {
          maxIterations: 9,
          continuity: { enabled: true },
        },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    expect(context?.iterationPolicy.maxIterations).toBe(9);
    expect(context?.acceptanceCriteria).toBe("Feature implemented");
  });

  it("sets a concrete planRepair block via live update-context (no silent no-op)", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        planRepair: { enabled: false, maxAttemptsPerContext: 1 },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    expect(context?.planRepair).toEqual({
      enabled: false,
      maxAttemptsPerContext: 1,
    });
  });

  it("rejects a live agentValidation selection naming an unregistered command", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const before = structuredClone(execution);

    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        agentValidation: {
          implementer: {
            // "format" is not in the deps' registry (["typecheck", "test"]).
            value: { mode: "all", except: ["format"] },
            source: "per-node",
          },
          contextValidator: {
            value: { mode: "only", commands: [] },
            source: "global",
          },
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
    expect(result.issues[0]).toMatchObject({
      code: "unknown-validation-command",
      contextId: "context-implement",
      field:
        "executionContexts.context-implement.agentValidation.implementer.value.except.0",
    });
    expect(execution).toEqual(before);
  });

  it("rejects an oversized validation selection without mutating live state", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const before = structuredClone(execution);

    const result = apply(
      execution,
      [
        {
          type: "update-context",
          contextId: "context-implement",
          scriptValidator: { commands: ["test"] },
        },
      ],
      makeDeps({
        validationCommandPreflight: () => ({
          commandCosts: { typecheck: 2, test: 5 },
          concurrencyLimit: 4,
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_cost_exceeds_limit");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "validation_cost_exceeds_limit",
        contextId: "context-implement",
        field: "executionContexts.context-implement.scriptValidator.commands.0",
        message: expect.stringMatching(/cost 5.*limit 4.*lower-worker/),
      }),
    );
    expect(execution).toEqual(before);
  });

  it("does not preflight a pre-existing oversized selection on a prose-only edit", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    if (!context) throw new Error("fixture missing context-implement");
    context.scriptValidator = { commands: ["test"] };

    const result = apply(
      execution,
      [
        {
          type: "update-context",
          contextId: "context-implement",
          title: "Clarified title",
        },
      ],
      makeDeps({
        validationCommandPreflight: () => ({
          commandCosts: { typecheck: 2, test: 5 },
          concurrencyLimit: 4,
        }),
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("applies a registered agentValidation selection without touching in-flight state", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const before = structuredClone(execution);
    const agentValidation = {
      implementer: {
        value: { mode: "only" as const, commands: ["typecheck", "test"] },
        source: "per-node" as const,
      },
      contextValidator: {
        value: { mode: "only" as const, commands: ["test"] },
        source: "per-node" as const,
      },
    };

    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        agentValidation,
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    // The edit boundary re-freezes each rewritten role to an explicit
    // command-name snapshot, the same expansion a seed performs (design §6).
    expect(context?.agentValidation).toEqual({
      implementer: {
        ...agentValidation.implementer,
        commands: ["typecheck", "test"],
      },
      contextValidator: {
        ...agentValidation.contextValidator,
        commands: ["test"],
      },
    });
    // Future submissions only: the edit rewrites the working definition that
    // upcoming submissions resolve against; task/context runtime state — where
    // in-flight work lives — is untouched.
    expect(result.execution.taskStates).toEqual(before.taskStates);
    expect(result.execution.contextStates).toEqual(before.contextStates);
  });

  it('expands and freezes a live `mode:"all"` selector against the current registry', () => {
    const execution = createWorkflowExecution({ status: "paused" });

    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        agentValidation: {
          implementer: {
            value: { mode: "all", except: ["test"] },
            source: "per-node",
          },
          contextValidator: {
            value: { mode: "only", commands: [] },
            source: "global",
          },
        },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    expect(context?.agentValidation?.implementer.commands).toEqual([
      "typecheck",
    ]);
    expect(context?.agentValidation?.contextValidator.commands).toEqual([]);
  });

  it("preserves an untouched role's frozen snapshot when the registry has since grown", () => {
    const base = createWorkflowExecution({ status: "paused" });
    const execution = structuredClone(base);
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    // Frozen at seed when the registry knew only "typecheck".
    const frozenImplementer = {
      value: { mode: "all" as const, except: [] },
      source: "global" as const,
      commands: ["typecheck"],
    };
    context!.agentValidation = {
      implementer: frozenImplementer,
      contextValidator: {
        value: { mode: "only", commands: [] },
        source: "global",
        commands: [],
      },
    };

    // The operator edits ONLY the context-validator role; the UI echoes the
    // implementer role verbatim. The registry now also registers "test".
    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        agentValidation: {
          implementer: frozenImplementer,
          contextValidator: {
            value: { mode: "only", commands: ["test"] },
            source: "per-node",
          },
        },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    // Echoing an unchanged selector must NOT re-expand it against the grown
    // registry — that would silently broaden a frozen permission set.
    expect(next?.agentValidation?.implementer.commands).toEqual(["typecheck"]);
    expect(next?.agentValidation?.contextValidator.commands).toEqual(["test"]);
  });

  it("updates a context's prose and concrete config on an unstarted context", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        title: "Implement carefully",
        description: null,
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "high",
          },
        },
        scriptValidator: { commands: [] },
        mutability: { allowAgentTaskAdd: true },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    expect(context?.title).toBe("Implement carefully");
    expect(context?.description).toBeUndefined();
    expect(context?.implementer.agent.reasoningEffort).toBe("high");
    expect(context?.mutability.allowAgentTaskAdd).toBe(true);
    expect(result.affectedContextIds).toContain("context-implement");
  });

  it("disables a context validator by setting it to null", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const withValidator: GraphWorkflowExecution = {
      ...execution,
      workingDefinition: {
        ...execution.workingDefinition,
        executionContexts: execution.workingDefinition.executionContexts.map(
          (ctx) =>
            ctx.id === "context-implement"
              ? {
                  ...ctx,
                  contextValidator: {
                    enabled: true,
                    assignments: [
                      {
                        id: "general",
                        profile: { tier: "builtin", id: "general-reviewer" },
                        profileSnapshot: makeProfileSnapshot(),
                        strategy: "conversation",
                        agent: {
                          backend: "claude",
                          model: "sonnet",
                          reasoningEffort: "medium",
                        },
                        continuity: { enabled: true },
                      },
                    ],
                  },
                }
              : ctx,
        ),
      },
    };

    const result = apply(withValidator, [
      {
        type: "update-context",
        contextId: "context-implement",
        contextValidator: { enabled: false, assignments: [] },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    // Off is a cohort with `enabled: false`, never an absent validator — that
    // is what preserves the dormant assignments across a live edit.
    expect(context?.contextValidator).toEqual({
      enabled: false,
      assignments: [],
    });
  });

  it("rejects editing a completed (frozen) context with code frozen", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const frozen: GraphWorkflowExecution = {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        "context-plan": {
          ...execution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
        },
      },
      taskStates: {
        ...execution.taskStates,
        "task-plan-1": {
          ...execution.taskStates["task-plan-1"]!,
          status: "completed",
          completedAt: "2026-03-27T16:40:00.000Z",
        },
      },
    };

    const result = apply(frozen, [
      { type: "update-context", contextId: "context-plan", title: "Nope" },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("frozen");
    expect(result.issues[0]?.operationIndex).toBe(0);
  });

  it("adds a task with a minted id at the end and syncs the runtime map", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-task",
        contextId: "context-implement",
        title: "Add tests",
        instructions: "Cover the new behavior.",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const implTasks = result.execution.workingDefinition.tasks
      .filter((task) => task.contextId === "context-implement")
      .sort((a, b) => a.order - b.order);
    expect(implTasks.map((t) => t.id)).toEqual([
      "task-implement-1",
      "task-minted-1",
    ]);
    expect(implTasks[1]?.order).toBe(2);
    expect(result.execution.taskStates["task-minted-1"]).toMatchObject({
      contextId: "context-implement",
      order: 2,
      status: "pending",
    });
    expect(
      result.execution.contextStates["context-implement"]?.totalTaskCount,
    ).toBe(2);
  });

  it("places an added task before an anchor via position", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-task",
        id: "impl-first",
        contextId: "context-implement",
        title: "Set up",
        instructions: "Prepare the ground.",
        position: { before: "task-implement-1" },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const implTasks = result.execution.workingDefinition.tasks
      .filter((task) => task.contextId === "context-implement")
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);
    expect(implTasks).toEqual(["impl-first", "task-implement-1"]);
  });

  it("rejects an add-task with a duplicate id", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-task",
        id: "task-implement-1",
        contextId: "context-implement",
        title: "Dup",
        instructions: "Duplicate id.",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
  });

  it("updates a pending task's fields", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "update-task",
        taskId: "task-implement-1",
        instructions: "Revised instructions.",
        metadata: { area: "backend" },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.execution.workingDefinition.tasks.find(
      (t) => t.id === "task-implement-1",
    );
    expect(task?.instructions).toBe("Revised instructions.");
    expect(task?.metadata).toEqual({ area: "backend" });
  });

  it("rejects editing a locked (completed) task with code frozen", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const withCompleted: GraphWorkflowExecution = {
      ...execution,
      taskStates: {
        ...execution.taskStates,
        "task-plan-1": {
          ...execution.taskStates["task-plan-1"]!,
          status: "completed",
          completedAt: "2026-03-27T16:40:00.000Z",
        },
      },
    };
    const result = apply(withCompleted, [
      { type: "update-task", taskId: "task-plan-1", title: "Nope" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("frozen");
  });

  it("removes a task, resequences the context, and drops its task state", () => {
    const execution = withTwoImplTasks();
    const result = apply(execution, [
      { type: "remove-task", taskId: "task-implement-1" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const implTasks = result.execution.workingDefinition.tasks
      .filter((task) => task.contextId === "context-implement")
      .sort((a, b) => a.order - b.order);
    expect(implTasks.map((t) => ({ id: t.id, order: t.order }))).toEqual([
      { id: "task-implement-2", order: 1 },
    ]);
    expect(result.execution.taskStates["task-implement-1"]).toBeUndefined();
    expect(
      result.execution.contextStates["context-implement"]?.totalTaskCount,
    ).toBe(1);
  });

  it("moves a task between two unstarted contexts and resequences both", () => {
    const execution = withTwoImplTasks({ status: "paused" });
    const result = apply(execution, [
      {
        type: "move-task",
        taskId: "task-implement-2",
        targetContextId: "context-verify",
        position: { at: "start" },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verifyTasks = result.execution.workingDefinition.tasks
      .filter((task) => task.contextId === "context-verify")
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);
    expect(verifyTasks).toEqual(["task-implement-2", "task-verify-1"]);
    expect(result.execution.taskStates["task-implement-2"]?.contextId).toBe(
      "context-verify",
    );
    expect(
      result.execution.contextStates["context-implement"]?.totalTaskCount,
    ).toBe(1);
    expect(
      result.execution.contextStates["context-verify"]?.totalTaskCount,
    ).toBe(2);
  });

  it("rejects move-task for a launched spec execution through the registered contract seam", () => {
    const base = withTwoImplTasks({ status: "paused" });
    const execution: GraphWorkflowExecution = {
      ...base,
      workingDefinition: {
        ...base.workingDefinition,
        origin: {
          sourceUri:
            "spec-execution://spec-native-sdd/revisions/revision-1?scope=scope-1",
        },
      },
    };
    const result = apply(
      execution,
      [
        {
          type: "move-task",
          taskId: "task-implement-2",
          targetContextId: "context-verify",
        },
      ],
      makeDeps({ executionContract: createSpecExecutionContract() }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("spec_grouping_frozen");
    expect(result.issues[0]).toMatchObject({
      code: "spec-grouping-frozen",
      operationIndex: 0,
      taskId: "task-implement-2",
    });
  });

  it("rejects a move-task while running unless both contexts are unstarted", () => {
    const execution = withTwoImplTasks({
      status: "running",
      activeContextIds: ["context-plan"],
    });
    const running: GraphWorkflowExecution = {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        "context-plan": {
          ...execution.contextStates["context-plan"]!,
          status: "running",
          iterationCount: 1,
        },
      },
    };
    const result = apply(running, [
      {
        type: "move-task",
        taskId: "task-plan-1",
        targetContextId: "context-implement",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("requires_pause");
  });

  it("reorders all tasks in an unstarted context", () => {
    const execution = withTwoImplTasks({ status: "paused" });
    const result = apply(execution, [
      {
        type: "reorder-tasks",
        contextId: "context-implement",
        orderedTaskIds: ["task-implement-2", "task-implement-1"],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const implTasks = result.execution.workingDefinition.tasks
      .filter((task) => task.contextId === "context-implement")
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);
    expect(implTasks).toEqual(["task-implement-2", "task-implement-1"]);
  });

  it("reorders only editable tasks in a quiescent started context, keeping completed positions", () => {
    const execution = quiescentStartedPlan();
    const result = apply(execution, [
      {
        type: "reorder-tasks",
        contextId: "context-plan",
        orderedTaskIds: ["task-plan-3", "task-plan-2"],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const planTasks = result.execution.workingDefinition.tasks
      .filter((task) => task.contextId === "context-plan")
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);
    // The completed task-plan-1 keeps position 1; editable tasks take the order.
    expect(planTasks).toEqual(["task-plan-1", "task-plan-3", "task-plan-2"]);
  });

  it("rejects a reorder that is not an exact permutation of editable tasks", () => {
    const execution = quiescentStartedPlan();
    const result = apply(execution, [
      {
        type: "reorder-tasks",
        contextId: "context-plan",
        orderedTaskIds: ["task-plan-2"],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
  });

  it("applies ops sequentially so a later op sees an earlier addition", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-task",
        id: "impl-new",
        contextId: "context-implement",
        title: "New",
        instructions: "Newly added.",
      },
      {
        type: "reorder-tasks",
        contextId: "context-implement",
        orderedTaskIds: ["impl-new", "task-implement-1"],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const implTasks = result.execution.workingDefinition.tasks
      .filter((task) => task.contextId === "context-implement")
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);
    expect(implTasks).toEqual(["impl-new", "task-implement-1"]);
  });

  it("is atomic — a later failing op leaves nothing applied and does not mutate the input", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const before = structuredClone(execution);
    const result = apply(execution, [
      {
        type: "add-task",
        id: "impl-added",
        contextId: "context-implement",
        title: "Added first",
        instructions: "This op succeeds.",
      },
      { type: "remove-task", taskId: "does-not-exist" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.operationIndex).toBe(1);
    expect(execution).toEqual(before);
  });

  it("does not bump liveRevision in the pure core", () => {
    const execution = createWorkflowExecution({
      status: "paused",
      liveRevision: 4,
    });
    const result = apply(execution, [
      { type: "update-task", taskId: "task-plan-1", title: "Tweaked" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.liveRevision).toBe(4);
  });
});

describe("applyLiveExecutionEdits — update-lane-merge-validation", () => {
  it("rewrites the workflow-scope snapshot; future merge submissions read it, runtime state is untouched", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const before = structuredClone(execution);

    const result = apply(execution, [
      {
        type: "update-lane-merge-validation",
        laneMergeValidation: {
          strategy: "every-merge",
          commands: { mode: "only", commands: ["typecheck"] },
        },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.workingDefinition.laneMergeValidation).toEqual({
      strategy: "every-merge",
      commands: { mode: "only", commands: ["typecheck"] },
    });
    expect(result.execution.taskStates).toEqual(before.taskStates);
    expect(result.execution.contextStates).toEqual(before.contextStates);
  });

  it("rejects an unregistered command name path-qualified at the edit boundary", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const before = structuredClone(execution);

    const result = apply(execution, [
      {
        type: "update-lane-merge-validation",
        laneMergeValidation: {
          strategy: "final-only",
          commands: { mode: "only", commands: ["ghost"] },
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
    expect(result.issues[0]).toMatchObject({
      code: "unknown-validation-command",
      field: "laneMergeValidation.commands.commands.0",
    });
    expect(execution).toEqual(before);
  });

  it("rejects an oversized explicit lane-merge command", () => {
    const execution = createWorkflowExecution({ status: "paused" });

    const result = apply(
      execution,
      [
        {
          type: "update-lane-merge-validation",
          laneMergeValidation: {
            strategy: "final-only",
            commands: { mode: "only", commands: ["test"] },
          },
        },
      ],
      makeDeps({
        validationCommandPreflight: () => ({
          commandCosts: { typecheck: 2, test: 5 },
          concurrencyLimit: 4,
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_cost_exceeds_limit");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "validation_cost_exceeds_limit",
        field: "laneMergeValidation.commands.commands.0",
      }),
    );
  });

  it("requires a quiescent execution", () => {
    const execution = createWorkflowExecution({ status: "running" });

    const result = apply(execution, [
      {
        type: "update-lane-merge-validation",
        laneMergeValidation: {
          strategy: "every-merge",
          commands: { mode: "project" },
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("requires_pause");
  });
});

describe("applyLiveExecutionEdits — structural ops + frontier invariant", () => {
  it("adds a context seeded from resolved global defaults and seeds its runtime state", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-context",
        id: "context-review",
        title: "Review",
        acceptanceCriteria: "The change is reviewed.",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-review",
    );
    expect(context?.implementer).toEqual(RESOLVED_DEFAULTS.implementer);
    expect(context?.collaboration).toEqual(RESOLVED_DEFAULTS.collaboration);
    expect(context?.contextValidator).toEqual(
      RESOLVED_DEFAULTS.contextValidator,
    );
    const state = result.execution.contextStates["context-review"];
    expect(state).toMatchObject({
      status: "pending",
      totalTaskCount: 0,
      completedTaskCount: 0,
      iterationCount: 0,
    });
    expect(result.affectedContextIds).toContain("context-review");
  });

  it("seeds add-context config from configFromContextId with explicit overrides winning", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-context",
        id: "context-review",
        title: "Review",
        acceptanceCriteria: "Reviewed.",
        configFromContextId: "context-plan",
        iterationPolicy: { maxIterations: 7, continuity: { enabled: true } },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-review",
    );
    // context-plan resolves to claude/opus/high; the explicit iterationPolicy wins.
    expect(context?.implementer.agent).toEqual({
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
    });
    expect(context?.iterationPolicy.maxIterations).toBe(7);
    // context-plan carries no resolved collaboration, so it falls back to defaults.
    expect(context?.collaboration).toEqual(RESOLVED_DEFAULTS.collaboration);
  });

  it("rejects add-context whose configFromContextId does not exist", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-context",
        id: "context-review",
        title: "Review",
        acceptanceCriteria: "Reviewed.",
        configFromContextId: "nope",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
  });

  it("adds a context, a task into it, and an edge to it in one sequential batch", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-context",
        id: "context-review",
        title: "Review",
        acceptanceCriteria: "Reviewed.",
      },
      {
        type: "add-task",
        contextId: "context-review",
        title: "Do the review",
        instructions: "Review the implementation.",
      },
      {
        type: "add-edge",
        sourceContextId: "context-verify",
        targetContextId: "context-review",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reviewTasks = result.execution.workingDefinition.tasks.filter(
      (task) => task.contextId === "context-review",
    );
    expect(reviewTasks).toHaveLength(1);
    expect(
      result.execution.contextStates["context-review"]?.totalTaskCount,
    ).toBe(1);
    expect(
      result.execution.workingDefinition.edges.some(
        (edge) =>
          edge.sourceContextId === "context-verify" &&
          edge.targetContextId === "context-review",
      ),
    ).toBe(true);
  });

  it("rejects a structural op while the execution is running (requires quiescence)", () => {
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });
    const result = apply(execution, [
      {
        type: "add-context",
        id: "context-review",
        title: "Review",
        acceptanceCriteria: "Reviewed.",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("requires_pause");
  });

  it("rejects an add-edge that would introduce a cycle", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-edge",
        sourceContextId: "context-verify",
        targetContextId: "context-plan",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
    expect(result.issues.some((issue) => issue.code === "cycle-detected")).toBe(
      true,
    );
  });

  it("rejects a duplicate add-edge", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-edge",
        sourceContextId: "context-plan",
        targetContextId: "context-implement",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
  });

  it("rejects an add-edge into a started target as frozen", () => {
    const execution = pausedStartedVerify();
    const result = apply(execution, [
      {
        type: "add-edge",
        sourceContextId: "context-plan",
        targetContextId: "context-verify",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("frozen");
  });

  it("removes an edge whose target is unstarted", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "remove-edge",
        sourceContextId: "context-implement",
        targetContextId: "context-verify",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.execution.workingDefinition.edges.some(
        (edge) => edge.targetContextId === "context-verify",
      ),
    ).toBe(false);
  });

  it("rejects removing an unknown edge", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "remove-edge",
        sourceContextId: "context-plan",
        targetContextId: "context-verify",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
  });

  it("rejects removing an edge into a started target as frozen", () => {
    const execution = pausedStartedVerify();
    const result = apply(execution, [
      {
        type: "remove-edge",
        sourceContextId: "context-implement",
        targetContextId: "context-verify",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("frozen");
  });

  it("rejects remove-context while outgoing edges remain, then succeeds after an in-batch remove-edge", () => {
    const rejected = apply(createWorkflowExecution({ status: "paused" }), [
      {
        type: "remove-context",
        contextId: "context-implement",
        deleteTasks: true,
      },
    ]);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("invalid_edit");

    const cleared = apply(createWorkflowExecution({ status: "paused" }), [
      {
        type: "remove-edge",
        sourceContextId: "context-implement",
        targetContextId: "context-verify",
      },
      {
        type: "remove-context",
        contextId: "context-implement",
        deleteTasks: true,
      },
    ]);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(
      cleared.execution.workingDefinition.executionContexts.some(
        (entry) => entry.id === "context-implement",
      ),
    ).toBe(false);
    expect(
      cleared.execution.contextStates["context-implement"],
    ).toBeUndefined();
    expect(cleared.execution.taskStates["task-implement-1"]).toBeUndefined();
    // The incoming edge plan → implement cascades away automatically.
    expect(
      cleared.execution.workingDefinition.edges.some(
        (edge) =>
          edge.sourceContextId === "context-implement" ||
          edge.targetContextId === "context-implement",
      ),
    ).toBe(false);
  });

  it("rejects remove-context with tasks unless deleteTasks is set", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      { type: "remove-context", contextId: "context-verify" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
  });

  it("rejects removing a started context", () => {
    const execution = pausedStartedVerify();
    const result = apply(execution, [
      {
        type: "remove-context",
        contextId: "context-verify",
        deleteTasks: true,
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
  });

  it("rejects an implementer whose Codex reasoning effort is unsupported by the model", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "minimal",
          },
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
    expect(
      result.issues.some(
        (issue) => issue.code === "implementer-effort-unsupported",
      ),
    ).toBe(true);
  });

  it("allows selecting a registered script-validator command", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(
      execution,
      [
        {
          type: "update-context",
          contextId: "context-implement",
          scriptValidator: { commands: ["typecheck"] },
        },
      ],
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.execution.workingDefinition.executionContexts.find(
      (context) => context.id === "context-implement",
    );
    expect(updated).toHaveProperty("scriptValidatorSource", "per-node");
  });

  it("allows prose edits on a quiescent started context without tripping the frozen-past net", () => {
    const execution = quiescentStartedPlan();
    const result = apply(execution, [
      { type: "update-context", contextId: "context-plan", title: "Replan" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    expect(context?.title).toBe("Replan");
  });

  it("rejects an update-context that sets a Codex validator whose effort the model rejects", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "update-context",
        contextId: "context-implement",
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "task",
              agent: {
                backend: "codex",
                model: "gpt-5.4",
                reasoningEffort: "minimal",
              },
              continuity: { enabled: true },
            },
          ],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
    expect(
      result.issues.some(
        (issue) => issue.code === "validator-effort-unsupported",
      ),
    ).toBe(true);
  });

  it("rejects an add-context whose validator effort is unsupported by the model", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = apply(execution, [
      {
        type: "add-context",
        id: "context-review",
        title: "Review",
        acceptanceCriteria: "Reviewed.",
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "conversation",
              agent: {
                backend: "codex",
                model: "gpt-5.4",
                reasoningEffort: "minimal",
              },
              continuity: { enabled: true },
            },
          ],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
    expect(
      result.issues.some(
        (issue) => issue.code === "validator-effort-unsupported",
      ),
    ).toBe(true);
  });

  it("rejects a batch that would disturb a completed task's position (frozen-past net)", () => {
    const execution = quiescentStartedPlan();
    const result = apply(execution, [
      {
        type: "move-task",
        taskId: "task-plan-3",
        targetContextId: "context-plan",
        position: { at: "start" },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("frozen");
  });
});

function pausedStartedVerify(): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "paused" });
  return {
    ...base,
    contextStates: {
      ...base.contextStates,
      "context-verify": {
        ...base.contextStates["context-verify"]!,
        status: "ready",
        iterationCount: 1,
      },
    },
  };
}

function withTwoImplTasks(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const base = createWorkflowExecution(overrides);
  return {
    ...base,
    workingDefinition: {
      ...base.workingDefinition,
      tasks: [
        ...base.workingDefinition.tasks,
        {
          id: "task-implement-2",
          contextId: "context-implement",
          order: 2,
          title: "Add tests",
          instructions: "Cover the new behavior.",
          source: "user",
        },
      ],
    },
    contextStates: {
      ...base.contextStates,
      "context-implement": {
        ...base.contextStates["context-implement"]!,
        totalTaskCount: 2,
      },
    },
    taskStates: {
      ...base.taskStates,
      "task-implement-2": pendingTaskState(
        "task-implement-2",
        "context-implement",
        2,
      ),
    },
  };
}

function quiescentStartedPlan(): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "paused" });
  return {
    ...base,
    workingDefinition: {
      ...base.workingDefinition,
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
          title: "Draft plan",
          instructions: "Write the plan.",
          source: "user",
        },
        {
          id: "task-plan-3",
          contextId: "context-plan",
          order: 3,
          title: "Review plan",
          instructions: "Review the plan.",
          source: "user",
        },
        ...base.workingDefinition.tasks.filter(
          (task) => task.contextId !== "context-plan",
        ),
      ],
    },
    contextStates: {
      ...base.contextStates,
      "context-plan": {
        ...base.contextStates["context-plan"]!,
        status: "ready",
        iterationCount: 1,
        totalTaskCount: 3,
        completedTaskCount: 1,
      },
    },
    taskStates: {
      ...base.taskStates,
      "task-plan-1": {
        ...base.taskStates["task-plan-1"]!,
        status: "completed",
        completedAt: "2026-03-27T16:40:00.000Z",
      },
      "task-plan-2": pendingTaskState("task-plan-2", "context-plan", 2),
      "task-plan-3": pendingTaskState("task-plan-3", "context-plan", 3),
    },
  };
}

describe("applyLiveExecutionEdits — amend-charter", () => {
  const NOW = "2026-07-29T10:00:00.000Z";

  function amendDeps(): LiveEditDeps {
    return makeDeps({ now: () => NOW });
  }

  function applyAmend(
    execution: GraphWorkflowExecution,
    operations: WorkflowLiveEditOperation[],
  ) {
    return applyLiveExecutionEdits(
      execution,
      { operations, source: "cli" },
      amendDeps(),
    );
  }

  /** Paused execution whose context-plan is frozen (completed). */
  function pausedWithFrozenPlan(): GraphWorkflowExecution {
    const base = createWorkflowExecution({ status: "paused" });
    return {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
        },
      },
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...base.taskStates["task-plan-1"]!,
          status: "completed",
          completedAt: "2026-03-27T16:40:00.000Z",
        },
      },
    };
  }

  it("requires a quiescent execution (requires_pause while running)", () => {
    const running = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });
    const result = applyAmend(running, [
      {
        type: "amend-charter",
        rationale: "mission drifted",
        mission: "Corrected mission",
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("requires_pause");
  });

  it("merges content, propagates to non-frozen contexts only, and appends the amendment log", () => {
    const execution = pausedWithFrozenPlan();
    const frozenCharterBefore = structuredClone(
      execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-plan",
      )?.charter,
    );

    const result = applyAmend(execution, [
      {
        type: "amend-charter",
        rationale: "Invariant inv-x was impossible against the shipped API",
        mission: "Amended mission statement",
        invariants: [
          { id: "inv-new", statement: "One authority per decision" },
        ],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.execution;

    expect(next.charter.mission).toBe("Amended mission statement");
    expect(next.charter.invariants).toEqual([
      { id: "inv-new", statement: "One authority per decision" },
    ]);

    const byId = new Map(
      next.workingDefinition.executionContexts.map((entry) => [
        entry.id,
        entry,
      ]),
    );
    // Frozen context keeps its as-run copy (may be undefined in this fixture).
    expect(byId.get("context-plan")?.charter).toEqual(frozenCharterBefore);
    // Non-frozen contexts carry the amended charter.
    expect(byId.get("context-implement")?.charter).toEqual(next.charter);
    expect(byId.get("context-verify")?.charter).toEqual(next.charter);

    expect(next.charterAmendments).toHaveLength(1);
    const amendment = next.charterAmendments[0]!;
    expect(amendment.seq).toBe(1);
    expect(amendment.amendedAt).toBe(NOW);
    expect(amendment.source).toBe("cli");
    expect(amendment.rationale).toBe(
      "Invariant inv-x was impossible against the shipped API",
    );
    expect([...amendment.fieldsChanged].sort()).toEqual([
      "invariants",
      "mission",
    ]);
    expect(amendment.charterHash.length).toBeGreaterThan(0);

    expect(result.affectedContextIds).toContain("context-implement");
    expect(result.affectedContextIds).toContain("context-verify");
    expect(result.affectedContextIds).not.toContain("context-plan");
  });

  it("rejects a merge that violates charter validity (duplicate invariant ids)", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = applyAmend(execution, [
      {
        type: "amend-charter",
        rationale: "bad merge",
        invariants: [
          { id: "inv-dup", statement: "first" },
          { id: "inv-dup", statement: "second" },
        ],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_edit");
    expect(result.issues[0]?.operationIndex).toBe(0);
  });

  it("gives a later add-context the amended charter (sequential visibility)", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = applyAmend(execution, [
      {
        type: "amend-charter",
        rationale: "clarify mission before fanning out",
        mission: "Amended before expansion",
      },
      {
        type: "add-context",
        id: "context-added",
        title: "Added later in the same batch",
        acceptanceCriteria: "Carries the amended charter",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = result.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-added",
    );
    expect(added?.charter?.mission).toBe("Amended before expansion");
  });

  it("rejects the whole batch when a later op fails (no amendment persists in the result)", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const result = applyAmend(execution, [
      {
        type: "amend-charter",
        rationale: "will be rolled back",
        mission: "Should not survive",
      },
      { type: "remove-task", taskId: "task-does-not-exist" },
    ]);
    expect(result.ok).toBe(false);
    expect(execution.charter.mission).not.toBe("Should not survive");
    expect(execution.charterAmendments).toHaveLength(0);
  });

  it("bumps the charter shared-document entry's updatedAt", () => {
    const base = createWorkflowExecution({ status: "paused" });
    const execution: GraphWorkflowExecution = {
      ...base,
      sharedDocuments: [
        {
          id: "doc-charter-1",
          relativePath: ".cc/graph-workflow-docs/charter.md",
          description: "The workflow charter",
          readWhen: "Read before resolving any source conflict",
          kind: "charter",
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
          lastUpdatedByConversationId: null,
        },
      ],
    };
    const result = applyAmend(execution, [
      {
        type: "amend-charter",
        rationale: "content changed; pointer copy is stale",
        mission: "Amended mission",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.sharedDocuments[0]?.updatedAt).toBe(NOW);
  });

  it("increments seq across amendments already on the execution", () => {
    const base = createWorkflowExecution({ status: "paused" });
    const execution: GraphWorkflowExecution = {
      ...base,
      charterAmendments: [
        {
          seq: 1,
          amendedAt: "2026-07-01T00:00:00.000Z",
          source: "ui",
          rationale: "earlier amendment",
          fieldsChanged: ["mission"],
          charterHash: "earlier-hash",
        },
      ],
    };
    const result = applyAmend(execution, [
      {
        type: "amend-charter",
        rationale: "second amendment",
        testStrategy: "Integration-first",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.charterAmendments).toHaveLength(2);
    expect(result.execution.charterAmendments[1]?.seq).toBe(2);
  });
});

describe("workflowLiveEditOperationSchema — amend-charter shape", () => {
  it("rejects an amendment with a rationale but no content field", () => {
    const parsed = workflowLiveEditOperationSchema.safeParse({
      type: "amend-charter",
      rationale: "changed nothing",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an amendment without a rationale", () => {
    const parsed = workflowLiveEditOperationSchema.safeParse({
      type: "amend-charter",
      mission: "New mission",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a rationale plus one content field and preserves null clears", () => {
    const parsed = workflowLiveEditOperationSchema.safeParse({
      type: "amend-charter",
      rationale: "test strategy section retracted",
      testStrategy: null,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      type: "amend-charter",
      testStrategy: null,
    });
  });
});

describe("applyLiveExecutionEdits — outputSchema on the live tier (R1.1, R1.2)", () => {
  const VALID_SCHEMA = {
    type: "object",
    required: ["verdict"],
    additionalProperties: false,
    properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
  };
  const UNENFORCEABLE_SCHEMA = {
    type: "object",
    properties: { verdict: { type: "string", format: "uri" } },
  };

  /** Parse through the shared vocabulary so the tests exercise the real ops. */
  function liveOps(...raw: unknown[]): WorkflowLiveEditOperation[] {
    return raw.map((entry) => workflowLiveEditOperationSchema.parse(entry));
  }

  function contextOf(result: ReturnType<typeof apply>, contextId: string) {
    if (!result.ok) throw new Error("expected the live edit batch to succeed");
    return result.execution.workingDefinition.executionContexts.find(
      (context) => context.id === contextId,
    );
  }

  it("sets outputSchema on a live add-context", () => {
    const result = apply(
      createWorkflowExecution({ status: "paused" }),
      liveOps({
        type: "add-context",
        id: "context-review",
        title: "Review",
        acceptanceCriteria: "Every finding is triaged.",
        outputSchema: VALID_SCHEMA,
      }),
    );

    expect(contextOf(result, "context-review")?.outputSchema).toEqual(
      VALID_SCHEMA,
    );
  });

  it("sets and then clears outputSchema through a live update-context", () => {
    const seeded = apply(
      createWorkflowExecution({ status: "paused" }),
      liveOps({
        type: "update-context",
        contextId: "context-verify",
        outputSchema: VALID_SCHEMA,
      }),
    );
    expect(contextOf(seeded, "context-verify")?.outputSchema).toEqual(
      VALID_SCHEMA,
    );

    if (!seeded.ok) throw new Error("expected the seeding batch to succeed");
    const cleared = apply(
      seeded.execution,
      liveOps({
        type: "update-context",
        contextId: "context-verify",
        outputSchema: null,
      }),
    );

    expect(contextOf(cleared, "context-verify")).not.toHaveProperty(
      "outputSchema",
    );
  });

  /**
   * A banked payload is evidence about ONE contract. Clearing or replacing that
   * contract makes the payload unvalidated against everything the definition
   * now says, so the row goes with the declaration rather than surviving to be
   * shown as this context's captured output (R7.6/R7.7).
   */
  it.each([
    { label: "cleared", next: null },
    {
      label: "replaced",
      next: {
        type: "object",
        required: ["verdict", "confidence"],
        properties: {
          verdict: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  ])(
    "drops a banked output when its schema is $label by a live update-context",
    ({ next }) => {
      const seeded = createWorkflowExecution({
        status: "paused",
        contextOutputs: {
          "context-verify": {
            value: { verdict: "pass" },
            capturedAt: "2026-07-31T10:00:00.000Z",
            iteration: 1,
            parse: { source: "native" },
          },
        },
      });
      seeded.workingDefinition.executionContexts =
        seeded.workingDefinition.executionContexts.map((context) =>
          context.id === "context-verify"
            ? { ...context, outputSchema: VALID_SCHEMA }
            : context,
        );

      const result = apply(
        seeded,
        liveOps({
          type: "update-context",
          contextId: "context-verify",
          outputSchema: next,
        }),
      );

      if (!result.ok)
        throw new Error("expected the live edit batch to succeed");
      expect(result.execution.contextOutputs).not.toHaveProperty(
        "context-verify",
      );
    },
  );

  it("keeps a banked output when the edit re-states the same schema", () => {
    const seeded = createWorkflowExecution({
      status: "paused",
      contextOutputs: {
        "context-verify": {
          value: { verdict: "pass" },
          capturedAt: "2026-07-31T10:00:00.000Z",
          iteration: 1,
          parse: { source: "native" },
        },
      },
    });
    seeded.workingDefinition.executionContexts =
      seeded.workingDefinition.executionContexts.map((context) =>
        context.id === "context-verify"
          ? { ...context, outputSchema: VALID_SCHEMA }
          : context,
      );

    const result = apply(
      seeded,
      liveOps({
        type: "update-context",
        contextId: "context-verify",
        // Same document, different key order — an unchanged contract, so the
        // payload it validated stays valid.
        outputSchema: {
          properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
          additionalProperties: false,
          required: ["verdict"],
          type: "object",
        },
      }),
    );

    if (!result.ok) throw new Error("expected the live edit batch to succeed");
    expect(result.execution.contextOutputs["context-verify"]?.value).toEqual({
      verdict: "pass",
    });
  });

  it.each([
    [
      "add-context",
      {
        type: "add-context",
        id: "context-review",
        title: "Review",
        acceptanceCriteria: "Every finding is triaged.",
        outputSchema: UNENFORCEABLE_SCHEMA,
      },
      "executionContexts[3].outputSchema.properties.verdict.format",
    ],
    [
      "update-context",
      {
        type: "update-context",
        contextId: "context-verify",
        outputSchema: UNENFORCEABLE_SCHEMA,
      },
      "executionContexts[2].outputSchema.properties.verdict.format",
    ],
  ])(
    "refuses a live %s fail-closed with a locator naming the context and schema path",
    (_label, operation, expectedField) => {
      const execution = createWorkflowExecution({ status: "paused" });
      const before = structuredClone(execution);

      const result = apply(execution, liveOps(operation));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid_edit");
      const issue = result.issues.find(
        (candidate) => candidate.field === expectedField,
      );
      expect(issue?.contextId).toBe(
        expectedField.startsWith("executionContexts[3]")
          ? "context-review"
          : "context-verify",
      );
      expect(issue?.message).toContain("format");
      // Fail-closed means the whole batch is refused, not partially applied.
      expect(execution).toEqual(before);
    },
  );

  /**
   * `outputSchema` rides the SAME lifecycle gate as every other context field —
   * it gets no bypass. A completed context refuses both a set and a clear.
   * The case type is derived from the op schema itself, so a change to the
   * field's vocabulary breaks this table at compile time.
   */
  type FrozenOutputSchemaCase = {
    label: string;
    outputSchema: Exclude<
      Extract<
        WorkflowLiveEditOperation,
        { type: "update-context" }
      >["outputSchema"],
      undefined
    >;
  };

  it.each<FrozenOutputSchemaCase>([
    { label: "sets", outputSchema: VALID_SCHEMA },
    { label: "clears", outputSchema: null },
  ])(
    "refuses a live update-context that $label outputSchema on a frozen context",
    ({ outputSchema }) => {
      const execution = createWorkflowExecution({ status: "paused" });
      const planContext = execution.contextStates["context-plan"];
      const planTask = execution.taskStates["task-plan-1"];
      if (!planContext || !planTask) {
        throw new Error("fixture must seed context-plan and task-plan-1");
      }
      const frozen: GraphWorkflowExecution = {
        ...execution,
        contextStates: {
          ...execution.contextStates,
          "context-plan": {
            ...planContext,
            status: "completed",
            completedTaskCount: 1,
          },
        },
        taskStates: {
          ...execution.taskStates,
          "task-plan-1": {
            ...planTask,
            status: "completed",
            completedAt: "2026-03-27T16:40:00.000Z",
          },
        },
      };
      const before = structuredClone(frozen);

      const result = apply(
        frozen,
        liveOps({
          type: "update-context",
          contextId: "context-plan",
          outputSchema,
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("frozen");
      expect(result.issues[0]?.contextId).toBe("context-plan");
      expect(result.issues[0]?.operationIndex).toBe(0);
      expect(frozen).toEqual(before);
    },
  );
});
