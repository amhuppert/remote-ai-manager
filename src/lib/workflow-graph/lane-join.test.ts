import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
  GraphWorkflowTaskState,
} from "@/lib/workflows/schemas";
import {
  appendPendingJoin,
  applyJoinProgress,
  findActiveJoin,
  materializeSessionLane,
  pickJoinTarget,
  planContextJoin,
  planFinalPublishJoin,
  remainingSourceLanes,
  resetJoinForRetry,
  resolveLaneConversationId,
} from "./lane-join";
import { createWorkflowExecution } from "./test-fixtures";

const t0 = "2026-03-27T12:00:00.000Z";
const t1 = "2026-03-27T12:05:00.000Z";

function makeLane(
  overrides: Partial<GraphWorkflowExecutionLaneState> &
    Pick<GraphWorkflowExecutionLaneState, "laneId" | "branchName">,
): GraphWorkflowExecutionLaneState {
  return {
    kind: "worktree",
    status: "active",
    worktreePath: `/tmp/${overrides.laneId}`,
    includedContextIds: [],
    lastCommittingContextId: null,
    commitSnapshots: [],
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

function makeJoin(
  overrides: Partial<GraphWorkflowExecutionJoinState> &
    Pick<
      GraphWorkflowExecutionJoinState,
      "joinId" | "targetLaneId" | "sourceLaneIds"
    >,
): GraphWorkflowExecutionJoinState {
  return {
    kind: "context_merge",
    contextId: null,
    mergedSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: t0,
    updatedAt: t0,
    completedAt: null,
    ...overrides,
  };
}

describe("pickJoinTarget", () => {
  it("picks the most-recently-updated existing source lane", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          updatedAt: t0,
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/test-b",
          updatedAt: t1,
        }),
      },
    };

    expect(pickJoinTarget(["lane-a", "lane-b"], execution)).toBe("lane-b");
  });

  it("breaks ties on equal updatedAt by lane id (asc)", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-z": makeLane({
          laneId: "lane-z",
          branchName: "csm/test-z",
          updatedAt: t0,
        }),
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          updatedAt: t0,
        }),
      },
    };

    expect(pickJoinTarget(["lane-z", "lane-a"], execution)).toBe("lane-a");
  });
});

