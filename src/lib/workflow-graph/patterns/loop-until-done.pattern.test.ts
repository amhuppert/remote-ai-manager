import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import { workflowSemanticDefinitionSchema } from "../definition-schemas";
import {
  runEngineScenario,
  type EngineScenarioRun,
} from "../compat/engine-harness";
import type { TypedEventRecord } from "../compat/projections";
import { EXECUTION_TOTAL_PASS_BACKSTOP } from "../constants";
import { resolveUpstreamInputs } from "../context-outputs";
import { isResumableHalt } from "../lifecycle-classifier";
import { applyLiveEditsToActiveExecution } from "../live-edit-apply";
import { loopInstanceId } from "../loop-resolver";
import { evaluatePlanRepairTrigger } from "../plan-repair/trigger";
import {
  expandPlanRepairOperations,
  validatePlanRepairOperations,
} from "../plan-repair/schemas";
import { harnessLiveEditDeps } from "./pattern-live-edit-deps";
import type { GraphWorkflowExecution } from "../schemas";
import { stubAssignmentSnapshotPreparation } from "../test-fixtures";

/**
 * Pattern proof: worker+judge Loop-Until-Done (R15.3).
 *
 * The claim under test is that "repeat a body until an independent judge says
 * stop" is an ORDINARY template — so the graph comes from a real plan body
 * admitted through the production authoring path, and both of the loop's
 * terminals are driven through the engine harness: a conclusion inside budget,
 * and the `loop_limit_reached` halt on exhaustion followed by an operator's cap
 * raise and a resume that re-decides.
 *
 * Follows the shape T19 set for Classify-And-Act and T20 extended for
 * Generate-And-Filter (see `.cc/graph-workflow-docs/pattern-proofs.md`): admit
 * the template, execute it, assert from durable state and events, and vary only
 * the scripted judgment so the assertions are load-bearing.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = path.join(moduleDir, "loop-until-done.plan.json");

const LOOP = "refine";
const BRIEF = "context-brief";
const DRAFT = "context-draft";
const REVIEW = "context-review";
const PUBLISH = "context-publish";

/** The pass-K instances the engine mints, from the production minting function. */
const draftId = (pass: number): string => loopInstanceId(LOOP, pass, DRAFT);
const reviewId = (pass: number): string => loopInstanceId(LOOP, pass, REVIEW);

type JudgeVerdict = "approved" | "revise";

function readPlan(): unknown {
  return JSON.parse(readFileSync(PLAN_PATH, "utf8"));
}

function planDefinition() {
  const plan = readPlan();
  const definition =
    typeof plan === "object" && plan !== null && "definition" in plan
      ? (plan as { definition: unknown }).definition
      : undefined;
  return workflowSemanticDefinitionSchema.parse(definition);
}

/**
 * The scripted judgment, and the ONLY thing that varies between scenarios. A
 * mutable holder rather than a constant because the exhaustion scenario changes
 * its mind between the halt and the resume — which is exactly what an operator
 * raising a cap is betting on.
 */
interface JudgePanel {
  verdictFor(pass: number): JudgeVerdict;
}

function approveOnPass(pass: number): JudgePanel {
  return {
    verdictFor: (candidate) => (candidate >= pass ? "approved" : "revise"),
  };
}

function neverApprove(): JudgePanel {
  return { verdictFor: () => "revise" };
}

interface LoopPatternRun {
  settled: GraphWorkflowExecution;
  /** Every typed event published so far — live, so a resume appends to it. */
  events: readonly TypedEventRecord[];
  /** The last prompt each context's implementer was handed. */
  prompts: Map<string, string>;
  manager: EngineScenarioRun["manager"];
  eventPublisher: EngineScenarioRun["eventPublisher"];
  projectPath: string;
  sessionName: string;
  resume: EngineScenarioRun["resume"];
}

/**
 * Execute the template with a scripted worker and judge. Each pass instance is
 * a fresh context id, so a verdict keyed on the pass is a verdict keyed on the
 * instance — no scenario state leaks between passes.
 */
