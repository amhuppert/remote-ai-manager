import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import type {
  ContextPlacement,
  ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  classifyContextSchedulability,
  isContextOutputCommittedToLane,
  isUpstreamVisibleToDownstream,
} from "./lane-readiness";
import {
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "@/lib/workflow-graph/lane-identity";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";

const timestamp = "2026-03-27T12:00:00.000Z";

/**
 * Re-place named contexts of a definition. Placement is the only lane authority
 * (R2), so nearly every scheduler case is expressed by moving a context onto a
 * particular lane rather than by arranging where its upstream happened to land.
 */
function withPlacement<
  T extends { executionContexts: readonly { id: string }[] },
>(definition: T, placements: Record<string, ContextPlacement>): T {
  return {
    ...definition,
    executionContexts: definition.executionContexts.map((context) =>
      placements[context.id]
        ? { ...context, placement: placements[context.id]! }
        : context,
    ),
  };
}

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
    validationDebtSourceLaneIds: [],
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
  it("treats session-isolation + completed as committed (no lane required)", () => {
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

  it("does not treat a lane-less worktree as committed despite merged-success", () => {
    const base = createWorkflowExecution();
    const state = {
      ...base.contextStates["context-plan"]!,
      status: "completed" as const,
      isolation: "worktree" as const,
      laneId: null,
      mergeStatus: "merged-success" as const,
    };
    expect(isContextOutputCommittedToLane(state, base)).toBe(false);
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
      includedContextIds: ["context-plan"],
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

  it("returns true when upstream landed on session and downstream has no lane (session-bound)", () => {
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
      includedContextIds: ["context-plan"],
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

  it("keeps a context authored onto the session lane in the session worktree when sessionLaneEnabled is opted in", () => {
    const definition = withPlacement(createWorkflowDefinition(), {
      "context-implement": { lane: SESSION_LANE_NAME, mode: "readOnly" },
    });
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

  it("schedules a read-only session sentinel without opt-in, even when an execution lane row exists", () => {
    const definition = withPlacement(createWorkflowDefinition(), {
      "context-implement": { lane: SESSION_LANE_NAME, mode: "readOnly" },
    });
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        [SESSION_LANE_ID]: {
          laneId: SESSION_LANE_ID,
          kind: "session",
          status: "active",
          worktreePath: null,
          branchName: "csm/session-1",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
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
    expect(result).toEqual({
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: false,
      forkFromLaneId: null,
    });
  });

  it("requires fork for a context authored onto a group lane even when its upstream landed in session", () => {
    // Authored placement is the only lane authority (R2): a group lane always
    // costs a worktree, whatever the caller opted into for the session lane.
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
    expect(result).toEqual({
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: true,
      forkFromLaneId: null,
    });
  });

  it("forks the authored lane from the sole worktree lane the upstream landed on", () => {
    // The upstream's lane is a fork BASE, never a destination: `context-plan`
    // landed on `lane-a`, but `context-implement` is authored onto `implement`.
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
    expect(result).toEqual({
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: true,
      forkFromLaneId: "lane-a",
    });
  });

  it("mints the authored lane even while the fork parent is running another context", () => {
    // The fork copies the parent's COMMITTED head, so a turn still in flight on
    // the parent lane is no reason to hold the new lane back.
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
        "context-verify": {
          ...base.contextStates["context-verify"]!,
          status: "running",
          isolation: "worktree",
          laneId: "lane-a",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-implement",
      definition,
      execution,
    });
    expect(result).toEqual({
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: true,
      forkFromLaneId: "lane-a",
    });
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

  it("returns wait-for-join when one upstream landed on a lane its authored target cannot see", () => {
    // Landed but invisible is a ROUTING gap, not a dependency one: a join into
    // the authored target is exactly what closes it, so blocking the context on
    // its dependency instead would leave nobody to plan that join.
    const definition = withPlacement(createWorkflowDefinition(), {
      "context-implement": { lane: "lane-down", mode: "full" },
    });
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
    expect(result).toEqual({
      kind: "wait-for-join",
      sourceLaneIds: ["lane-up"],
    });
  });

  it("classifies a forked context as schedulable when its lane already includes the upstream output (post-interruption re-schedule)", () => {
    // Repro of the premature-completion bug: a parallel wave forked its lane
    // from the parent's committed head, ran partway, then was interrupted and
    // reset to `ready`. On re-schedule it must be schedulable on its own lane,
    // not dependency-blocked, even though no join connects the parent lane to
    // the fork. Otherwise the scheduler strands it and the loop completes with
    // unfinished work.
    const definition = withPlacement(createWorkflowDefinition(), {
      "context-implement": { lane: "lane-down", mode: "full" },
    });
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

  it("mints the authored lane forked from the common target once both upstream lanes are joined into it", () => {
    const definition = withPlacement(
      createWorkflowDefinition({
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
      }),
      { "context-verify": { lane: "verify", mode: "full" } },
    );
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
      includedContextIds: ["context-plan", "context-implement"],
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
    expect(result).toEqual({
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: true,
      forkFromLaneId: "lane-target",
    });
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

  it("returns wait-for-lane when the authored target lane is running a full-access member", () => {
    const definition = withPlacement(
      createWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      }),
      {
        // Both write-capable members share the target lane; the running one
        // holds it exclusively because it declares full access.
        "context-implement": { lane: "lane-target", mode: "full" },
        "context-verify": { lane: "lane-target", mode: "full" },
      },
    );
    const base = createWorkflowExecution();
    const laneA = makeLane({
      laneId: "lane-a",
      branchName: "csm/test-a",
      includedContextIds: ["context-plan"],
    });
    const laneTarget = makeLane({
      laneId: "lane-target",
      branchName: "csm/test-target",
      includedContextIds: ["context-plan", "context-implement"],
    });
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-a"],
      status: "succeeded",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-a": laneA,
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
          status: "running",
          isolation: "worktree",
          laneId: "lane-target",
        },
      },
    };
    const result = classifyContextSchedulability({
      contextId: "context-verify",
      definition,
      execution,
    });
    expect(result).toEqual({ kind: "wait-for-lane", laneId: "lane-target" });
  });

  it("does not require fork for a session-lane context once every worktree lane is published into the session lane", () => {
    const definition = withPlacement(createWorkflowDefinition(), {
      "context-implement": { lane: SESSION_LANE_NAME, mode: "readOnly" },
    });
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

  it("a read-only session sentinel consumes structured outputs without waiting for upstream worktree publication", () => {
    const definition = withPlacement(
      createWorkflowDefinition({
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
      }),
      { "context-verify": { lane: SESSION_LANE_NAME, mode: "readOnly" } },
    );
    const base = createWorkflowExecution();
    const sessionLaneId = SESSION_LANE_ID;
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
    expect(before).toEqual({
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: false,
      forkFromLaneId: null,
    });

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
    expect(after).toEqual(before);
  });

  describe("authored placement drives the target lane (R2, R3, R5)", () => {
    /**
     * A two-member `impl` lane fed by `context-plan` on the `plan` lane. Each
     * caller decides what the two members own and how far the upstream got, so
     * one shape covers admission, same-lane visibility, and the cross-lane wait.
     */
    function makeLaneGroupFixture(input: {
      implementPlacement: ContextPlacement;
      verifyPlacement: ContextPlacement;
      planLanded?: boolean;
      implementStatus?: GraphWorkflowExecutionContextState["status"];
      /**
       * Whether the `impl` lane forked from `plan` and therefore already
       * carries `context-plan`'s work. False isolates the cross-lane case where
       * a join is genuinely still owed.
       */
      implInheritsPlan?: boolean;
    }): {
      definition: ResolvedWorkflowSemanticDefinition;
      execution: GraphWorkflowExecution;
    } {
      const base = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      });
      const definition: ResolvedWorkflowSemanticDefinition = {
        ...base,
        executionContexts: base.executionContexts.map((context) => {
          if (context.id === "context-implement") {
            return { ...context, placement: input.implementPlacement };
          }
          if (context.id === "context-verify") {
            return { ...context, placement: input.verifyPlacement };
          }
          return context;
        }),
      };
      const baseExecution = createWorkflowExecution({
        workingDefinition: definition,
      });
      const planLanded = input.planLanded ?? true;
      const execution: GraphWorkflowExecution = {
        ...baseExecution,
        executionLanes: {
          plan: makeLane({
            laneId: "plan",
            branchName: "csm/test-plan",
            includedContextIds: planLanded ? ["context-plan"] : [],
          }),
          impl: makeLane({
            laneId: "impl",
            branchName: "csm/test-impl",
            includedContextIds:
              (input.implInheritsPlan ?? true) && planLanded
                ? ["context-plan"]
                : [],
          }),
        },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: planLanded ? "completed" : "running",
            isolation: "worktree",
            laneId: "plan",
          },
          "context-implement": {
            ...baseExecution.contextStates["context-implement"]!,
            status: input.implementStatus ?? "running",
            isolation: "worktree",
            laneId: "impl",
          },
        },
      };
      return { definition, execution };
    }

    it("admits an ownership-disjoint sibling onto a lane another member is already running on", () => {
      const { definition, execution } = makeLaneGroupFixture({
        implementPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src/api"],
        },
        verifyPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src/ui"],
        },
      });

      const result = classifyContextSchedulability({
        contextId: "context-verify",
        definition,
        execution,
      });

      expect(result).toEqual({
        kind: "schedulable",
        targetLaneId: "impl",
        requiresFork: false,
        forkFromLaneId: null,
      });
    });

    it("refuses a sibling whose owned prefix is nested inside a running member's", () => {
      const { definition, execution } = makeLaneGroupFixture({
        implementPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src"],
        },
        verifyPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src/ui"],
        },
      });

      const result = classifyContextSchedulability({
        contextId: "context-verify",
        definition,
        execution,
      });

      expect(result).toEqual({ kind: "wait-for-lane", laneId: "impl" });
    });

    it("never admits a full-access member alongside a running write-capable sibling", () => {
      const { definition, execution } = makeLaneGroupFixture({
        implementPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src/api"],
        },
        verifyPlacement: { lane: "impl", mode: "full" },
      });

      const result = classifyContextSchedulability({
        contextId: "context-verify",
        definition,
        execution,
      });

      expect(result).toEqual({ kind: "wait-for-lane", laneId: "impl" });
    });

    it("admits a read-only member concurrently with a full-access member", () => {
      const { definition, execution } = makeLaneGroupFixture({
        implementPlacement: { lane: "impl", mode: "full" },
        verifyPlacement: { lane: "impl", mode: "readOnly" },
      });

      const result = classifyContextSchedulability({
        contextId: "context-verify",
        definition,
        execution,
      });

      expect(result).toEqual({
        kind: "schedulable",
        targetLaneId: "impl",
        requiresFork: false,
        forkFromLaneId: null,
      });
    });

    it("schedules a same-lane downstream as soon as its upstream lands on the shared lane, with no join", () => {
      // R3.2: the upstream's commit is already in the shared worktree, so there
      // is nothing to merge — the only thing a join would add is a wait.
      const { definition, execution } = makeLaneGroupFixture({
        implementPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src/api"],
        },
        verifyPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src/ui"],
        },
        implementStatus: "completed",
      });
      const landed: GraphWorkflowExecution = {
        ...execution,
        executionLanes: {
          ...execution.executionLanes,
          impl: {
            ...execution.executionLanes.impl!,
            includedContextIds: ["context-implement"],
          },
        },
      };
      const chained: ResolvedWorkflowSemanticDefinition = {
        ...definition,
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-implement-verify",
            sourceContextId: "context-implement",
            targetContextId: "context-verify",
          },
        ],
      };

      const result = classifyContextSchedulability({
        contextId: "context-verify",
        definition: chained,
        execution: { ...landed, workingDefinition: chained },
      });

      expect(result).toEqual({
        kind: "schedulable",
        targetLaneId: "impl",
        requiresFork: false,
        forkFromLaneId: null,
      });
    });

    it("waits for a join when a single cross-lane upstream has not reached the authored target", () => {
      // R3.2's other half, and the case planContextJoin's two-source minimum
      // used to drop on the floor: ONE unmerged source into an existing target.
      const { definition, execution } = makeLaneGroupFixture({
        implementPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src/api"],
        },
        verifyPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src/ui"],
        },
        implementStatus: "completed",
        implInheritsPlan: false,
      });

      const result = classifyContextSchedulability({
        contextId: "context-verify",
        definition,
        execution,
      });

      expect(result).toEqual({
        kind: "wait-for-join",
        sourceLaneIds: ["plan"],
      });
    });

    it("forks the authored lane from its sole upstream lane when the lane does not exist yet", () => {
      const { definition, execution } = makeLaneGroupFixture({
        implementPlacement: {
          lane: "impl",
          mode: "owned",
          ownedPaths: ["src/api"],
        },
        verifyPlacement: { lane: "review", mode: "full" },
      });

      const result = classifyContextSchedulability({
        contextId: "context-verify",
        definition,
        execution,
      });

      expect(result).toEqual({
        kind: "schedulable",
        targetLaneId: null,
        requiresFork: true,
        forkFromLaneId: "plan",
      });
    });
  });
});

/**
 * A lane forked from a join target inherits the target's committed history,
 * including everything the join delivered into it. The join records that merge
 * in the join graph but never writes the merged contexts into the target
 * lane's `includedContextIds`, so a naive inheritance strands the fork: its
 * branch genuinely contains the merged upstream's work, yet the visibility
 * model cannot see it and the scheduler judges the context dependency-blocked
 * forever.
 */
