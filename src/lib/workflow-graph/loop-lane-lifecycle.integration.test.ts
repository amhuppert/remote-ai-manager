/**
 * The composed proof for the lane lifecycle's loop exception (lwp R10.1,
 * decision D11): a two-pass loop whose body shares one lane, wired across three
 * lanes, driven to conclusion through the production settlement path.
 *
 * The two failure modes it rules out are opposites, which is why one run has to
 * show both. Freeze too eagerly and pass 2 materializes onto a lane that has
 * stopped accepting members — a frozen lane. Never freeze and the join intent
 * can be planned mid-loop, consuming a branch pass 2 is about to write to. The
 * run below ends with the loop concluded, both passes landed on the authored
 * lane, the join planned only afterwards, and the lane closed from that moment.
 */

import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowResolvedContext,
  ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { appendPendingJoin, planContextJoin } from "./lane-join";
import { laneClosure, openLoopLanes } from "./lane-lifecycle";
import { applyLiveExecutionEdits } from "./runtime-edits";
import {
  NOW,
  P1_JUDGE,
  P1_WORKER,
  P2_JUDGE,
  P2_WORKER,
  completeContext,
  executionFor,
  makeLiveEditDeps,
  runPass,
  workerJudgeDefinition,
} from "./loop-test-fixtures";

const SEED_LANE = "seed-lane";
const LOOP_LANE = "loop-lane";
const PUBLISH_LANE = "publish-lane";

/**
 * Where each authored context runs. The loop body shares one lane and OWNS its
 * surface rather than claiming full access: a full-access member needs the lane
 * to itself, which would make every mid-loop expansion refusable for a reason
 * that has nothing to do with the lifecycle under test.
 */
const PLACEMENT_BY_AUTHORED_ID: Readonly<
  Record<string, GraphWorkflowResolvedContext["placement"]>
> = {
  seed: { lane: SEED_LANE, mode: "full" },
  worker: { lane: LOOP_LANE, mode: "owned", ownedPaths: ["src/loop"] },
  judge: { lane: LOOP_LANE, mode: "owned", ownedPaths: ["src/loop"] },
  publish: { lane: PUBLISH_LANE, mode: "full" },
};

function place(
  context: GraphWorkflowResolvedContext,
  authoredId: string,
): GraphWorkflowResolvedContext {
  const placement = PLACEMENT_BY_AUTHORED_ID[authoredId];
  return placement === undefined ? context : { ...context, placement };
}

/**
 * `workerJudgeDefinition` places every context on a lane of its own. Re-place
 * the body — template AND the pass-1 instances the resolver already spliced —
 * onto one shared lane, so the loop's openness is a property of a lane two
 * contexts share rather than of two single-member ones.
 */
function crossLaneLoopDefinition(): ResolvedWorkflowSemanticDefinition {
  const definition = workerJudgeDefinition();
  return {
    ...definition,
    executionContexts: definition.executionContexts.map((context) =>
      place(
        context,
        context.id.includes("__p")
          ? (context.id.split("__").at(-1) ?? context.id)
          : context.id,
      ),
    ),
    loopGroups: definition.loopGroups?.map((group) => ({
      ...group,
      template: {
        ...group.template,
        contexts: group.template.contexts.map((context) =>
          place(context, context.id),
        ),
      },
    })),
  };
}

