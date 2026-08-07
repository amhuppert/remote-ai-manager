import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runEngineScenario } from "@/lib/workflow-graph/compat/engine-harness";
import { lintGuardEnumCoverage } from "@/lib/workflow-graph/edge-guard-validation";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import { activeDependencySourceIds } from "@/lib/workflow-graph/route-projection";
import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { EngineScenarioRun } from "@/lib/workflow-graph/compat/engine-harness";

/**
 * Pattern proof: Classify-And-Act (D4 R15.1).
 *
 * `classify-and-act.plan.json` is a REAL template — the same `{name,
 * description, definition, layout}` document `cctl workflow validate --file`
 * posts — carrying nothing D4-specific beyond an `outputSchema`, three guarded
 * outgoing edges (one of them the `else` fallback) and a fan-in. It is admitted
 * here through the production authoring path, then executed through the engine
 * harness, so the claim "this pattern is expressible as an ordinary template"
 * rests on an artifact an author could actually submit rather than on a fixture
 * shaped to the assertions.
 *
 * Everything that decides the routing is production code: the loop's settlement
 * pass, the projection, the scheduler, lane readiness, the joins, the completion
 * invariant, the typed-event publisher and the execution repository over real
 * SQLite. Only the agent turn, the validator verdict and the git side effects
 * are faked, and none of them decides a route — the classifier's verdict reaches
 * the engine the same way a real one does, as a captured structured output.
 *
 * The live mini-execution R15 also asks for belongs to the closeout task; this
 * is the deterministic half.
 */

const PLAN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "classify-and-act.plan.json",
);

const TRIAGE = "ctx-triage";
const HOTFIX = "ctx-hotfix";
const REPAIR = "ctx-repair";
const BACKLOG = "ctx-backlog";
const REPORT = "ctx-report";

/** The classifier's outgoing edges, in the order the template declares them. */
const TO_HOTFIX = "ctx-triage__ctx-hotfix";
const TO_REPAIR = "ctx-triage__ctx-repair";
const TO_BACKLOG = "ctx-triage__ctx-backlog";

const SEVERITIES = ["blocker", "defect", "enhancement", "not-a-bug"];

interface AcceptedTemplate {
  definition: WorkflowSemanticDefinition;
  warnings: WorkflowPlanIssue[];
}

/**
 * The committed template, through the one function the create, replace and
 * `graph-workflow/validate` paths all call. A plan this accepts is exactly a
 * plan `cctl workflow create` accepts.
 */
