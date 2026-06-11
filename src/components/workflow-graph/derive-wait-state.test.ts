import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
import { deriveContextWaitState } from "./derive-wait-state";

function makeDefinition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    executionContexts: [],
    tasks: [],
    edges: [],
    ...overrides,
  };
}

function makeContextState(
  overrides: Partial<GraphWorkflowExecutionContextState> = {},
): GraphWorkflowExecutionContextState {
  return {
    contextId: "ctx-1",
    status: "pending",
    totalTaskCount: 3,
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
    ...overrides,
  };
}

function makeLane(
  overrides: Partial<GraphWorkflowExecutionLaneState> = {},
): GraphWorkflowExecutionLaneState {
  return {
    laneId: "lane-1",
    kind: "worktree",
    status: "pending",
    worktreePath: null,
    branchName: "feature/lane-1",
    includedContextIds: [],
    lastCommittingContextId: null,
    commitSnapshots: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeJoin(
  overrides: Partial<GraphWorkflowExecutionJoinState> = {},
): GraphWorkflowExecutionJoinState {
  return {
    joinId: "join-1",
    kind: "context_merge",
    contextId: null,
    targetLaneId: "lane-target",
    sourceLaneIds: ["lane-source"],
    mergedSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
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
    contextStates: {},
    taskStates: {},
    sharedDocuments: [],
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
    machineSnapshot: null,
    history: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    pendingCollaborations: {},
    collaborationContinuations: {},
    pendingMergeRetry: [],
    ...overrides,
  };
}

describe("deriveContextWaitState", () => {
  it("returns undefined when no context state exists for the id", () => {
    const result = deriveContextWaitState({
      contextId: "missing",
      definition: makeDefinition(),
      execution: makeExecution(),
    });
    expect(result).toBeUndefined();
  });

  it("flags a downstream pending context with an incomplete upstream as dependency-blocked", () => {
    const definition = makeDefinition({
      edges: [{ id: "e1", sourceContextId: "ctx-a", targetContextId: "ctx-b" }],
    });
    const execution = makeExecution({
      contextStates: {
        "ctx-a": makeContextState({ contextId: "ctx-a", status: "running" }),
        "ctx-b": makeContextState({ contextId: "ctx-b", status: "pending" }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-b",
      definition,
      execution,
    });

    expect(result).toEqual({
      kind: "dependency-blocked",
      unmetDependencyIds: ["ctx-a"],
      blockedByApproval: false,
    });
  });

  it("flags a dependent as blocked-by-approval when an unmet upstream is parked at a gate", () => {
    const definition = makeDefinition({
      edges: [{ id: "e1", sourceContextId: "ctx-a", targetContextId: "ctx-b" }],
    });
    const execution = makeExecution({
      contextStates: {
        "ctx-a": makeContextState({
          contextId: "ctx-a",
          status: "awaiting_approval",
        }),
        "ctx-b": makeContextState({ contextId: "ctx-b", status: "pending" }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-b",
      definition,
      execution,
    });

    expect(result).toEqual({
      kind: "dependency-blocked",
      unmetDependencyIds: ["ctx-a"],
      blockedByApproval: true,
    });
  });

  it("treats a pending context with no edges as ready (no upstream to wait on)", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({ status: "pending" }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "ready" });
  });

  it("reports ready when all upstream dependencies are completed (no more Waiting on upstream)", () => {
    const definition = makeDefinition({
      edges: [{ id: "e1", sourceContextId: "ctx-a", targetContextId: "ctx-b" }],
    });
    const execution = makeExecution({
      contextStates: {
        "ctx-a": makeContextState({
          contextId: "ctx-a",
          status: "completed",
          completedTaskCount: 3,
        }),
        "ctx-b": makeContextState({ contextId: "ctx-b", status: "pending" }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-b",
      definition,
      execution,
    });

    expect(result).toEqual({ kind: "ready" });
  });

  it("lists every unmet upstream id when multiple dependencies are pending", () => {
    const definition = makeDefinition({
      edges: [
        { id: "e1", sourceContextId: "ctx-a", targetContextId: "ctx-c" },
        { id: "e2", sourceContextId: "ctx-b", targetContextId: "ctx-c" },
      ],
    });
    const execution = makeExecution({
      contextStates: {
        "ctx-a": makeContextState({
          contextId: "ctx-a",
          status: "completed",
        }),
        "ctx-b": makeContextState({ contextId: "ctx-b", status: "running" }),
        "ctx-c": makeContextState({ contextId: "ctx-c", status: "pending" }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-c",
      definition,
      execution,
    });

    expect(result).toEqual({
      kind: "dependency-blocked",
      unmetDependencyIds: ["ctx-b"],
      blockedByApproval: false,
    });
  });

  it("reports waiting-for-lane when deps are satisfied but the assigned lane is still pending", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({ status: "ready", laneId: "lane-1" }),
      },
      executionLanes: {
        "lane-1": makeLane({ laneId: "lane-1", status: "pending" }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "waiting-for-lane", laneId: "lane-1" });
  });

  it("does not report waiting-for-lane when the lane has already become active", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({ status: "ready", laneId: "lane-1" }),
      },
      executionLanes: {
        "lane-1": makeLane({ laneId: "lane-1", status: "active" }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "ready" });
  });

  it("reports waiting-for-join when the assigned join is still pending", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({ status: "ready", joinId: "join-1" }),
      },
      joins: {
        "join-1": makeJoin({ joinId: "join-1", status: "pending" }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "waiting-for-join", joinId: "join-1" });
  });

  it("falls back to ready when lane/join records are absent (legacy executions)", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "ready",
          laneId: "lane-ghost",
          joinId: "join-ghost",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "ready" });
  });

  it("reports awaiting-approval for a context parked at the human review gate", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "awaiting_approval",
          totalTaskCount: 1,
          completedTaskCount: 1,
          pendingApproval: {
            conversationId: "conv-1",
            requestedAt: "2026-06-10T09:00:00.000Z",
            decision: null,
          },
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "awaiting-approval" });
  });

  it("reports running when tasks are still in progress", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "running",
          totalTaskCount: 3,
          completedTaskCount: 1,
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "running" });
  });

  it("reports validating when running but every task is complete", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "running",
          totalTaskCount: 3,
          completedTaskCount: 3,
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "validating" });
  });

  it("reports merging when merge is in progress, exposing the target branch", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "running",
          totalTaskCount: 3,
          completedTaskCount: 3,
          mergeStatus: "in-progress",
          branchName: "feature/foo",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "merging", targetBranch: "feature/foo" });
  });

  it("reports completed for a session-isolation context that has finished", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "session",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "completed" });
  });

  it("reports published for a worktree-isolation context whose merge succeeded", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "merged-success",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "published" });
  });

  it("reports halted regardless of upstream state", () => {
    const definition = makeDefinition({
      edges: [{ id: "e1", sourceContextId: "ctx-a", targetContextId: "ctx-b" }],
    });
    const execution = makeExecution({
      contextStates: {
        "ctx-a": makeContextState({ contextId: "ctx-a", status: "running" }),
        "ctx-b": makeContextState({ contextId: "ctx-b", status: "halted" }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-b",
      definition,
      execution,
    });

    expect(result).toEqual({ kind: "halted" });
  });
});
