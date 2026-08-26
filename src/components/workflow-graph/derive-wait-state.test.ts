import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { deriveContextWaitState } from "./derive-wait-state";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

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
    consecutiveCandidateMismatchCount: 0,
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
    skipReason: null,
    landingIntent: null,
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
    validationDebtSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
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
    origin: {
      kind: "template",
      definitionId: "def-1",
      definitionRevision: 1,
      tier: "project",
    },
    launchDocument: null,
    liveSessionReadOnlyPinned: false,
    abandonment: null,
    liveRevision: 1,
    executionStateRevision: 0,
    structuralRevision: 0,
    charterAmendments: [],
    planRepairRounds: [],
    loopControlAmendments: [],
    contextOutputs: {},
    routeControlRevisions: {},
    routeSettlements: {},
    expansionReceipts: { accepted: [], refusals: [] },
    loopStates: {},
    loopEpoch: 0,
    boundInputs: {},
    launchedTier: "project",
    ownerConversationId: null,
    definitionApproval: null,
    definitionApprovalClaim: null,
    workingDefinition:
      makeDefinition() as unknown as ResolvedWorkflowSemanticDefinition,
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: [],
    contextStates: {},
    taskStates: {},
    sharedDocuments: [],
    advisoryIndex: [],
    laneStates: {},
    executionLanes: {},
    laneReservations: {},
    joins: {},
    machineSnapshot: null,
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
            approvalScope: { kind: "whole_tree" },
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

  it("reports awaiting-user-input for a context parked on a workflow question", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "awaiting_user_input",
          totalTaskCount: 2,
          completedTaskCount: 1,
          pendingUserInputs: {
            implementer: {
              conversationId: "conv-1",
              lane: "implementer",
              questionBatchId: "qb-1",
              questions: [],
              requestedAt: "2026-07-03T09:00:00.000Z",
              roundSeq: null,
              answers: null,
            },
          },
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "awaiting-user-input" });
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

  /**
   * The legacy per-context worktree shape, which predates lanes entirely: no
   * laneId, and a squash-merge that landed the work directly in the session
   * worktree at completion time. `isContextOutputCommittedToLane` already
   * defines this state as landed, so a historical execution's nodes have to
   * read Published rather than being stranded on Completed for want of a lane
   * record that never existed.
   */
  it("reports published for a legacy worktree merge that carries no laneId", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "merged-success",
          laneId: null,
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

  /**
   * The legacy shape's own negative: no laneId AND no successful merge is not a
   * publication, so the null lane must not become a blanket "published".
   */
  it("reports completed for a laneless context whose merge did not succeed", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "not-applicable",
          laneId: null,
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

  it("reports published once the final publish join landed the context's lane", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "merged-success",
          laneId: "lane-delivery",
        }),
      },
      executionLanes: {
        "lane-delivery": makeLane({
          laneId: "lane-delivery",
          status: "merged",
          includedContextIds: ["ctx-1"],
        }),
        __session__: makeLane({ laneId: "__session__", kind: "session" }),
      },
      joins: {
        "join-publish": makeJoin({
          joinId: "join-publish",
          kind: "final_publish",
          sourceLaneIds: ["lane-delivery"],
          targetLaneId: "__session__",
          status: "succeeded",
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

  /**
   * The lane a context RAN on is rarely the lane the publish names. Final-publish
   * planning drops any lane a succeeded context_merge already consumed, so a
   * fan-in topology (plan → delivery → session) lists only `lane-delivery` as a
   * source. Publication has to be read as reachability through succeeded joins,
   * or every context upstream of a join stalls on "completed" forever.
   */
  it("reports published for a lane that reached the session through a chained join", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "merged-success",
          laneId: "lane-plan",
        }),
      },
      executionLanes: {
        "lane-plan": makeLane({
          laneId: "lane-plan",
          status: "merged",
          includedContextIds: ["ctx-1"],
        }),
        "lane-delivery": makeLane({
          laneId: "lane-delivery",
          status: "merged",
        }),
        __session__: makeLane({ laneId: "__session__", kind: "session" }),
      },
      joins: {
        "join-merge": makeJoin({
          joinId: "join-merge",
          kind: "context_merge",
          sourceLaneIds: ["lane-plan"],
          targetLaneId: "lane-delivery",
          status: "succeeded",
        }),
        "join-publish": makeJoin({
          joinId: "join-publish",
          kind: "final_publish",
          sourceLaneIds: ["lane-delivery"],
          targetLaneId: "__session__",
          status: "succeeded",
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

  /**
   * The other half of reachability: an UNFINISHED link in the chain must not
   * publish the whole upstream. The publish landed `lane-delivery`, but the
   * merge that would have carried `lane-plan` into it never succeeded.
   */
  it("reports awaiting-merge when the chain to the session is broken by an unfinished join", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "merged-success",
          laneId: "lane-plan",
        }),
      },
      executionLanes: {
        "lane-plan": makeLane({
          laneId: "lane-plan",
          status: "active",
          includedContextIds: ["ctx-1"],
        }),
        "lane-delivery": makeLane({ laneId: "lane-delivery" }),
        __session__: makeLane({ laneId: "__session__", kind: "session" }),
      },
      joins: {
        "join-merge": makeJoin({
          joinId: "join-merge",
          kind: "context_merge",
          sourceLaneIds: ["lane-plan"],
          targetLaneId: "lane-delivery",
          status: "pending",
        }),
        "join-publish": makeJoin({
          joinId: "join-publish",
          kind: "final_publish",
          sourceLaneIds: ["lane-delivery"],
          targetLaneId: "__session__",
          status: "succeeded",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({
      kind: "awaiting-merge",
      targetLaneName: "lane-delivery",
    });
  });

  /**
   * The defect this pins: a lane-local merge only proves the context landed
   * among its band mates. Saying "published" here would tell an operator the
   * work reached the session worktree while the run still owes a final publish
   * — and saying "completed" hides that a merge is still owed at all.
   */
  it("reports awaiting-merge, not published, while a final publish is still owed", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "merged-success",
          laneId: "lane-delivery",
        }),
      },
      executionLanes: {
        "lane-delivery": makeLane({
          laneId: "lane-delivery",
          status: "active",
          includedContextIds: ["ctx-1"],
        }),
        __session__: makeLane({ laneId: "__session__", kind: "session" }),
      },
      joins: {
        "join-publish": makeJoin({
          joinId: "join-publish",
          kind: "final_publish",
          sourceLaneIds: ["lane-delivery"],
          targetLaneId: "__session__",
          status: "pending",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({
      kind: "awaiting-merge",
      targetLaneName: "session",
    });
  });

  /**
   * A lane no join will ever consume: the work is committed and will sit in the
   * lane worktree indefinitely. There is no target to name, but the node must
   * still not claim the work reached the session.
   */
  it("reports awaiting-merge with no target for a lane no join covers", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "merged-success",
          laneId: "lane-delivery",
        }),
      },
      executionLanes: {
        "lane-delivery": makeLane({
          laneId: "lane-delivery",
          status: "active",
          includedContextIds: ["ctx-1"],
        }),
        __session__: makeLane({ laneId: "__session__", kind: "session" }),
      },
      joins: {
        "join-other": makeJoin({
          joinId: "join-other",
          kind: "final_publish",
          sourceLaneIds: ["lane-docs"],
          targetLaneId: "__session__",
          status: "succeeded",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({ kind: "awaiting-merge", targetLaneName: null });
  });

  /**
   * A read-only member writes nothing, so completion IS its settled state —
   * there is no merge for it to be waiting on. Without this, every reviewer and
   * judge in a run would sit on "waiting to merge" forever.
   */
  it("reports completed for a read-only member, which has nothing to merge", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "not-applicable",
          laneId: "lane-delivery",
        }),
      },
      executionLanes: {
        "lane-delivery": makeLane({
          laneId: "lane-delivery",
          status: "active",
          includedContextIds: ["ctx-1"],
        }),
      },
      joins: {
        "join-publish": makeJoin({
          joinId: "join-publish",
          kind: "final_publish",
          sourceLaneIds: ["lane-delivery"],
          targetLaneId: "__session__",
          status: "pending",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition({
        executionContexts: [
          {
            id: "ctx-1",
            title: "Review",
            acceptanceCriteria: "the work is reviewed",
            placement: { lane: "lane-delivery", mode: "readOnly" },
          },
        ],
      }) as WorkflowSemanticDefinition,
      execution,
    });

    expect(result).toEqual({ kind: "completed" });
  });

  /**
   * The window the canvas was blind to: the join runner is merging this
   * context's lane right now. A lane already in `mergedSourceLaneIds` is NOT
   * the one in flight — a multi-source join merges them one at a time.
   */
  it("reports merging while a running join is landing the context's lane", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "merged-success",
          laneId: "lane-delivery",
          branchName: "csm/session-1-delivery",
        }),
      },
      executionLanes: {
        "lane-delivery": makeLane({
          laneId: "lane-delivery",
          status: "active",
          includedContextIds: ["ctx-1"],
        }),
        __session__: makeLane({
          laneId: "__session__",
          kind: "session",
          branchName: "csm/session-1",
        }),
      },
      joins: {
        "join-publish": makeJoin({
          joinId: "join-publish",
          kind: "final_publish",
          sourceLaneIds: ["lane-delivery"],
          targetLaneId: "__session__",
          status: "running",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({
      kind: "merging",
      targetBranch: "csm/session-1",
    });
  });

  it("does not report merging for a lane the running join has already merged", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          isolation: "worktree",
          mergeStatus: "merged-success",
          laneId: "lane-delivery",
        }),
      },
      executionLanes: {
        "lane-delivery": makeLane({
          laneId: "lane-delivery",
          status: "merged",
          includedContextIds: ["ctx-1"],
        }),
        __session__: makeLane({ laneId: "__session__", kind: "session" }),
      },
      joins: {
        "join-publish": makeJoin({
          joinId: "join-publish",
          kind: "final_publish",
          sourceLaneIds: ["lane-delivery", "lane-docs"],
          mergedSourceLaneIds: ["lane-delivery"],
          targetLaneId: "__session__",
          status: "running",
        }),
      },
    });

    const result = deriveContextWaitState({
      contextId: "ctx-1",
      definition: makeDefinition(),
      execution,
    });

    expect(result).toEqual({
      kind: "awaiting-merge",
      targetLaneName: "session",
    });
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

    expect(result).toEqual({ kind: "halted", repairInFlight: false });
  });

  it("marks a halted context whose plan-repair round is still open", () => {
    const definition = makeDefinition({
      edges: [{ id: "e1", sourceContextId: "ctx-a", targetContextId: "ctx-b" }],
    });
    const execution = makeExecution({
      contextStates: {
        "ctx-a": makeContextState({ contextId: "ctx-a", status: "running" }),
        "ctx-b": makeContextState({ contextId: "ctx-b", status: "halted" }),
      },
      planRepairRounds: [
        {
          seq: 1,
          contextId: "ctx-b",
          haltType: "circuit_breaker",
          loopGroupId: null,
          // Within the open-round trust window on the real clock: a fixed
          // past timestamp reads as a round whose agent is long gone.
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          settledAt: null,
          outcome: null,
          planningDefect: null,
          diagnosis: null,
          operationCount: 0,
          resumed: false,
          conversationId: null,
        },
      ],
    });

    const result = deriveContextWaitState({
      contextId: "ctx-b",
      definition,
      execution,
    });

    expect(result).toEqual({ kind: "halted", repairInFlight: true });
  });
});