async function runLoopPattern<T>(
  panel: { current: JudgePanel },
  inspect: (run: LoopPatternRun) => Promise<T>,
): Promise<T> {
  const prompts = new Map<string, string>();
  /**
   * Which pass of the body this context id is, matched against ids the
   * PRODUCTION minting function produces rather than a pattern this test
   * invented. Bounded by the execution backstop, above which no pass instance
   * can exist.
   */
  const passOf = (contextId: string, templateId: string): number | null => {
    for (let pass = 1; pass <= EXECUTION_TOTAL_PASS_BACKSTOP; pass += 1) {
      if (contextId === loopInstanceId(LOOP, pass, templateId)) return pass;
    }
    return null;
  };

  return runEngineScenario(
    {
      name: "loop-until-done",
      definition: planDefinition(),
      sessionLaneEnabled: false,
      agent: () => "complete-next-task",
      capture: ({ contextId }) => {
        if (contextId === BRIEF) {
          return {
            objective: "Cut the cold-start cost of the projection cache",
            exitBar:
              "The projection warms in under 200ms with no behavioural change",
          };
        }
        const draftPass = passOf(contextId, DRAFT);
        if (draftPass !== null) {
          return {
            passSummary: `Draft revision ${draftPass}`,
            handoff: `Revision ${draftPass} reworked the warm path; the cold path is untouched.`,
          };
        }
        if (contextId === PUBLISH) {
          return { delivered: "The approved revision, published as final" };
        }
        const reviewPass = passOf(contextId, REVIEW);
        if (reviewPass !== null) {
          const verdict = panel.current.verdictFor(reviewPass);
          return {
            verdict,
            blocking:
              verdict === "approved"
                ? []
                : [`Pass ${reviewPass}: cold path still misses the exit bar`],
            handoff:
              verdict === "approved"
                ? `Revision ${reviewPass} clears the exit bar.`
                : `Revision ${reviewPass} rejected; measure the cold path next.`,
          };
        }
        return null;
      },
      async onAgentTurn(turn) {
        prompts.set(turn.contextId, turn.prompt);
      },
    },
    async (run) =>
      inspect({
        settled: run.settled,
        events: run.events,
        prompts,
        manager: run.manager,
        eventPublisher: run.eventPublisher,
        projectPath: run.projectPath,
        sessionName: run.sessionName,
        resume: run.resume,
      }),
  );
}

function loopState(execution: GraphWorkflowExecution) {
  const state = execution.loopStates[LOOP];
  if (!state) throw new Error(`loop "${LOOP}" has no ledger entry`);
  return state;
}

function decisionRecords(
  execution: GraphWorkflowExecution,
): Array<Record<string, unknown>> {
  const decisions = loopState(execution).decisions;
  return Object.keys(decisions)
    .map(Number)
    .sort((left, right) => left - right)
    .map((pass) => {
      const record = decisions[String(pass)];
      return {
        pass: record?.pass,
        verdict: record?.verdict,
        outcome: record?.outcome,
        exitContextId: record?.exitContextId,
        loopControlRevision: record?.loopControlRevision,
      };
    });
}

function slotLedger(
  execution: GraphWorkflowExecution,
): Array<[number, string, number]> {
  return loopState(execution).slotLedger.map((slot) => [
    slot.pass,
    slot.state,
    slot.grantOrder,
  ]);
}

function loopDecisionEvents(
  events: readonly TypedEventRecord[],
): Array<{ subject: string | null; detail: string | null }> {
  return events
    .filter((event) => event.kind === "graph-workflow-loop-decision")
    .map((event) => ({ subject: event.subject, detail: event.detail }));
}

// ============================================================
// 1. The template is admitted by the production authoring path
// ============================================================

