/**
 * Loop budgets, exhaustion halts, the execution backstop, and the per-pass gates
 * (D4 R10).
 *
 * Three budgets meet here and they are deliberately different in kind:
 *
 *  - a loop's mandatory `maxPasses`, which bounds ONE loop and which an audited
 *    repair may raise;
 *  - the per-execution 25-pass backstop, which bounds EVERY loop together and
 *    which nothing may raise;
 *  - the ordinary per-context iteration and consecutive-failure budgets, which
 *    a pass instance gets fresh because it is a fresh context — and which a
 *    false exit verdict must never touch, because a false verdict is control
 *    flow, not a failure.
 *
 * The suite shares `loop-test-fixtures.ts` with `loop-settlement.test.ts` and
 * `loop-crash-safety.test.ts`, so budget behaviour is proven against the same
 * engine the happy path and the crash windows model.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  graphWorkflowExecutionSchema,
  type GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import { validatePlanRepairOperations } from "@/lib/workflow-graph/plan-repair/schemas";
import { workflowLiveEditOperationSchema } from "@/lib/workflows/edit-schemas";
import { runCircuitBreakerGate } from "@/lib/workflows/primitives/circuit-breaker-gate";
import { createApprovalGateService } from "./approval-gate";
import { transitionContextStatus } from "./context-transitions";
import { isResumableHalt } from "./lifecycle-classifier";
import {
  EXECUTION_TOTAL_PASS_BACKSTOP,
  resolveConsecutiveFailureThreshold,
} from "./constants";
import {
  livePassSlotCount,
  releaseLoopPassSlotsForContexts,
  remainingPassSlots,
} from "./loop-budgets";
import { settleLoops } from "./loop-settlement";
import { settleRoutes } from "./route-runtime";
import { validateWorkflowDefinition } from "./validation";
import {
  JUDGE_OUTPUT_SCHEMA,
  NOW,
  P1_JUDGE,
  P1_WORKER,
  P2_JUDGE,
  P2_WORKER,
  P3_JUDGE,
  P3_WORKER,
  completeContext,
  context,
  executionFor,
  runPass,
  tightInstanceId,
  tightTwoLoopDefinition,
  workerJudgeDefinition,
} from "./loop-test-fixtures";
import {
  createWorkflowDefinition,
  makeValidatorAssignment,
} from "./test-fixtures";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
const RESUMED = "2026-08-04T09:00:00.000Z";
const RESUMED_AGAIN = "2026-08-04T10:00:00.000Z";

describe("loop budgets (R10)", () => {
  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  /** A real persistence round trip — the resume every "survives" claim rests on. */
  async function restart(
    execution: GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "loop-budgets",
      () => ({ execution, events: [] }),
    );
    const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (!reloaded) throw new Error("no active execution after restart");
    return reloaded;
  }

  /** The durable slot ledger as `[pass, state, grantOrder]` rows. */
  function ledger(
    execution: GraphWorkflowExecution,
    loopGroupId = "refine",
  ): Array<[number, string, number]> {
    return (execution.loopStates[loopGroupId]?.slotLedger ?? []).map((slot) => [
      slot.pass,
      slot.state,
      slot.grantOrder,
    ]);
  }

  /** Two unsatisfied passes against `maxPasses: 2` — the exhaustion state. */
  function atExhaustedLoopBudget(): GraphWorkflowExecution {
    let execution = executionFor(workerJudgeDefinition({}, { maxPasses: 2 }));
    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });
    execution = runPass(execution).execution;
    completeContext(execution, P2_WORKER);
    completeContext(execution, P2_JUDGE, {
      verdict: "fail",
      notes: "still no",
    });
    return execution;
  }

  // ==========================================================
  // R10.1 — exhaustion halts, and the pass count survives resume
  // ==========================================================

  describe("pass exhaustion (R10.1)", () => {
    it("halts resumable with scope loop, the final verdict and the pass count", () => {
      const outcome = runPass(atExhaustedLoopBudget(), { now: RESUMED });

      expect(outcome.halt).toMatchObject({
        type: "loop_limit_reached",
        scope: "loop",
        loopGroupId: "refine",
        pass: 2,
        maxPasses: 2,
        verdict: "unsatisfied",
        passCount: 2,
        contextId: P2_JUDGE,
      });
      const halt = outcome.halt;
      if (!halt) throw new Error("expected a loop_limit_reached halt");
      expect(isResumableHalt(halt)).toBe(true);
      // There is no completion-on-exhaustion mode (locked Q15): nothing settles.
      expect(outcome.execution.loopStates["refine"]?.activation).toBe(
        "running",
      );
      expect(outcome.materialized).toEqual([]);
    });

    it("counts the started final pass rather than leaving it reserved", () => {
      // R10 counts every STARTED pass, and the halt is what an operator reads
      // the count from. A halt that returned before the ledger was reconciled
      // would leave the pass that genuinely ran sitting in `reserved` — a slot
      // the release path would later be entitled to give back, double-spending
      // the shared budget for work that already happened.
      const outcome = runPass(atExhaustedLoopBudget(), { now: RESUMED });

      expect(outcome.halt).toMatchObject({ type: "loop_limit_reached" });
      expect(ledger(outcome.execution)).toEqual([
        [1, "counted", 1],
        [2, "counted", 2],
      ]);
      expect(livePassSlotCount(outcome.execution)).toBe(2);
      expect(outcome.halt).toMatchObject({ totalPassCount: 2, passCount: 2 });
    });

    it("does not reset the pass count across a resume", async () => {
      const halted = runPass(atExhaustedLoopBudget(), { now: RESUMED });
      expect(halted.halt).not.toBeNull();
      expect(halted.execution.loopStates["refine"]?.passCount).toBe(2);

      const resumed = await restart(halted.execution);
      expect(resumed.loopStates["refine"]?.passCount).toBe(2);

      // Re-deriving the halt on the resumed state reports the same count — a
      // pass count rebuilt from a live counter would restart at zero and let the
      // budget spend itself twice.
      const again = runPass(resumed, { now: RESUMED_AGAIN });
      expect(again.halt).toMatchObject({
        type: "loop_limit_reached",
        scope: "loop",
        pass: 2,
        passCount: 2,
        verdict: "unsatisfied",
      });
      expect(again.execution.loopStates["refine"]?.passCount).toBe(2);
      expect(
        again.execution.workingDefinition.executionContexts.filter(
          (entry) => entry.id === P3_WORKER,
        ),
      ).toEqual([]);
    });
  });

  // ==========================================================
  // R10.2 — per-pass budget resets, and false verdicts are control flow
  // ==========================================================

  describe("per-pass budgets (R10.2)", () => {
    it("gives every pass a fresh iteration and consecutive-failure budget", () => {
      let execution = executionFor(workerJudgeDefinition());
      completeContext(execution, "seed");
      execution = runPass(execution).execution;

      // Pass 1's worker burned nearly its whole budget: one more failure trips
      // the breaker, one more iteration hits the cap.
      const first = execution.contextStates[P1_WORKER];
      if (!first) throw new Error("missing pass-1 worker state");
      const definition = execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === P1_WORKER,
      );
      if (!definition) throw new Error("missing pass-1 worker definition");
      const threshold = resolveConsecutiveFailureThreshold(
        definition.circuitBreaker,
      );
      first.consecutiveFailureCount = threshold - 1;
      first.iterationCount = definition.iterationPolicy.maxIterations - 1;

      completeContext(execution, P1_WORKER);
      completeContext(execution, P1_JUDGE, { verdict: "fail" });
      execution = runPass(execution).execution;

      const second = execution.contextStates[P2_WORKER];
      expect(second?.iterationCount).toBe(0);
      expect(second?.consecutiveFailureCount).toBe(0);
      expect(
        runCircuitBreakerGate({
          failureCount: second?.consecutiveFailureCount ?? 0,
          threshold,
        }).status,
      ).toBe("pass");

      // The budget itself is cloned unchanged — a reset budget is only a reset
      // if the next pass gets the same allowance.
      const clone = execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === P2_WORKER,
      );
      expect(clone?.iterationPolicy).toEqual(definition.iterationPolicy);
      expect(clone?.circuitBreaker).toEqual(definition.circuitBreaker);
    });

    it("never increments a failure counter or trips the breaker across a mixed pass/fail sequence", () => {
      let execution = executionFor(workerJudgeDefinition());
      completeContext(execution, "seed");
      execution = runPass(execution).execution;

      const verdicts: Array<{
        worker: string;
        judge: string;
        verdict: "pass" | "fail";
      }> = [
        { worker: P1_WORKER, judge: P1_JUDGE, verdict: "fail" },
        { worker: P2_WORKER, judge: P2_JUDGE, verdict: "fail" },
        { worker: P3_WORKER, judge: P3_JUDGE, verdict: "pass" },
      ];

      const judgeThreshold = 3;
      for (const step of verdicts) {
        // A REAL failure inside the pass, so the counters under test are not
        // trivially zero everywhere: the worker genuinely failed twice and
        // recovered. The loop's verdict must still contribute nothing.
        const worker = execution.contextStates[step.worker];
        if (!worker) throw new Error(`missing ${step.worker}`);
        worker.consecutiveFailureCount = 2;
        completeContext(execution, step.worker);
        worker.consecutiveFailureCount = 0;

        completeContext(execution, step.judge, { verdict: step.verdict });
        const outcome = runPass(execution);
        execution = outcome.execution;
        expect(outcome.halt).toBeNull();
      }

      const state = execution.loopStates["refine"];
      expect(state?.activation).toBe("concluded");
      expect(state?.concludingExitContextId).toBe(P3_JUDGE);

      // Two false verdicts and one satisfying one: no exit instance carries a
      // failure, and the breaker passes for every one of them.
      for (const step of verdicts) {
        const judge = execution.contextStates[step.judge];
        expect(judge?.consecutiveFailureCount).toBe(0);
        expect(
          runCircuitBreakerGate({
            failureCount: judge?.consecutiveFailureCount ?? 0,
            threshold: judgeThreshold,
          }).status,
        ).toBe("pass");
      }
      expect(
        Object.values(state?.decisions ?? {}).map((d) => d.verdict),
      ).toEqual(["unsatisfied", "unsatisfied", "satisfied"]);
    });
  });

  // ==========================================================
  // R10.3 — the per-execution backstop
  // ==========================================================

  describe("the execution pass backstop (R10.3)", () => {
    it("is the constant R10 names", () => {
      expect(EXECUTION_TOTAL_PASS_BACKSTOP).toBe(25);
    });

    /**
     * Drive two tight loops until the shared backstop refuses a pass. `beta`
     * concludes early and keeps its slots; `alpha` then runs alone against a
     * budget the two of them share.
     */
    function driveToBackstop(betaConcludesAtPass: number): {
      execution: GraphWorkflowExecution;
      halt: ReturnType<typeof runPass>["halt"];
    } {
      let execution = executionFor(
        tightTwoLoopDefinition(EXECUTION_TOTAL_PASS_BACKSTOP),
      );
      completeContext(execution, "seed");
      execution = runPass(execution).execution;

      for (let pass = 1; pass <= EXECUTION_TOTAL_PASS_BACKSTOP * 2; pass += 1) {
        const alphaId = tightInstanceId("alpha", pass);
        if (execution.contextStates[alphaId]?.status === "pending") {
          completeContext(execution, alphaId, { verdict: "fail" });
        }
        const betaId = tightInstanceId("beta", pass);
        if (execution.contextStates[betaId]?.status === "pending") {
          completeContext(execution, betaId, {
            verdict: pass === betaConcludesAtPass ? "pass" : "fail",
          });
        }
        const outcome = runPass(execution);
        execution = outcome.execution;
        if (outcome.halt) return { execution, halt: outcome.halt };
      }
      throw new Error("expected the execution backstop to halt the run");
    }

    it("halts scope execution with a runaway loop still inside its own maxPasses", () => {
      const { execution, halt } = driveToBackstop(3);

      expect(halt).toMatchObject({
        type: "loop_limit_reached",
        scope: "execution",
        loopGroupId: "alpha",
        verdict: "unsatisfied",
        totalPassCount: EXECUTION_TOTAL_PASS_BACKSTOP,
      });
      if (!halt) throw new Error("expected a loop_limit_reached halt");
      expect(isResumableHalt(halt)).toBe(true);

      // Independence from the per-loop cap: alpha halted well inside its own
      // allowance, because the OTHER loop had already spent part of the budget
      // the two of them share.
      const alpha = execution.loopStates["alpha"];
      const beta = execution.loopStates["beta"];
      expect(alpha?.passCount).toBeLessThan(EXECUTION_TOTAL_PASS_BACKSTOP);
      expect(beta?.activation).toBe("concluded");
      expect(beta?.passCount).toBe(3);
      expect((alpha?.passCount ?? 0) + (beta?.passCount ?? 0)).toBe(
        EXECUTION_TOTAL_PASS_BACKSTOP,
      );
      expect(livePassSlotCount(execution)).toBe(EXECUTION_TOTAL_PASS_BACKSTOP);
    });

    it("re-halts on resume and admits nothing further — the backstop is a constant", async () => {
      const { execution, halt } = driveToBackstop(3);
      if (!halt) throw new Error("expected a halt");
      const contextCount = execution.workingDefinition.executionContexts.length;

      const resumed = await restart(execution);
      const again = runPass(resumed, { now: RESUMED });

      expect(again.halt).toMatchObject({
        type: "loop_limit_reached",
        scope: "execution",
        loopGroupId: "alpha",
        totalPassCount: EXECUTION_TOTAL_PASS_BACKSTOP,
      });
      expect(again.materialized).toEqual([]);
      expect(again.execution.workingDefinition.executionContexts).toHaveLength(
        contextCount,
      );
      expect(livePassSlotCount(again.execution)).toBe(
        EXECUTION_TOTAL_PASS_BACKSTOP,
      );
    });

    /**
     * Both tight loops in lockstep until they want a pass each in the SAME
     * scheduling pass with exactly ONE slot left — the arbitration boundary.
     */
    function atLastSlotCollision(): ReturnType<typeof runPass> {
      let execution = executionFor(tightTwoLoopDefinition());
      completeContext(execution, "seed");
      // Both loops activate here, spending the first two slots together.
      execution = runPass(execution).execution;

      for (let pass = 1; pass <= EXECUTION_TOTAL_PASS_BACKSTOP; pass += 1) {
        completeContext(execution, tightInstanceId("alpha", pass), {
          verdict: "fail",
        });
        completeContext(execution, tightInstanceId("beta", pass), {
          verdict: "fail",
        });
        const outcome = runPass(execution);
        execution = outcome.execution;
        if (outcome.halt) return outcome;
      }
      throw new Error("expected the execution backstop to halt the run");
    }

    it("admits the 25th pass and halts only the loop the budget cannot reach", () => {
      // Two loops colliding on the last slot is the boundary case: definition
      // order decides who gets it, and the grant is DURABLE. Abandoning the
      // admitted grant with the refused one would halt the execution one pass
      // BELOW the backstop, so the constant R10.3 names would bound 24 passes.
      const outcome = atLastSlotCollision();
      const { execution } = outcome;

      expect(outcome.halt).toMatchObject({
        type: "loop_limit_reached",
        scope: "execution",
        // `beta` is declared second, so it is the one the walk cannot reach.
        loopGroupId: "beta",
        pass: 12,
        verdict: "unsatisfied",
        contextId: tightInstanceId("beta", 12),
        totalPassCount: EXECUTION_TOTAL_PASS_BACKSTOP,
      });
      const halt = outcome.halt;
      if (!halt) throw new Error("expected a loop_limit_reached halt");
      expect(isResumableHalt(halt)).toBe(true);

      // The 25th pass is REAL: admitted, cloned, and waiting to run.
      expect(livePassSlotCount(execution)).toBe(EXECUTION_TOTAL_PASS_BACKSTOP);
      expect(execution.loopStates["alpha"]?.passCount).toBe(13);
      expect(execution.loopStates["beta"]?.passCount).toBe(12);
      expect(
        execution.contextStates[tightInstanceId("alpha", 13)]?.status,
      ).toBe("pending");
      expect(
        execution.contextStates[tightInstanceId("beta", 13)],
      ).toBeUndefined();
      expect(outcome.materialized).toEqual([
        expect.objectContaining({ loopGroupId: "alpha", nextPass: 13 }),
      ]);
      // Every pass that RAN is counted on the halt path too: only the pass just
      // admitted is still a reservation.
      expect(ledger(execution, "beta").map(([, state]) => state)).toEqual(
        Array.from({ length: 12 }, () => "counted"),
      );
      expect(ledger(execution, "alpha")[12]).toEqual([13, "reserved", 25]);
    });

    it("charges a re-admitted slot against the same ceiling", () => {
      // A retry after a released grant is a REQUEST, not a right. At the ceiling
      // the freed slot is arbitrated in definition order like any other, so a
      // batch that failed can never buy an execution a 26th pass.
      const collided = atLastSlotCollision();
      let execution = collided.execution;
      expect(
        releaseLoopPassSlotsForContexts(execution, [
          tightInstanceId("alpha", 13),
        ]),
      ).toEqual([{ loopGroupId: "alpha", pass: 13 }]);
      expect(livePassSlotCount(execution)).toBe(
        EXECUTION_TOTAL_PASS_BACKSTOP - 1,
      );

      const again = runPass(execution, { now: RESUMED });
      execution = again.execution;

      // The freed slot goes back to alpha's existing pass 13 — alpha is declared
      // first — under a fresh grant order, and beta is refused exactly as before.
      expect(ledger(execution, "alpha")[12]).toEqual([13, "reserved", 26]);
      expect(again.halt).toMatchObject({
        type: "loop_limit_reached",
        scope: "execution",
        loopGroupId: "beta",
        totalPassCount: EXECUTION_TOTAL_PASS_BACKSTOP,
      });
      expect(livePassSlotCount(execution)).toBe(EXECUTION_TOTAL_PASS_BACKSTOP);
      expect(
        execution.contextStates[tightInstanceId("beta", 13)],
      ).toBeUndefined();
    });

    it("re-derives the same refusal on resume and admits nothing further", async () => {
      const collided = atLastSlotCollision();
      const contextCount =
        collided.execution.workingDefinition.executionContexts.length;

      const resumed = await restart(collided.execution);
      const again = runPass(resumed, { now: RESUMED });

      expect(again.halt).toMatchObject({
        type: "loop_limit_reached",
        scope: "execution",
        loopGroupId: "beta",
        totalPassCount: EXECUTION_TOTAL_PASS_BACKSTOP,
      });
      expect(again.materialized).toEqual([]);
      expect(again.execution.workingDefinition.executionContexts).toHaveLength(
        contextCount,
      );
      expect(livePassSlotCount(again.execution)).toBe(
        EXECUTION_TOTAL_PASS_BACKSTOP,
      );
    });

    it("gives a never-formed batch's slot back and re-admits it on the retry", () => {
      // Decision D7: a provisioning failure RELEASES the reservation durably and
      // the resume re-reserves it. Keeping it would charge the shared backstop
      // for a pass no lane exists for, and released slots are reusable — which
      // is only true if the release actually happens.
      let execution = executionFor(workerJudgeDefinition());
      completeContext(execution, "seed");
      execution = runPass(execution).execution;
      completeContext(execution, P1_WORKER);
      completeContext(execution, P1_JUDGE, { verdict: "fail" });
      execution = runPass(execution).execution;
      expect(livePassSlotCount(execution)).toBe(2);

      // The scheduler's compensation for a batch that never formed.
      expect(
        releaseLoopPassSlotsForContexts(execution, [P2_WORKER, P2_JUDGE]),
      ).toEqual([{ loopGroupId: "refine", pass: 2 }]);
      expect(ledger(execution)).toEqual([
        [1, "counted", 1],
        [2, "released", 2],
      ]);
      expect(livePassSlotCount(execution)).toBe(1);
      expect(remainingPassSlots(execution)).toBe(
        EXECUTION_TOTAL_PASS_BACKSTOP - 1,
      );

      // The retry is re-admitted through the SAME ordered walk, under a fresh
      // grant order: it was arbitrated against the budget as it stands now.
      const retried = runPass(execution, { now: RESUMED });
      execution = retried.execution;
      expect(retried.halt).toBeNull();
      expect(retried.materialized).toEqual([]);
      expect(ledger(execution)).toEqual([
        [1, "counted", 1],
        [2, "reserved", 3],
      ]);
      expect(livePassSlotCount(execution)).toBe(2);
      expect(execution.loopStates["refine"]?.passCount).toBe(2);

      // A pass that has already STARTED keeps its slot: the batch that failed is
      // never the one that ran it.
      completeContext(execution, P2_WORKER);
      execution = runPass(execution, { now: RESUMED_AGAIN }).execution;
      expect(releaseLoopPassSlotsForContexts(execution, [P2_JUDGE])).toEqual(
        [],
      );
      expect(ledger(execution)).toEqual([
        [1, "counted", 1],
        [2, "counted", 3],
      ]);
    });

    it("releases the reservation of an unroll that will never install, returning its slot", () => {
      // The slot is admitted BEFORE the clone, so a decided-but-never-installed
      // unroll leaves a durable reservation behind. If the loop then settles
      // some other way — here an audited predicate amendment makes the banked
      // verdict satisfying — that reservation admits a pass that will never
      // exist, and a budget that kept charging for it would starve later loops.
      let execution = executionFor(workerJudgeDefinition());
      completeContext(execution, "seed");
      execution = runPass(execution).execution;
      completeContext(execution, P1_WORKER);
      completeContext(execution, P1_JUDGE, { verdict: "fail" });

      settleRoutes(execution, { now: NOW });
      const decided = settleLoops(execution, { now: NOW });
      expect(decided.materializations).toHaveLength(1);
      // Nothing installs: pass 2 was admitted but never cloned.
      expect(execution.loopStates["refine"]?.passCount).toBe(1);
      expect(livePassSlotCount(execution)).toBe(2);

      // The repair, as durable state (T15 owns the op that writes it): the
      // predicate now accepts the verdict pass 1 already banked.
      const group = execution.workingDefinition.loopGroups?.[0];
      if (!group) throw new Error("missing loop group");
      group.until = {
        schema: {
          type: "object",
          properties: { verdict: { const: "fail" } },
          required: ["verdict"],
        },
      };
      const state = execution.loopStates["refine"];
      if (!state) throw new Error("missing loop state");
      state.loopControlRevision += 1;

      settleRoutes(execution, { now: RESUMED });
      const concluded = settleLoops(execution, { now: RESUMED });
      expect(concluded.concludedLoopGroupIds).toEqual(["refine"]);
      expect(concluded.materializations).toEqual([]);

      expect(
        execution.loopStates["refine"]?.slotLedger.map((slot) => [
          slot.pass,
          slot.state,
        ]),
      ).toEqual([
        [1, "counted"],
        [2, "released"],
      ]);
      expect(livePassSlotCount(execution)).toBe(1);
    });

    it("refuses a loop whose declared cap exceeds the backstop", () => {
      const authored = createWorkflowDefinition({
        executionContexts: [
          context("seed"),
          context("step", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        ],
        tasks: [
          {
            id: "task-seed",
            contextId: "seed",
            order: 1,
            title: "seed",
            instructions: "seed",
            source: "user",
          },
          {
            id: "task-step",
            contextId: "step",
            order: 1,
            title: "step",
            instructions: "step",
            source: "user",
          },
        ],
        edges: [
          {
            id: "seed__step",
            sourceContextId: "seed",
            targetContextId: "step",
          },
        ],
        loopGroups: [
          {
            id: "runaway",
            bodyContextIds: ["step"],
            entryContextId: "step",
            exitContextId: "step",
            until: {
              schema: {
                type: "object",
                properties: { verdict: { const: "pass" } },
                required: ["verdict"],
              },
            },
            maxPasses: EXECUTION_TOTAL_PASS_BACKSTOP + 1,
          },
        ],
      });

      const result = validateWorkflowDefinition(authored);
      expect(result.ok).toBe(false);
      expect(result.errors.map((error) => error.code)).toContain(
        "loop-max-passes-exceeds-backstop",
      );
    });

    it("carries no live-edit or repair vocabulary that could raise the budget", () => {
      const attempts: unknown[] = [
        { type: "set-execution-pass-backstop", value: 50 },
        { type: "update-loop-group", loopGroupId: "refine", maxPasses: 40 },
        { type: "raise-loop-cap", loopGroupId: "refine", maxPasses: 40 },
      ];
      for (const attempt of attempts) {
        expect(workflowLiveEditOperationSchema.safeParse(attempt).success).toBe(
          false,
        );
        expect(validatePlanRepairOperations([attempt]).ok).toBe(false);
      }
    });
  });

  // ==========================================================
  // R10.3 — the per-pass gates
  // ==========================================================

  describe("validators and human gates on every pass (R10.3)", () => {
    const GATED_JUDGE: Partial<GraphWorkflowExecutionContextDefinition> = {
      outputSchema: JUDGE_OUTPUT_SCHEMA,
      humanApprovalGate: { enabled: true },
      contextValidator: {
        enabled: true,
        assignments: [
          makeValidatorAssignment({
            agent: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "high",
            },
          }),
        ],
      },
    };

    function gatedDefinition() {
      return workerJudgeDefinition({
        executionContexts: [
          context("seed", { outputSchema: undefined }),
          context("worker"),
          context("judge", GATED_JUDGE),
          context("publish"),
        ],
      });
    }

    it("clones the exit's validator and approval gate onto every pass instance", () => {
      let execution = executionFor(gatedDefinition());
      completeContext(execution, "seed");
      execution = runPass(execution).execution;
      completeContext(execution, P1_WORKER);
      completeContext(execution, P1_JUDGE, { verdict: "fail" });
      execution = runPass(execution).execution;

      const contexts = execution.workingDefinition.executionContexts;
      const first = contexts.find((entry) => entry.id === P1_JUDGE);
      const second = contexts.find((entry) => entry.id === P2_JUDGE);
      expect(first?.humanApprovalGate).toEqual({ enabled: true });
      expect(second?.humanApprovalGate).toEqual(first?.humanApprovalGate);
      expect(second?.contextValidator).toEqual(first?.contextValidator);
      expect(second?.contextValidator).not.toBeNull();
    });

    it("holds settlement while a LATER pass's exit waits in its approval gate", async () => {
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

      let execution = executionFor(gatedDefinition());
      completeContext(execution, "seed");
      execution = runPass(execution).execution;
      completeContext(execution, P1_WORKER);
      completeContext(execution, P1_JUDGE, { verdict: "fail" });
      execution = runPass(execution).execution;
      completeContext(execution, P2_WORKER);

      // Pass 2's exit banked a SATISFYING verdict and parked for a human. The
      // gate is on the clone, so it runs here exactly as it ran on pass 1.
      execution.contextOutputs[P2_JUDGE] = {
        value: { verdict: "pass" },
        iteration: 1,
        capturedAt: NOW,
        parse: { source: "native" },
      };
      transitionContextStatus(execution, P2_JUDGE, "running", {
        reason: "test.dispatch",
      });
      approvals.enterAwaitingApproval(execution, {
        contextId: P2_JUDGE,
        conversationId: "conversation-2",
        approvalScope: { kind: "whole_tree" },
      });
      execution = await restart(execution);
      expect(execution.contextStates[P2_JUDGE]?.status).toBe(
        "awaiting_approval",
      );

      settleRoutes(execution, { now: RESUMED });
      expect(settleLoops(execution, { now: RESUMED }).halt).toBeNull();
      expect(execution.loopStates["refine"]?.decisions["2"]).toBeUndefined();
      expect(execution.loopStates["refine"]?.activation).toBe("running");

      const recorded = await approvals.recordDecision({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        contextId: P2_JUDGE,
        decision: { type: "approved" },
      });
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;
      execution = recorded.execution;
      approvals.applyApprovedDecision(execution, P2_JUDGE);
      completeContext(execution, P2_JUDGE);
      execution = graphWorkflowExecutionSchema.parse(execution);

      execution = runPass(execution, { now: RESUMED_AGAIN }).execution;
      expect(execution.loopStates["refine"]?.activation).toBe("concluded");
      expect(execution.loopStates["refine"]?.decisions["2"]).toMatchObject({
        verdict: "satisfied",
        outcome: "concluded",
      });
    });
  });
});