function acceptTemplate(): AcceptedTemplate {
  const plan: unknown = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
  const validation = validateWorkflowPlan(plan);
  if (!validation.ok) {
    throw new Error(
      `classify-and-act.plan.json is not an acceptable plan:\n${validation.issues
        .map((issue) => `  ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  return {
    definition: validation.draft.definition,
    warnings: validation.warnings,
  };
}

/**
 * Run the template with a scripted triage verdict. Every context completes its
 * task on its first turn, so the only thing that varies between scenarios — and
 * therefore the only thing that can explain a different outcome — is the
 * classifier's captured `severity`.
 */
async function runTriage<T>(
  scenarioName: string,
  severity: string,
  inspect: (run: EngineScenarioRun) => Promise<T>,
): Promise<T> {
  return runEngineScenario(
    {
      name: scenarioName,
      definition: acceptTemplate().definition,
      sessionLaneEnabled: false,
      agent: () => "complete-next-task",
      capture: ({ contextId }) =>
        contextId === TRIAGE
          ? {
              severity,
              rationale: `Scripted triage verdict for the ${severity} scenario`,
            }
          : null,
    },
    inspect,
  );
}

interface Branch {
  contextId: string;
  edgeId: string;
}

function dispatchedContextIds(run: EngineScenarioRun): string[] {
  return run.recording.scheduling.flatMap((decision) =>
    decision.decision === "dispatched" ? [decision.contextId] : [],
  );
}

function laneIdOf(
  settled: GraphWorkflowExecution,
  contextId: string,
): string | null {
  return settled.contextStates[contextId]?.laneId ?? null;
}

/**
 * The whole R15.1 claim, asserted identically whichever branch the verdict
 * selects: one branch ran, its siblings are terminally skipped with the reason
 * recorded, the fan-in ran on the taken branch, the run completed and published,
 * and the durable settlement plus the event ledger say all of that on their own.
 *
 * `declined` is given in the template's edge order, which is the order the
 * settlement marker lists them in.
 */
function expectClassifyAndAct(
  run: EngineScenarioRun,
  taken: Branch,
  declined: readonly Branch[],
): void {
  const { settled, events } = run;

  expect(settled.status).toBe("completed");
  expect(settled.haltReason).toBeNull();

  // Exactly one branch activated, and the engine agrees it is exactly one: the
  // classifier declares `exactlyOne`, so an under- or over-selection would have
  // raised a resumable routing halt instead of finishing.
  expect(settled.contextStates[taken.contextId]?.status).toBe("completed");
  const projection = projectExecutionRoutes(settled);
  expect(projection.cardinality).toContainEqual({
    sourceContextId: TRIAGE,
    policy: "exactlyOne",
    conditionalEdgeIds: [TO_HOTFIX, TO_REPAIR, TO_BACKLOG],
    activatedEdgeIds: [taken.edgeId],
    outcome: "satisfied",
  });

  // The siblings are terminally skipped, each carrying the complete verdict set
  // of its incoming edges — a routing decision nobody could reconstruct is not a
  // recorded reason.
  for (const branch of declined) {
    expect(settled.contextStates[branch.contextId]?.status).toBe("skipped");
    expect(
      settled.contextStates[branch.contextId]?.skipReason?.edgeEvaluations,
    ).toEqual([{ edgeId: branch.edgeId, verdict: "inactive" }]);
    // A skipped context is settled with NOTHING: its task never ran, and the
    // completion invariant let the execution finish anyway (R4.1).
    expect(settled.contextStates[branch.contextId]?.completedTaskCount).toBe(0);
    expect(settled.contextStates[branch.contextId]?.totalTaskCount).toBe(1);
  }

  // The fan-in ran, and it ran on the taken branch: its ONE active dependency is
  // the branch that was selected. The declined siblings' edges dropped out of
  // the conjunction rather than vetoing it.
  expect(settled.contextStates[REPORT]?.status).toBe("completed");
  expect(activeDependencySourceIds(projection, REPORT)).toEqual([
    taken.contextId,
  ]);

  // Nothing on an untaken branch was ever dispatched — the skip is a decision
  // the scheduler made before the work, not a status applied after it.
  expect(dispatchedContextIds(run).sort()).toEqual(
    [TRIAGE, taken.contextId, REPORT].sort(),
  );

  // The routing settlement tells the story from durable state alone.
  expect(settled.routeSettlements[TRIAGE]).toMatchObject({
    sourceContextId: TRIAGE,
    captureIteration: 1,
    routeControlRevision: 0,
    activatedEdgeIds: [taken.edgeId],
    inactiveEdgeIds: declined.map((branch) => branch.edgeId),
    omittedEdgeIds: [],
  });

  // ...and so does the event ledger: one route resolution naming the activated
  // edge, one skip per declined branch naming its verdict.
  expect(
    events.filter((event) => event.kind === "graph-workflow-route-resolved"),
  ).toEqual([
    {
      kind: "graph-workflow-route-resolved",
      subject: TRIAGE,
      detail: `r0:${taken.edgeId}`,
    },
  ]);
  expect(
    events.filter((event) => event.kind === "graph-workflow-context-skipped"),
  ).toEqual(
    declined.map((branch) => ({
      kind: "graph-workflow-context-skipped",
      subject: branch.contextId,
      detail: `${branch.edgeId}:inactive`,
    })),
  );

  // It published, and the publication carries the lanes that ran and nothing
  // else: a skipped branch holds no lane and contributes no merge input.
  const finalPublish = Object.values(settled.joins).filter(
    (join) => join.kind === "final_publish",
  );
  expect(finalPublish).toHaveLength(1);
  expect(finalPublish[0]?.status).toBe("succeeded");
  for (const branch of declined) {
    expect(laneIdOf(settled, branch.contextId)).toBeNull();
    expect(finalPublish[0]?.sourceLaneIds).not.toContain(branch.contextId);
  }
}

describe("Classify-And-Act, as an ordinary template (D4 R15.1)", () => {
  it("is a plan the production authoring path accepts with no unrouted enum values", () => {
    const { definition, warnings } = acceptTemplate();

    expect(warnings).toEqual([]);

    const classifier = definition.executionContexts.find(
      (context) => context.id === TRIAGE,
    );
    expect(classifier?.outputSchema).toMatchObject({
      properties: { severity: { enum: SEVERITIES } },
    });
    expect(classifier?.routing?.cardinality).toBe("exactlyOne");

    const outgoing = definition.edges.filter(
      (edge) => edge.sourceContextId === TRIAGE,
    );
    expect(outgoing.map((edge) => edge.id)).toEqual([
      TO_HOTFIX,
      TO_REPAIR,
      TO_BACKLOG,
    ]);
    expect(
      outgoing.filter((edge) => edge.when && "else" in edge.when),
    ).toHaveLength(1);
    expect(
      definition.edges.filter((edge) => edge.targetContextId === REPORT),
    ).toHaveLength(3);
  });

  it("routes its two unnamed severities through the else edge, which is why authoring is warning-free", () => {
    // Drop the fallback and the same template warns about exactly the values no
    // branch names — proof the else edge is load-bearing rather than decorative.
    const { definition } = acceptTemplate();
    const withoutElse = definition.edges.filter(
      (edge) => edge.id !== TO_BACKLOG,
    );

    expect(
      lintGuardEnumCoverage(definition.executionContexts, withoutElse),
    ).toEqual([
      expect.objectContaining({
        code: "uncovered-guard-enum-values",
        contextId: TRIAGE,
        message: expect.stringContaining('"enhancement", "not-a-bug"'),
      }),
    ]);
  });

  it("runs the branch the classifier selected, skips its siblings, fans in and publishes", async () => {
    await runTriage("classify-and-act-defect", "defect", async (run) => {
      expectClassifyAndAct(run, { contextId: REPAIR, edgeId: TO_REPAIR }, [
        { contextId: HOTFIX, edgeId: TO_HOTFIX },
        { contextId: BACKLOG, edgeId: TO_BACKLOG },
      ]);

      // Durable, not an in-memory verdict: reloading through the repository —
      // real SQLite, same database — returns the same terminal routing.
      const reloaded = await run.manager.getActive(
        run.projectPath,
        run.sessionName,
      );
      expect(reloaded?.contextStates[HOTFIX]?.status).toBe("skipped");
      expect(reloaded?.contextStates[BACKLOG]?.status).toBe("skipped");
      expect(reloaded?.routeSettlements[TRIAGE]?.activatedEdgeIds).toEqual([
        TO_REPAIR,
      ]);
    });
  }, 60_000);

  it("takes the else branch when the verdict matches no named branch", async () => {
    await runTriage("classify-and-act-else", "enhancement", async (run) => {
      expectClassifyAndAct(run, { contextId: BACKLOG, edgeId: TO_BACKLOG }, [
        { contextId: HOTFIX, edgeId: TO_HOTFIX },
        { contextId: REPAIR, edgeId: TO_REPAIR },
      ]);
    });
  }, 60_000);

  it("takes the first branch on the severity that names it", async () => {
    await runTriage("classify-and-act-blocker", "blocker", async (run) => {
      expectClassifyAndAct(run, { contextId: HOTFIX, edgeId: TO_HOTFIX }, [
        { contextId: REPAIR, edgeId: TO_REPAIR },
        { contextId: BACKLOG, edgeId: TO_BACKLOG },
      ]);
    });
  }, 60_000);
});