describe("Loop-Until-Done template — authoring (R15.3)", () => {
  it("is accepted, warning-free, by the validator `cctl workflow create` runs", () => {
    const result = validateWorkflowPlan(readPlan());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });

  it("declares a worker+judge body whose exit is the judge, bounded by a cap", () => {
    const definition = planDefinition();
    const group = definition.loopGroups?.[0];

    expect(definition.loopGroups).toHaveLength(1);
    expect(group).toMatchObject({
      id: LOOP,
      bodyContextIds: [DRAFT, REVIEW],
      entryContextId: DRAFT,
      exitContextId: REVIEW,
      maxPasses: 3,
    });
    // The judge is an INDEPENDENT context, not a self-assessment appended to the
    // worker: the exit that decides the loop is not the context that did the
    // work.
    expect(group?.exitContextId).not.toBe(group?.entryContextId);
    // The exit's captured verdict is what `until` reads, so the exit owes an
    // output contract that can satisfy it.
    const judge = definition.executionContexts.find(
      (context) => context.id === REVIEW,
    );
    expect(judge?.outputSchema).toBeDefined();
  });
});

// ============================================================
// 2. Terminal one — the loop concludes inside its budget
// ============================================================

describe("Loop-Until-Done — conclusion inside budget (R15.3)", () => {
  it("repeats the body until the judge approves, then hands the concluding pass downstream", async () => {
    await runLoopPattern({ current: approveOnPass(2) }, async (run) => {
      const state = loopState(run.settled);

      // --- the loop took exactly the passes the verdicts asked for ----------
      expect(run.settled.status).toBe("completed");
      expect(state.activation).toBe("concluded");
      expect(state.passCount).toBe(2);
      expect(state.concludingExitContextId).toBe(reviewId(2));
      // A third pass was never materialized, so the cap was not what stopped
      // it. Pass 1 is spliced where the body was declared; every later pass is
      // appended, because a runtime unroll adds to the graph rather than
      // reordering it.
      expect(
        run.settled.workingDefinition.executionContexts.map(
          (context) => context.id,
        ),
      ).toEqual([
        BRIEF,
        draftId(1),
        reviewId(1),
        PUBLISH,
        draftId(2),
        reviewId(2),
      ]);

      // --- the decision records and the ledger ------------------------------
      expect(decisionRecords(run.settled)).toEqual([
        {
          pass: 1,
          verdict: "unsatisfied",
          outcome: "materialized",
          exitContextId: reviewId(1),
          loopControlRevision: 0,
        },
        {
          pass: 2,
          verdict: "satisfied",
          outcome: "concluded",
          exitContextId: reviewId(2),
          loopControlRevision: 0,
        },
      ]);
      // Both grants were spent — a pass that ran is `counted`, in grant order.
      expect(slotLedger(run.settled)).toEqual([
        [1, "counted", 1],
        [2, "counted", 2],
      ]);
      expect(loopDecisionEvents(run.events)).toEqual([
        { subject: `${LOOP}#1`, detail: "r0:unsatisfied:materialized" },
        { subject: `${LOOP}#2`, detail: "r0:satisfied:concluded" },
      ]);

      // --- pass 2 was told what pass 1 already tried -------------------------
      const secondDraftPrompt = run.prompts.get(draftId(2)) ?? "";
      expect(secondDraftPrompt).toContain("## Loop History");
      expect(secondDraftPrompt).toContain("### Pass 1");
      expect(secondDraftPrompt).toContain(
        "Pass 1: cold path still misses the exit bar",
      );
      // Pass 1's entry gets no history — there is nothing behind it.
      expect(run.prompts.get(draftId(1)) ?? "").not.toContain(
        "## Loop History",
      );

      // A pass-2 entry's only edge is the prior-exit wiring edge, so the brief
      // reaches it through the pinned boundary snapshot rather than the graph.
      expect(
        resolveUpstreamInputs(run.settled, draftId(2)).map(
          (input) => input.contextId,
        ),
      ).toEqual([BRIEF, reviewId(1)]);

      // --- downstream consumed the CONCLUDING pass via the effective source --
      const publishInputs = resolveUpstreamInputs(run.settled, PUBLISH);
      expect(publishInputs.map((input) => input.contextId)).toEqual([
        reviewId(2),
      ]);
      expect(publishInputs[0]?.output).toMatchObject({ verdict: "approved" });
      const publishPrompt = run.prompts.get(PUBLISH) ?? "";
      expect(publishPrompt).toContain(reviewId(2));
      expect(publishPrompt).toContain('"verdict": "approved"');
      expect(run.settled.contextStates[PUBLISH]?.status).toBe("completed");

      // --- and it survives a reload through the repository -------------------
      const reloaded = await run.manager.getActive(
        run.projectPath,
        run.sessionName,
      );
      expect(reloaded?.loopStates[LOOP]?.concludingExitContextId).toBe(
        reviewId(2),
      );
      expect(reloaded?.status).toBe("completed");
      return null;
    });
  });

  it("concludes on the first pass when the judge approves the first draft", async () => {
    // The load-bearing variation: only the scripted verdict changes, and the
    // whole shape of the run follows it.
    await runLoopPattern({ current: approveOnPass(1) }, async (run) => {
      const state = loopState(run.settled);

      expect(run.settled.status).toBe("completed");
      expect(state.passCount).toBe(1);
      expect(state.concludingExitContextId).toBe(reviewId(1));
      expect(decisionRecords(run.settled)).toEqual([
        {
          pass: 1,
          verdict: "satisfied",
          outcome: "concluded",
          exitContextId: reviewId(1),
          loopControlRevision: 0,
        },
      ]);
      // No second pass exists, so the previous test's assertions could not have
      // passed on this run.
      expect(
        run.settled.workingDefinition.executionContexts.some(
          (context) => context.id === draftId(2),
        ),
      ).toBe(false);
      expect(
        resolveUpstreamInputs(run.settled, PUBLISH).map(
          (input) => input.contextId,
        ),
      ).toEqual([reviewId(1)]);
      return null;
    });
  });
});

