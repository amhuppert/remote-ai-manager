import { describe, expect, it } from "vitest";
import {
  graphWorkflowExecutionSchema,
  type GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import { resolveUpstreamInputs } from "./context-outputs";
import { projectExecutionRoutes } from "./execution-routes";
import { landGatedPublishSettlement } from "./lane-readiness";
import {
  finalizeLoopPassMaterialization,
  prepareLoopPassMaterialization,
  settleLoops,
  type LoopMaterializationRequest,
} from "./loop-settlement";
import { routeVerdict } from "./route-projection";
import { settleRoutes } from "./route-runtime";
import { applyLiveExecutionEdits } from "./runtime-edits";
import { validateWorkflowDefinition } from "./validation";
import {
  ALPHA_P1_JUDGE,
  ALPHA_P1_WORKER,
  JUDGE_OUTPUT_SCHEMA,
  NOW,
  P1_JUDGE,
  P1_WORKER,
  P2_JUDGE,
  P2_WORKER,
  P3_WORKER,
  completeContext,
  context,
  edge,
  executionFor,
  makeLiveEditDeps,
  runPass,
  task,
  twoLoopDefinition,
  workerJudgeDefinition,
} from "./loop-test-fixtures";

describe("worker+judge loop, both terminals (R9.1)", () => {
  it("clones pass 2 on a failing verdict and injects the prior exit output", () => {
    const definition = workerJudgeDefinition();
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    expect(execution.loopStates["refine"]?.activation).toBe("running");
    expect(execution.loopStates["refine"]?.slotLedger).toEqual([
      expect.objectContaining({ pass: 1, state: "reserved", grantOrder: 1 }),
    ]);

    completeContext(execution, P1_WORKER, undefined);
    completeContext(execution, P1_JUDGE, {
      verdict: "fail",
      notes: "needs another round",
    });

    const pass2 = runPass(execution);
    execution = pass2.execution;
    expect(pass2.materialized).toHaveLength(1);
    expect(
      execution.workingDefinition.executionContexts.map(
        (entry: { id: string }) => entry.id,
      ),
    ).toEqual(["seed", P1_WORKER, P1_JUDGE, "publish", P2_WORKER, P2_JUDGE]);

    // The next pass's entry reads the prior exit's banked output.
    const entryInputs = resolveUpstreamInputs(execution, P2_WORKER);
    expect(entryInputs.map((row) => row.contextId)).toContain(P1_JUDGE);
    expect(
      entryInputs.find((row) => row.contextId === P1_JUDGE)?.output,
    ).toEqual({ verdict: "fail", notes: "needs another round" });

    // Fresh instances, so fresh conversations: nothing has run yet.
    expect(execution.contextStates[P2_WORKER]?.status).toBe("pending");
    expect(execution.contextStates[P2_WORKER]?.iterationCount).toBe(0);
  });

  it("concludes on a satisfying verdict and releases downstream onto the final pass", () => {
    const definition = workerJudgeDefinition();
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });
    execution = runPass(execution).execution;

    completeContext(execution, P2_WORKER);
    completeContext(execution, P2_JUDGE, { verdict: "pass", notes: "good" });
    execution = runPass(execution).execution;

    const state = execution.loopStates["refine"];
    expect(state?.activation).toBe("concluded");
    expect(state?.concludingExitContextId).toBe(P2_JUDGE);

    // Downstream becomes eligible and reads the CONCLUDING pass's output.
    execution = runPass(execution).execution;
    const projection = projectExecutionRoutes(execution);
    expect(routeVerdict(projection, "publish").kind).toBe("eligible");
    const publishInputs = resolveUpstreamInputs(execution, "publish");
    expect(publishInputs.map((row) => row.output)).toEqual([
      { verdict: "pass", notes: "good" },
    ]);
  });
});

