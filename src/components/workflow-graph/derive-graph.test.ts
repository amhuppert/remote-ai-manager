import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowContextStatus,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowResolvedContext,
  GraphWorkflowVisualLayout,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  deriveEdges,
  deriveNodes,
  getContextDisplayPhase,
  getDisplayApprovalGate,
  getDisplayValidators,
} from "./derive-graph";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";

function makeDefinition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: [],
    tasks: [],
    edges: [],
    ...overrides,
  };
}

function makeLayout(
  overrides: Partial<GraphWorkflowVisualLayout> = {},
): GraphWorkflowVisualLayout {
  return {
    workflowId: "wf-1",
    contextPositions: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides,
  };
}

function makeExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return {
    id: "exec-1",
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    workingDefinition:
      makeDefinition() as unknown as ResolvedWorkflowSemanticDefinition,
    status: "running",
    activeContextIds: [],
    activeTaskId: null,
    contextStates: {},
    taskStates: {},
    contextOutputs: {},
    sharedDocuments: [],
    machineSnapshot: null,
    history: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    haltReason: null,
    ...overrides,
  } as GraphWorkflowExecution;
}

describe("deriveNodes", () => {
  it("returns empty array for empty definition", () => {
    const result = deriveNodes(makeDefinition(), makeLayout());
    expect(result).toEqual([]);
  });

  it("derives a single node at default position when layout has no entry", () => {
    const def = makeDefinition({
      executionContexts: [
        {
          id: "ctx-1",
          title: "My Context",
          description: "desc",
          acceptanceCriteria: "TBD",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin" as const, id: "general-implementer" },
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        },
      ],
    });
    const layout = makeLayout();

    const nodes = deriveNodes(def, layout);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe("ctx-1");
    expect(nodes[0]!.type).toBe("executionContext");
    expect(nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(nodes[0]!.data.context.title).toBe("My Context");
    expect(nodes[0]!.data.tasks).toEqual([]);
    expect(nodes[0]!.data.mode).toBe("builder");
    expect(nodes[0]!.data.contextState).toBeUndefined();
    expect(nodes[0]!.data.taskStates).toBeUndefined();
  });

  it("uses layout positions when provided", () => {
    const def = makeDefinition({
      executionContexts: [
        {
          id: "ctx-1",
          title: "A",
          acceptanceCriteria: "TBD",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin" as const, id: "general-implementer" },
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        },
        {
          id: "ctx-2",
          title: "B",
          acceptanceCriteria: "TBD",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin" as const, id: "general-implementer" },
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        },
      ],
    });
    const layout = makeLayout({
      contextPositions: {
        "ctx-1": { x: 100, y: 200 },
        "ctx-2": { x: 400, y: 50 },
      },
    });

    const nodes = deriveNodes(def, layout);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.position).toEqual({ x: 100, y: 200 });
    expect(nodes[1]!.position).toEqual({ x: 400, y: 50 });
  });

  it("sorts tasks by order within each node", () => {
    const def = makeDefinition({
      executionContexts: [
        {
          id: "ctx-1",
          title: "A",
          acceptanceCriteria: "TBD",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin" as const, id: "general-implementer" },
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        },
      ],
      tasks: [
        {
          id: "t3",
          contextId: "ctx-1",
          order: 3,
          title: "Third",
          instructions: "",
          source: "user",
        },
        {
          id: "t1",
          contextId: "ctx-1",
          order: 1,
          title: "First",
          instructions: "",
          source: "user",
        },
        {
          id: "t2",
          contextId: "ctx-1",
          order: 2,
          title: "Second",
          instructions: "",
          source: "user",
        },
        {
          id: "t4",
          contextId: "ctx-2",
          order: 1,
          title: "Other",
          instructions: "",
          source: "user",
        },
      ],
    });

    const nodes = deriveNodes(def, makeLayout());
    expect(nodes[0]!.data.tasks).toHaveLength(3);
    expect(nodes[0]!.data.tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("populates contextState and taskStates in execution mode", () => {
    const def = makeDefinition({
      executionContexts: [
        {
          id: "ctx-1",
          title: "A",
          acceptanceCriteria: "TBD",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin" as const, id: "general-implementer" },
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        },
      ],
      tasks: [
        {
          id: "t1",
          contextId: "ctx-1",
          order: 1,
          title: "Task",
          instructions: "",
          source: "user",
        },
      ],
    });

    const ctxState: GraphWorkflowExecutionContextState = {
      pendingApproval: null,
      pendingUserInputs: {},
      contextId: "ctx-1",
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
    };

    const taskState: GraphWorkflowTaskState = {
      taskId: "t1",
      contextId: "ctx-1",
      order: 1,
      status: "running",
      summary: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      lastConversationId: null,
      failureMessage: null,
      failureHistory: [],
    };

    const execution = makeExecution({
      workingDefinition: def as unknown as ResolvedWorkflowSemanticDefinition,
      contextStates: { "ctx-1": ctxState },
      taskStates: { t1: taskState },
    });

    const nodes = deriveNodes(def, makeLayout(), execution);
    expect(nodes[0]!.data.mode).toBe("execution");
    expect(nodes[0]!.data.contextState).toEqual(ctxState);
    expect(nodes[0]!.data.taskStates).toEqual({ t1: taskState });
  });
});

describe("deriveNodes wait state attachment", () => {
  function makeCtx(id: string) {
    return {
      id,
      title: id,
      acceptanceCriteria: "TBD",
      implementer: {
        id: "implementer",
        profile: { tier: "builtin" as const, id: "general-implementer" },
        agent: {
          backend: "claude" as const,
          model: "sonnet" as const,
          reasoningEffort: "medium" as const,
        },
      },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
    };
  }

  function makeCtxState(
    overrides: Partial<GraphWorkflowExecutionContextState> &
      Pick<GraphWorkflowExecutionContextState, "contextId" | "status">,
  ): GraphWorkflowExecutionContextState {
    return {
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
      pendingUserInputs: {},
      ...overrides,
    };
  }

  it("attaches no waitState in builder mode", () => {
    const def = makeDefinition({ executionContexts: [makeCtx("ctx-1")] });
    const nodes = deriveNodes(def, makeLayout());
    expect(nodes[0]!.data.waitState).toBeUndefined();
  });

  it("marks a pending downstream context as dependency-blocked while its upstream is still running", () => {
    const def = makeDefinition({
      executionContexts: [makeCtx("ctx-a"), makeCtx("ctx-b")],
      edges: [{ id: "e1", sourceContextId: "ctx-a", targetContextId: "ctx-b" }],
    });
    const execution = makeExecution({
      workingDefinition: def as unknown as ResolvedWorkflowSemanticDefinition,
      contextStates: {
        "ctx-a": makeCtxState({ contextId: "ctx-a", status: "running" }),
        "ctx-b": makeCtxState({ contextId: "ctx-b", status: "pending" }),
      },
    });

    const nodes = deriveNodes(def, makeLayout(), execution);
    const ctxB = nodes.find((n) => n.id === "ctx-b");
    expect(ctxB?.data.waitState).toEqual({
      kind: "dependency-blocked",
      unmetDependencyIds: ["ctx-a"],
      blockedByApproval: false,
    });
  });

  it("marks a downstream context whose dependencies are satisfied as ready (no false Waiting on upstream)", () => {
    const def = makeDefinition({
      executionContexts: [makeCtx("ctx-a"), makeCtx("ctx-b")],
      edges: [{ id: "e1", sourceContextId: "ctx-a", targetContextId: "ctx-b" }],
    });
    const execution = makeExecution({
      workingDefinition: def as unknown as ResolvedWorkflowSemanticDefinition,
      contextStates: {
        "ctx-a": makeCtxState({
          contextId: "ctx-a",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
        }),
        "ctx-b": makeCtxState({ contextId: "ctx-b", status: "pending" }),
      },
    });

    const nodes = deriveNodes(def, makeLayout(), execution);
    const ctxB = nodes.find((n) => n.id === "ctx-b");
    expect(ctxB?.data.waitState).toEqual({ kind: "ready" });
  });

  it("falls back to a useful wait state for legacy executions that lack lane/join records", () => {
    const def = makeDefinition({ executionContexts: [makeCtx("ctx-1")] });
    const execution = makeExecution({
      workingDefinition: def as unknown as ResolvedWorkflowSemanticDefinition,
      contextStates: {
        "ctx-1": makeCtxState({ contextId: "ctx-1", status: "ready" }),
      },
    });
    delete (execution as Partial<GraphWorkflowExecution>).executionLanes;
    delete (execution as Partial<GraphWorkflowExecution>).joins;

    const nodes = deriveNodes(def, makeLayout(), execution);
    expect(nodes[0]!.data.waitState).toEqual({ kind: "ready" });
  });

  it("surfaces waiting-for-lane when the assigned lane is still pending", () => {
    const def = makeDefinition({ executionContexts: [makeCtx("ctx-1")] });
    const execution = makeExecution({
      workingDefinition: def as unknown as ResolvedWorkflowSemanticDefinition,
      contextStates: {
        "ctx-1": makeCtxState({
          contextId: "ctx-1",
          status: "ready",
          laneId: "lane-x",
        }),
      },
      executionLanes: {
        "lane-x": {
          laneId: "lane-x",
          kind: "worktree",
          status: "pending",
          worktreePath: null,
          branchName: "feature/lane-x",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const nodes = deriveNodes(def, makeLayout(), execution);
    expect(nodes[0]!.data.waitState).toEqual({
      kind: "waiting-for-lane",
      laneId: "lane-x",
    });
  });
});

describe("getContextDisplayPhase", () => {
  function makeState(
    overrides: Partial<GraphWorkflowExecutionContextState> = {},
  ): GraphWorkflowExecutionContextState {
    return {
      contextId: "ctx-1",
      status: "running",
      totalTaskCount: 3,
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
      pendingApproval: null,
      pendingUserInputs: {},
      ...overrides,
    };
  }

  it("returns undefined when no state provided", () => {
    expect(getContextDisplayPhase(undefined)).toBeUndefined();
  });

  it("passes through non-running statuses", () => {
    expect(getContextDisplayPhase(makeState({ status: "pending" }))).toBe(
      "pending",
    );
    expect(getContextDisplayPhase(makeState({ status: "ready" }))).toBe(
      "ready",
    );
    expect(
      getContextDisplayPhase(
        makeState({
          status: "completed",
          completedTaskCount: 3,
          totalTaskCount: 3,
        }),
      ),
    ).toBe("completed");
    expect(getContextDisplayPhase(makeState({ status: "halted" }))).toBe(
      "halted",
    );
  });

  it("returns 'running' when tasks are in progress", () => {
    expect(
      getContextDisplayPhase(
        makeState({ completedTaskCount: 0, totalTaskCount: 3 }),
      ),
    ).toBe("running");
    expect(
      getContextDisplayPhase(
        makeState({ completedTaskCount: 2, totalTaskCount: 3 }),
      ),
    ).toBe("running");
  });

  it("returns 'validating' when status is running and all tasks are complete", () => {
    expect(
      getContextDisplayPhase(
        makeState({ completedTaskCount: 3, totalTaskCount: 3 }),
      ),
    ).toBe("validating");
  });

  it("returns 'running' when there are no tasks (edge case, not a validation phase)", () => {
    expect(
      getContextDisplayPhase(
        makeState({ completedTaskCount: 0, totalTaskCount: 0 }),
      ),
    ).toBe("running");
  });

  it("returns 'merging' when mergeStatus is in-progress, regardless of status", () => {
    expect(
      getContextDisplayPhase(
        makeState({
          status: "running",
          completedTaskCount: 3,
          totalTaskCount: 3,
          mergeStatus: "in-progress",
        }),
      ),
    ).toBe("merging");
    expect(
      getContextDisplayPhase(
        makeState({
          status: "completed",
          completedTaskCount: 3,
          totalTaskCount: 3,
          mergeStatus: "in-progress",
        }),
      ),
    ).toBe("merging");
  });

  it("does not return 'merging' for terminal merge statuses (merged-success / merged-failed / conflicts)", () => {
    expect(
      getContextDisplayPhase(
        makeState({
          status: "completed",
          completedTaskCount: 3,
          totalTaskCount: 3,
          mergeStatus: "merged-success",
        }),
      ),
    ).toBe("completed");
    expect(
      getContextDisplayPhase(
        makeState({
          status: "halted",
          mergeStatus: "merged-failed",
        }),
      ),
    ).toBe("halted");
  });
});

describe("getDisplayValidators", () => {
  function makeResolved(
    overrides: Partial<GraphWorkflowResolvedContext> = {},
  ): GraphWorkflowResolvedContext {
    return {
      id: "ctx-1",
      title: "Ctx",
      acceptanceCriteria: "AC",
      implementer: {
        id: "implementer",
        profile: { tier: "builtin" as const, id: "general-implementer" },
        profileSnapshot: makeProfileSnapshot(),
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      contextValidator: { enabled: false, assignments: [] },
      scriptValidator: { enabled: false },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: { consecutiveFailureThreshold: 3 },
      iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
      planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      ...overrides,
    };
  }

  function makeBuilderContext(
    overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
  ): GraphWorkflowExecutionContextDefinition {
    return {
      id: "ctx-1",
      title: "Ctx",
      acceptanceCriteria: "AC",
      implementer: {
        id: "implementer",
        profile: { tier: "builtin" as const, id: "general-implementer" },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
      ...overrides,
    };
  }

  it("returns no validators when both script is disabled and context validator is null", () => {
    expect(getDisplayValidators(makeResolved())).toEqual({
      script: false,
      agent: null,
    });
  });

  it("surfaces an inherited script validator as enabled", () => {
    const ctx = makeResolved({ scriptValidator: { enabled: true } });
    expect(getDisplayValidators(ctx)).toEqual({ script: true, agent: null });
  });

  it("surfaces an inherited claude agent validator", () => {
    const ctx = makeResolved({
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin" as const, id: "general-reviewer" },
            profileSnapshot: makeProfileSnapshot(),
            strategy: "conversation" as const,
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
        ],
      },
    });
    expect(getDisplayValidators(ctx)).toEqual({
      script: false,
      agent: "claude",
    });
  });

  it("surfaces an inherited codex agent validator", () => {
    const ctx = makeResolved({
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin" as const, id: "general-reviewer" },
            profileSnapshot: makeProfileSnapshot(),
            strategy: "task" as const,
            agent: {
              backend: "codex",
              model: "gpt-5.4",
              reasoningEffort: "high",
            },
            continuity: { enabled: true },
          },
        ],
      },
    });
    expect(getDisplayValidators(ctx)).toEqual({
      script: false,
      agent: "codex",
    });
  });

  it("hides the agent validator when its config is present but disabled", () => {
    const ctx = makeResolved({
      contextValidator: {
        enabled: false,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin" as const, id: "general-reviewer" },
            profileSnapshot: makeProfileSnapshot(),
            strategy: "conversation" as const,
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
        ],
      },
    });
    expect(getDisplayValidators(ctx)).toEqual({
      script: false,
      agent: null,
    });
  });

  it("surfaces both validators together when both are enabled", () => {
    const ctx = makeResolved({
      scriptValidator: { enabled: true },
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin" as const, id: "general-reviewer" },
            profileSnapshot: makeProfileSnapshot(),
            strategy: "conversation" as const,
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
        ],
      },
    });
    expect(getDisplayValidators(ctx)).toEqual({
      script: true,
      agent: "claude",
    });
  });

  it("surfaces a claude agent validator from a per-context 'use' override", () => {
    const ctx = makeBuilderContext({
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin" as const, id: "general-reviewer" },
            strategy: "conversation" as const,
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
        ],
      },
    });
    expect(getDisplayValidators(ctx)).toEqual({
      script: false,
      agent: "claude",
    });
  });

  it("surfaces a codex agent validator from a per-context 'use' override", () => {
    const ctx = makeBuilderContext({
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin" as const, id: "general-reviewer" },
            strategy: "task" as const,
            agent: {
              backend: "codex",
              model: "gpt-5.5",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
        ],
      },
    });
    expect(getDisplayValidators(ctx)).toEqual({
      script: false,
      agent: "codex",
    });
  });

  it("hides the agent validator when a 'use' override is present but disabled", () => {
    const ctx = makeBuilderContext({
      contextValidator: {
        enabled: false,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin" as const, id: "general-reviewer" },
            strategy: "conversation" as const,
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
        ],
      },
    });
    expect(getDisplayValidators(ctx)).toEqual({
      script: false,
      agent: null,
    });
  });

  it("returns no agent validator for an explicitly 'disabled' override", () => {
    const ctx = makeBuilderContext({
      contextValidator: { enabled: false, assignments: [] },
    });
    expect(getDisplayValidators(ctx)).toEqual({
      script: false,
      agent: null,
    });
  });
});

