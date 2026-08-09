import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowContextStatus } from "@/lib/workflow-graph/definition-schemas";
import {
  appendPendingJoin,
  findActiveJoin,
  findBusyJoinSourceLaneIds,
  findContextsWithUnfinishedTasks,
  materializeSessionLane,
  pickJoinTarget,
  planContextJoin,
  planFinalPublishJoin,
  remainingSourceLanes,
  resolveLaneConversationId,
} from "./lane-join";
import { applyJoinProgress, resetJoinForRetry } from "./context-transitions";
import { createWorkflowExecution } from "./test-fixtures";

const t0 = "2026-03-27T12:00:00.000Z";
const t1 = "2026-03-27T12:05:00.000Z";
const nonCompletedContextStatuses = [
  "pending",
  "ready",
  "running",
  "halted",
  "awaiting_approval",
  "awaiting_user_input",
] satisfies readonly GraphWorkflowContextStatus[];

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
    ignoredBaseline: [],
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
    validationDebtSourceLaneIds: [],
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

/**
 * Publish-shaped fixtures must be coherent: planFinalPublishJoin refuses to
 * plan while any context still has unfinished tasks (ticket #28), so tests
 * about lane selection mark every context's work as done first and override
 * specific contexts afterward when the scenario needs an exception.
 */
function completeAllContextTasks(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  const contextStates = Object.fromEntries(
    Object.entries(execution.contextStates).map(([contextId, state]) => [
      contextId,
      {
        ...state,
        status: "completed" as const,
        completedTaskCount: state.totalTaskCount,
      },
    ]),
  );
  return { ...execution, contextStates };
}

describe("pickJoinTarget", () => {
  it("uses the authored target lane, whatever the sources' recency", () => {
    // Authored placement decides where the downstream runs, so the join has to
    // deliver the work THERE. Recency is not a placement authority.
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

    expect(pickJoinTarget(["lane-a", "lane-b"], execution, "lane-a")).toBe(
      "lane-a",
    );
  });

  it("falls back to the lowest source lane id when the authored target has no lane yet", () => {
    // The downstream's own lane does not exist to merge into, so the sources
    // converge on one of themselves and the new lane forks from the result.
    // Deterministic by id so a resume and a replay converge on the same answer.
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-z": makeLane({
          laneId: "lane-z",
          branchName: "csm/test-z",
          updatedAt: t1,
        }),
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/test-a",
          updatedAt: t0,
        }),
      },
    };

    expect(pickJoinTarget(["lane-z", "lane-a"], execution, "lane-new")).toBe(
      "lane-a",
    );
    expect(pickJoinTarget(["lane-z", "lane-a"], execution)).toBe("lane-a");
  });
});