// ============================================================
// 3. Terminal two — exhaustion, and the cap raise that resumes it
// ============================================================

describe("Loop-Until-Done — exhaustion halt and cap-raise resume (R15.3)", () => {
  it("halts resumably on loop_limit_reached, then re-decides and concludes after a raised cap", async () => {
    const panel = { current: neverApprove() };

    await runLoopPattern(panel, async (run) => {
      // --- the budget refused the loop, and said so --------------------------
      expect(run.settled.status).toBe("halted");
      expect(run.settled.haltReason).toMatchObject({
        type: "loop_limit_reached",
        scope: "loop",
        loopGroupId: LOOP,
        verdict: "unsatisfied",
        passCount: 3,
      });
      const haltReason = run.settled.haltReason;
      expect(haltReason).not.toBeNull();
      if (haltReason === null) return null;
      // Resumable is the whole point of this terminal: exhaustion is an
      // operator decision, not a dead run.
      expect(isResumableHalt(haltReason)).toBe(true);

      const halted = loopState(run.settled);
      expect(halted.activation).toBe("running");
      expect(halted.passCount).toBe(3);
      expect(halted.concludingExitContextId).toBeNull();
      // A halt writes NOTHING durable: pass 3 has no decision record, which is
      // exactly what lets the resume re-decide it.
      expect(decisionRecords(run.settled).map((record) => record.pass)).toEqual(
        [1, 2],
      );
      expect(slotLedger(run.settled)).toEqual([
        [1, "counted", 1],
        [2, "counted", 2],
        [3, "counted", 3],
      ]);

      // --- a resume with nothing repaired re-derives the SAME refusal --------
      // What makes the cap raise below load-bearing: resuming is not what
      // releases the loop, and an exhausted budget is re-derived from durable
      // state rather than consumed by the halt that reported it.
      const unrepaired = await run.resume();
      expect(unrepaired.status).toBe("halted");
      expect(unrepaired.haltReason).toMatchObject({
        type: "loop_limit_reached",
        loopGroupId: LOOP,
        passCount: 3,
      });
      expect(loopState(unrepaired).passCount).toBe(3);

      // --- the operator's repair: the supervisor's exact chain ---------------
      const trigger = evaluatePlanRepairTrigger(unrepaired);
      expect(trigger.eligible).toBe(true);
      if (!trigger.eligible || trigger.loopGroupId === null) return null;

      const validated = validatePlanRepairOperations(
        [{ type: "raise-loop-max-passes", loopGroupId: LOOP, maxPasses: 4 }],
        unrepaired.workingDefinition.executionContexts,
        {
          loopGroupId: trigger.loopGroupId,
          scope: trigger.loopScope ?? "loop",
        },
      );
      expect(validated.ok).toBe(true);
      if (!validated.ok) return null;

      const expanded = expandPlanRepairOperations(
        validated.operations,
        unrepaired.workingDefinition.executionContexts,
      );
      expect(expanded.ok).toBe(true);
      if (!expanded.ok) return null;

      const applied = await applyLiveEditsToActiveExecution(
        {
          projectPath: run.projectPath,
          sessionName: run.sessionName,
          request: {
            executionId: unrepaired.id,
            baseLiveRevision: unrepaired.liveRevision,
            source: "plan-repair",
            operations: expanded.operations,
          },
        },
        {
          getActiveExecution: run.manager.getActive,
          mutateActive: run.manager.mutateActive,
          buildLiveEditDeps: async () => harnessLiveEditDeps(),
          prepareAssignmentSnapshots: stubAssignmentSnapshotPreparation(),
          // The run's own publisher, so the repair's event lands in the same
          // log the engine's decisions do.
          publishLiveEditApplied: run.eventPublisher.publishLiveEditApplied,
          publishCharterUpdated: run.eventPublisher.publishCharterUpdated,
          getSession: async () => null,
          writeCharterDocument: async () => {},
        },
      );
      expect(applied.ok).toBe(true);
      expect(
        run.events.some(
          (event) =>
            event.kind === "graph-workflow-live-edit-applied" &&
            event.detail === "plan-repair",
        ),
      ).toBe(true);

      // The judge is satisfied by the pass the raised cap buys.
      panel.current = approveOnPass(4);

      // --- resume: normalize → resume → run the loop again -------------------
      const resumed = await run.resume();
      const state = loopState(resumed);

      expect(resumed.status).toBe("completed");
      expect(resumed.haltReason).toBeNull();
      expect(state.activation).toBe("concluded");
      expect(state.passCount).toBe(4);
      expect(state.concludingExitContextId).toBe(reviewId(4));
      // Pass 3 was re-decided under the amended control revision — the halt is
      // re-derived from durable state, never un-recorded.
      expect(decisionRecords(resumed)).toEqual([
        {
          pass: 1,
          verdict: "unsatisfied",
          outcome: "materialized",
          exitContextId: reviewId(1),
          loopControlRevision: 0,
        },
        {
          pass: 2,
          verdict: "unsatisfied",
          outcome: "materialized",
          exitContextId: reviewId(2),
          loopControlRevision: 0,
        },
        {
          pass: 3,
          verdict: "unsatisfied",
          outcome: "materialized",
          exitContextId: reviewId(3),
          loopControlRevision: 1,
        },
        {
          pass: 4,
          verdict: "satisfied",
          outcome: "concluded",
          exitContextId: reviewId(4),
          loopControlRevision: 1,
        },
      ]);
      expect(loopDecisionEvents(run.events).slice(-2)).toEqual([
        { subject: `${LOOP}#3`, detail: "r1:unsatisfied:materialized" },
        { subject: `${LOOP}#4`, detail: "r1:satisfied:concluded" },
      ]);
      expect(slotLedger(resumed)).toEqual([
        [1, "counted", 1],
        [2, "counted", 2],
        [3, "counted", 3],
        [4, "counted", 4],
      ]);

      // The amendment is auditable, and the loop concluded through the same
      // downstream contract the in-budget terminal used.
      expect(
        resumed.loopControlAmendments.map((entry) => ({
          kind: entry.kind,
          source: entry.source,
        })),
      ).toEqual([{ kind: "raise-max-passes", source: "plan-repair" }]);
      expect(
        resolveUpstreamInputs(resumed, PUBLISH).map((input) => input.contextId),
      ).toEqual([reviewId(4)]);
      expect(resumed.contextStates[PUBLISH]?.status).toBe("completed");
      return null;
    });
  });
});