describe("pass immutability and acyclicity (R9.2)", () => {
  it("freezes prior passes, keeps distinct captures, and leaves the graph acyclic", () => {
    const definition = workerJudgeDefinition();
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail", notes: "pass 1" });
    execution = runPass(execution).execution;
    expect(
      validateWorkflowDefinition(execution.workingDefinition).errors,
    ).toEqual([]);

    completeContext(execution, P2_WORKER);
    completeContext(execution, P2_JUDGE, { verdict: "fail", notes: "pass 2" });
    execution = runPass(execution).execution;
    expect(
      validateWorkflowDefinition(execution.workingDefinition).errors,
    ).toEqual([]);

    expect(execution.contextStates[P1_JUDGE]?.status).toBe("completed");
    expect(execution.contextStates[P2_JUDGE]?.status).toBe("completed");
    expect(execution.contextOutputs[P1_JUDGE]?.value).toEqual({
      verdict: "fail",
      notes: "pass 1",
    });
    expect(execution.contextOutputs[P2_JUDGE]?.value).toEqual({
      verdict: "fail",
      notes: "pass 2",
    });
    expect(execution.contextStates[P3_WORKER]?.status).toBe("pending");
  });
});

describe("evaluation precedes the pass limit (R9.3)", () => {
  it("concludes normally on a satisfying verdict in the final allowed pass", () => {
    const definition = workerJudgeDefinition({}, { maxPasses: 2 });
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });
    execution = runPass(execution).execution;

    completeContext(execution, P2_WORKER);
    completeContext(execution, P2_JUDGE, { verdict: "pass" });
    const final = runPass(execution);

    expect(final.halt).toBeNull();
    expect(final.execution.loopStates["refine"]?.activation).toBe("concluded");
    expect(final.execution.loopStates["refine"]?.concludingExitContextId).toBe(
      P2_JUDGE,
    );
  });

  it("halts when the final allowed pass does not satisfy the predicate", () => {
    const definition = workerJudgeDefinition({}, { maxPasses: 2 });
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });
    execution = runPass(execution).execution;

    completeContext(execution, P2_WORKER);
    completeContext(execution, P2_JUDGE, { verdict: "fail" });
    const final = runPass(execution);

    expect(final.halt).toMatchObject({
      type: "loop_limit_reached",
      loopGroupId: "refine",
      pass: 2,
      maxPasses: 2,
    });
    expect(final.execution.loopStates["refine"]?.activation).toBe("running");
  });
});