describe("planContextJoin targets the authored lane (R3, decision D5)", () => {
  /**
   * `context-plan` on `lane-up`, `context-implement` authored onto `lane-down`.
   * The caller decides what has already been merged into `lane-down`.
   */
  function makeTargetedFixture(input: {
    joins?: GraphWorkflowExecution["joins"];
    downIncludes?: readonly string[];
    extraUpstreamLaneId?: string;
  }): GraphWorkflowExecution {
    const base = createWorkflowExecution();
    const definition = {
      ...base.workingDefinition,
      executionContexts: base.workingDefinition.executionContexts.map(
        (context) =>
          context.id === "context-implement"
            ? {
                ...context,
                placement: { lane: "lane-down", mode: "full" as const },
              }
            : context,
      ),
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        ...(input.extraUpstreamLaneId
          ? [
              {
                id: "edge-verify-implement",
                sourceContextId: "context-verify",
                targetContextId: "context-implement",
              },
            ]
          : []),
      ],
    };
    const executionLanes: GraphWorkflowExecution["executionLanes"] = {
      "lane-up": makeLane({
        laneId: "lane-up",
        branchName: "csm/test-up",
        includedContextIds: ["context-plan"],
      }),
      "lane-down": makeLane({
        laneId: "lane-down",
        branchName: "csm/test-down",
        includedContextIds: [...(input.downIncludes ?? [])],
      }),
    };
    const contextStates: GraphWorkflowExecution["contextStates"] = {
      ...base.contextStates,
      "context-plan": {
        ...base.contextStates["context-plan"]!,
        status: "completed" as const,
        isolation: "worktree" as const,
        laneId: "lane-up",
        mergeStatus: "merged-success" as const,
      },
    };
    if (input.extraUpstreamLaneId) {
      executionLanes[input.extraUpstreamLaneId] = makeLane({
        laneId: input.extraUpstreamLaneId,
        branchName: `csm/test-${input.extraUpstreamLaneId}`,
        includedContextIds: ["context-verify"],
      });
      contextStates["context-verify"] = {
        ...base.contextStates["context-verify"]!,
        status: "completed" as const,
        isolation: "worktree" as const,
        laneId: input.extraUpstreamLaneId,
        mergeStatus: "merged-success" as const,
      };
    }
    return {
      ...base,
      workingDefinition: definition,
      executionLanes,
      joins: input.joins ?? {},
      contextStates,
    };
  }

  it("plans a join for a SINGLE upstream lane that has not reached the authored target", () => {
    // The two-source minimum used to drop this on the floor: one unmerged
    // source into an existing target is still a merge that has to happen.
    const plan = planContextJoin({
      contextId: "context-implement",
      execution: makeTargetedFixture({}),
      now: () => t1,
      generateJoinId: () => "join-single",
    });

    expect(plan).not.toBeNull();
    expect(plan!.targetLaneId).toBe("lane-down");
    expect(plan!.sourceLaneIds.sort()).toEqual(["lane-down", "lane-up"]);
    expect(plan!.contextId).toBe("context-implement");
  });

  it("merges every unreached source into the authored target", () => {
    const plan = planContextJoin({
      contextId: "context-implement",
      execution: makeTargetedFixture({ extraUpstreamLaneId: "lane-side" }),
      now: () => t1,
      generateJoinId: () => "join-multi",
    });

    expect(plan!.targetLaneId).toBe("lane-down");
    expect(plan!.sourceLaneIds.sort()).toEqual([
      "lane-down",
      "lane-side",
      "lane-up",
    ]);
  });

  it("skips a source lane already reachable from the authored target", () => {
    const plan = planContextJoin({
      contextId: "context-implement",
      execution: makeTargetedFixture({
        extraUpstreamLaneId: "lane-side",
        joins: {
          "join-prior": makeJoin({
            joinId: "join-prior",
            targetLaneId: "lane-down",
            sourceLaneIds: ["lane-up"],
            mergedSourceLaneIds: ["lane-up"],
            status: "succeeded",
          }),
        },
      }),
      now: () => t1,
      generateJoinId: () => "join-rest",
    });

    expect(plan!.targetLaneId).toBe("lane-down");
    expect(plan!.sourceLaneIds.sort()).toEqual(["lane-down", "lane-side"]);
  });

  it("returns null when every upstream is already visible from the authored target", () => {
    const plan = planContextJoin({
      contextId: "context-implement",
      execution: makeTargetedFixture({
        joins: {
          "join-prior": makeJoin({
            joinId: "join-prior",
            targetLaneId: "lane-down",
            sourceLaneIds: ["lane-up"],
            mergedSourceLaneIds: ["lane-up"],
            status: "succeeded",
          }),
        },
      }),
      now: () => t1,
      generateJoinId: () => "join-none",
    });

    expect(plan).toBeNull();
  });

  it("returns null when the upstream ran on the authored target lane itself", () => {
    // R3.2: same-lane work is already in the shared worktree, so a join would
    // merge a branch into itself and buy the downstream nothing but a wait.
    const base = makeTargetedFixture({});
    const sameLane: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        ...base.executionLanes,
        "lane-down": makeLane({
          laneId: "lane-down",
          branchName: "csm/test-down",
          includedContextIds: ["context-plan"],
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          laneId: "lane-down",
        },
      },
    };

    expect(
      planContextJoin({
        contextId: "context-implement",
        execution: sameLane,
        now: () => t1,
        generateJoinId: () => "join-same",
      }),
    ).toBeNull();
  });
});