function lane(laneId: string): GraphWorkflowExecutionLaneState {
  return {
    laneId,
    kind: "worktree",
    status: "active",
    worktreePath: `/tmp/${laneId}`,
    branchName: `csm/${laneId}`,
    includedContextIds: [],
    lastCommittingContextId: null,
    commitSnapshots: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The D4 expansion entry point's options: a server-derived additive append. */
function expandOnto(
  execution: GraphWorkflowExecution,
  laneName: string,
  id: string,
) {
  return applyLiveExecutionEdits(
    execution,
    {
      operations: [
        {
          type: "add-context",
          id,
          title: id,
          acceptanceCriteria: `${id} is done`,
          placement: {
            lane: laneName,
            mode: "owned",
            ownedPaths: [`src/${id}`],
          },
        },
      ],
    },
    makeLiveEditDeps(),
    { structuralSource: "lane-agent-expansion" },
  );
}

describe("a cross-lane two-pass loop and the lane lifecycle (lwp R10.1)", () => {
  it("runs both passes on the authored lane, then closes it at the join intent", () => {
    let execution = executionFor(crossLaneLoopDefinition());
    execution = {
      ...execution,
      executionLanes: {
        [SEED_LANE]: lane(SEED_LANE),
        [LOOP_LANE]: lane(LOOP_LANE),
        [PUBLISH_LANE]: lane(PUBLISH_LANE),
      },
    };

    // --- pass 1 -------------------------------------------------------------
    completeContext(execution, "seed", undefined, { laneId: SEED_LANE });
    execution = runPass(execution).execution;
    expect(execution.loopStates["refine"]?.activation).toBe("running");
    expect([...openLoopLanes(execution).all]).toEqual([LOOP_LANE]);

    completeContext(execution, P1_WORKER, undefined, { laneId: LOOP_LANE });
    completeContext(
      execution,
      P1_JUDGE,
      { verdict: "fail", notes: "another round" },
      { laneId: LOOP_LANE },
    );

    // Mid-loop the lane is OPEN: no join has claimed it, so an expansion may
    // still place work there. This is the freeze-too-eagerly failure mode.
    expect(laneClosure(execution, LOOP_LANE)).toBeNull();
    const midLoopExpansion = expandOnto(execution, LOOP_LANE, "context-helper");
    expect(midLoopExpansion.ok).toBe(true);

    // --- pass 2 -------------------------------------------------------------
    const pass2 = runPass(execution);
    execution = pass2.execution;
    expect(pass2.materialized).toHaveLength(1);

    // Pass 2 inherited the template's placement rather than deciding its own,
    // and it landed on the still-open lane rather than a frozen one.
    for (const instanceId of [P2_WORKER, P2_JUDGE]) {
      expect(
        execution.workingDefinition.executionContexts.find(
          (context) => context.id === instanceId,
        )?.placement,
      ).toEqual({ lane: LOOP_LANE, mode: "owned", ownedPaths: ["src/loop"] });
      expect(laneClosure(execution, LOOP_LANE)).toBeNull();
    }

    // --- conclusion ---------------------------------------------------------
    completeContext(execution, P2_WORKER, undefined, { laneId: LOOP_LANE });
    completeContext(
      execution,
      P2_JUDGE,
      { verdict: "pass", notes: "good" },
      { laneId: LOOP_LANE },
    );
    execution = runPass(execution).execution;
    expect(execution.loopStates["refine"]?.activation).toBe("concluded");
    expect(execution.loopStates["refine"]?.concludingExitContextId).toBe(
      P2_JUDGE,
    );
    // The run converged rather than deadlocking on its own freeze.
    expect([...openLoopLanes(execution).all]).toEqual([]);

    // --- the join the conclusion released -----------------------------------
    const concludedPlan = planContextJoin({
      contextId: "publish",
      execution,
      now: () => NOW,
      generateJoinId: () => "join-publish",
    });
    expect(concludedPlan).not.toBeNull();
    expect(concludedPlan!.targetLaneId).toBe(PUBLISH_LANE);
    expect(concludedPlan!.sourceLaneIds).toContain(LOOP_LANE);

    // The control that isolates the loop rule from routing: the SAME graph and
    // the SAME settled routes, with only the activation wound back, plans no
    // join at all. Nothing but loop-openness can account for the difference.
    const stillLooping: GraphWorkflowExecution = {
      ...execution,
      loopStates: {
        ...execution.loopStates,
        refine: { ...execution.loopStates["refine"]!, activation: "running" },
      },
    };
    expect(
      planContextJoin({
        contextId: "publish",
        execution: stillLooping,
        now: () => NOW,
        generateJoinId: () => "join-publish",
      }),
    ).toBeNull();

    // --- membership freezes at that intent ----------------------------------
    const joined = appendPendingJoin(execution, concludedPlan!);
    expect(laneClosure(joined, LOOP_LANE)).toEqual({
      laneId: LOOP_LANE,
      reason: "join_planned",
    });

    const afterFreeze = expandOnto(joined, LOOP_LANE, "context-late");
    expect(afterFreeze.ok).toBe(false);
    if (afterFreeze.ok) return;
    expect(afterFreeze.issues.map((issue) => issue.code)).toContain(
      "lane_closed",
    );

    // The same work targeting a NEW lane is what the refusal points at.
    expect(expandOnto(joined, "follow-up", "context-late").ok).toBe(true);
  });
});