describe("planContextJoin", () => {
  it("returns null when all upstream contexts share the same lane", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        shared: makeLane({
          laneId: "shared",
          branchName: "csm/shared",
          includedContextIds: ["context-plan"],
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "shared",
          mergeStatus: "merged-success",
        },
      },
    };

    expect(
      planContextJoin({
        contextId: "context-implement",
        execution,
        now: () => t1,
        generateJoinId: () => "join-x",
      }),
    ).toBeNull();
  });

  it("plans a context_merge for a non-terminal fan-in context (downstream of the verify) from two distinct source lanes", () => {
    const base = createWorkflowExecution();
    const def = base.workingDefinition;
    const definitionWithFanIn = {
      ...def,
      edges: [
        ...def.edges,
        {
          id: "edge-extra",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
        {
          id: "edge-verify-followup",
          sourceContextId: "context-verify",
          targetContextId: "context-followup",
        },
      ],
    };
    const execution: GraphWorkflowExecution = {
      ...base,
      workingDefinition: definitionWithFanIn,
      executionLanes: {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          includedContextIds: ["context-plan"],
          updatedAt: t1,
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/test-b",
          includedContextIds: ["context-implement"],
          updatedAt: t0,
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-b",
          mergeStatus: "merged-success",
        },
      },
    };

    const plan = planContextJoin({
      contextId: "context-verify",
      execution,
      now: () => t1,
      generateJoinId: () => "join-1",
    });
    expect(plan).not.toBeNull();
    expect(plan!.kind).toBe("context_merge");
    expect(plan!.contextId).toBe("context-verify");
    expect(plan!.targetLaneId).toBe("lane-a");
    expect(plan!.sourceLaneIds.sort()).toEqual(["lane-a", "lane-b"]);
    expect(plan!.status).toBe("pending");
    expect(plan!.joinId).toBe("join-1");
  });

  it("returns null for a terminal context with two source lanes so final publish handles convergence on the session lane", () => {
    const base = createWorkflowExecution();
    const def = base.workingDefinition;
    const definitionWithFanIn = {
      ...def,
      edges: [
        ...def.edges,
        {
          id: "edge-extra-terminal",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    };
    const execution: GraphWorkflowExecution = {
      ...base,
      workingDefinition: definitionWithFanIn,
      executionLanes: {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          includedContextIds: ["context-plan"],
          updatedAt: t1,
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/test-b",
          includedContextIds: ["context-implement"],
          updatedAt: t0,
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-b",
          mergeStatus: "merged-success",
        },
      },
    };

    const plan = planContextJoin({
      contextId: "context-verify",
      execution,
      now: () => t1,
      generateJoinId: () => "join-terminal",
    });
    expect(plan).toBeNull();
  });

  it("returns null when a prior succeeded join makes lanes reach a common target", () => {
    const base = createWorkflowExecution();
    const def = base.workingDefinition;
    const definitionWithFanIn = {
      ...def,
      edges: [
        ...def.edges,
        {
          id: "edge-extra",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    };
    const execution: GraphWorkflowExecution = {
      ...base,
      workingDefinition: definitionWithFanIn,
      executionLanes: {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          includedContextIds: ["context-plan"],
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/test-b",
          includedContextIds: ["context-implement"],
        }),
      },
      joins: {
        "join-prior": {
          joinId: "join-prior",
          kind: "context_merge",
          contextId: null,
          targetLaneId: "lane-a",
          sourceLaneIds: ["lane-b"],
          mergedSourceLaneIds: ["lane-b"],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: t0,
          updatedAt: t1,
          completedAt: t1,
        },
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-b",
          mergeStatus: "merged-success",
        },
      },
    };

    expect(
      planContextJoin({
        contextId: "context-verify",
        execution,
        now: () => t1,
        generateJoinId: () => "join-new",
      }),
    ).toBeNull();
  });
});

