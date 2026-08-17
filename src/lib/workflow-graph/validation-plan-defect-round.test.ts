/**
 * What a round does when a blocking seat refuses the CONTRACT rather than the
 * work, driven through the production engine: the real orchestrator, the real
 * validation service, and a fake only at the single-specialist dispatch.
 *
 * Two claims are worth the whole file. A plan defect must reopen NOTHING and
 * charge NOTHING — the reopen loop is the failure this response exists to
 * escape, and a defect that fed the circuit breaker would halt a workflow for a
 * reason no reviewer raised. And the finding has to be durable: the halt an
 * operator resumes and the plan-repair round that answers it both read the
 * defect itself, so a round record that survived with a count instead of the
 * finding would leave the recovery with nothing to act on.
 *
 * The engine-level halt is deliberately absent here; it belongs to the context
 * that follows this one. What is asserted is the conclusion layer's own
 * contract, which that halt is built on top of.
 */

import { describe, expect, it } from "vitest";
import {
  createCohortExecution,
  createHarness,
  failResult,
  metadata,
  NOW,
  passResult,
  planDefectResult,
  PLAN_DEFECT,
  specialistRecord,
  withOpenRound,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import type { ValidatorRunResult } from "@/lib/workflow-graph/validator-runner";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
const COHORT_OF_TWO = ["general", "security-reviewer"] as const;

function runResult(
  result: ValidatorRunResult["result"],
  roundToken: ValidatorRunResult["roundToken"],
): ValidatorRunResult {
  return { result, metadata: metadata(), roundToken };
}

/**
 * A round where the first seat reports a defect and the second rejects the
 * work outright. The sibling's rejection is what makes the precedence visible:
 * an engine that concluded on it would reopen `task-plan-1`.
 */
function defectAndRejectionHarness() {
  return createHarness({
    execution: createCohortExecution({ assignmentIds: COHORT_OF_TWO }),
    runContextValidator: async (input) =>
      runResult(
        input.validator.id === "general"
          ? planDefectResult("general", ["task-plan-1"])
          : failResult("security-reviewer", ["task-plan-1"]),
        input.roundToken ?? null,
      ),
  });
}

describe("a plan-defect round concludes without reopening or charging anything", () => {
  it("records each seat's defects on the round, grouped by the seat that raised them", async () => {
    const harness = defectAndRejectionHarness();

    await harness.run();

    const round = harness.contextState()?.validationRound;
    // The engine's seat stamp rides along on the way in, exactly as it does on
    // a finding; the RECORD's own key is the durable attribution, and the
    // reload below pins the stored shape.
    expect(round?.specialists["general"]?.planDefects).toEqual([
      { ...PLAN_DEFECT, assignmentId: "general" },
    ]);
    // The defecting seat's own findings are kept beside them as evidence, and
    // the rejecting sibling contributes findings but no defect of its own — the
    // record groups both by seat, which is where the attribution lives.
    expect(round?.specialists["general"]?.issues).toHaveLength(1);
    expect(round?.specialists["security-reviewer"]?.planDefects).toBeUndefined();
    expect(round?.specialists["security-reviewer"]?.issues).toHaveLength(1);
  });

  it("reopens no task and charges no consecutive failure, with the sibling's rejection in hand", async () => {
    const harness = defectAndRejectionHarness();
    const before = harness.contextState()?.consecutiveFailureCount;

    await harness.run();

    // Two seats asked for `task-plan-1` to be redone — one as a finding beside
    // its defect, one as an outright rejection — and neither may move it: no
    // task here can remedy a defective contract.
    expect(harness.repository.read().taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(harness.contextState()?.consecutiveFailureCount).toBe(before);
    // No aggregate verdict is published either: nobody certified this candidate
    // and nobody rejected the WORK, so a result event would tell every consumer
    // that counts verdicts something no reviewer said.
    expect(harness.results()).toEqual([]);
    // The round stays open with its verdicts intact, which is what leaves the
    // frozen candidate and every seat's reading readable to the recovery.
    const round = harness.contextState()?.validationRound;
    expect(round?.phase).toBe("specialists");
    expect(round?.outcome).toBeNull();
  });

  it("keeps the defect, the untouched tasks, and the failure count durable through SQLite", async () => {
    const harness = defectAndRejectionHarness();
    await harness.run();

    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      fixture.graphWorkflowExecutions.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        harness.repository.read(),
        NOW,
      );

      // A reader that never saw the write: the post-restart view of the round
      // an operator resumes into.
      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const contextState = reloaded?.contextStates["context-plan"];
      expect(
        contextState?.validationRound?.specialists["general"]?.planDefects,
      ).toEqual([PLAN_DEFECT]);
      expect(reloaded?.taskStates["task-plan-1"]?.status).toBe("completed");
      expect(contextState?.consecutiveFailureCount).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it("rebuilds a stored defect as a defect on resume, without re-dispatching the seat", async () => {
    // The other half of durability: a record read back has to decide the round
    // the way the verdict that wrote it did. A lane rebuilt as an ordinary
    // rejection would derive a reopen from the findings stored beside the
    // defect — the reaction the response exists to prevent, arriving one crash
    // later.
    const harness = createHarness({
      execution: withOpenRound(
        createCohortExecution({ assignmentIds: COHORT_OF_TWO }),
        {
          specialists: {
            general: specialistRecord({
              state: "verdict_fail",
              attempts: 1,
              summary: "general cannot satisfy the assigned contract.",
              issues: [
                {
                  taskId: "task-plan-1",
                  title: "general on task-plan-1",
                  description: "general saw a problem in task-plan-1.",
                },
              ],
              planDefects: [PLAN_DEFECT],
            }),
            "security-reviewer": specialistRecord({ state: "pending" }),
          },
        },
      ),
      runContextValidator: async (input) =>
        runResult(passResult(input.validator.id), input.roundToken ?? null),
    });

    await harness.run();

    // Only the lane that never settled ran again.
    expect(
      harness.runContextValidator.mock.calls.map(
        (call) => call[0].validator.id,
      ),
    ).toEqual(["security-reviewer"]);
    // And the stored defect still decided the round: the passing sibling did
    // not turn it into a certification, and its findings reopened nothing.
    expect(harness.repository.read().taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(harness.contextState()?.consecutiveFailureCount).toBe(1);
    expect(harness.results()).toEqual([]);
  });
});
