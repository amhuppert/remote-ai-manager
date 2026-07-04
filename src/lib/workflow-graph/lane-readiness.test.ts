import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionLaneState,
  GraphWorkflowExecutionJoinState,
} from "@/lib/workflows/schemas";
import {
  classifyContextSchedulability,
  isContextOutputCommittedToLane,
  isUpstreamVisibleToDownstream,
} from "./lane-readiness";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";

const timestamp = "2026-03-27T12:00:00.000Z";

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
    createdAt: timestamp,
    updatedAt: timestamp,
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
    status: "succeeded",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    ...overrides,
  };
}

describe("isContextOutputCommittedToLane", () => {
  it("treats legacy session-isolation + completed as committed (no lane required)", () => {
    const base = createWorkflowExecution();
    const state = {
      ...base.contextStates["context-plan"]!,
      status: "completed" as const,
      isolation: "session" as const,
      laneId: null,
      mergeStatus: "not-applicable" as const,
    };
    expect(isContextOutputCommittedToLane(state, base)).toBe(true);
  });

  it("treats legacy worktree-isolation + merged-success as committed", () => {
    const base = createWorkflowExecution();
    const state = {
      ...base.contextStates["context-plan"]!,
      status: "completed" as const,
      isolation: "worktree" as const,
      laneId: null,
      mergeStatus: "merged-success" as const,
    };
    expect(isContextOutputCommittedToLane(state, base)).toBe(true);
  });

  it("requires the lane to acknowledge the context when laneId is set", () => {
    const base = createWorkflowExecution();
    const lane = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-lane-a",
      includedContextIds: [],
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-a": lane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          mergeStatus: "merged-success",
        },
      },
    };
    expect(
      isContextOutputCommittedToLane(
        execution.contextStates["context-plan"]!,
        execution,
      ),
    ).toBe(false);
  });

  it("returns true when the lane has the context in includedContextIds", () => {
    const base = createWorkflowExecution();
    const lane = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-lane-a",
      includedContextIds: ["context-plan"],
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-a": lane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          mergeStatus: "merged-success",
        },
      },
    };
    expect(
      isContextOutputCommittedToLane(
        execution.contextStates["context-plan"]!,
        execution,
      ),
    ).toBe(true);
  });

  it("returns false when status is not completed", () => {
    const base = createWorkflowExecution();
    const state = {
      ...base.contextStates["context-plan"]!,
      status: "running" as const,
      isolation: "session" as const,
    };
    expect(isContextOutputCommittedToLane(state, base)).toBe(false);
  });
});