describe("planFinalPublishJoin", () => {
  it("returns null when no terminal worktree lanes need publishing", () => {
    const base = createWorkflowExecution();
    const sessionLaneId = "session-lane";
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [sessionLaneId]: makeLane({
          laneId: sessionLaneId,
          branchName: "csm/session",
          kind: "session",
          worktreePath: "/tmp/session",
          includedContextIds: ["context-plan", "context-implement"],
        }),
      },
    };

    expect(
      planFinalPublishJoin({
        execution,
        sessionLaneId,
        now: () => t1,
        generateJoinId: () => "join-final",
      }),
    ).toBeNull();
  });

  it("plans a final publish for one non-session terminal lane", () => {
    const base = createWorkflowExecution();
    const sessionLaneId = "session-lane";
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [sessionLaneId]: makeLane({
          laneId: sessionLaneId,
          branchName: "csm/session",
          kind: "session",
          worktreePath: "/tmp/session",
        }),
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          includedContextIds: ["context-verify"],
        }),
      },
    };

    const plan = planFinalPublishJoin({
      execution,
      sessionLaneId,
      now: () => t1,
      generateJoinId: () => "join-final",
    });
    expect(plan).not.toBeNull();
    expect(plan!.kind).toBe("final_publish");
    expect(plan!.targetLaneId).toBe(sessionLaneId);
    expect(plan!.sourceLaneIds).toEqual(["lane-a"]);
  });

  it("excludes a lane whose currently-assigned context has not completed (never publishes partial work)", () => {
    // Defense-in-depth for the premature-completion bug: an interrupted parallel
    // wave reset to `ready` still occupies its forked worktree lane. That lane
    // holds partial, unvalidated work and must never be folded into the session
    // via the final publish.
    const base = createWorkflowExecution();
    const sessionLaneId = "session-lane";
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [sessionLaneId]: makeLane({
          laneId: sessionLaneId,
          branchName: "csm/session",
          kind: "session",
          worktreePath: "/tmp/session",
        }),
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          includedContextIds: ["context-plan"],
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "ready",
          isolation: "worktree",
          laneId: "lane-a",
        },
      },
    };

    expect(
      planFinalPublishJoin({
        execution,
        sessionLaneId,
        now: () => t1,
        generateJoinId: () => "join-final",
      }),
    ).toBeNull();
  });

  it("still publishes a lane once its occupant context completes", () => {
    // Guards against the exclusion being too broad: a lane whose occupant has
    // finished is safe to publish.
    const base = createWorkflowExecution();
    const sessionLaneId = "session-lane";
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [sessionLaneId]: makeLane({
          laneId: sessionLaneId,
          branchName: "csm/session",
          kind: "session",
          worktreePath: "/tmp/session",
        }),
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          includedContextIds: ["context-plan", "context-implement"],
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          mergeStatus: "merged-success",
        },
      },
    };

    const plan = planFinalPublishJoin({
      execution,
      sessionLaneId,
      now: () => t1,
      generateJoinId: () => "join-final",
    });
    expect(plan).not.toBeNull();
    expect(plan!.sourceLaneIds).toEqual(["lane-a"]);
  });

  it("plans a final publish for multiple non-session terminal lanes", () => {
    const base = createWorkflowExecution();
    const sessionLaneId = "session-lane";
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [sessionLaneId]: makeLane({
          laneId: sessionLaneId,
          branchName: "csm/session",
          kind: "session",
          worktreePath: "/tmp/session",
        }),
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          includedContextIds: ["context-plan"],
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/test-b",
          includedContextIds: ["context-implement"],
        }),
      },
    };

    const plan = planFinalPublishJoin({
      execution,
      sessionLaneId,
      now: () => t1,
      generateJoinId: () => "join-final",
    });
    expect(plan).not.toBeNull();
    expect(plan!.kind).toBe("final_publish");
    expect(plan!.targetLaneId).toBe(sessionLaneId);
    expect(plan!.sourceLaneIds.sort()).toEqual(["lane-a", "lane-b"]);
  });

  it("excludes lanes already reaching the session via a succeeded prior join", () => {
    const base = createWorkflowExecution();
    const sessionLaneId = "session-lane";
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [sessionLaneId]: makeLane({
          laneId: sessionLaneId,
          branchName: "csm/session",
          kind: "session",
          worktreePath: "/tmp/session",
        }),
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          includedContextIds: ["context-plan"],
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/test-b",
          includedContextIds: ["context-implement"],
        }),
      },
      joins: {
        "join-prior": {
          joinId: "join-prior",
          kind: "context_merge",
          contextId: null,
          targetLaneId: sessionLaneId,
          sourceLaneIds: ["lane-a"],
          mergedSourceLaneIds: ["lane-a"],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: t0,
          updatedAt: t1,
          completedAt: t1,
        },
      },
    };

    const plan = planFinalPublishJoin({
      execution,
      sessionLaneId,
      now: () => t1,
      generateJoinId: () => "join-final",
    });
    expect(plan).not.toBeNull();
    expect(plan!.sourceLaneIds).toEqual(["lane-b"]);
  });

  it("publishes only the terminal target lane after a context_merge consumes a source", () => {
    const base = createWorkflowExecution();
    const sessionLaneId = "session-lane";
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [sessionLaneId]: makeLane({
          laneId: sessionLaneId,
          branchName: "csm/session",
          kind: "session",
          worktreePath: "/tmp/session",
        }),
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/lane-a",
          includedContextIds: ["context-plan"],
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/lane-b",
          includedContextIds: ["context-impl"],
        }),
      },
      joins: {
        "join-b-into-a": {
          joinId: "join-b-into-a",
          kind: "context_merge",
          contextId: "downstream-merge",
          targetLaneId: "lane-a",
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: ["lane-b"],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: t0,
          updatedAt: t1,
          completedAt: t1,
        },
      },
    };

    const plan = planFinalPublishJoin({
      execution,
      sessionLaneId,
      now: () => t1,
      generateJoinId: () => "join-final",
    });

    expect(plan).not.toBeNull();
    expect(plan!.targetLaneId).toBe(sessionLaneId);
    expect(plan!.sourceLaneIds).toEqual(["lane-a"]);
  });

  it("excludes a chain of consumed lanes when joins have cascaded into a single terminal", () => {
    const base = createWorkflowExecution();
    const sessionLaneId = "session-lane";
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [sessionLaneId]: makeLane({
          laneId: sessionLaneId,
          branchName: "csm/session",
          kind: "session",
          worktreePath: "/tmp/session",
        }),
        "lane-a": makeLane({ laneId: "lane-a", branchName: "csm/lane-a" }),
        "lane-b": makeLane({ laneId: "lane-b", branchName: "csm/lane-b" }),
        "lane-c": makeLane({ laneId: "lane-c", branchName: "csm/lane-c" }),
      },
      joins: {
        "join-b-into-a": {
          joinId: "join-b-into-a",
          kind: "context_merge",
          contextId: "context-merge-ab",
          targetLaneId: "lane-a",
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: ["lane-b"],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: t0,
          updatedAt: t1,
          completedAt: t1,
        },
        "join-c-into-a": {
          joinId: "join-c-into-a",
          kind: "context_merge",
          contextId: "context-merge-ac",
          targetLaneId: "lane-a",
          sourceLaneIds: ["lane-a", "lane-c"],
          mergedSourceLaneIds: ["lane-c"],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: t0,
          updatedAt: t1,
          completedAt: t1,
        },
      },
    };

    const plan = planFinalPublishJoin({
      execution,
      sessionLaneId,
      now: () => t1,
      generateJoinId: () => "join-final",
    });

    expect(plan).not.toBeNull();
    expect(plan!.sourceLaneIds).toEqual(["lane-a"]);
  });
});

