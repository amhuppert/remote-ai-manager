import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import { structuralWarningsOf } from "./pattern-plan-warnings";
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

/** The pass-K review instances the engine mints. */
const reviewId = (pass: number): string => loopInstanceId(LOOP, pass, REVIEW);

type JudgeVerdict = "approved" | "revise";

/**
 * The bar the brief sets and every draft carries forward verbatim. One constant
 * so the assertion that it reached the judge compares against the same string
 * the brief published, rather than a restatement that could drift from it.
 */
const EXIT_BAR =
  "The projection warms in under 200ms with no behavioural change";

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
            exitBar: EXIT_BAR,
          };
        }
        const draftPass = passOf(contextId, DRAFT);
        if (draftPass !== null) {
          return {
            // Carried verbatim, as the plan requires: the judge is downstream of
            // the draft, not of the brief, so a scenario that dropped it here
            // would bank a payload the production capture gate refuses — and
            // would model a judge with no bar to apply.
            exitBar: EXIT_BAR,
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
    expect(structuralWarningsOf(result.warnings)).toEqual([]);
  });
});

// ============================================================
// 1b. D5 placement: one reusable lane, and a judge that cannot edit (D6 R2.6)
// ============================================================

describe("Loop-Until-Done — lane reuse and judge independence (D6 R2.6)", () => {
  it("puts the writable worker and the read-only judge on ONE reusable group lane", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(
      result.draft.definition.executionContexts.map((context) => [
        context.id,
        context,
      ]),
    );
    const draft = byId.get(DRAFT);
    const review = byId.get(REVIEW);

    // The worker writes, so it needs a real lane — and the judge has to see
    // what the worker wrote, which is exactly why it shares that lane rather
    // than getting one of its own. A judge on a separate lane would have to
    // wait for a join to see the work, turning every pass into a merge.
    expect(draft?.placement?.mode).not.toBe("readOnly");
    expect(review?.placement?.lane).toBe(draft?.placement?.lane);
    expect(draft?.placement?.lane).not.toBe("session");

    // `judge-is-independent` as a MECHANICAL property, not a convention the
    // charter asks an agent to honour: a read-only context skips the commit
    // phase entirely, so this judge cannot edit the work even if it tried.
    expect(review?.placement?.mode).toBe("readOnly");
  });

  it("requires a bounded handoff from both halves of the pass", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const contextId of [DRAFT, REVIEW]) {
      const schema = result.draft.definition.executionContexts.find(
        (context) => context.id === contextId,
      )?.outputSchema as
        | {
            required?: unknown;
            properties?: Record<string, { maxLength?: number }>;
          }
        | undefined;

      // Required, because carrying what the last pass learned is what stops
      // pass 3 from re-trying what pass 1 already had rejected — an optional
      // handoff is one an agent drops exactly when the loop is going badly.
      expect(
        schema?.required,
        `${contextId} does not require a handoff`,
      ).toEqual(expect.arrayContaining(["handoff"]));

      // Bounded, because loop history accumulates into every later pass's
      // prompt: an unbounded handoff grows the context window pass over pass.
      expect(
        schema?.properties?.handoff?.maxLength,
        `${contextId}'s handoff declares no maxLength`,
      ).toBeGreaterThan(0);
    }
  });

  it("carries the exit bar to the judge through its direct predecessor", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const definition = result.draft.definition;

    // The judge's ONLY direct predecessor is the draft. The brief that sets the
    // exit bar is two hops away, and loop boundary inputs enter at the entry
    // context, so nothing injects the brief's output into the judge — the same
    // constraint the Tournament semifinals carry winner artifacts to work
    // around. A judge told to read a bar that is not in front of it would apply
    // whatever bar it invented instead, and every verdict would be unfalsifiable.
    expect(
      definition.edges
        .filter((edge) => edge.targetContextId === REVIEW)
        .map((edge) => edge.sourceContextId),
    ).toEqual([DRAFT]);

    const draftSchema = definition.executionContexts.find(
      (context) => context.id === DRAFT,
    )?.outputSchema as
      | { required?: unknown; properties?: Record<string, unknown> }
      | undefined;
    expect(
      draftSchema?.required,
      "the draft does not carry the exit bar forward to the judge",
    ).toEqual(expect.arrayContaining(["exitBar"]));

    // And the judge is told where it actually is, rather than pointed at an
    // "Inputs from upstream" section the brief's output never reaches.
    const reviewInstructions = definition.tasks
      .filter((task) => task.contextId === REVIEW)
      .map((task) => task.instructions)
      .join("\n");
    expect(reviewInstructions).not.toMatch(
      /from the brief's structured output/i,
    );
    expect(reviewInstructions).toMatch(/exit bar/i);
  });

  it("puts that exit bar in the judge's actual prompt, and never the brief's own output", async () => {
    await runLoopPattern({ current: approveOnPass(1) }, async (run) => {
      // The plan assertion above says the contract carries the bar; this says
      // the engine actually delivered it. Read off the rendered prompt, which
      // is the only place the judge's real inputs can be observed.
      const judgePrompt = run.prompts.get(reviewId(1)) ?? "";
      expect(judgePrompt, "the judge was never dispatched").not.toBe("");
      expect(
        judgePrompt.includes(EXIT_BAR),
        "the exit bar never reached the judge's prompt",
      ).toBe(true);

      // ...and it arrived via the draft, not the brief: the brief's own output
      // is not injected here, so its objective — which only the brief banks —
      // must be absent. Otherwise this would pass for the wrong reason, on a
      // boundary input the loop does not actually provide.
      expect(judgePrompt).not.toContain(
        "Cut the cold-start cost of the projection cache",
      );
      return null;
    });
  }, 120_000);
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