describe("findBusyJoinSourceLaneIds", () => {
  it("returns no busy lanes when every context on the source lanes is completed", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          laneId: "lane-a",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "completed",
          laneId: "lane-b",
        },
      },
    };
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b"],
    });

    expect(findBusyJoinSourceLaneIds(join, execution)).toEqual([]);
  });

  it.each(nonCompletedContextStatuses)(
    "returns a source lane occupied by a context with status %s",
    (status) => {
      const base = createWorkflowExecution();
      const execution: GraphWorkflowExecution = {
        ...base,
        contextStates: {
          ...base.contextStates,
          "context-plan": {
            ...base.contextStates["context-plan"]!,
            status,
            laneId: "lane-a",
          },
        },
      };
      const join = makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-b",
        sourceLaneIds: ["lane-a", "lane-b"],
      });

      expect(findBusyJoinSourceLaneIds(join, execution)).toEqual(["lane-a"]);
    },
  );

  it("de-duplicates busy lanes and preserves source-lane order", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "ready",
          laneId: "lane-b",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "running",
          laneId: "lane-a",
        },
        "context-verify": {
          ...base.contextStates["context-verify"]!,
          status: "awaiting_approval",
          laneId: "lane-b",
        },
      },
    };
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-b",
      sourceLaneIds: ["lane-b", "lane-a"],
    });

    expect(findBusyJoinSourceLaneIds(join, execution)).toEqual([
      "lane-b",
      "lane-a",
    ]);
  });

  it("ignores incomplete contexts on unrelated lanes", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          laneId: "lane-a",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "ready",
          laneId: "lane-unrelated",
        },
      },
    };
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b"],
    });

    expect(findBusyJoinSourceLaneIds(join, execution)).toEqual([]);
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

  it("plans a context_merge for a terminal fan-in context so its work can run before the final publish (ticket #28)", () => {
    // Regression for F25: the sentinel-sweep shape. A terminal context fanning
    // in from multiple worktree lanes must converge those lanes with a
    // context_merge and run BEFORE final publish — the terminal join is the
    // delivery point (delivery gate), so deferring the terminal context to
    // after publish lets incomplete work merge. Supersedes accepted design
    // decision 9 ("final verification runs after publish"), which predates the
    // delivery gate.
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
    expect(plan).not.toBeNull();
    expect(plan!.kind).toBe("context_merge");
    expect(plan!.contextId).toBe("context-verify");
    expect(plan!.targetLaneId).toBe("lane-a");
    expect(plan!.sourceLaneIds.sort()).toEqual(["lane-a", "lane-b"]);
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
          validationDebtSourceLaneIds: [],
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
    const base = completeAllContextTasks(createWorkflowExecution());
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

  it("freezes a three-member lane's context ids into its final-publish intent", () => {
    const base = completeAllContextTasks(createWorkflowExecution());
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
          includedContextIds: [
            "context-plan",
            "context-implement",
            "context-verify",
          ],
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
    expect(plan!.sourceLaneContextIds).toEqual({
      "lane-a": ["context-plan", "context-implement", "context-verify"],
    });
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
    const base = completeAllContextTasks(createWorkflowExecution());
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

  it("returns null while a never-started context still has unstarted tasks (F25: the terminal join must not be planned over incomplete work)", () => {
    // The incident shape from ticket #28: every lane-bearing context completed,
    // but a laneless downstream (the sentinel sweep) went ready and never ran.
    // Its work exists only as unstarted tasks — no lane carries it, so the
    // per-lane incomplete-work exclusion cannot see it. The planner must refuse
    // to plan the terminal join outright until every context's tasks are done.
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
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          completedTaskCount: 1,
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          completedTaskCount: 1,
        },
        "context-verify": {
          ...base.contextStates["context-verify"]!,
          status: "ready",
          laneId: null,
          completedTaskCount: 0,
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

  it("plans the final publish once every context's tasks are complete, even when a status lags behind", () => {
    // Counterpart to the unstarted-tasks refusal: the guard is task-based, not
    // status-based. A context whose tasks are all done but whose status has
    // not flipped to completed (e.g. parked awaiting collaboration delivery)
    // must not block the publish — its LANE is excluded by the per-lane
    // incomplete-work filter instead when it holds one.
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
          includedContextIds: [
            "context-plan",
            "context-implement",
            "context-verify",
          ],
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          completedTaskCount: 1,
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          completedTaskCount: 1,
        },
        "context-verify": {
          ...base.contextStates["context-verify"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-a",
          completedTaskCount: 1,
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
    const base = completeAllContextTasks(createWorkflowExecution());
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
    const base = completeAllContextTasks(createWorkflowExecution());
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
          validationDebtSourceLaneIds: [],
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
    const base = completeAllContextTasks(createWorkflowExecution());
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
          validationDebtSourceLaneIds: [],
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
    const base = completeAllContextTasks(createWorkflowExecution());
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
          validationDebtSourceLaneIds: [],
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
          validationDebtSourceLaneIds: [],
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
      backend: "claude",
      refKind: "conversation",
      workflowConversationId,
      sessionRef: { backend: "claude", ref: workflowConversationId },
      metrics: { rotateBeforeNextTurn: false },
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
      backend: "claude",
      refKind: "conversation",
      workflowConversationId: "conv-validator",
      sessionRef: { backend: "claude", ref: "conv-validator" },
      metrics: { rotateBeforeNextTurn: false },
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

describe("skipped contexts are settled with nothing (D4 R4.1)", () => {
  /**
   * A skipped context never runs its tasks, so the task-based completion
   * invariant would otherwise hold the whole execution open on work that is
   * definitionally never going to happen.
   */
  it("exempts a skipped context from the unfinished-task completion invariant", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "skipped",
          completedTaskCount: 0,
          skipReason: {
            edgeEvaluations: [
              { edgeId: "edge-plan-implement", verdict: "inactive" },
            ],
            at: t0,
          },
        },
        "context-verify": {
          ...base.contextStates["context-verify"]!,
          status: "skipped",
          completedTaskCount: 0,
          skipReason: {
            edgeEvaluations: [
              { edgeId: "edge-implement-verify", verdict: "omitted" },
            ],
            at: t0,
          },
        },
      },
    };

    expect(findContextsWithUnfinishedTasks(execution)).toEqual([]);
  });

  it("does not treat a skipped context's lane as holding incomplete work at final publish", () => {
    const base = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "cc/lane-a",
          includedContextIds: ["context-plan"],
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          laneId: "lane-a",
          isolation: "worktree",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "skipped",
          // A skipped context is frozen mid-graph and may still carry the lane
          // its dispatch would have used; it holds no work, so it must not
          // block that lane's publication.
          laneId: "lane-a",
          skipReason: { edgeEvaluations: [], at: t0 },
        },
        "context-verify": {
          ...base.contextStates["context-verify"]!,
          status: "skipped",
          skipReason: { edgeEvaluations: [], at: t0 },
        },
      },
    };

    const join = planFinalPublishJoin({
      execution,
      sessionLaneId: "__session__",
      now: () => t1,
      generateJoinId: () => "join-publish",
    });

    expect(join).not.toBeNull();
    expect(join?.sourceLaneIds).toEqual(["lane-a"]);
  });

  it("plans no join for a fan-in whose second branch was skipped", () => {
    const base = createWorkflowExecution({
      workingDefinition: {
        ...createWorkflowExecution().workingDefinition,
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
      },
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "cc/lane-a",
          includedContextIds: ["context-plan"],
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "cc/lane-b",
          includedContextIds: ["context-implement"],
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          laneId: "lane-a",
          isolation: "worktree",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "skipped",
          laneId: "lane-b",
          isolation: "worktree",
          skipReason: {
            edgeEvaluations: [
              { edgeId: "edge-implement-verify", verdict: "inactive" },
            ],
            at: t0,
          },
        },
      },
    };

    // Only one branch actually contributes work, so there is nothing to merge.
    expect(
      planContextJoin({
        contextId: "context-verify",
        execution,
        now: () => t1,
        generateJoinId: () => "join-1",
      }),
    ).toBeNull();
  });
});

describe("quiescence derives from the route projection (D4 R4.1, decision D1)", () => {
  /**
   * A restart between a guard resolving false and the settlement pass that
   * persists the skip. The routing has already decided the branch does not run;
   * only the durable status has not caught up. Completion and publish must
   * derive that from the projection — reading the status alone strands the run
   * on a context that is never going to execute.
   */
  function routeDeclinedExecution(): GraphWorkflowExecution {
    const base = createWorkflowExecution({
      workingDefinition: {
        ...createWorkflowExecution().workingDefinition,
        executionContexts:
          createWorkflowExecution().workingDefinition.executionContexts.map(
            (context) =>
              context.id === "context-plan"
                ? {
                    ...context,
                    outputSchema: {
                      type: "object",
                      properties: { verdict: { type: "string" } },
                      required: ["verdict"],
                    },
                  }
                : context,
          ),
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
            when: {
              schema: {
                type: "object",
                properties: { verdict: { const: "implement" } },
                required: ["verdict"],
              },
            },
          },
          {
            id: "edge-implement-verify",
            sourceContextId: "context-implement",
            targetContextId: "context-verify",
          },
        ],
      },
    });
    return {
      ...base,
      contextOutputs: {
        "context-plan": {
          value: { verdict: "done" },
          capturedAt: t0,
          iteration: 1,
          parse: { source: "native" },
        },
      },
      executionLanes: {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "cc/lane-a",
          includedContextIds: ["context-plan"],
        }),
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          laneId: "lane-a",
          isolation: "worktree",
        },
      },
    };
  }

  it("exempts a route-declined context from the unfinished-task invariant before its skip is persisted", () => {
    const execution = routeDeclinedExecution();

    expect(execution.contextStates["context-implement"]?.status).toBe(
      "pending",
    );
    expect(findContextsWithUnfinishedTasks(execution)).toEqual([]);
  });

  it("still counts a context the routing has not declined", () => {
    const execution = routeDeclinedExecution();
    execution.contextOutputs["context-plan"] = {
      value: { verdict: "implement" },
      capturedAt: t0,
      iteration: 1,
      parse: { source: "native" },
    };

    expect(
      findContextsWithUnfinishedTasks(execution).map(
        (state) => state.contextId,
      ),
    ).toEqual(["context-implement", "context-verify"]);
  });

  it("publishes the branch that ran without waiting for the declined one", () => {
    const join = planFinalPublishJoin({
      execution: routeDeclinedExecution(),
      sessionLaneId: "__session__",
      now: () => t1,
      generateJoinId: () => "join-publish",
    });

    expect(join?.sourceLaneIds).toEqual(["lane-a"]);
  });

  /**
   * The projection carries no lane or merge state on purpose, so its skip
   * verdict alone is a ROUTING decision, not a settled exemption. Until the
   * source's work has landed, R2.5 says the source BLOCKS its dependents —
   * exempting them from completion and final publish first would let a run
   * converge around a branch whose fate is still open.
   */
  function unlandedSource(
    execution: GraphWorkflowExecution,
  ): GraphWorkflowExecution {
    const next = structuredClone(execution);
    next.contextStates["context-plan"] = {
      ...next.contextStates["context-plan"]!,
      mergeStatus: "merged-failed",
      lastMergeError: "conflict in src/app.ts",
      landingIntent: {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:context-plan:1",
        laneId: "lane-a",
        worktreePath: "/tmp/lane-a",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "failed",
        evidence: "join-merge",
        recordedAt: t0,
        settledAt: t0,
      },
    };
    return next;
  }

  it("counts a route-declined context until its source has landed (R2.5)", () => {
    const execution = unlandedSource(routeDeclinedExecution());

    expect(
      findContextsWithUnfinishedTasks(execution).map(
        (state) => state.contextId,
      ),
    ).toEqual(["context-implement", "context-verify"]);
  });

  it("refuses the final publish while the declined branch's source has not landed (R2.5)", () => {
    expect(
      planFinalPublishJoin({
        execution: unlandedSource(routeDeclinedExecution()),
        sessionLaneId: "__session__",
        now: () => t1,
        generateJoinId: () => "join-publish",
      }),
    ).toBeNull();
  });

  it("does not let a route-declined context's lane hold the publish open", () => {
    const execution = routeDeclinedExecution();
    // The declined context was placed on the lane before the guard resolved.
    execution.contextStates["context-implement"] = {
      ...execution.contextStates["context-implement"]!,
      laneId: "lane-a",
      isolation: "worktree",
    };

    const join = planFinalPublishJoin({
      execution,
      sessionLaneId: "__session__",
      now: () => t1,
      generateJoinId: () => "join-publish",
    });

    expect(join?.sourceLaneIds).toEqual(["lane-a"]);
  });
});