describe("findActiveJoin", () => {
  it("returns a pending join when present", () => {
    const base = createWorkflowExecution();
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b"],
      status: "pending",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      joins: { "join-1": join },
    };
    expect(findActiveJoin(execution)?.joinId).toBe("join-1");
  });

  it("returns null when only succeeded/failed joins exist", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      joins: {
        "join-1": makeJoin({
          joinId: "join-1",
          targetLaneId: "lane-a",
          sourceLaneIds: ["lane-b"],
          status: "succeeded",
        }),
      },
    };
    expect(findActiveJoin(execution)).toBeNull();
  });

  it("returns a running join so the execution loop reuses it instead of planning a duplicate after restart", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      joins: {
        "join-running": makeJoin({
          joinId: "join-running",
          targetLaneId: "lane-target",
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: ["lane-a"],
          status: "running",
        }),
      },
    };
    expect(findActiveJoin(execution)?.joinId).toBe("join-running");
  });

  it("prefers the first pending or running join when multiple terminal joins coexist with one active join", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      joins: {
        "join-done": makeJoin({
          joinId: "join-done",
          targetLaneId: "lane-target",
          sourceLaneIds: ["lane-a"],
          status: "succeeded",
        }),
        "join-active": makeJoin({
          joinId: "join-active",
          targetLaneId: "lane-target",
          sourceLaneIds: ["lane-b", "lane-c"],
          status: "pending",
        }),
        "join-failed-prior": makeJoin({
          joinId: "join-failed-prior",
          targetLaneId: "lane-other",
          sourceLaneIds: ["lane-d"],
          status: "failed",
        }),
      },
    };
    expect(findActiveJoin(execution)?.joinId).toBe("join-active");
  });
});