describe("getDisplayApprovalGate", () => {
  function makeResolved(
    overrides: Partial<GraphWorkflowResolvedContext> = {},
  ): GraphWorkflowResolvedContext {
    return {
      id: "ctx-1",
      title: "Ctx",
      acceptanceCriteria: "AC",
      implementer: {
        id: "implementer",
        profile: { tier: "builtin" as const, id: "general-implementer" },
        profileSnapshot: makeProfileSnapshot(),
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      contextValidator: { enabled: false, assignments: [] },
      scriptValidator: { enabled: false },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: { consecutiveFailureThreshold: 3 },
      iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
      planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      ...overrides,
    };
  }

  it("returns false when the human approval gate is disabled", () => {
    expect(getDisplayApprovalGate(makeResolved())).toBe(false);
  });

  it("returns true when the human approval gate is enabled", () => {
    const ctx = makeResolved({ humanApprovalGate: { enabled: true } });
    expect(getDisplayApprovalGate(ctx)).toBe(true);
  });

  it("returns false for a builder context with no gate override", () => {
    const ctx: GraphWorkflowExecutionContextDefinition = {
      id: "ctx-1",
      title: "Ctx",
      acceptanceCriteria: "AC",
      implementer: {
        id: "implementer",
        profile: { tier: "builtin" as const, id: "general-implementer" },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
    };
    expect(getDisplayApprovalGate(ctx)).toBe(false);
  });
});

describe("deriveNodes — output schema indicator (R7.7)", () => {
  const schema = {
    type: "object",
    properties: { verdict: { type: "string" } },
  };

  /**
   * A real resolved definition: the execution branch reads the SAME document
   * through `getContextOutput`, so the node's `captured` verdict is only
   * trustworthy when the fixture is the shape an execution actually carries.
   */
  function definitionWithSchema(): ResolvedWorkflowSemanticDefinition {
    const base = createResolvedWorkflowDefinition();
    const [declaring, freeForm] = base.executionContexts;
    if (!declaring || !freeForm) {
      throw new Error("the resolved fixture needs at least two contexts");
    }
    return {
      ...base,
      executionContexts: [{ ...declaring, outputSchema: schema }, freeForm],
    };
  }

  function nodesFor(
    definition: ResolvedWorkflowSemanticDefinition,
    execution?: GraphWorkflowExecution,
  ) {
    return deriveNodes(definition, makeLayout(), execution);
  }

  it("omits the indicator for a context that declares no schema", () => {
    const definition = definitionWithSchema();
    const nodes = nodesFor(definition);
    expect(nodes[1]!.data.outputSchema).toBeUndefined();
  });

  it("marks a declared schema uncaptured in builder mode", () => {
    const nodes = nodesFor(definitionWithSchema());
    expect(nodes[0]!.data.outputSchema).toEqual({ captured: false });
  });

  it("marks a declared schema uncaptured while the execution has banked nothing", () => {
    const definition = definitionWithSchema();
    const nodes = nodesFor(
      definition,
      createWorkflowExecution({ workingDefinition: definition }),
    );
    expect(nodes[0]!.data.outputSchema).toEqual({ captured: false });
  });

  it("marks the indicator captured once the output is banked", () => {
    const definition = definitionWithSchema();
    const contextId = definition.executionContexts[0]!.id;
    const nodes = nodesFor(
      definition,
      createWorkflowExecution({
        workingDefinition: definition,
        contextOutputs: {
          [contextId]: {
            value: { verdict: "pass" },
            capturedAt: "2026-03-27T10:00:00.000Z",
            iteration: 1,
            parse: { source: "native" },
          },
        },
      }),
    );
    expect(nodes[0]!.data.outputSchema).toEqual({ captured: true });
  });

  // The read side keys off the CURRENT declaration, so a payload left behind by
  // a cleared contract must not light the glyph (R7.7).
  it("omits the indicator when the schema is gone but a payload lingers", () => {
    const definition = definitionWithSchema();
    const contextId = definition.executionContexts[0]!.id;
    const cleared: ResolvedWorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map(
        ({ outputSchema: _dropped, ...context }) => context,
      ),
    };
    const nodes = nodesFor(
      cleared,
      createWorkflowExecution({
        workingDefinition: cleared,
        contextOutputs: {
          [contextId]: {
            value: { verdict: "pass" },
            capturedAt: "2026-03-27T10:00:00.000Z",
            iteration: 1,
            parse: { source: "native" },
          },
        },
      }),
    );
    expect(nodes[0]!.data.outputSchema).toBeUndefined();
  });
});

describe("deriveEdges", () => {
  it("returns empty array for empty definition", () => {
    const result = deriveEdges(makeDefinition());
    expect(result).toEqual([]);
  });

  it("derives edges with correct source/target", () => {
    const def = makeDefinition({
      edges: [
        { id: "e1", sourceContextId: "ctx-1", targetContextId: "ctx-2" },
        { id: "e2", sourceContextId: "ctx-2", targetContextId: "ctx-3" },
      ],
    });

    const edges = deriveEdges(def);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({
      id: "e1",
      source: "ctx-1",
      target: "ctx-2",
      type: "contextEdge",
    });
    expect(edges[1]).toMatchObject({
      id: "e2",
      source: "ctx-2",
      target: "ctx-3",
      type: "contextEdge",
    });
  });

  it("populates edge status data in execution mode", () => {
    const def = makeDefinition({
      edges: [{ id: "e1", sourceContextId: "ctx-1", targetContextId: "ctx-2" }],
    });

    const execution = makeExecution({
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "ctx-1",
          status: "completed" as GraphWorkflowContextStatus,
          totalTaskCount: 1,
          completedTaskCount: 1,
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
        "ctx-2": {
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "ctx-2",
          status: "running" as GraphWorkflowContextStatus,
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
      },
    });

    const edges = deriveEdges(def, execution);
    expect(edges[0]!.data!.sourceStatus).toBe("completed");
    expect(edges[0]!.data!.targetStatus).toBe("running");
  });

  it("leaves edge data undefined when no execution provided", () => {
    const def = makeDefinition({
      edges: [{ id: "e1", sourceContextId: "ctx-1", targetContextId: "ctx-2" }],
    });

    const edges = deriveEdges(def);
    expect(edges[0]!.data!.sourceStatus).toBeUndefined();
    expect(edges[0]!.data!.targetStatus).toBeUndefined();
  });
});
