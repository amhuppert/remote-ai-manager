import { changed } from "@/lib/workflow-graph/execution-mutation";
/**
 * The ENGINE's reaction to a plan-defect round conclusion, driven through the
 * production orchestrator: a durable, resumable halt, and nothing else.
 *
 * "Nothing else" is the whole claim. The reopen loop is what this response
 * exists to escape, so a defect that reopened a task would hand an implementer
 * a contract it has no authority over; a defect that charged a consecutive
 * failure would trip the circuit breaker for a reason no reviewer raised; and a
 * defect that FINISHED the context would certify work a blocking seat just
 * called unsatisfiable — the worst of the three, because `completed` is
 * terminal and nothing downstream can take it back.
 *
 * Halts are recorded here through the real signal-halt handler
 * (`productionSignalHalt`), not the harness's one-write fake. Production
 * records a PENDING halt and leaves the execution running for the loop to
 * drain, so the iteration keeps going after the halt — and that window is
 * exactly where the finalizer would otherwise complete the context.
 */

import { describe, expect, it } from "vitest";
import {
  createCohortExecution,
  createHarness,
  failResult,
  metadata,
  NOW,
  planDefectResult,
  PLAN_DEFECT,
  type Harness,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { isResumableHalt } from "@/lib/workflow-graph/lifecycle-classifier";
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
 * One seat reports a defect while the other rejects the work outright. The
 * sibling's rejection is what makes the halt's precedence visible: an engine
 * that concluded on it would reopen `task-plan-1` and charge a failure.
 */
function defectAndRejectionHarness(): Harness {
  return createHarness({
    execution: createCohortExecution({ assignmentIds: COHORT_OF_TWO }),
    productionSignalHalt: true,
    runContextValidator: async (input) =>
      runResult(
        input.validator.id === "general"
          ? planDefectResult("general", ["task-plan-1"])
          : failResult("security-reviewer", ["task-plan-1"]),
        input.roundToken ?? null,
      ),
  });
}

describe("a plan-defect conclusion halts the run and touches nothing else", () => {
  it("records a plan_defect halt carrying the context and every defecting seat's finding", async () => {
    const harness = defectAndRejectionHarness();

    await harness.run();

    // Recorded the way every context halt is: a PENDING reason the loop drains,
    // written through the production halt path rather than assembled here.
    const halted = harness.repository.read();
    expect(halted.pendingHaltReason).toEqual({
      type: "plan_defect",
      contextId: "context-plan",
      planDefects: [{ ...PLAN_DEFECT, assignmentId: "general" }],
      roundSeq: 1,
      summary: null,
    });
    // Resumable, because the remedy is a repair of the contract the defect
    // names — the reviewed work is intact and nothing here is terminal.
    expect(isResumableHalt(halted.pendingHaltReason!)).toBe(true);
  });

  it("reopens no task, charges no failure, and spends no further iteration", async () => {
    const harness = defectAndRejectionHarness();
    const before = harness.contextState();

    await harness.run();

    // Two seats asked for `task-plan-1` to be redone — one as evidence beside
    // its defect, one as an outright rejection — and neither may move it.
    expect(harness.repository.read().taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(harness.contextState()?.consecutiveFailureCount).toBe(
      before?.consecutiveFailureCount,
    );
    expect(harness.contextState()?.iterationCount).toBe(before?.iterationCount);
    // No aggregate verdict either: nobody certified this candidate and nobody
    // rejected the WORK, so a result event would tell every consumer that
    // counts verdicts something no reviewer said.
    expect(harness.results()).toEqual([]);
  });

  it("leaves the halted context halted rather than finishing it", async () => {
    const harness = defectAndRejectionHarness();

    await harness.run();

    // The failure mode this pins: with the halt recorded as PENDING the
    // execution is still running, so an iteration that fell through to
    // finalize would find no remaining tasks and mark the context `completed`
    // — certifying a contract a blocking seat just refused, terminally.
    expect(harness.contextState()?.status).toBe("halted");
    expect(harness.repository.read().activeContextIds).not.toContain(
      "context-plan",
    );
  });

  it("admits the implementer the repair's new tasks need, once the resume has retired the round", async () => {
    // The deadlock this ticket is named for (#86). The halt leaves the round
    // open so the repair can read it; a repair that ADDS TASKS then hands back a
    // context that owes work under a round frozen before that work existed. The
    // loop must seed an implementer, and the seed guard refuses while a round
    // still owns the candidate — a throw that escapes as `execution_loop_failed`
    // and re-halts identically on every subsequent resume.
    const harness = defectAndRejectionHarness();
    await harness.run();
    // The pending reason becomes the halt the recovery actually reads.
    await harness.drainAndHalt();

    // What the plan repair leaves behind, applied the way the live-edit core
    // does: a task in the definition and a state to go with it.
    await harness.repository
      .mutateActive(PROJECT_PATH, SESSION_NAME, (execution) => {
        const next = structuredClone(execution);
        next.workingDefinition.tasks = [
          ...next.workingDefinition.tasks,
          {
            id: "task-plan-2",
            contextId: "context-plan",
            order: 2,
            title: "Satisfy the repaired criterion",
            instructions: "Implement what the repaired contract now asks for.",
            // What the live-edit core stamps on a task added under a launched
            // execution, plan repair's included (`runtime-edits.ts:3101`).
            source: "user",
          },
        ];
        next.taskStates["task-plan-2"] = {
          taskId: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        };
        return changed(next);
      })
      .then((mutation) => mutation.execution);

    await harness.resumeHalt();

    // The retirement the resume owes this halt: without it the seed below is
    // refused with "validation round 1 still owns the candidate".
    expect(harness.contextState()?.validationRound?.phase).toBe("concluded");

    // Reaching the implementer dispatch IS the claim: this harness refuses to
    // run one, so its own refusal is the proof that the seed got past the guard.
    // Before the fix the rejection was the guard's instead.
    await expect(harness.run()).rejects.toThrow(/must not run the implementer/);
  });

  it("keeps the frozen candidate and every seat's verdict readable through SQLite", async () => {
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

      // A reader that never saw the write: the post-restart view an operator
      // — or the plan repair that answers the halt — resumes into.
      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const round = reloaded?.contextStates["context-plan"]?.validationRound;
      // Still OPEN, on the candidate it froze: concluding it would discard the
      // reading the recovery has to act on.
      expect(round?.outcome).toBeNull();
      expect(round?.candidate.candidateTreeHash).toBe("tree-a");
      expect(round?.specialists["general"]?.planDefects).toEqual([PLAN_DEFECT]);
      expect(round?.specialists["general"]?.state).toBe("verdict_fail");
      expect(round?.specialists["security-reviewer"]?.issues).toHaveLength(1);
      expect(reloaded?.pendingHaltReason?.type).toBe("plan_defect");
    } finally {
      fixture.close();
    }
  });
});
