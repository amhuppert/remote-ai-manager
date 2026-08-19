import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import { structuralWarningsOf } from "./pattern-plan-warnings";
import { runEngineScenario } from "../compat/engine-harness";
import type {
  CompatibilityValidatorTurn,
  CompatibilityValidatorSeat,
  EngineScenarioRun,
} from "../compat/engine-harness";
import { workflowSemanticDefinitionSchema } from "../definition-schemas";
import { concludeCohort, type CohortLane } from "../validation-cohort";
import {
  COHORT_SEATS,
  expectAdversarialCohort,
  settledSpecialists,
} from "./adversarial-cohort-assertions";

/**
 * Pattern proof: Adversarial Verification (D6 R2.3).
 *
 * The vision's version of this pattern is not "add a reviewer" — it is a PANEL:
 * one seat that can send the work back, and specialists whose lens is narrow
 * enough to see what a generalist misses. D3 built that (per-assignment
 * profiles, per-assignment authority); D6's job is to show it composes as an
 * ordinary plan and that the panel's two halves behave differently.
 *
 * So the proof is in three parts: the plan staffs the exact four seats with the
 * exact authorities; a real run gives each seat its own durable identity and a
 * settled verdict against the same candidate; and the blocking seat's findings
 * reopen the worker while an advisory seat's cannot.
 */

const PLAN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "adversarial-verification.plan.json",
);

const WORKER = "context-implement";
const REPORT = "context-report";

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

async function runAdversarial<T>(
  script: (seat: CompatibilityValidatorSeat) => CompatibilityValidatorTurn,
  inspect: (run: EngineScenarioRun) => Promise<T>,
): Promise<T> {
  return runEngineScenario(
    {
      name: "adversarial-verification",
      definition: planDefinition(),
      sessionLaneEnabled: false,
      agent: () => "complete-next-task",
      validator: script,
      capture: ({ contextId }) => {
        if (contextId === REPORT) {
          return {
            verdictSummary:
              "The candidate cleared the panel after one round of rework.",
          };
        }
        // The worker carries the panel's outcome across its own boundary: the
        // validation round is not injected anywhere, so what it does not bank
        // here never reaches the reporter.
        if (contextId === WORKER) {
          return {
            changeSummary: "The change the panel reviewed.",
            blockingFindingsAddressed: [
              {
                finding: "Acceptance criteria not evidenced",
                resolution: "Recorded the verification evidence.",
              },
            ],
            advisories: [
              {
                assignmentId: "security",
                finding: "Prefers a narrower boundary.",
              },
            ],
          };
        }
        return null;
      },
    },
    inspect,
  );
}

/**
 * The worker's blocking seat rejects round 1 and accepts round 2; its
 * specialists observe, and every other context passes.
 *
 * Scoped to the worker's context deliberately: the downstream reporter carries
 * the default cohort, whose seat is also blocking, and a script keyed on
 * authority alone would have that seat try to reopen a task belonging to
 * someone else — which the engine correctly refuses, halting the run.
 */
function rejectFirstRound(taskId: string) {
  return (seat: CompatibilityValidatorSeat): CompatibilityValidatorTurn => {
    if (
      seat.contextId === WORKER &&
      seat.authority === "blocking" &&
      seat.attempt === 1
    ) {
      return { verdict: "fail", reopenTaskIds: [taskId] };
    }
    return {
      verdict: "pass",
      advisories: [
        {
          kind: "implementation",
          title: `${seat.assignmentId} observation`,
          description: `What the ${seat.assignmentId} lens noticed.`,
        },
      ],
    };
  };
}

/**
 * The worker's task id as the ENGINE minted it, discovered by running the plan
 * once with every seat passing.
 *
 * A reopen keyed on an id this test guessed would prove nothing: the engine
 * mints task ids, and a rejection naming an id that does not exist cannot
 * reopen anything, so the run would halt and the halt would look like evidence.
 */
async function discoverWorkerTaskId(): Promise<string> {
  return runAdversarial(
    () => ({ verdict: "pass" }),
    async (run) => {
      const task = Object.values(run.settled.taskStates).find(
        (state) => state.contextId === WORKER,
      );
      expect(task, `no task state for "${WORKER}"`).toBeDefined();
      return task?.taskId ?? "";
    },
  );
}