describe("runtime terminal behaviours (R9.6)", () => {
  it("skips an untaken loop with its body and raises no halt", () => {
    const definition = workerJudgeDefinition({
      edges: [
        edge("seed__worker", "seed", "worker", {
          schema: {
            type: "object",
            properties: { route: { const: "refine" } },
            required: ["route"],
          },
        }),
        edge("worker__judge", "worker", "judge"),
        edge("judge__publish", "judge", "publish"),
        edge("seed__publish", "seed", "publish"),
      ],
      executionContexts: [
        context("seed", {
          outputSchema: {
            type: "object",
            properties: { route: { type: "string" } },
            required: ["route"],
            additionalProperties: false,
          },
        }),
        context("worker"),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        context("publish"),
      ],
    });
    let execution = executionFor(definition);

    completeContext(execution, "seed", { route: "ship" });
    execution = runPass(execution).execution;
    const second = runPass(execution);
    execution = second.execution;

    expect(second.halt).toBeNull();
    expect(execution.loopStates["refine"]?.activation).toBe("skipped");
    expect(execution.contextStates[P1_WORKER]?.status).toBe("skipped");
    expect(execution.contextStates[P1_JUDGE]?.status).toBe("skipped");

    // The logical exit reads as a skipped source: the unconditional external
    // edge is omitted and `publish` runs on its other, satisfied route.
    const projection = projectExecutionRoutes(execution);
    expect(routeVerdict(projection, "publish").kind).toBe("eligible");
  });

  it("halts with loop_exit_skipped when an ACTIVE loop's exit resolves skipped", () => {
    const definition = workerJudgeDefinition();
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    expect(execution.loopStates["refine"]?.activation).toBe("running");

    // The exit instance is skipped out from under a running loop.
    const exitState = execution.contextStates[P1_JUDGE];
    if (!exitState) throw new Error("missing exit state");
    exitState.status = "skipped";
    exitState.skipReason = { edgeEvaluations: [], at: NOW };

    const outcome = settleLoops(execution, { now: NOW });
    expect(outcome.halt).toMatchObject({
      type: "loop_exit_skipped",
      loopGroupId: "refine",
      pass: 1,
      contextId: P1_JUDGE,
    });
  });

  it("halts with the typed invariant halt when an active exit's output is unevaluable", () => {
    const definition = workerJudgeDefinition();
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    // Completed with NO banked capture: the predicate has nothing to read.
    completeContext(execution, P1_JUDGE);

    const outcome = settleLoops(execution, { now: NOW });
    expect(outcome.halt).toMatchObject({
      type: "loop_invariant",
      loopGroupId: "refine",
      pass: 1,
      reason: "exit-output-unevaluable",
      contextId: P1_JUDGE,
    });
    expect(outcome.materializations).toEqual([]);
  });

  it("pins the boundary inputs at activation and re-delivers them to every pass entry", () => {
    const definition = workerJudgeDefinition({
      executionContexts: [
        context("seed", {
          outputSchema: {
            type: "object",
            properties: { brief: { type: "string" } },
            required: ["brief"],
            additionalProperties: false,
          },
        }),
        context("worker"),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        context("publish"),
      ],
    });
    let execution = executionFor(definition);

    completeContext(execution, "seed", { brief: "refine the draft" });
    execution = runPass(execution).execution;

    const snapshot = execution.loopStates["refine"]?.boundaryInputs;
    expect(snapshot?.map((row) => row.contextId)).toEqual(["seed"]);
    expect(snapshot?.[0]?.output).toEqual({ brief: "refine the draft" });

    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });
    execution = runPass(execution).execution;

    // Pass 2's entry has NO boundary routing edge — it is never cloned — so the
    // snapshot is what carries the loop's external inputs forward, alongside
    // the prior exit output.
    expect(
      execution.workingDefinition.edges.filter(
        (entry: { targetContextId: string }) =>
          entry.targetContextId === P2_WORKER,
      ),
    ).toHaveLength(1);
    const inputs = resolveUpstreamInputs(execution, P2_WORKER);
    expect(inputs.map((row) => row.contextId)).toEqual(["seed", P1_JUDGE]);
    expect(inputs[0]?.output).toEqual({ brief: "refine the draft" });
  });
});