describe("isUpstreamVisibleToDownstream", () => {
  it("returns true when both contexts share the same lane and upstream is committed", () => {
    const base = createWorkflowExecution();
    const lane = makeLane({
      laneId: "shared",
      branchName: "csm/test-shared",
      includedContextIds: ["context-plan"],
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { shared: lane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "shared",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          laneId: "shared",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(true);
  });

  it("returns true when upstream lane was joined into downstream lane via a succeeded join", () => {
    const base = createWorkflowExecution();
    const upstreamLane = makeLane({
      laneId: "lane-up",
      branchName: "csm/test-up",
      includedContextIds: ["context-plan"],
    });
    const downstreamLane = makeLane({
      laneId: "lane-down",
      branchName: "csm/test-down",
    });
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-down",
      sourceLaneIds: ["lane-up"],
      status: "succeeded",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-up": upstreamLane, "lane-down": downstreamLane },
      joins: { "join-1": join },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(true);
  });

  it("returns false when join exists but has not succeeded yet", () => {
    const base = createWorkflowExecution();
    const upstreamLane = makeLane({
      laneId: "lane-up",
      branchName: "csm/test-up",
      includedContextIds: ["context-plan"],
    });
    const downstreamLane = makeLane({
      laneId: "lane-down",
      branchName: "csm/test-down",
    });
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-down",
      sourceLaneIds: ["lane-up"],
      status: "pending",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-up": upstreamLane, "lane-down": downstreamLane },
      joins: { "join-1": join },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(false);
  });

  it("returns false when upstream output is on a different lane and no join connects them", () => {
    const base = createWorkflowExecution();
    const upstreamLane = makeLane({
      laneId: "lane-up",
      branchName: "csm/test-up",
      includedContextIds: ["context-plan"],
    });
    const downstreamLane = makeLane({
      laneId: "lane-down",
      branchName: "csm/test-down",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-up": upstreamLane, "lane-down": downstreamLane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(false);
  });

  it("returns true when the downstream's forked lane already includes the upstream context (fork ancestry, no join)", () => {
    // A parallel wave forks its worktree lane from the parent lane's committed
    // head; the fork's branch history carries the parent's output, recorded as
    // the parent context id in the fork lane's includedContextIds. This
    // visibility holds with no join — without it, an interrupted forked context
    // is wrongly judged dependency-blocked and stranded as ineligible on resume.
    const base = createWorkflowExecution();
    const upstreamLane = makeLane({
      laneId: "lane-up",
      branchName: "csm/test-up",
      includedContextIds: ["context-plan"],
    });
    const forkedDownstreamLane = makeLane({
      laneId: "lane-down",
      branchName: "csm/test-down",
      includedContextIds: ["context-plan"],
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-up": upstreamLane,
        "lane-down": forkedDownstreamLane,
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "ready",
          isolation: "worktree",
          laneId: "lane-down",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(true);
  });

  it("returns true when upstream landed on session (legacy) and downstream has no lane (session-bound)", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "session",
          laneId: null,
          mergeStatus: "not-applicable",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(true);
  });

  it("returns true when upstream is committed to a session-kind lane and downstream has no lane (session-bound)", () => {
    const base = createWorkflowExecution();
    const sessionLane = makeLane({
      laneId: "session-lane",
      branchName: "csm/test-session",
      kind: "session",
      worktreePath: null,
      includedContextIds: ["context-plan"],
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "session-lane": sessionLane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "session",
          laneId: "session-lane",
          mergeStatus: "merged-success",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(true);
  });

  it("returns true when upstream's worktree lane reaches a session-kind lane via succeeded join, and downstream is session-bound", () => {
    const base = createWorkflowExecution();
    const upstreamLane = makeLane({
      laneId: "lane-up",
      branchName: "csm/test-up",
      includedContextIds: ["context-plan"],
    });
    const sessionLane = makeLane({
      laneId: "session-lane",
      branchName: "csm/test-session",
      kind: "session",
      worktreePath: null,
    });
    const finalPublish = makeJoin({
      joinId: "final-publish",
      kind: "final_publish",
      targetLaneId: "session-lane",
      sourceLaneIds: ["lane-up"],
      status: "succeeded",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-up": upstreamLane,
        "session-lane": sessionLane,
      },
      joins: { "final-publish": finalPublish },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(true);
  });

  it("returns false when upstream is on a worktree lane that has not been published to any session-kind lane and downstream is session-bound", () => {
    const base = createWorkflowExecution();
    const upstreamLane = makeLane({
      laneId: "lane-up",
      branchName: "csm/test-up",
      includedContextIds: ["context-plan"],
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-up": upstreamLane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(false);
  });

  it("returns false when upstream is not yet committed", () => {
    const base = createWorkflowExecution();
    const lane = makeLane({
      laneId: "shared",
      branchName: "csm/test-shared",
      includedContextIds: [],
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { shared: lane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "running",
          isolation: "worktree",
          laneId: "shared",
          mergeStatus: "not-applicable",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          laneId: "shared",
        },
      },
    };
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(false);
  });
});

describe("classifyContextSchedulability", () => {
  it("returns dependency-blocked when upstream output is not yet visible", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution: base,
    });
    expect(result.kind).toBe("dependency-blocked");
    if (result.kind === "dependency-blocked") {
      expect(result.unmetUpstreamIds).toEqual(["context-plan"]);
    }
  });

  it("returns schedulable on the session lane when the sole upstream landed in session and sessionLaneEnabled is opted in", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "session",
          mergeStatus: "not-applicable",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
      options: { sessionLaneEnabled: true },
    });
    expect(result.kind).toBe("schedulable");
    if (result.kind === "schedulable") {
      expect(result.targetLaneId).toBeNull();
      expect(result.requiresFork).toBe(false);
    }
  });

  it("requires fork by default when the sole upstream landed in session because sessionLaneEnabled defaults to false", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "session",
          mergeStatus: "not-applicable",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
    });
    expect(result.kind).toBe("schedulable");
    if (result.kind === "schedulable") {
      expect(result.targetLaneId).toBeNull();
      expect(result.requiresFork).toBe(true);
    }
  });

  it("returns schedulable with sole worktree source lane when that lane is idle", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const lane = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-a",
      includedContextIds: ["context-plan"],
      status: "active",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-a": lane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          mergeStatus: "merged-success",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
    });
    expect(result.kind).toBe("schedulable");
    if (result.kind === "schedulable") {
      expect(result.targetLaneId).toBe("lane-a");
      expect(result.requiresFork).toBe(false);
    }
  });

  it("returns wait-for-lane when the sole source lane currently has a running context", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const lane = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-a",
      includedContextIds: ["context-plan", "context-busy"],
      status: "active",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-a": lane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          mergeStatus: "merged-success",
        },
        "context-busy": {
          pendingApproval: null,
          pendingUserInput: null,
          contextId: "context-busy",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "worktree",
          batchId: null,
          laneId: "lane-a",
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
    });
    expect(result.kind).toBe("wait-for-lane");
    if (result.kind === "wait-for-lane") {
      expect(result.laneId).toBe("lane-a");
    }
  });

  it("returns wait-for-join when two upstreams sit on different worktree lanes", () => {
    const definition = createWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
        {
          id: "edge-implement-verify",
          sourceContextId: "context-implement",
          targetContextId: "context-verify",
        },
      ],
    });
    const base = createWorkflowExecution();
    const laneA = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-a",
      includedContextIds: ["context-plan"],
    });
    const laneB = makeLane({
      laneId: "lane-b",
      branchName: "csm/test-b",
      includedContextIds: ["context-implement"],
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-a": laneA, "lane-b": laneB },
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
    const result = classifyContextSchedulability({
      contextId: "context-verify",
      definition,
      execution,
    });
    expect(result.kind).toBe("wait-for-join");
    if (result.kind === "wait-for-join") {
      expect(result.sourceLaneIds.sort()).toEqual(["lane-a", "lane-b"]);
    }
  });

  it("returns dependency-blocked when one upstream is committed but invisible to the downstream's lane", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const upstreamLane = makeLane({
      laneId: "lane-up",
      branchName: "csm/test-up",
      includedContextIds: ["context-plan"],
    });
    const downstreamLane = makeLane({
      laneId: "lane-down",
      branchName: "csm/test-down",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-up": upstreamLane, "lane-down": downstreamLane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
    });
    expect(result.kind).toBe("dependency-blocked");
    if (result.kind === "dependency-blocked") {
      expect(result.unmetUpstreamIds).toEqual(["context-plan"]);
    }
  });

  it("classifies a forked context as schedulable when its lane already includes the upstream output (post-interruption re-schedule)", () => {
    // Repro of the premature-completion bug: a parallel wave forked its lane
    // from the parent's committed head, ran partway, then was interrupted and
    // reset to `ready`. On re-schedule it must be schedulable on its own lane,
    // not dependency-blocked, even though no join connects the parent lane to
    // the fork. Otherwise the scheduler strands it and the loop completes with
    // unfinished work.
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const upstreamLane = makeLane({
      laneId: "lane-up",
      branchName: "csm/test-up",
      includedContextIds: ["context-plan"],
    });
    const forkedLane = makeLane({
      laneId: "lane-down",
      branchName: "csm/test-down",
      includedContextIds: ["context-plan"],
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: { "lane-up": upstreamLane, "lane-down": forkedLane },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "ready",
          isolation: "worktree",
          laneId: "lane-down",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
    });
    expect(result.kind).toBe("schedulable");
    if (result.kind === "schedulable") {
      expect(result.targetLaneId).toBe("lane-down");
      expect(result.requiresFork).toBe(false);
    }
  });

  it("returns wait-for-capacity when capacityRemaining is 0", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "session",
          mergeStatus: "not-applicable",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
      options: { capacityRemaining: 0 },
    });
    expect(result.kind).toBe("wait-for-capacity");
  });

  it("requires fork when session-lane participation is disabled and downstream would otherwise land in session", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "session",
          mergeStatus: "not-applicable",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
      options: { sessionLaneEnabled: false },
    });
    expect(result.kind).toBe("schedulable");
    if (result.kind === "schedulable") {
      expect(result.requiresFork).toBe(true);
    }
  });

  it("requires fork when an unrelated worktree lane has unpublished work and downstream would target session", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "session",
          mergeStatus: "not-applicable",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "pending",
        },
        "context-verify": {
          ...base.contextStates["context-verify"]!,
          status: "running",
          isolation: "worktree",
          mergeStatus: "not-applicable",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
    });
    expect(result.kind).toBe("schedulable");
    if (result.kind === "schedulable") {
      expect(result.requiresFork).toBe(true);
    }
  });

  it("returns schedulable on the common target lane when both upstream lanes have been joined into it", () => {
    const definition = createWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
        {
          id: "edge-implement-verify",
          sourceContextId: "context-implement",
          targetContextId: "context-verify",
        },
      ],
    });
    const base = createWorkflowExecution();
    const laneA = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-a",
      includedContextIds: ["context-plan"],
    });
    const laneB = makeLane({
      laneId: "lane-b",
      branchName: "csm/test-b",
      includedContextIds: ["context-implement"],
    });
    const laneTarget = makeLane({
      laneId: "lane-target",
      branchName: "csm/test-target",
    });
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-a", "lane-b"],
      status: "succeeded",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-a": laneA,
        "lane-b": laneB,
        "lane-target": laneTarget,
      },
      joins: { "join-1": join },
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
    const result = classifyContextSchedulability({
      contextId: "context-verify",
      definition,
      execution,
    });
    expect(result.kind).toBe("schedulable");
    if (result.kind === "schedulable") {
      expect(result.targetLaneId).toBe("lane-target");
      expect(result.requiresFork).toBe(false);
    }
  });

  it("returns wait-for-join when only one of two upstream lanes has been joined into the candidate target", () => {
    const definition = createWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
        {
          id: "edge-implement-verify",
          sourceContextId: "context-implement",
          targetContextId: "context-verify",
        },
      ],
    });
    const base = createWorkflowExecution();
    const laneA = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-a",
      includedContextIds: ["context-plan"],
    });
    const laneB = makeLane({
      laneId: "lane-b",
      branchName: "csm/test-b",
      includedContextIds: ["context-implement"],
    });
    const laneTarget = makeLane({
      laneId: "lane-target",
      branchName: "csm/test-target",
    });
    const join = makeJoin({
      joinId: "join-only-a",
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-a"],
      status: "succeeded",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-a": laneA,
        "lane-b": laneB,
        "lane-target": laneTarget,
      },
      joins: { "join-only-a": join },
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
    const result = classifyContextSchedulability({
      contextId: "context-verify",
      definition,
      execution,
    });
    expect(result.kind).toBe("wait-for-join");
    if (result.kind === "wait-for-join") {
      expect(result.sourceLaneIds.sort()).toEqual(["lane-a", "lane-b"]);
    }
  });

  it("returns wait-for-lane when post-join common target lane is currently running another context", () => {
    const definition = createWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
        {
          id: "edge-implement-verify",
          sourceContextId: "context-implement",
          targetContextId: "context-verify",
        },
      ],
    });
    const base = createWorkflowExecution();
    const laneA = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-a",
      includedContextIds: ["context-plan"],
    });
    const laneB = makeLane({
      laneId: "lane-b",
      branchName: "csm/test-b",
      includedContextIds: ["context-implement"],
    });
    const laneTarget = makeLane({
      laneId: "lane-target",
      branchName: "csm/test-target",
    });
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-a", "lane-b"],
      status: "succeeded",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-a": laneA,
        "lane-b": laneB,
        "lane-target": laneTarget,
      },
      joins: { "join-1": join },
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
        "context-busy": {
          pendingApproval: null,
          pendingUserInput: null,
          contextId: "context-busy",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "worktree",
          batchId: null,
          laneId: "lane-target",
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-verify",
      definition,
      execution,
    });
    expect(result.kind).toBe("wait-for-lane");
    if (result.kind === "wait-for-lane") {
      expect(result.laneId).toBe("lane-target");
    }
  });

  it("does not require fork when a worktree lane is already published into a session-kind lane via succeeded join", () => {
    const definition = createWorkflowDefinition();
    const base = createWorkflowExecution();
    const worktreeLane = makeLane({
      laneId: "lane-finished",
      branchName: "csm/test-finished",
      includedContextIds: ["context-verify"],
      status: "merged",
    });
    const sessionLane = makeLane({
      laneId: "session-lane",
      branchName: "csm/test-session",
      kind: "session",
    });
    const join = makeJoin({
      joinId: "final-publish",
      kind: "final_publish",
      targetLaneId: "session-lane",
      sourceLaneIds: ["lane-finished"],
      status: "succeeded",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-finished": worktreeLane,
        "session-lane": sessionLane,
      },
      joins: { "final-publish": join },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "session",
          mergeStatus: "not-applicable",
        },
        "context-verify": {
          ...base.contextStates["context-verify"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-finished",
          mergeStatus: "merged-success",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
      options: { sessionLaneEnabled: true },
    });
    expect(result.kind).toBe("schedulable");
    if (result.kind === "schedulable") {
      expect(result.targetLaneId).toBeNull();
      expect(result.requiresFork).toBe(false);
    }
  });

  it("a terminal verification context with multi-worktree-lane upstreams stays unschedulable until a final_publish join lands the lanes on the session lane", () => {
    const definition = createWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
        {
          id: "edge-implement-verify",
          sourceContextId: "context-implement",
          targetContextId: "context-verify",
        },
      ],
    });
    const base = createWorkflowExecution();
    const sessionLaneId = "session-lane";
    const sessionLane = makeLane({
      laneId: sessionLaneId,
      branchName: "csm/test-session",
      kind: "session",
      worktreePath: "/tmp/session",
    });
    const laneA = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-a",
      includedContextIds: ["context-plan"],
    });
    const laneB = makeLane({
      laneId: "lane-b",
      branchName: "csm/test-b",
      includedContextIds: ["context-implement"],
    });

    const preJoin: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [sessionLaneId]: sessionLane,
        "lane-a": laneA,
        "lane-b": laneB,
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

    const before = classifyContextSchedulability({
      contextId: "context-verify",
      definition,
      execution: preJoin,
    });
    expect(before.kind).toBe("wait-for-join");

    const postPublish: GraphWorkflowExecution = {
      ...preJoin,
      joins: {
        "join-final": makeJoin({
          joinId: "join-final",
          kind: "final_publish",
          targetLaneId: sessionLaneId,
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: ["lane-a", "lane-b"],
          status: "succeeded",
        }),
      },
    };

    const after = classifyContextSchedulability({
      contextId: "context-verify",
      definition,
      execution: postPublish,
    });
    expect(after.kind).toBe("schedulable");
    if (after.kind === "schedulable") {
      expect(after.targetLaneId).toBe(sessionLaneId);
      expect(after.requiresFork).toBe(false);
    }
  });
});