describe("remainingSourceLanes", () => {
  it("excludes already-merged source lanes and the target itself", () => {
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b", "lane-c"],
      mergedSourceLaneIds: ["lane-b"],
    });
    expect(remainingSourceLanes(join)).toEqual(["lane-c"]);
  });
});

describe("appendPendingJoin / applyJoinProgress", () => {
  it("appendPendingJoin stores the join under its id", () => {
    const base = createWorkflowExecution();
    const next = appendPendingJoin(
      base,
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
      }),
    );
    expect(next.joins["join-1"]?.status).toBe("pending");
  });

  it("appendPendingJoin writes joinId onto the target context state for context_merge joins so UI wait-state derivation can see the link", () => {
    const base = createWorkflowExecution();
    expect(base.contextStates["context-verify"]?.joinId).toBeNull();
    const next = appendPendingJoin(
      base,
      makeJoin({
        joinId: "join-link",
        kind: "context_merge",
        contextId: "context-verify",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
      }),
    );
    expect(next.contextStates["context-verify"]?.joinId).toBe("join-link");
    // Unrelated context states are not modified.
    expect(next.contextStates["context-plan"]?.joinId).toBeNull();
  });

  it("appendPendingJoin leaves context states untouched when the join has no contextId (final_publish)", () => {
    const base = createWorkflowExecution();
    const next = appendPendingJoin(
      base,
      makeJoin({
        joinId: "join-final",
        kind: "final_publish",
        contextId: null,
        targetLaneId: "session-lane",
        sourceLaneIds: ["lane-a"],
      }),
    );
    for (const state of Object.values(next.contextStates)) {
      expect(state.joinId).toBeNull();
    }
  });

  it("applyJoinProgress updates status, mergedSourceLaneIds, and updatedAt", () => {
    const base = createWorkflowExecution();
    const seeded = appendPendingJoin(
      base,
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b", "lane-c"],
      }),
    );
    const next = applyJoinProgress(seeded, "join-1", t1, {
      status: "running",
      addMergedSourceLaneId: "lane-b",
    });
    const join = next.joins["join-1"]!;
    expect(join.status).toBe("running");
    expect(join.mergedSourceLaneIds).toEqual(["lane-b"]);
    expect(join.updatedAt).toBe(t1);
  });

  it("applyJoinProgress sets completedAt when status becomes succeeded", () => {
    const base = createWorkflowExecution();
    const seeded = appendPendingJoin(
      base,
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
      }),
    );
    const next = applyJoinProgress(seeded, "join-1", t1, {
      status: "succeeded",
      addMergedSourceLaneId: "lane-b",
    });
    expect(next.joins["join-1"]?.completedAt).toBe(t1);
  });

  it("applyJoinProgress records errorMessage + conflicts on failure", () => {
    const base = createWorkflowExecution();
    const seeded = appendPendingJoin(
      base,
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
      }),
    );
    const next = applyJoinProgress(seeded, "join-1", t1, {
      status: "failed",
      errorMessage: "merge conflict",
      conflicts: {
        files: ["src/foo.ts"],
        message: "conflict",
        analysis: [
          {
            file: "src/foo.ts",
            description: "both sides changed the loader",
            resolution: "combine",
            rationale: "independent hunks",
          },
        ],
      },
    });
    expect(next.joins["join-1"]?.status).toBe("failed");
    expect(next.joins["join-1"]?.errorMessage).toBe("merge conflict");
    expect(next.joins["join-1"]?.conflicts?.files).toEqual(["src/foo.ts"]);
    expect(next.joins["join-1"]?.conflicts?.analysis?.[0]?.file).toBe(
      "src/foo.ts",
    );
  });

  it("applyJoinProgress clears conflictGuidance when the patch sets it to null", () => {
    const base = createWorkflowExecution();
    const seeded = appendPendingJoin(
      base,
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
        conflictGuidance: [
          { file: "src/foo.ts", decision: "rejected", feedback: "keep both" },
        ],
      }),
    );
    const next = applyJoinProgress(seeded, "join-1", t1, {
      status: "succeeded",
      conflictGuidance: null,
    });
    expect(next.joins["join-1"]?.conflictGuidance).toBeNull();
  });
});