describe("Adversarial Verification, as an ordinary plan (D6 R2.3)", () => {
  it("staffs the worker with one blocking generalist and three advisory specialists", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(structuralWarningsOf(result.warnings)).toEqual([]);

    expectAdversarialCohort(result.draft.definition, WORKER);
  });

  it("gives every seat its own durable identity and a settled verdict against one candidate", async () => {
    const workerTaskId = await discoverWorkerTaskId();
    expect(workerTaskId).not.toBe("");

    await runAdversarial(rejectFirstRound(workerTaskId), async (run) => {
      const { settled } = run;
      expect(settled.status).toBe("completed");

      // Four seats, four durable specialist records, each with a settled
      // verdict — not one aggregate standing in for a panel.
      const specialists = settledSpecialists(settled, WORKER);
      expect(Object.keys(specialists).sort()).toEqual(
        COHORT_SEATS.map((seat) => seat.id).sort(),
      );
      for (const seat of COHORT_SEATS) {
        expect(specialists[seat.id]?.state).toBe("verdict_pass");
      }

      // The frozen roster names each seat separately, with the library
      // profile and revision it resolved: a cohort keyed by role rather than
      // by seat would collapse four reviewers into one entry here.
      const roster = settled.contextStates[WORKER]?.validationRound?.roster;
      expect(
        roster?.map((entry) => ({
          assignmentId: entry.assignmentId,
          profileId: entry.profileRef.id,
        })),
      ).toEqual(
        COHORT_SEATS.map((seat) => ({
          assignmentId: seat.id,
          profileId: seat.profileId,
        })),
      );
      return null;
    });
  }, 120_000);

  it("reopens the worker on a blocking finding", async () => {
    const workerTaskId = await discoverWorkerTaskId();
    expect(workerTaskId).not.toBe("");

    await runAdversarial(rejectFirstRound(workerTaskId), async (run) => {
      const { settled } = run;

      // The rejection was not merely recorded: the worker was dispatched
      // again. A blocking finding that left the worker at one dispatch would
      // be a finding nobody acted on.
      const workerDispatches = run.recording.scheduling.filter(
        (decision) =>
          decision.decision === "dispatched" && decision.contextId === WORKER,
      );
      expect(workerDispatches.length).toBeGreaterThanOrEqual(2);

      // ...and it converged: the reopened task is complete and the run ended
      // on its own rather than on the iteration cap.
      expect(settled.contextStates[WORKER]?.status).toBe("completed");
      expect(settled.taskStates[workerTaskId]?.status).toBe("completed");
      expect(settled.status).toBe("completed");
      expect(settled.haltReason).toBeNull();
      return null;
    });
  }, 120_000);

  it("gives the reporter a predecessor that carries the panel outcome it must record", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const definition = result.draft.definition;

    // The reporter is asked to record which findings blocked and which
    // advisories were raised. Cohort findings live on the validation ROUND, not
    // in any context's output, and the reporter's only direct predecessor is the
    // worker — so unless the worker carries the outcome forward in its own
    // output, the reporter has nothing to summarize and would invent one.
    expect(
      definition.edges
        .filter((edge) => edge.targetContextId === REPORT)
        .map((edge) => edge.sourceContextId),
    ).toEqual([WORKER]);

    const workerSchema = definition.executionContexts.find(
      (context) => context.id === WORKER,
    )?.outputSchema as
      | { required?: unknown; properties?: Record<string, unknown> }
      | undefined;
    expect(
      workerSchema?.required,
      "the worker carries no panel outcome to the reporter",
    ).toEqual(
      expect.arrayContaining(["blockingFindingsAddressed", "advisories"]),
    );
  });

  it("cannot let an advisory seat fail the round", () => {
    // The production partition, exercised directly: an advisory rejection is
    // structurally incapable of concluding a round as failed, which is what
    // makes adding a specialist safe.
    const lanes: CohortLane[] = [
      {
        assignmentId: "acceptance",
        authority: "blocking",
        attempts: 1,
        settlement: {
          kind: "pass",
          summary: "Meets the criteria",
          feedback: "The candidate satisfies every acceptance criterion.",
          issues: [],
          reopenTaskIds: [],
          sessionRef: null,
          reviewArtifact: null,
        },
      },
      {
        assignmentId: "security",
        authority: "advisory",
        attempts: 1,
        settlement: {
          kind: "fail",
          summary: "Would like a different auth boundary",
          feedback: "Prefers a narrower boundary than the one implemented.",
          issues: [
            {
              // Attribution is part of a finding's identity: an advisory that
              // could not name the seat it came from would be indistinguishable
              // from the blocking seat's, which is what the partition rests on.
              assignmentId: "security",
              taskId: "task-implement-1",
              title: "Auth boundary",
              description: "Prefers a narrower boundary.",
            },
          ],
          reopenTaskIds: ["task-implement-1"],
          sessionRef: null,
          reviewArtifact: null,
        },
      },
    ];

    expect(concludeCohort(lanes).kind).toBe("passed");
  });
});
