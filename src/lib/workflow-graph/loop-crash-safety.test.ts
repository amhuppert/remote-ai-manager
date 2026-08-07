/**
 * Loop crash and restart safety (D4 R9.4, decisions D7 and D8).
 *
 * Loop settlement is one fenced transaction that has to survive the process
 * dying at any point: before the exit's work lands, after the commit but before
 * the mutation that records it, after the landing but before the decision, and
 * between the staged unroll and its install. Each of those windows is a
 * separate durable state, and the property is the same in all of them — the
 * resumed engine re-derives to a consistent graph with no duplicate and no
 * missing pass.
 *
 * Every "restart" here is a REAL persistence round trip: the execution is
 * written through the executions repository into SQLite, dropped, and read
 * back, so the slot ledger, the decision records and the landing intents must
 * genuinely be durable for any of this to hold. A JS-object clone would prove
 * nothing about the state a resumed process actually sees.
 *
 * The suites share `loop-test-fixtures.ts` with `loop-settlement.test.ts`, so a
 * crash fixture and a happy-path fixture cannot drift into modelling different
 * engines.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  graphWorkflowExecutionSchema,
  type GraphWorkflowExecution,
  type GraphWorkflowLoopState,
} from "@/lib/workflow-graph/schemas";
import { createApprovalGateService } from "./approval-gate";
import { transitionContextStatus } from "./context-transitions";
import { projectExecutionRoutes } from "./execution-routes";
import { landGatedPublishSettlement } from "./lane-readiness";
import { isResumableHalt } from "./lifecycle-classifier";
import { releaseLoopPassSlotsForContexts } from "./loop-budgets";
import {
  finalizeLoopPassMaterialization,
  prepareLoopPassMaterialization,
  settleLoops,
  type LoopMaterializationRequest,
} from "./loop-settlement";
import { routeVerdict } from "./route-projection";
import {
  collectLandingProbeTargets,
  settleRoutes,
  type LandingBranchEvidence,
} from "./route-runtime";
import {
  ALPHA_P1_JUDGE,
  ALPHA_P1_WORKER,
  ALPHA_P2_JUDGE,
  ALPHA_P2_WORKER,
  BETA_P1_JUDGE,
  BETA_P1_WORKER,
  NOW,
  P1_JUDGE,
  P1_WORKER,
  P2_JUDGE,
  P2_WORKER,
  P3_JUDGE,
  P3_WORKER,
  completeContext,
  executionFor,
  makeLiveEditDeps,
  runPass,
  twoLoopDefinition,
  workerJudgeDefinition,
  type CompleteContextLanding,
} from "./loop-test-fixtures";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
/** A later clock, so a re-used durable reservation is distinguishable by its stamp. */
const RESUMED = "2026-08-04T09:00:00.000Z";
const RESUMED_AGAIN = "2026-08-04T10:00:00.000Z";

const LANE_ID = "lane-refine";
const LANE_WORKTREE = "/worktrees/lane-refine";

