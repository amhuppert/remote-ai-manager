import { describe, expect, it } from "vitest";
import {
  graphWorkflowLoopStateSchema,
  type GraphWorkflowExecution,
  type GraphWorkflowExecutionJoinState,
  type GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "./test-fixtures";
import { SESSION_LANE_ID, SESSION_LANE_NAME } from "./lane-identity";
import { workerJudgeDefinition, executionFor } from "./loop-test-fixtures";
import {
  laneClosure,
  laneClosureFromPin,
  openLoopLanes,
  pinLaneClosure,
} from "./lane-lifecycle";

const NOW = "2026-08-08T00:00:00.000Z";

function lane(
  laneId: string,
  overrides: Partial<GraphWorkflowExecutionLaneState> = {},
): GraphWorkflowExecutionLaneState {
  return {
    laneId,
    kind: "worktree",
    status: "active",
    worktreePath: `/tmp/${laneId}`,
    branchName: `csm/${laneId}`,
    includedContextIds: [],
    lastCommittingContextId: null,
    commitSnapshots: [],
    ignoredBaseline: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function join(
  joinId: string,
  targetLaneId: string,
  sourceLaneIds: string[],
  status: GraphWorkflowExecutionJoinState["status"] = "pending",
): GraphWorkflowExecutionJoinState {
  return {
    joinId,
    kind: "context_merge",
    contextId: "context-implement",
    targetLaneId,
    sourceLaneIds,
    mergedSourceLaneIds: [],
    validationDebtSourceLaneIds: [],
    status,
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  };
}

function executionWithLanes(
  lanes: GraphWorkflowExecutionLaneState[],
  joins: GraphWorkflowExecutionJoinState[] = [],
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "running",
    executionLanes: Object.fromEntries(
      lanes.map((entry) => [entry.laneId, entry]),
    ),
    joins: Object.fromEntries(joins.map((entry) => [entry.joinId, entry])),
  });
}

describe("laneClosure (lwp R10, decision D11)", () => {
  it("reports no closure for a lane no join has claimed", () => {
    const execution = executionWithLanes([lane("delivery")]);

    expect(laneClosure(execution, "delivery")).toBeNull();
  });

  it("reports no closure for a lane that has no record yet", () => {
    const execution = executionWithLanes([]);

    expect(laneClosure(execution, "brand-new")).toBeNull();
  });

  it("closes a lane the moment a join intent names it as a source", () => {
    const execution = executionWithLanes(
      [lane("docs"), lane("delivery")],
      [join("join-1", "delivery", ["docs", "delivery"])],
    );

    expect(laneClosure(execution, "docs")).toEqual({
      laneId: "docs",
      reason: "join_planned",
    });
  });

  it("keeps the join's own TARGET lane open for new members", () => {
    const execution = executionWithLanes(
      [lane("docs"), lane("delivery")],
      [join("join-1", "delivery", ["docs", "delivery"])],
    );

    expect(laneClosure(execution, "delivery")).toBeNull();
  });

  it("reports a lane consumed by a succeeded join as joined", () => {
    const execution = executionWithLanes(
      [lane("docs"), lane("delivery")],
      [join("join-1", "delivery", ["docs", "delivery"], "succeeded")],
    );

    expect(laneClosure(execution, "docs")).toEqual({
      laneId: "docs",
      reason: "joined",
    });
  });

  it("keeps a lane closed after its join intent failed — there is no reopen verb", () => {
    const execution = executionWithLanes(
      [lane("docs"), lane("delivery")],
      [join("join-1", "delivery", ["docs", "delivery"], "failed")],
    );

    expect(laneClosure(execution, "docs")?.reason).toBe("join_planned");
  });

  it("reports a retired lane record as disposed", () => {
    const execution = executionWithLanes([
      lane("docs", { status: "merged", worktreePath: null }),
    ]);

    expect(laneClosure(execution, "docs")).toEqual({
      laneId: "docs",
      reason: "disposed",
    });
  });

  it("leaves a halted lane open — a halt is recoverable, not a closure", () => {
    const execution = executionWithLanes([lane("docs", { status: "halted" })]);

    expect(laneClosure(execution, "docs")).toBeNull();
  });

  it("leaves a loop-open lane open even after a join intent names it", () => {
    // Freeze-at-intent applies from loop CONCLUSION onward: a body's lanes swap
    // work through an intra-loop join on every pass, and letting one of those
    // stamp the lane closed would strand every pass after it.
    const definition = workerJudgeDefinition();
    const loopLane =
      definition.loopGroups?.[0]?.template.contexts[0]?.placement.lane;
    if (loopLane === undefined)
      throw new Error("fixture declares no loop body");
    const execution = executionFor(definition);

    expect(
      laneClosure(
        {
          ...execution,
          joins: {
            "join-1": join("join-1", "downstream", [loopLane, "downstream"]),
          },
          loopStates: {
            refine: graphWorkflowLoopStateSchema.parse({
              loopGroupId: "refine",
              activation: "running",
              passCount: 1,
            }),
          },
        },
        loopLane,
      ),
    ).toBeNull();
  });

  it("resolves the authored session lane name onto the engine's session lane id", () => {
    const execution = executionWithLanes(
      [lane(SESSION_LANE_ID, { kind: "session" }), lane("docs")],
      [join("join-final", "docs", [SESSION_LANE_ID, "docs"], "succeeded")],
    );

    expect(laneClosure(execution, SESSION_LANE_NAME)).toEqual({
      laneId: SESSION_LANE_ID,
      reason: "joined",
    });
  });
});

/**
 * The staging seam re-derives closure inside the write queue, where a walk of
 * the definition is exactly the cost it exists to avoid. It pins the
 * definition-derived half outside the lock and re-reads only the runtime half —
 * so the pin must carry the loop exemption forward AND must not bank its
 * verdict.
 */
describe("laneClosureFromPin (lwp R10.1, decision D11)", () => {
  const LOOP_LANE = "refine-lane";

  /** `refine`'s body on one shared lane, with the loop running its first pass. */
  function loopExecution(): GraphWorkflowExecution {
    const definition = workerJudgeDefinition();
    const execution = executionFor({
      ...definition,
      loopGroups: definition.loopGroups?.map((group) => ({
        ...group,
        template: {
          ...group.template,
          contexts: group.template.contexts.map((context) => ({
            ...context,
            placement: { lane: LOOP_LANE, mode: "full" as const },
          })),
        },
      })),
    });
    return {
      ...execution,
      loopStates: {
        refine: graphWorkflowLoopStateSchema.parse({
          loopGroupId: "refine",
          activation: "running",
          passCount: 1,
        }),
      },
    };
  }

  function withJoinClaiming(
    execution: GraphWorkflowExecution,
  ): GraphWorkflowExecution {
    return {
      ...execution,
      joins: {
        "join-1": join("join-1", "downstream", [LOOP_LANE, "downstream"]),
      },
    };
  }

  it("agrees with laneClosure when pin and check read the same execution", () => {
    const execution = executionWithLanes(
      [lane("docs"), lane("delivery")],
      [join("join-1", "delivery", ["docs", "delivery"])],
    );

    expect(
      laneClosureFromPin(execution, pinLaneClosure(execution, "docs")),
    ).toEqual(laneClosure(execution, "docs"));
  });

  it("carries the loop exemption forward when a join lands after the pin", () => {
    const execution = loopExecution();
    const pin = pinLaneClosure(execution, LOOP_LANE);

    expect(laneClosureFromPin(withJoinClaiming(execution), pin)).toBeNull();
  });

  it("closes a pinned loop lane once the loop concludes", () => {
    // The pin banks WHICH loops claim the lane, never whether they were open.
    // Banking the verdict would leave a lane pinned during a running loop
    // permanently exempt, which is the freeze-at-conclusion rule inverted.
    const execution = loopExecution();
    const pin = pinLaneClosure(execution, LOOP_LANE);

    const concluded: GraphWorkflowExecution = {
      ...withJoinClaiming(execution),
      loopStates: {
        refine: graphWorkflowLoopStateSchema.parse({
          loopGroupId: "refine",
          activation: "concluded",
          passCount: 2,
        }),
      },
    };

    expect(laneClosureFromPin(concluded, pin)).toEqual({
      laneId: LOOP_LANE,
      reason: "join_planned",
    });
  });
});

describe("openLoopLanes (lwp R10, decision D11)", () => {
  /**
   * `workerJudgeDefinition` lifts `worker` and `judge` into the `refine` group's
   * template; both are re-placed onto one shared lane so the loop's openness is a
   * property of that lane rather than of two single-member ones.
   */
  const LOOP_LANE = "refine-lane";

  function loopExecution(
    activation?: "unstarted" | "running" | "concluded" | "skipped",
  ): GraphWorkflowExecution {
    const definition = workerJudgeDefinition();
    const withSharedLane = {
      ...definition,
      loopGroups: definition.loopGroups?.map((group) => ({
        ...group,
        template: {
          ...group.template,
          contexts: group.template.contexts.map((context) => ({
            ...context,
            placement: { lane: LOOP_LANE, mode: "full" as const },
          })),
        },
      })),
      executionContexts: definition.executionContexts.map((context) =>
        context.id.includes("__p")
          ? {
              ...context,
              placement: { lane: LOOP_LANE, mode: "full" as const },
            }
          : context,
      ),
    };
    const execution = executionFor(withSharedLane);
    if (activation === undefined) return execution;
    return {
      ...execution,
      loopStates: {
        refine: graphWorkflowLoopStateSchema.parse({
          loopGroupId: "refine",
          activation,
          passCount: 1,
        }),
      },
    };
  }

  it("holds a lane open while its loop body has not concluded", () => {
    expect([...openLoopLanes(loopExecution("running")).all]).toEqual([
      LOOP_LANE,
    ]);
  });

  it("holds a lane open before its loop has even activated", () => {
    expect([...openLoopLanes(loopExecution()).all]).toEqual([LOOP_LANE]);
  });

  it("releases the lane once the loop concludes", () => {
    expect([...openLoopLanes(loopExecution("concluded")).all]).toEqual([]);
  });

  it("releases the lane when the loop's activation path was never taken", () => {
    expect([...openLoopLanes(loopExecution("skipped")).all]).toEqual([]);
  });

  it("reports no loop-open lanes for a definition that declares no loops", () => {
    expect([...openLoopLanes(createWorkflowExecution({})).all]).toEqual([]);
  });
});