describe("the slot ledger and the decision record (R16.1)", () => {
  it("grants slots in definition order and records the latest decision per pass", () => {
    const definition = workerJudgeDefinition();
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });
    execution = runPass(execution).execution;

    const state = execution.loopStates["refine"];
    expect(
      state?.slotLedger.map((slot) => [slot.pass, slot.grantOrder]),
    ).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(state?.passCount).toBe(2);
    expect(state?.decisions["1"]).toMatchObject({
      loopGroupId: "refine",
      pass: 1,
      loopControlRevision: 0,
      templateVersion: 1,
      exitCaptureIteration: 1,
      verdict: "unsatisfied",
      outcome: "materialized",
    });
  });

  it("admits a materialization before a later loop's activation in the same pass", () => {
    // Two loops, alpha declared first. In ONE scheduling pass alpha needs its
    // pass 2 and beta activates for the first time — the arbitration decision D7
    // requires to follow DEFINITION order, which a ledger that grants
    // activations eagerly and materializations afterwards would reverse.
    const definition = twoLoopDefinition();
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    expect(execution.loopStates["alpha"]?.activation).toBe("running");
    expect(execution.loopStates["beta"]?.activation ?? "unstarted").toBe(
      "unstarted",
    );

    completeContext(execution, ALPHA_P1_WORKER);
    completeContext(execution, ALPHA_P1_JUDGE, { verdict: "fail" });
    // Beta's activation path resolves in the very pass alpha decides to unroll.
    completeContext(execution, "gate");

    const pass = runPass(execution);
    execution = pass.execution;
    expect(pass.materialized).toHaveLength(1);
    expect(execution.loopStates["beta"]?.activation).toBe("running");

    const alphaSlots = execution.loopStates["alpha"]?.slotLedger ?? [];
    const betaSlots = execution.loopStates["beta"]?.slotLedger ?? [];
    expect(alphaSlots.map((slot) => [slot.pass, slot.grantOrder])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(betaSlots.map((slot) => [slot.pass, slot.grantOrder])).toEqual([
      [1, 3],
    ]);
  });

  it("re-uses the reservation of an unroll that never installed", () => {
    // The slot is admitted before the clone, so an unroll that is refused or
    // never staged leaves a durable reservation behind. Re-deciding the same
    // pass must re-use it — a second grant would consume two slots for one pass
    // and, once budgets land, starve a loop out of its own reservation.
    const definition = workerJudgeDefinition();
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });

    settleRoutes(execution, { now: NOW });
    const first = settleLoops(execution, { now: NOW });
    expect(first.materializations).toHaveLength(1);
    // Nothing installs: no decision record, and pass 2 does not exist yet.
    expect(execution.loopStates["refine"]?.passCount).toBe(1);
    expect(execution.loopStates["refine"]?.decisions).toEqual({});

    const again = settleLoops(execution, { now: "2026-08-04T01:00:00.000Z" });
    expect(again.materializations).toEqual(first.materializations);
    expect(
      execution.loopStates["refine"]?.slotLedger.map((slot) => [
        slot.pass,
        slot.grantOrder,
        slot.grantedAt,
      ]),
    ).toEqual([
      [1, 1, NOW],
      [2, 2, NOW],
    ]);
  });

  it("does not re-decide a pass whose decision record already exists", () => {
    const definition = workerJudgeDefinition();
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });
    execution = runPass(execution).execution;

    const again = settleLoops(execution, { now: NOW });
    expect(again.materializations).toEqual([]);
    expect(again.halt).toBeNull();
    expect(
      execution.workingDefinition.executionContexts.filter(
        (entry: { id: string }) => entry.id === P3_WORKER,
      ),
    ).toEqual([]);
  });
});

describe("the unroll rides the one mutation core (charter invariant)", () => {
  /** An execution at the point where pass 2 has been decided but not installed. */
  function decidedAtPassOne(): {
    execution: GraphWorkflowExecution;
    request: LoopMaterializationRequest;
  } {
    let execution = executionFor(workerJudgeDefinition());
    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });
    settleRoutes(execution, { now: NOW });
    const outcome = settleLoops(execution, { now: NOW });
    const request = outcome.materializations[0];
    if (!request) throw new Error("expected a materialization decision");
    return { execution, request };
  }

  it("refuses the unroll from any caller without the engine's settlement authority", () => {
    const { execution, request } = decidedAtPassOne();

    // The op shares the live-edit vocabulary, so the refusal — not the schema —
    // is what keeps it out of reach of the HTTP route, the CLI and plan repair.
    const refused = applyLiveExecutionEdits(
      execution,
      {
        operations: [
          {
            type: "materialize-loop-pass",
            loopGroupId: request.loopGroupId,
            pass: request.nextPass,
          },
        ],
        source: "cli",
      },
      makeLiveEditDeps(),
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "loop-materialization-unauthorized",
    ]);
    expect(
      execution.workingDefinition.executionContexts.map((entry) => entry.id),
    ).not.toContain(P2_WORKER);
  });

  it("unrolls while a sibling context is mid-turn, and keeps that turn's write", () => {
    const { execution, request } = decidedAtPassOne();

    // A NON-quiescent execution: `publish` is running its own turn. Every other
    // structural op would be refused here; the unroll is exempt because every
    // node it writes is brand new.
    const publishState = execution.contextStates["publish"];
    if (!publishState) throw new Error("missing publish state");
    publishState.status = "running";

    const prepared = prepareLoopPassMaterialization(
      execution,
      request,
      makeLiveEditDeps(),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // A scheduler tick commits between prepare and finalize, exactly as the
    // staging seam is built for: the fence moves, the delta merges forward, and
    // the interleaved write survives.
    const draft = graphWorkflowExecutionSchema.parse(execution);
    draft.executionStateRevision += 1;
    const interleaved = draft.contextStates["publish"];
    if (!interleaved) throw new Error("missing publish state");
    interleaved.iterationCount = 7;

    const installed = finalizeLoopPassMaterialization(
      draft,
      prepared.prepared,
      request,
      { now: NOW },
    );
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.install).toBe("merged");
    expect(installed.execution.contextStates["publish"]?.iterationCount).toBe(
      7,
    );
    expect(
      installed.execution.workingDefinition.executionContexts.map(
        (entry) => entry.id,
      ),
    ).toContain(P2_WORKER);
  });

  it("declines a staged unroll the ledger already admitted", () => {
    const { execution, request } = decidedAtPassOne();
    const prepared = prepareLoopPassMaterialization(
      execution,
      request,
      makeLiveEditDeps(),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const first = finalizeLoopPassMaterialization(
      graphWorkflowExecutionSchema.parse(execution),
      prepared.prepared,
      request,
      { now: NOW },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The same staged batch against state that already carries pass 2: the
    // decision record is the done-marker, so nothing installs a second copy.
    const again = finalizeLoopPassMaterialization(
      graphWorkflowExecutionSchema.parse(first.execution),
      prepared.prepared,
      request,
      { now: NOW },
    );
    expect(again).toEqual({ ok: false, outcome: "superseded" });
  });
});