describe("deriveContextWaitState — advisory response phase (R6.3)", () => {
  it("reports advisory-response while a certified context still owes the turn", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "running",
          totalTaskCount: 3,
          completedTaskCount: 3,
          advisoryResponse: {
            roundSeq: 2,
            phase: "awaiting_response",
            enteredAt: "2026-03-27T10:10:00.000Z",
          },
        }),
      },
    });

    // Without the phase this same state reads as `validating`, which is the
    // exact confusion R6.3 forbids: the cohort has already passed and released
    // the candidate, and it is the implementer that is about to run.
    expect(
      deriveContextWaitState({
        contextId: "ctx-1",
        definition: makeDefinition(),
        execution,
      }),
    ).toEqual({ kind: "advisory-response" });
  });

  it("reports validating again once the response turn moved the candidate", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "running",
          totalTaskCount: 3,
          completedTaskCount: 3,
          advisoryResponse: {
            roundSeq: 2,
            phase: "recertifying",
            enteredAt: "2026-03-27T10:10:00.000Z",
          },
        }),
      },
    });

    expect(
      deriveContextWaitState({
        contextId: "ctx-1",
        definition: makeDefinition(),
        execution,
      }),
    ).toEqual({ kind: "validating" });
  });

  it("reports completed once the context finished, phase record or not", () => {
    const execution = makeExecution({
      contextStates: {
        "ctx-1": makeContextState({
          status: "completed",
          totalTaskCount: 3,
          completedTaskCount: 3,
          advisoryResponse: {
            roundSeq: 2,
            phase: "awaiting_response",
            enteredAt: "2026-03-27T10:10:00.000Z",
          },
        }),
      },
    });

    expect(
      deriveContextWaitState({
        contextId: "ctx-1",
        definition: makeDefinition(),
        execution,
      }),
    ).toEqual({ kind: "completed" });
  });
});
