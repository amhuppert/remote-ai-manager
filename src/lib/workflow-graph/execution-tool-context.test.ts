import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import {
  createGraphWorkflowExecutionToolContext,
  type GraphWorkflowExecutionToolContextDeps,
} from "./execution-tool-context";
import type { ExecutionTarget } from "./execution-target-resolver";
import { createGraphWorkflowRuntimeEditService } from "./runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "./shared-documents";
import { createWorkflowExecution } from "./test-fixtures";
import type { GraphWorkflowCollaborationContextBlock } from "./tool-server";

interface FakeStore {
  current: GraphWorkflowExecution;
  serializedQueue: Promise<unknown>;
  mutateCount: number;
}

function createFakeStore(initial: GraphWorkflowExecution): FakeStore {
  return {
    current: structuredClone(initial),
    serializedQueue: Promise.resolve(),
    mutateCount: 0,
  };
}

function createFakeMutateActive(
  store: FakeStore,
): GraphWorkflowExecutionToolContextDeps["workflowManager"]["mutateActive"] {
  return async function mutateActive(
    _projectPath,
    _sessionName,
    fn,
  ): Promise<GraphWorkflowExecution> {
    const next = store.serializedQueue.then(async () => {
      store.mutateCount += 1;
      const draft = structuredClone(store.current);
      const result = await fn(draft);
      store.current = structuredClone(result);
      return store.current;
    });
    store.serializedQueue = next.catch(() => undefined);
    return next;
  };
}

function withRunningContext(
  execution: GraphWorkflowExecution,
  contextIds: string[],
  options: { worktreePath?: string; branchName?: string } = {},
): GraphWorkflowExecution {
  const next: GraphWorkflowExecution = {
    ...execution,
    status: "running",
    activeContextIds: contextIds,
    contextStates: { ...execution.contextStates },
  };
  for (const contextId of contextIds) {
    const existing = next.contextStates[contextId];
    if (!existing) {
      throw new Error(`fixture missing contextId=${contextId}`);
    }
    next.contextStates[contextId] = {
      ...existing,
      status: "running",
      worktreePath: options.worktreePath ?? null,
      branchName: options.branchName ?? null,
      isolation: options.worktreePath ? "worktree" : "session",
    };
  }
  return next;
}

interface FactoryOptions {
  initialExecution?: GraphWorkflowExecution;
}

interface FactoryResult {
  store: FakeStore;
  toolContext: ReturnType<
    ReturnType<typeof createGraphWorkflowExecutionToolContext>["create"]
  >;
  deps: GraphWorkflowExecutionToolContextDeps;
}

interface CreateInputOverrides {
  executionId?: string;
  contextId?: string;
  conversationId?: string;
  executionTarget?: ExecutionTarget;
  executionContextTitle?: string;
  allowAgentTaskAdd?: boolean;
}

const sessionTarget: ExecutionTarget = {
  worktreePath: "/repo/.worktrees/session-1",
  branchName: "csm/session-1",
  isolation: "session",
  laneId: null,
};

function buildToolContext(
  factoryOptions: FactoryOptions,
  overrides: CreateInputOverrides = {},
): FactoryResult {
  const initial =
    factoryOptions.initialExecution ??
    withRunningContext(createWorkflowExecution(), ["context-plan"]);
  const store = createFakeStore(initial);
  const runtimeEditService = createGraphWorkflowRuntimeEditService({
    createTaskId: () => "task-agent-generated",
    now: () => "2026-03-27T12:00:00.000Z",
  });
  const sharedDocumentRegistry =
    createGraphWorkflowSharedDocumentRegistryService({
      now: () => "2026-03-27T12:00:00.000Z",
      createDocumentId: () => "doc-1",
    });
  const deps: GraphWorkflowExecutionToolContextDeps = {
    workflowManager: {
      mutateActive: createFakeMutateActive(store),
    },
    runtimeEditService,
    sharedDocumentRegistry,
    now: () => "2026-03-27T12:00:00.000Z",
  };
  const factory = createGraphWorkflowExecutionToolContext(deps);
  const toolContext = factory.create({
    projectPath: "/projects/test",
    sessionName: "session-1",
    executionId: overrides.executionId ?? "execution-1",
    contextId: overrides.contextId ?? "context-plan",
    conversationId: overrides.conversationId ?? "conv-bound",
    executionTarget: overrides.executionTarget ?? sessionTarget,
    executionContextTitle: overrides.executionContextTitle ?? "Plan",
    allowAgentTaskAdd: overrides.allowAgentTaskAdd ?? true,
    allowAgentCollaboration: false,
  });
  return { store, toolContext, deps };
}