describe("an unsettled loop is outstanding work (R9.2)", () => {
  it("holds the publish settlement open while a tail loop is mid-flight", () => {
    // No downstream consumer, so nothing but the loop itself keeps the run
    // open: every materialized pass has completed and the next has not been
    // decided yet.
    const definition = workerJudgeDefinition({
      executionContexts: [
        context("seed"),
        context("worker"),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
      ],
      tasks: [
        task("task-seed", "seed"),
        task("task-worker", "worker"),
        task("task-judge", "judge"),
      ],
      edges: [
        edge("seed__worker", "seed", "worker"),
        edge("worker__judge", "worker", "judge"),
      ],
    });
    let execution = executionFor(definition);

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail" });

    // Every execution CONTEXT is completed, so a context-only reading would call
    // the run finished. The PROJECTION itself must say otherwise: publish
    // settlement is projection-owned for every consumer (charter invariant), so
    // the unsettled loop's logical exit is outstanding there, not in a second
    // computation the scheduler bolts on.
    const publish = projectExecutionRoutes(execution).publish;
    expect(publish.settled).toBe(false);
    expect(publish.outstandingContextIds).toEqual(["judge"]);
    expect(publish.outstandingLoopExitContextIds).toEqual(["judge"]);

    // Lane readiness and completion derive from that result rather than
    // disagreeing with it.
    const settlement = landGatedPublishSettlement(execution);
    expect(settlement).toEqual(publish);

    // Settling it releases the publish.
    execution = runPass(execution).execution;
    completeContext(execution, P2_WORKER);
    completeContext(execution, P2_JUDGE, { verdict: "pass" });
    execution = runPass(execution).execution;

    expect(execution.loopStates["refine"]?.activation).toBe("concluded");
    expect(landGatedPublishSettlement(execution).settled).toBe(true);
  });

  it("releases the publish for an untaken loop without waiting on its exit", () => {
    const definition = workerJudgeDefinition({
      executionContexts: [
        context("seed", {
          outputSchema: {
            type: "object",
            properties: { route: { type: "string" } },
            required: ["route"],
            additionalProperties: false,
          },
        }),
        context("worker"),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
      ],
      tasks: [
        task("task-seed", "seed"),
        task("task-worker", "worker"),
        task("task-judge", "judge"),
      ],
      edges: [
        edge("seed__worker", "seed", "worker", {
          schema: {
            type: "object",
            properties: { route: { const: "refine" } },
            required: ["route"],
          },
        }),
        edge("worker__judge", "worker", "judge"),
      ],
    });
    let execution = executionFor(definition);

    completeContext(execution, "seed", { route: "ship" });
    execution = runPass(execution).execution;
    execution = runPass(execution).execution;

    expect(execution.loopStates["refine"]?.activation).toBe("skipped");
    expect(landGatedPublishSettlement(execution).settled).toBe(true);
  });
});