describe("resetJoinForRetry", () => {
  function seededFailedJoin(status: "failed" | "conflicts") {
    const base = createWorkflowExecution();
    return appendPendingJoin(
      base,
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b", "lane-c"],
        mergedSourceLaneIds: ["lane-b"],
        status,
        errorMessage: "resolution failed",
        conflicts: {
          files: ["src/foo.ts"],
          message: "conflict",
          analysis: null,
        },
        completedAt: t0,
      }),
    );
  }

  it("resets a conflicts join to pending, preserving merged-lane progress", () => {
    const next = resetJoinForRetry(seededFailedJoin("conflicts"), "join-1", t1);
    const join = next.joins["join-1"]!;
    expect(join.status).toBe("pending");
    expect(join.mergedSourceLaneIds).toEqual(["lane-b"]);
    expect(join.errorMessage).toBeNull();
    expect(join.conflicts).toBeNull();
    expect(join.completedAt).toBeNull();
    expect(join.updatedAt).toBe(t1);
  });

  it("attaches operator guidance for the next resolution attempt", () => {
    const guidance = [
      {
        file: "src/foo.ts",
        decision: "rejected" as const,
        feedback: "keep both",
      },
    ];
    const next = resetJoinForRetry(
      seededFailedJoin("failed"),
      "join-1",
      t1,
      guidance,
    );
    expect(next.joins["join-1"]?.conflictGuidance).toEqual(guidance);
  });

  it("leaves succeeded and in-flight joins untouched", () => {
    const base = createWorkflowExecution();
    for (const status of ["pending", "running", "succeeded"] as const) {
      const seeded = appendPendingJoin(
        base,
        makeJoin({
          joinId: "join-1",
          targetLaneId: "lane-a",
          sourceLaneIds: ["lane-a", "lane-b"],
          status,
        }),
      );
      const next = resetJoinForRetry(seeded, "join-1", t1);
      expect(next.joins["join-1"]?.status).toBe(status);
      expect(next.joins["join-1"]?.updatedAt).toBe(t0);
    }
  });
});