describe("GraphWorkflowExecutionToolContext", () => {
  beforeEach(() => {});

  it("completes a task through mutateActive with the bound conversationId fallback", async () => {
    const { store, toolContext } = buildToolContext({});

    await toolContext.completeTask("task-plan-1", "Wrote the plan.");

    const taskState = store.current.taskStates["task-plan-1"];
    expect(taskState?.status).toBe("completed");
    expect(taskState?.summary).toBe("Wrote the plan.");
    expect(taskState?.lastConversationId).toBe("conv-bound");
    expect(
      store.current.contextStates["context-plan"]?.completedTaskCount,
    ).toBe(1);
  });

  it("prefers the addressed task's lastConversationId when present", async () => {
    const initial = withRunningContext(createWorkflowExecution(), [
      "context-plan",
    ]);
    const taskState = initial.taskStates["task-plan-1"];
    if (!taskState) throw new Error("missing task fixture");
    initial.taskStates["task-plan-1"] = {
      ...taskState,
      lastConversationId: "conv-task-direct",
    };
    const { store, toolContext } = buildToolContext({
      initialExecution: initial,
    });

    await toolContext.completeTask("task-plan-1", "done");

    expect(store.current.taskStates["task-plan-1"]?.lastConversationId).toBe(
      "conv-task-direct",
    );
  });

  it("ignores non-running tasks in the bound context when falling back to a conversationId", async () => {
    const base = createWorkflowExecution();
    const completedPlanTask = base.taskStates["task-plan-1"];
    if (!completedPlanTask) throw new Error("missing plan task fixture");
    base.taskStates["task-plan-1"] = {
      ...completedPlanTask,
      status: "completed",
      lastConversationId: "conv-stale-completed",
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    base.workingDefinition = {
      ...base.workingDefinition,
      tasks: [
        ...base.workingDefinition.tasks,
        {
          id: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          title: "Second plan task",
          instructions: "Continue planning.",
          source: "user",
        },
      ],
    };
    base.taskStates["task-plan-2"] = {
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
    };
    const planContextState = base.contextStates["context-plan"];
    if (!planContextState) throw new Error("missing plan context fixture");
    base.contextStates["context-plan"] = {
      ...planContextState,
      totalTaskCount: 2,
      completedTaskCount: 1,
    };
    const initial = withRunningContext(base, ["context-plan"]);
    const { store, toolContext } = buildToolContext({
      initialExecution: initial,
    });

    await toolContext.completeTask("task-plan-2", "second-task done");

    expect(store.current.taskStates["task-plan-2"]?.lastConversationId).toBe(
      "conv-bound",
    );
  });

  it("never resolves a conversationId from a different context's tasks", async () => {
    const base = createWorkflowExecution();
    const otherTask = base.taskStates["task-implement-1"];
    if (!otherTask) throw new Error("missing implement task fixture");
    base.taskStates["task-implement-1"] = {
      ...otherTask,
      lastConversationId: "conv-other-context",
    };
    const initial = withRunningContext(base, [
      "context-plan",
      "context-implement",
    ]);
    const { store, toolContext } = buildToolContext({
      initialExecution: initial,
    });

    await toolContext.completeTask("task-plan-1", "summary");

    expect(store.current.taskStates["task-plan-1"]?.lastConversationId).toBe(
      "conv-bound",
    );
  });

  it("rejects completeTask once the bound contextId leaves the active set", async () => {
    const initial = withRunningContext(createWorkflowExecution(), [
      "context-implement",
    ]);
    const { toolContext } = buildToolContext(
      { initialExecution: initial },
      { contextId: "context-plan" },
    );

    await expect(
      toolContext.completeTask("task-plan-1", "summary"),
    ).rejects.toThrow(/no longer in the active set|not in the active set/i);
  });

  it("rejects completeTask when the bound context is not running", async () => {
    const initial = withRunningContext(createWorkflowExecution(), [
      "context-plan",
    ]);
    const planState = initial.contextStates["context-plan"];
    if (!planState) throw new Error("missing plan context");
    initial.contextStates["context-plan"] = {
      ...planState,
      status: "pending",
    };
    initial.activeContextIds = ["context-plan"];
    const { toolContext } = buildToolContext({ initialExecution: initial });

    await expect(
      toolContext.completeTask("task-plan-1", "summary"),
    ).rejects.toThrow(/is not running/i);
  });

  it("rejects completeTask if the task belongs to a different context", async () => {
    const initial = withRunningContext(createWorkflowExecution(), [
      "context-plan",
    ]);
    const { toolContext } = buildToolContext({ initialExecution: initial });

    await expect(
      toolContext.completeTask("task-implement-1", "summary"),
    ).rejects.toThrow(/does not belong to context/i);
  });

  it("rejects an already-completed completeTask once the bound contextId leaves the active set", async () => {
    const initial = withRunningContext(createWorkflowExecution(), [
      "context-implement",
    ]);
    const planTaskState = initial.taskStates["task-plan-1"];
    if (!planTaskState) throw new Error("missing task fixture");
    initial.taskStates["task-plan-1"] = {
      ...planTaskState,
      status: "completed",
      completedAt: "2026-01-01T00:00:00.000Z",
      summary: "earlier completion",
    };
    const { toolContext } = buildToolContext(
      { initialExecution: initial },
      { contextId: "context-plan" },
    );

    await expect(
      toolContext.completeTask("task-plan-1", "stale retry"),
    ).rejects.toThrow(/no longer in the active set|not in the active set/i);
  });

  it("treats completeTask as idempotent when the task is already completed", async () => {
    const initial = withRunningContext(createWorkflowExecution(), [
      "context-plan",
    ]);
    const taskState = initial.taskStates["task-plan-1"];
    if (!taskState) throw new Error("missing task fixture");
    initial.taskStates["task-plan-1"] = {
      ...taskState,
      status: "completed",
      completedAt: "2026-01-01T00:00:00.000Z",
      summary: "first time",
    };
    const { store, toolContext } = buildToolContext({
      initialExecution: initial,
    });

    await toolContext.completeTask("task-plan-1", "second time");

    expect(store.current.taskStates["task-plan-1"]?.summary).toBe("first time");
    expect(store.current.taskStates["task-plan-1"]?.completedAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("appends agent-added tasks via the runtime edit service", async () => {
    const { store, toolContext } = buildToolContext({});

    await toolContext.addTask({
      title: "New planning task",
      instructions: "Capture more questions.",
    });

    const planTasks = store.current.workingDefinition.tasks.filter(
      (task) => task.contextId === "context-plan",
    );
    expect(planTasks.map((task) => task.id)).toContain("task-agent-generated");
  });

  it("rejects addTask once the bound contextId leaves the active set", async () => {
    const initial = withRunningContext(createWorkflowExecution(), [
      "context-implement",
    ]);
    const { toolContext } = buildToolContext(
      { initialExecution: initial },
      { contextId: "context-plan" },
    );

    await expect(
      toolContext.addTask({
        title: "Late task",
        instructions: "Should be rejected.",
      }),
    ).rejects.toThrow(/active set|currently executing context/i);
  });

  it("upserts a shared document against the executionTarget worktree path", async () => {
    const subWorktreeTarget: ExecutionTarget = {
      worktreePath: "/repo/.worktrees/session-1.context-plan",
      branchName: "csm/session-1-context-plan",
      isolation: "worktree",
      laneId: null,
    };
    const { store, toolContext } = buildToolContext(
      {},
      { executionTarget: subWorktreeTarget },
    );

    await toolContext.upsertSharedDocument({
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Planning notes",
      readWhen: "Read before implementation.",
    });

    expect(store.current.sharedDocuments).toEqual([
      expect.objectContaining({
        relativePath: ".cc/graph-workflow-docs/plan.md",
        description: "Planning notes",
        readWhen: "Read before implementation.",
        lastUpdatedByConversationId: "conv-bound",
      }),
    ]);
  });

  it("rejects shared documents whose path is outside .cc/graph-workflow-docs", async () => {
    const { toolContext } = buildToolContext({});

    await expect(
      toolContext.upsertSharedDocument({
        relativePath: "src/secret.ts",
        description: "rogue",
        readWhen: "never",
      }),
    ).rejects.toThrow();
  });

  it("rejects shared documents that escape the resolved worktree root", async () => {
    const { toolContext } = buildToolContext({});

    await expect(
      toolContext.upsertSharedDocument({
        relativePath: "../escape.md",
        description: "rogue",
        readWhen: "never",
      }),
    ).rejects.toThrow();
  });

  it("persists concurrent completeTask calls from sibling contexts without losing writes", async () => {
    const initial = withRunningContext(createWorkflowExecution(), [
      "context-plan",
      "context-implement",
    ]);
    const store = createFakeStore(initial);
    const runtimeEditService = createGraphWorkflowRuntimeEditService();
    const sharedDocumentRegistry =
      createGraphWorkflowSharedDocumentRegistryService();
    const deps: GraphWorkflowExecutionToolContextDeps = {
      workflowManager: { mutateActive: createFakeMutateActive(store) },
      runtimeEditService,
      sharedDocumentRegistry,
    };
    const factory = createGraphWorkflowExecutionToolContext(deps);

    const planContext = factory.create({
      projectPath: "/projects/test",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-plan",
      conversationId: "conv-plan",
      executionTarget: sessionTarget,
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: false,
    });
    const implementContext = factory.create({
      projectPath: "/projects/test",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-implement",
      conversationId: "conv-implement",
      executionTarget: sessionTarget,
      executionContextTitle: "Implement",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: false,
    });

    await Promise.all([
      planContext.completeTask("task-plan-1", "plan done"),
      implementContext.completeTask("task-implement-1", "implement done"),
    ]);

    expect(store.current.taskStates["task-plan-1"]?.status).toBe("completed");
    expect(store.current.taskStates["task-plan-1"]?.summary).toBe("plan done");
    expect(store.current.taskStates["task-implement-1"]?.status).toBe(
      "completed",
    );
    expect(store.current.taskStates["task-implement-1"]?.summary).toBe(
      "implement done",
    );
    expect(store.mutateCount).toBe(2);
  });

  it("threads an optional collaboration block onto the bound tool context", () => {
    const collaboration: GraphWorkflowCollaborationContextBlock = {
      parentImplementerTurnId: "turn-1",
      executionContextId: "context-plan",
      conversationId: "conv-bound",
      executionId: "execution-1",
      iterationIndex: 0,
      resolveCollaborationConfig: () => ({
        secondAgent: {
          value: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "medium",
          },
          source: "global",
        },
        negotiationRounds: { value: 3, source: "global" },
        autonomousResolutionThreshold: { value: "minor", source: "global" },
      }),
      triggerWorkflowCollaboration: vi.fn(),
      setPendingHaltReason: vi.fn(),
    };
    const { toolContext } = buildToolContext({});
    const factory = createGraphWorkflowExecutionToolContext({
      workflowManager: {
        mutateActive: async (_p, _s, fn) =>
          fn(structuredClone(createWorkflowExecution())) as never,
      },
      runtimeEditService: createGraphWorkflowRuntimeEditService(),
      sharedDocumentRegistry:
        createGraphWorkflowSharedDocumentRegistryService(),
    });
    const bound = factory.create({
      projectPath: "/projects/test",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-plan",
      conversationId: "conv-bound",
      executionTarget: sessionTarget,
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: true,
      collaboration,
    });

    expect(bound.allowAgentCollaboration).toBe(true);
    expect(bound.collaboration).toBe(collaboration);
    expect(toolContext.collaboration).toBeUndefined();
  });

  it("preserves a sibling's addTask write when racing with a completeTask", async () => {
    const initial = withRunningContext(createWorkflowExecution(), [
      "context-plan",
      "context-implement",
    ]);
    const planState = initial.contextStates["context-plan"];
    if (planState) {
      initial.contextStates["context-plan"] = {
        ...planState,
        totalTaskCount: 1,
      };
    }
    const store = createFakeStore(initial);
    let counter = 0;
    const runtimeEditService = createGraphWorkflowRuntimeEditService({
      createTaskId: () => {
        counter += 1;
        return `task-agent-${counter}`;
      },
    });
    const sharedDocumentRegistry =
      createGraphWorkflowSharedDocumentRegistryService();
    const deps: GraphWorkflowExecutionToolContextDeps = {
      workflowManager: { mutateActive: createFakeMutateActive(store) },
      runtimeEditService,
      sharedDocumentRegistry,
    };
    const factory = createGraphWorkflowExecutionToolContext(deps);
    const planContext = factory.create({
      projectPath: "/projects/test",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-plan",
      conversationId: "conv-plan",
      executionTarget: sessionTarget,
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: false,
    });
    const implementContext = factory.create({
      projectPath: "/projects/test",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-implement",
      conversationId: "conv-implement",
      executionTarget: sessionTarget,
      executionContextTitle: "Implement",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: false,
    });

    await Promise.all([
      planContext.addTask({
        title: "Planner discovered task",
        instructions: "Look into edge case.",
      }),
      implementContext.completeTask("task-implement-1", "implement done"),
    ]);

    const planTaskIds = store.current.workingDefinition.tasks
      .filter((task) => task.contextId === "context-plan")
      .map((task) => task.id);
    expect(planTaskIds).toContain("task-agent-1");
    expect(store.current.taskStates["task-implement-1"]?.status).toBe(
      "completed",
    );
  });
});