describe("loop crash and restart safety (R9.4)", () => {
  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  /**
   * Kill the process: write the execution through the repository, then read it
   * back the way a resumed engine does. Everything the next assertion reads has
   * survived SQLite.
   */
  async function restart(
    execution: GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "loop-crash-safety",
      () => ({ execution, events: [] }),
    );
    const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (!reloaded) throw new Error("no active execution after restart");
    return reloaded;
  }

  function loopState(
    execution: GraphWorkflowExecution,
  ): GraphWorkflowLoopState {
    const state = execution.loopStates["refine"];
    if (!state) throw new Error("loop `refine` has no ledger entry");
    return state;
  }

  function ledgerOf(
    execution: GraphWorkflowExecution,
    loopGroupId = "refine",
  ): Array<[number, string, number, string]> {
    return (execution.loopStates[loopGroupId]?.slotLedger ?? []).map((slot) => [
      slot.pass,
      slot.state,
      slot.grantOrder,
      slot.grantedAt,
    ]);
  }

  /** How many definition entries carry this context id — 1 unless a pass was cloned twice. */
  function contextCopies(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): number {
    return execution.workingDefinition.executionContexts.filter(
      (entry) => entry.id === contextId,
    ).length;
  }

  function incomingEdgeCount(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): number {
    return execution.workingDefinition.edges.filter(
      (entry) => entry.targetContextId === contextId,
    ).length;
  }

  function registerLane(execution: GraphWorkflowExecution): void {
    execution.executionLanes[LANE_ID] = {
      laneId: LANE_ID,
      kind: "worktree",
      status: "active",
      worktreePath: LANE_WORKTREE,
      branchName: "csm/lane-refine",
      includedContextIds: [],
      lastCommittingContextId: null,
      commitSnapshots: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  /**
   * An active loop whose pass-1 exit has produced `verdict` and completed, with
   * its landing intent left however the crash left it.
   */
  function atPassOneExit(
    verdict: "pass" | "fail",
    landing: CompleteContextLanding,
    loopOverrides: Parameters<typeof workerJudgeDefinition>[1] = {},
  ): GraphWorkflowExecution {
    let execution = executionFor(workerJudgeDefinition({}, loopOverrides));
    registerLane(execution);
    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict }, landing);
    return execution;
  }

  const PENDING_LANE_COMMIT: CompleteContextLanding = {
    mode: "lane_commit",
    state: "pending",
    laneId: LANE_ID,
    worktreePath: LANE_WORKTREE,
    baselineSha: "baseline-sha",
  };

  function branchEvidence(
    contextId: string,
    evidence: LandingBranchEvidence,
  ): ReadonlyMap<string, LandingBranchEvidence> {
    return new Map([[contextId, evidence]]);
  }

  // ==========================================================
  // Crash before the exit's work landed
  // ==========================================================

  describe("the pre-landing crash window", () => {
    it("decides nothing and releases nothing while the exit's commit intent is unreconciled", () => {
      // The verdict SATISFIES the predicate — the only thing holding the loop is
      // that the work it would settle on has not been proven to land.
      let execution = atPassOneExit("pass", PENDING_LANE_COMMIT);

      const settled = runPass(execution, { now: RESUMED });
      execution = settled.execution;

      expect(settled.materialized).toEqual([]);
      expect(settled.halt).toBeNull();
      expect(loopState(execution).activation).toBe("running");
      expect(loopState(execution).decisions).toEqual({});
      expect(execution.contextStates[P1_JUDGE]?.landingIntent?.state).toBe(
        "pending",
      );

      // R9.4's other half: downstream of the loop's external edge stays blocked
      // for the whole unconcluded window, and the run cannot publish.
      const projection = projectExecutionRoutes(execution);
      expect(routeVerdict(projection, "publish").kind).toBe("waiting");
      const publish = landGatedPublishSettlement(execution);
      expect(publish.settled).toBe(false);
      expect(publish.outstandingLoopExitContextIds).toEqual(["judge"]);
    });

    it("settles exactly once when a restart reconciles a lane_commit landing off the branch trailer", async () => {
      let execution = await restart(atPassOneExit("pass", PENDING_LANE_COMMIT));

      // The crash landed between the commit and the mutation that records it,
      // so the trailer is on the branch and the intent still reads `pending`.
      // That is precisely what the probe set exists to find.
      const targets = collectLandingProbeTargets(execution);
      expect(targets).toEqual([
        {
          contextId: P1_JUDGE,
          token: `cc-landing:${execution.id}:${P1_JUDGE}:1`,
          worktreePath: LANE_WORKTREE,
          baselineSha: "baseline-sha",
        },
      ]);

      const resumed = runPass(execution, {
        now: RESUMED,
        branchEvidence: branchEvidence(P1_JUDGE, {
          headSha: "head-sha",
          tokenCommitSha: "landing-sha",
          baselineReachable: true,
        }),
      });
      execution = resumed.execution;

      expect(execution.contextStates[P1_JUDGE]?.landingIntent).toMatchObject({
        state: "landed",
        evidence: "commit",
        headSha: "head-sha",
      });
      expect(loopState(execution).activation).toBe("concluded");
      expect(loopState(execution).concludingExitContextId).toBe(P1_JUDGE);
      expect(Object.keys(loopState(execution).decisions)).toEqual(["1"]);
      const decided = loopState(execution).decisions["1"];

      // Nothing left to probe, and a second resumed pass re-derives the same
      // state: the decision record is the done-marker, not the in-memory pass.
      expect(collectLandingProbeTargets(execution)).toEqual([]);
      execution = await restart(execution);
      const again = runPass(execution, { now: RESUMED_AGAIN });
      expect(again.materialized).toEqual([]);
      expect(again.halt).toBeNull();
      expect(loopState(again.execution).decisions["1"]).toEqual(decided);
      expect(contextCopies(again.execution, P2_WORKER)).toBe(0);
    });

    it("reconciles a solo_commit landing from the recorded baseline → head range and unrolls once", async () => {
      // No trailer: the implementer authored the commit itself, so the recorded
      // range is the whole evidence a restart has.
      let execution = await restart(
        atPassOneExit("fail", {
          mode: "solo_commit",
          state: "pending",
          worktreePath: "/worktrees/session",
          baselineSha: "baseline-sha",
        }),
      );

      // A branch whose recorded baseline is NOT an ancestor of head accounts for
      // nothing — a rewritten branch, not this context's work — so the loop must
      // keep waiting rather than settle on a range it cannot verify.
      const unproven = runPass(execution, {
        now: RESUMED,
        branchEvidence: branchEvidence(P1_JUDGE, {
          headSha: "advanced-sha",
          tokenCommitSha: null,
          baselineReachable: false,
        }),
      });
      execution = unproven.execution;
      expect(execution.contextStates[P1_JUDGE]?.landingIntent?.state).toBe(
        "pending",
      );
      expect(unproven.materialized).toEqual([]);
      expect(loopState(execution).decisions).toEqual({});

      const resumed = runPass(execution, {
        now: RESUMED,
        branchEvidence: branchEvidence(P1_JUDGE, {
          headSha: "advanced-sha",
          tokenCommitSha: null,
          baselineReachable: true,
        }),
      });
      execution = resumed.execution;

      expect(execution.contextStates[P1_JUDGE]?.landingIntent).toMatchObject({
        state: "landed",
        evidence: "adopted-head",
      });
      expect(resumed.materialized).toHaveLength(1);
      expect(contextCopies(execution, P2_WORKER)).toBe(1);
      expect(Object.keys(loopState(execution).decisions)).toEqual(["1"]);
    });

    it("reconciles a fan_in_merge landing from the join's own record, with no branch probe", async () => {
      let execution = atPassOneExit("pass", {
        mode: "fan_in_merge",
        state: "pending",
        laneId: LANE_ID,
        joinId: "join-1",
      });
      const lane = execution.executionLanes[LANE_ID];
      if (!lane) throw new Error("missing lane");
      lane.includedContextIds = [P1_JUDGE];
      execution.joins["join-1"] = {
        joinId: "join-1",
        kind: "context_merge",
        contextId: P1_JUDGE,
        targetLaneId: LANE_ID,
        sourceLaneIds: [LANE_ID],
        mergedSourceLaneIds: [],
        validationDebtSourceLaneIds: [],
        status: "running",
        errorMessage: null,
        conflicts: null,
        conflictGuidance: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      };
      execution = await restart(execution);

      // A merge landing needs no git: its evidence is the join record, which is
      // why the probe set deliberately excludes fan-in intents.
      expect(collectLandingProbeTargets(execution)).toEqual([]);

      // The merge has not concluded, so the absence of a failure is not a
      // landing: the loop waits rather than settling on an open merge (R2.5).
      const unmerged = runPass(execution, { now: RESUMED });
      execution = unmerged.execution;
      expect(execution.contextStates[P1_JUDGE]?.landingIntent?.state).toBe(
        "pending",
      );
      expect(loopState(execution).decisions).toEqual({});

      const join = execution.joins["join-1"];
      if (!join) throw new Error("missing join record");
      join.status = "succeeded";
      join.mergedSourceLaneIds = [LANE_ID];
      join.completedAt = RESUMED;
      execution = await restart(execution);

      const resumed = runPass(execution, { now: RESUMED });
      execution = resumed.execution;

      expect(execution.contextStates[P1_JUDGE]?.landingIntent).toMatchObject({
        state: "landed",
        evidence: "join-merge",
        joinId: "join-1",
      });
      expect(loopState(execution).activation).toBe("concluded");
      expect(Object.keys(loopState(execution).decisions)).toEqual(["1"]);
    });
  });

  // ==========================================================
  // Crash after the landing, before the decision
  // ==========================================================

  describe("the landed-but-unsettled crash window", () => {
    it("keeps the loop's downstream blocked until the settlement that concludes it", async () => {
      // The exit has landed with a satisfying verdict; the process died before
      // `settleLoops` ran. Routes settle on resume — and must still hold the
      // external edge, because the LOOP, not the exit instance, is what
      // downstream depends on.
      const execution = await restart(atPassOneExit("pass", {}));

      settleRoutes(execution, { now: RESUMED });
      expect(
        routeVerdict(projectExecutionRoutes(execution), "publish").kind,
      ).toBe("waiting");
      expect(
        landGatedPublishSettlement(execution).outstandingLoopExitContextIds,
      ).toEqual(["judge"]);

      const outcome = settleLoops(execution, { now: RESUMED });
      expect(outcome.concludedLoopGroupIds).toEqual(["refine"]);
      expect(
        routeVerdict(projectExecutionRoutes(execution), "publish").kind,
      ).toBe("eligible");
      // The loop no longer holds the run open; only the downstream work it just
      // released does.
      const publish = landGatedPublishSettlement(execution);
      expect(publish.outstandingLoopExitContextIds).toEqual([]);
      expect(publish.outstandingContextIds).toEqual(["publish"]);
    });

    it("materializes exactly one next pass no matter how often the resumed engine re-derives", async () => {
      let execution = await restart(atPassOneExit("fail", {}));

      const resumed = runPass(execution, { now: RESUMED });
      execution = resumed.execution;
      expect(resumed.materialized).toHaveLength(1);
      expect(ledgerOf(execution)).toEqual([
        [1, "counted", 1, NOW],
        [2, "reserved", 2, RESUMED],
      ]);
      expect(Object.keys(loopState(execution).decisions)).toEqual(["1"]);
      expect(loopState(execution).passCount).toBe(2);

      // Crash again, immediately after the unroll committed.
      execution = await restart(execution);
      const second = runPass(execution, { now: RESUMED_AGAIN });
      execution = second.execution;

      expect(second.materialized).toEqual([]);
      expect(second.halt).toBeNull();
      expect(contextCopies(execution, P2_WORKER)).toBe(1);
      expect(contextCopies(execution, P2_JUDGE)).toBe(1);
      expect(incomingEdgeCount(execution, P2_WORKER)).toBe(1);
      expect(ledgerOf(execution)).toEqual([
        [1, "counted", 1, NOW],
        [2, "reserved", 2, RESUMED],
      ]);
    });
  });

  // ==========================================================
  // Crash around the staged unroll
  // ==========================================================

  describe("the mid-finalize crash window", () => {
    /** A decided-but-uninstalled pass 2: the slot is granted, nothing is cloned. */
    function decidedAtPassOne(): {
      execution: GraphWorkflowExecution;
      request: LoopMaterializationRequest;
    } {
      const execution = atPassOneExit("fail", {});
      settleRoutes(execution, { now: NOW });
      const outcome = settleLoops(execution, { now: NOW });
      const request = outcome.materializations[0];
      if (!request) throw new Error("expected a materialization decision");
      return { execution, request };
    }

    it("declines a staged batch the restarted engine reads as already admitted", async () => {
      const { execution, request } = decidedAtPassOne();
      const prepared = prepareLoopPassMaterialization(
        execution,
        request,
        makeLiveEditDeps(),
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const installed = finalizeLoopPassMaterialization(
        execution,
        prepared.prepared,
        request,
        { now: NOW },
      );
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;

      // The install committed and the process died. The staged batch is replayed
      // against state reloaded from SQLite, so the DURABLE ledger — not any
      // in-memory bookkeeping — is what refuses the second copy.
      const reloaded = await restart(
        graphWorkflowExecutionSchema.parse(installed.execution),
      );
      const replayed = finalizeLoopPassMaterialization(
        reloaded,
        prepared.prepared,
        request,
        { now: RESUMED },
      );

      expect(replayed).toEqual({ ok: false, outcome: "superseded" });
      expect(contextCopies(reloaded, P2_WORKER)).toBe(1);
      expect(incomingEdgeCount(reloaded, P2_WORKER)).toBe(1);
      expect(Object.keys(loopState(reloaded).decisions)).toEqual(["1"]);
    });

    it("re-uses the durable reservation when the crash lost the staged batch", async () => {
      const { execution } = decidedAtPassOne();

      // The reservation outlives the process; the staged batch does not.
      const reloaded = await restart(execution);
      // Pass 1 is already `counted` — a slot is counted when its pass first
      // RUNS (R10), not when the settlement that reads its output commits — so
      // the lost finalize cannot un-count a pass that genuinely happened. Pass
      // 2's grant survives as a reservation because its clone never installed.
      expect(ledgerOf(reloaded)).toEqual([
        [1, "counted", 1, NOW],
        [2, "reserved", 2, NOW],
      ]);
      expect(loopState(reloaded).passCount).toBe(1);
      expect(loopState(reloaded).decisions).toEqual({});

      const resumed = runPass(reloaded, { now: RESUMED });
      expect(resumed.materialized).toHaveLength(1);
      // Same pass, same slot, ORIGINAL grant order and stamp: re-deciding must
      // not consume a second slot for one pass.
      expect(ledgerOf(resumed.execution)).toEqual([
        [1, "counted", 1, NOW],
        [2, "reserved", 2, NOW],
      ]);
      expect(contextCopies(resumed.execution, P2_WORKER)).toBe(1);
      expect(loopState(resumed.execution).decisions["1"]).toMatchObject({
        pass: 1,
        outcome: "materialized",
        decidedAt: RESUMED,
      });
    });

    it("admits one pass when two settlements race the same slot", async () => {
      // Two engine ticks decide the same pass from the same snapshot and stage
      // independently — the over-admission adversary. The ledger arbitrates.
      const { execution, request } = decidedAtPassOne();
      const first = prepareLoopPassMaterialization(
        execution,
        request,
        makeLiveEditDeps(),
      );
      const second = prepareLoopPassMaterialization(
        execution,
        request,
        makeLiveEditDeps(),
      );
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      const installed = finalizeLoopPassMaterialization(
        execution,
        first.prepared,
        request,
        { now: NOW },
      );
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;

      const loser = finalizeLoopPassMaterialization(
        graphWorkflowExecutionSchema.parse(installed.execution),
        second.prepared,
        request,
        { now: RESUMED },
      );
      expect(loser).toEqual({ ok: false, outcome: "superseded" });

      const settled = await restart(
        graphWorkflowExecutionSchema.parse(installed.execution),
      );
      expect(contextCopies(settled, P2_WORKER)).toBe(1);
      expect(contextCopies(settled, P2_JUDGE)).toBe(1);
      const grantOrders = ledgerOf(settled).map(([, , order]) => order);
      expect(new Set(grantOrders).size).toBe(grantOrders.length);
      expect(Object.keys(loopState(settled).decisions)).toEqual(["1"]);
    });
  });

  // ==========================================================
  // Racing the last slot the budget admits
  // ==========================================================

  describe("two settlements racing the final admissible slot", () => {
    it("admits one pass, then halts rather than over-admitting past the budget", async () => {
      // `maxPasses: 2` makes pass 2 the last pass the budget will admit, so a
      // race for ITS slot is the over-admission adversary at the boundary — the
      // one place where a second grant would not merely duplicate work but
      // exceed the bound the halt is supposed to enforce.
      const execution = atPassOneExit("fail", {}, { maxPasses: 2 });
      settleRoutes(execution, { now: NOW });
      const decided = settleLoops(execution, { now: NOW });
      const request = decided.materializations[0];
      if (!request) throw new Error("expected a materialization decision");
      expect(request.nextPass).toBe(2);

      // Two ticks stage the final slot independently from the same snapshot.
      const first = prepareLoopPassMaterialization(
        execution,
        request,
        makeLiveEditDeps(),
      );
      const second = prepareLoopPassMaterialization(
        execution,
        request,
        makeLiveEditDeps(),
      );
      if (!first.ok || !second.ok) throw new Error("staging refused");

      const installed = finalizeLoopPassMaterialization(
        execution,
        first.prepared,
        request,
        { now: NOW },
      );
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;

      let settled = await restart(
        graphWorkflowExecutionSchema.parse(installed.execution),
      );
      expect(
        finalizeLoopPassMaterialization(settled, second.prepared, request, {
          now: RESUMED,
        }),
      ).toEqual({ ok: false, outcome: "superseded" });

      // One copy of the final pass, one slot, one decision — the loser committed
      // nothing.
      expect(contextCopies(settled, P2_WORKER)).toBe(1);
      expect(contextCopies(settled, P2_JUDGE)).toBe(1);
      expect(ledgerOf(settled)).toEqual([
        [1, "counted", 1, NOW],
        [2, "reserved", 2, NOW],
      ]);
      expect(loopState(settled).passCount).toBe(2);

      // The budget is now spent. An unsatisfied final pass halts recoverably and
      // grants nothing further, no matter how often a resumed engine re-derives.
      completeContext(settled, P2_WORKER);
      completeContext(settled, P2_JUDGE, { verdict: "fail" });
      settled = await restart(settled);

      const exhausted = runPass(settled, { now: RESUMED });
      settled = exhausted.execution;
      expect(exhausted.halt).toMatchObject({
        type: "loop_limit_reached",
        loopGroupId: "refine",
        pass: 2,
        maxPasses: 2,
      });
      const halt = exhausted.halt;
      if (!halt) throw new Error("expected a loop_limit_reached halt");
      expect(isResumableHalt(halt)).toBe(true);
      expect(exhausted.materialized).toEqual([]);

      settled = await restart(settled);
      const again = runPass(settled, { now: RESUMED_AGAIN });
      expect(again.materialized).toEqual([]);
      expect(contextCopies(again.execution, P3_WORKER)).toBe(0);
      // Pass 2 RAN before the budget refused a third: an exhaustion halt still
      // owes R10's started-pass accounting, so the final pass is `counted`.
      expect(ledgerOf(again.execution)).toEqual([
        [1, "counted", 1, NOW],
        [2, "counted", 2, NOW],
      ]);
    });
  });

  // ==========================================================
  // Slot arbitration replays from the ledger (decision D7)
  // ==========================================================

  describe("restart replays slot arbitration", () => {
    /**
     * Drive two loops to the pass where alpha unrolls and beta activates in the
     * SAME scheduling pass, optionally crossing a persistence boundary at every
     * step. Cross-loop arbitration is the property under test, so both runs must
     * see identical grant orders.
     */
    async function driveTwoLoops(
      crash: boolean,
    ): Promise<GraphWorkflowExecution> {
      const through = async (
        execution: GraphWorkflowExecution,
      ): Promise<GraphWorkflowExecution> =>
        crash ? await restart(execution) : execution;

      let execution = executionFor(twoLoopDefinition());
      completeContext(execution, "seed");
      execution = await through(runPass(execution).execution);

      completeContext(execution, ALPHA_P1_WORKER);
      completeContext(execution, ALPHA_P1_JUDGE, { verdict: "fail" });
      completeContext(execution, "gate");
      execution = await through(runPass(execution).execution);
      return execution;
    }

    it("replays identical grant orders when every pass crosses a persistence boundary", async () => {
      const uninterrupted = await driveTwoLoops(false);
      const crashed = await driveTwoLoops(true);

      expect(crashed.loopStates).toEqual(uninterrupted.loopStates);
      expect(ledgerOf(crashed, "alpha")).toEqual([
        [1, "counted", 1, NOW],
        [2, "reserved", 2, NOW],
      ]);
      expect(ledgerOf(crashed, "beta")).toEqual([[1, "reserved", 3, NOW]]);
    });

    it("continues the grant order from the durable ledger rather than a live counter", async () => {
      let execution = await restart(await driveTwoLoops(true));

      // A resumed engine that re-settled from a counter would hand beta's pass 2
      // an order already spent by alpha.
      completeContext(execution, ALPHA_P2_WORKER);
      completeContext(execution, ALPHA_P2_JUDGE, { verdict: "pass" });
      completeContext(execution, BETA_P1_WORKER);
      completeContext(execution, BETA_P1_JUDGE, { verdict: "fail" });
      execution = runPass(execution, { now: RESUMED }).execution;

      expect(ledgerOf(execution, "alpha")).toEqual([
        [1, "counted", 1, NOW],
        [2, "counted", 2, NOW],
      ]);
      expect(ledgerOf(execution, "beta")).toEqual([
        [1, "counted", 3, NOW],
        [2, "reserved", 4, RESUMED],
      ]);
      expect(execution.loopStates["alpha"]?.activation).toBe("concluded");
    });
  });

  // ==========================================================
  // Approval-gated exits
  // ==========================================================

  describe("an approval-gated exit", () => {
    it("settles only after approval, completion and landing — in that order", async () => {
      const approvals = createApprovalGateService({
        mutateActive: async (projectPath, sessionName, mutate) => {
          const { execution } =
            await fixture.store.mutateActiveGraphWorkflowExecution(
              projectPath,
              sessionName,
              "approval",
              (current) => {
                if (!current) throw new Error("no active execution");
                return { execution: mutate(current), events: [] };
              },
            );
          return execution;
        },
        now: () => RESUMED,
      });

      let execution = executionFor(workerJudgeDefinition());
      completeContext(execution, "seed");
      execution = runPass(execution).execution;
      completeContext(execution, P1_WORKER);

      // The exit produced its verdict and parked for a human. Its output is
      // already banked, which is exactly the trap: a settlement that read the
      // capture without the status would conclude the loop on unapproved work.
      execution.contextOutputs[P1_JUDGE] = {
        value: { verdict: "pass" },
        iteration: 1,
        capturedAt: NOW,
        parse: { source: "native" },
      };
      transitionContextStatus(execution, P1_JUDGE, "running", {
        reason: "test.dispatch",
      });
      approvals.enterAwaitingApproval(execution, {
        contextId: P1_JUDGE,
        conversationId: "conversation-1",
      });
      execution = await restart(execution);

      expect(execution.contextStates[P1_JUDGE]?.status).toBe(
        "awaiting_approval",
      );
      let outcome = runPass(execution, { now: RESUMED });
      execution = outcome.execution;
      expect(outcome.halt).toBeNull();
      expect(loopState(execution).decisions).toEqual({});

      // Approved, but not yet completed: the gate cleared, the work did not.
      const recorded = await approvals.recordDecision({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        contextId: P1_JUDGE,
        decision: { type: "approved" },
      });
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;
      execution = recorded.execution;
      approvals.applyApprovedDecision(execution, P1_JUDGE);
      outcome = runPass(execution, { now: RESUMED });
      execution = outcome.execution;
      expect(loopState(execution).decisions).toEqual({});

      // Completed, but the landing intent is still pending.
      completeContext(execution, P1_JUDGE, undefined, {
        mode: "lane_commit",
        state: "pending",
        worktreePath: LANE_WORKTREE,
        baselineSha: "baseline-sha",
      });
      execution = await restart(execution);
      outcome = runPass(execution, { now: RESUMED });
      execution = outcome.execution;
      expect(loopState(execution).decisions).toEqual({});
      expect(loopState(execution).activation).toBe("running");

      // Landed: now — and only now — the loop settles, exactly once.
      outcome = runPass(execution, {
        now: RESUMED_AGAIN,
        branchEvidence: branchEvidence(P1_JUDGE, {
          headSha: "head-sha",
          tokenCommitSha: "landing-sha",
          baselineReachable: true,
        }),
      });
      execution = outcome.execution;
      expect(loopState(execution).activation).toBe("concluded");
      expect(Object.keys(loopState(execution).decisions)).toEqual(["1"]);
      expect(loopState(execution).decisions["1"]).toMatchObject({
        verdict: "satisfied",
        outcome: "concluded",
        exitCaptureIteration: 1,
      });
    });
  });

  // ==========================================================
  // Cap-only repair, re-decided on resume
  // ==========================================================

  describe("a cap-only repair", () => {
    /** Two passes burned against `maxPasses: 2`, both unsatisfied — the halt state. */
    function atExhaustedBudget(): GraphWorkflowExecution {
      let execution = atPassOneExit("fail", {}, { maxPasses: 2 });
      execution = runPass(execution).execution;
      completeContext(execution, P2_WORKER);
      completeContext(execution, P2_JUDGE, { verdict: "fail", notes: "again" });
      return execution;
    }

    it("re-decides the final pass's banked output under a raised cap and a bumped control revision", async () => {
      let execution = atExhaustedBudget();

      const exhausted = runPass(execution, { now: RESUMED });
      execution = exhausted.execution;
      expect(exhausted.halt).toMatchObject({
        type: "loop_limit_reached",
        loopGroupId: "refine",
        pass: 2,
        maxPasses: 2,
      });
      const halt = exhausted.halt;
      if (!halt) throw new Error("expected a loop_limit_reached halt");
      expect(isResumableHalt(halt)).toBe(true);
      // A halt records nothing: it is re-derived on every pass, which is what
      // lets an amended cap take effect on resume with no unwind path.
      expect(Object.keys(loopState(execution).decisions)).toEqual(["1"]);
      expect(contextCopies(execution, P3_WORKER)).toBe(0);

      // The repair, as durable state: a raised cap and a bumped control
      // revision, nothing else. (T15 owns the repair op that writes it.)
      const repaired = graphWorkflowExecutionSchema.parse(execution);
      const group = repaired.workingDefinition.loopGroups?.[0];
      if (!group) throw new Error("missing loop group");
      group.maxPasses = 4;
      const state = repaired.loopStates["refine"];
      if (!state) throw new Error("missing loop state");
      state.loopControlRevision += 1;
      execution = await restart(repaired);

      const resumed = runPass(execution, { now: RESUMED_AGAIN });
      execution = resumed.execution;

      // The resume re-decides the FINAL pass — pass 2's banked capture — under
      // the new revision, and unrolls pass 3 from it.
      expect(resumed.materialized).toHaveLength(1);
      expect(loopState(execution).decisions["2"]).toMatchObject({
        pass: 2,
        loopControlRevision: 1,
        exitContextId: P2_JUDGE,
        exitCaptureIteration: 1,
        verdict: "unsatisfied",
        outcome: "materialized",
        nextPass: 3,
      });
      // Completed passes keep the verdicts they ran under, and nothing re-runs.
      expect(loopState(execution).decisions["1"]).toMatchObject({
        pass: 1,
        loopControlRevision: 0,
      });
      expect(execution.contextStates[P2_JUDGE]?.status).toBe("completed");
      expect(execution.contextStates[P2_JUDGE]?.iterationCount).toBe(0);
      expect(execution.contextOutputs[P2_JUDGE]).toMatchObject({
        value: { verdict: "fail", notes: "again" },
        iteration: 1,
      });
      expect(contextCopies(execution, P3_WORKER)).toBe(1);
      expect(contextCopies(execution, P3_JUDGE)).toBe(1);
    });

    it("re-halts on resume when the repair amended nothing the budget depends on", async () => {
      // Resuming a `loop_limit_reached` halt without a repair must reach the
      // same halt, not unroll a pass the cap forbids (R12.2).
      const execution = await restart(atExhaustedBudget());
      const resumed = runPass(execution, { now: RESUMED });

      expect(resumed.halt).toMatchObject({
        type: "loop_limit_reached",
        pass: 2,
      });
      expect(resumed.materialized).toEqual([]);
      expect(contextCopies(resumed.execution, P3_WORKER)).toBe(0);
    });

    it("holds the whole decision key: an unchanged key idles, a bumped revision re-decides", async () => {
      // The ledger rebuilt behind an already-decided pass — the replay window
      // `finalizeLoopPassMaterialization`'s idempotent re-grant exists for. The
      // decision record, not the graph, is what must refuse the second unroll.
      const settled = runPass(atPassOneExit("fail", {}), {
        now: NOW,
      }).execution;
      const replayed = graphWorkflowExecutionSchema.parse(settled);
      const state = replayed.loopStates["refine"];
      if (!state) throw new Error("missing loop state");
      state.passCount = 1;
      const execution = await restart(replayed);

      expect(settleLoops(execution, { now: RESUMED }).materializations).toEqual(
        [],
      );

      // Bump one component of the key and the same durable state re-decides —
      // which is what makes an audited amendment take effect on resume.
      const bumped = await restart(
        graphWorkflowExecutionSchema.parse(execution),
      );
      const bumpedState = bumped.loopStates["refine"];
      if (!bumpedState) throw new Error("missing loop state");
      bumpedState.loopControlRevision += 1;
      const outcome = settleLoops(bumped, { now: RESUMED });
      expect(outcome.materializations).toEqual([
        {
          loopGroupId: "refine",
          pass: 1,
          nextPass: 2,
          loopControlRevision: 1,
          templateVersion: 1,
          exitContextId: P1_JUDGE,
          exitCaptureIteration: 1,
        },
      ]);
    });
  });

  // ==========================================================
  // A provisioning failure on a materialized pass
  // ==========================================================

  describe("a provisioning failure on a materialized pass", () => {
    it("releases the slot durably and re-reserves it on the retry", async () => {
      // Pass 2 was cloned, then its lane failed to provision: the scheduler
      // compensates (the lanes disposed, the reservation stamp cleared, the pass
      // slot given back) and the run halts recoverably with the pass instances
      // never started. Decision D7 makes the RELEASE the durable half — a
      // reservation the failed batch kept would charge the shared backstop for a
      // pass no lane exists for.
      let execution = runPass(atPassOneExit("fail", {}), {
        now: NOW,
      }).execution;
      const worker = execution.contextStates[P2_WORKER];
      if (!worker) throw new Error("missing pass-2 worker state");
      worker.reservedByBatchId = null;
      expect(worker.status).toBe("pending");
      expect(
        releaseLoopPassSlotsForContexts(execution, [P2_WORKER, P2_JUDGE]),
      ).toEqual([{ loopGroupId: "refine", pass: 2 }]);

      execution = await restart(execution);
      expect(ledgerOf(execution)).toEqual([
        [1, "counted", 1, NOW],
        [2, "released", 2, NOW],
      ]);

      const resumed = runPass(execution, { now: RESUMED });
      execution = resumed.execution;

      // The retry re-provisions the SAME pass; nothing re-clones it, and the
      // slot is re-admitted through the ordered walk under a fresh grant order.
      expect(resumed.materialized).toEqual([]);
      expect(resumed.halt).toBeNull();
      expect(contextCopies(execution, P2_WORKER)).toBe(1);
      expect(ledgerOf(execution)).toEqual([
        [1, "counted", 1, NOW],
        [2, "reserved", 3, RESUMED],
      ]);
      expect(loopState(execution).passCount).toBe(2);

      // And once provisioning succeeds, the loop settles the pass normally.
      completeContext(execution, P2_WORKER);
      completeContext(execution, P2_JUDGE, { verdict: "pass" });
      execution = await restart(execution);
      execution = runPass(execution, { now: RESUMED_AGAIN }).execution;

      expect(loopState(execution).activation).toBe("concluded");
      expect(loopState(execution).concludingExitContextId).toBe(P2_JUDGE);
      expect(Object.keys(loopState(execution).decisions)).toEqual(["1", "2"]);
      expect(ledgerOf(execution)).toEqual([
        [1, "counted", 1, NOW],
        [2, "counted", 3, RESUMED],
      ]);
    });
  });
});