describe("resolveLaneConversationId", () => {
  function implementerLaneState(
    contextId: string,
    workflowConversationId: string,
  ): GraphWorkflowAgentSessionState {
    return {
      lane: "implementer",
      contextId,
      engine: "claude",
      workflowConversationId,
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: workflowConversationId,
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "supported",
      lastUsedAt: t0,
    };
  }

  function makeTask(
    overrides: Partial<GraphWorkflowTaskState> &
      Pick<GraphWorkflowTaskState, "taskId" | "contextId" | "order">,
  ): GraphWorkflowTaskState {
    return {
      status: "completed",
      summary: null,
      startedAt: t0,
      completedAt: t0,
      lastConversationId: null,
      failureMessage: null,
      failureHistory: [],
      ...overrides,
    };
  }

  function executionWithLane(
    lane: GraphWorkflowExecutionLaneState,
  ): GraphWorkflowExecution {
    const base = createWorkflowExecution();
    return { ...base, executionLanes: { [lane.laneId]: lane } };
  }

  it("returns the implementer conversation of the lane's last committing context", () => {
    const execution = executionWithLane(
      makeLane({
        laneId: "lane-a",
        branchName: "csm/lane-a",
        includedContextIds: ["ctx-1", "ctx-2"],
        lastCommittingContextId: "ctx-2",
      }),
    );
    execution.laneStates = {
      "ctx-1": { implementer: implementerLaneState("ctx-1", "conv-ctx-1") },
      "ctx-2": { implementer: implementerLaneState("ctx-2", "conv-ctx-2") },
    };

    expect(resolveLaneConversationId(execution, "lane-a")).toBe("conv-ctx-2");
  });

  it("falls back through includedContextIds (most recent first) when the last committing context has no conversation", () => {
    const execution = executionWithLane(
      makeLane({
        laneId: "lane-a",
        branchName: "csm/lane-a",
        includedContextIds: ["ctx-1", "ctx-2"],
        lastCommittingContextId: null,
      }),
    );
    execution.laneStates = {
      "ctx-1": { implementer: implementerLaneState("ctx-1", "conv-ctx-1") },
    };

    expect(resolveLaneConversationId(execution, "lane-a")).toBe("conv-ctx-1");
  });

  it("falls back to the context's most recent task conversation when no implementer lane state exists", () => {
    const execution = executionWithLane(
      makeLane({
        laneId: "lane-a",
        branchName: "csm/lane-a",
        includedContextIds: ["ctx-1"],
        lastCommittingContextId: "ctx-1",
      }),
    );
    execution.taskStates = {
      "task-1": makeTask({
        taskId: "task-1",
        contextId: "ctx-1",
        order: 1,
        lastConversationId: "conv-early",
      }),
      "task-2": makeTask({
        taskId: "task-2",
        contextId: "ctx-1",
        order: 2,
        lastConversationId: "conv-late",
      }),
      "task-other": makeTask({
        taskId: "task-other",
        contextId: "ctx-other",
        order: 9,
        lastConversationId: "conv-other-context",
      }),
    };

    expect(resolveLaneConversationId(execution, "lane-a")).toBe("conv-late");
  });

  it("ignores non-implementer lane states", () => {
    const validatorState: GraphWorkflowAgentSessionState = {
      lane: "context_validator",
      contextId: "ctx-1",
      engine: "claude",
      workflowConversationId: "conv-validator",
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "conv-validator",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "supported",
      lastUsedAt: t0,
    };
    const execution = executionWithLane(
      makeLane({
        laneId: "lane-a",
        branchName: "csm/lane-a",
        includedContextIds: ["ctx-1"],
        lastCommittingContextId: "ctx-1",
      }),
    );
    execution.laneStates = { "ctx-1": { context_validator: validatorState } };

    expect(resolveLaneConversationId(execution, "lane-a")).toBeNull();
  });

  it("returns null for an unknown lane or a lane with no recorded conversations", () => {
    const execution = executionWithLane(
      makeLane({
        laneId: "lane-a",
        branchName: "csm/lane-a",
        includedContextIds: ["ctx-1"],
      }),
    );

    expect(resolveLaneConversationId(execution, "lane-a")).toBeNull();
    expect(resolveLaneConversationId(execution, "lane-missing")).toBeNull();
  });
});

describe("materializeSessionLane", () => {
  it("creates a session-kind lane when one is not present", () => {
    const base = createWorkflowExecution();
    const next = materializeSessionLane(base, {
      sessionLaneId: "session-lane",
      branchName: "csm/test-session",
      worktreePath: "/tmp/session",
      now: () => t1,
    });
    const lane = next.executionLanes["session-lane"];
    expect(lane?.kind).toBe("session");
    expect(lane?.worktreePath).toBe("/tmp/session");
    expect(lane?.branchName).toBe("csm/test-session");
  });

  it("is a no-op when the session lane already exists", () => {
    const base = createWorkflowExecution();
    const seeded = materializeSessionLane(base, {
      sessionLaneId: "session-lane",
      branchName: "csm/test-session",
      worktreePath: "/tmp/session",
      now: () => t0,
    });
    const next = materializeSessionLane(seeded, {
      sessionLaneId: "session-lane",
      branchName: "csm/test-session",
      worktreePath: "/tmp/session",
      now: () => t1,
    });
    expect(next.executionLanes["session-lane"]?.createdAt).toBe(t0);
  });
});
