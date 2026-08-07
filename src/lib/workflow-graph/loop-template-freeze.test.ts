import { describe, expect, it } from "vitest";
import { workflowLiveEditOperationSchema } from "@/lib/workflows/edit-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { applyLiveExecutionEdits } from "./runtime-edits";
import {
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
  workerJudgeDefinition,
} from "./loop-test-fixtures";

/**
 * A running loop at pass 1: the seed landed, the loop activated, and pass 1's
 * body is live. Every freeze rule is stated against a STARTED loop (R11.2), so
 * the fixture drives one rather than asserting against a dormant declaration.
 */
function startedLoop(maxPasses = 3): GraphWorkflowExecution {
  const execution = executionFor(
    workerJudgeDefinition(undefined, { maxPasses }),
  );
  completeContext(execution, "seed");
  return runPass(execution).execution;
}

/** Drive one pass to a failing verdict, unrolling the next one. */
function failPass(
  execution: GraphWorkflowExecution,
  worker: string,
  judge: string,
  notes = "another round",
): ReturnType<typeof runPass> {
  completeContext(execution, worker);
  completeContext(execution, judge, { verdict: "fail", notes });
  return runPass(execution);
}

function quiesce(
  execution: GraphWorkflowExecution,
  status: "paused" | "halted",
  haltReason: GraphWorkflowExecution["haltReason"] = null,
): GraphWorkflowExecution {
  return { ...execution, status, haltReason };
}

function apply(
  execution: GraphWorkflowExecution,
  operations: unknown[],
): ReturnType<typeof applyLiveExecutionEdits> {
  const parsed = operations.map((operation) =>
    workflowLiveEditOperationSchema.parse(operation),
  );
  return applyLiveExecutionEdits(
    execution,
    { operations: parsed, source: "cli" },
    makeLiveEditDeps(),
  );
}

function issueCodes(result: ReturnType<typeof applyLiveExecutionEdits>): {
  code: string;
  issues: string[];
} {
  if (result.ok) throw new Error("expected the batch to be refused");
  return {
    code: result.code,
    issues: result.issues.map((issue) => issue.code),
  };
}

describe("template membership freeze (R11.2)", () => {
  it("cannot express a membership change: the template vocabulary carries content ops only", () => {
    const membershipAttempts = [
      {
        type: "add-context",
        id: "reviewer",
        title: "R",
        acceptanceCriteria: "x",
      },
      { type: "remove-context", contextId: "worker" },
      { type: "add-edge", sourceContextId: "worker", targetContextId: "judge" },
      { type: "remove-edge", edgeId: "worker__judge" },
      { type: "move-task", taskId: "task-worker", targetContextId: "judge" },
    ];

    for (const operation of membershipAttempts) {
      expect(
        workflowLiveEditOperationSchema.safeParse({
          type: "edit-loop-template",
          loopGroupId: "refine",
          operations: [operation],
        }).success,
        `${operation.type} must be unrepresentable inside a template edit`,
      ).toBe(false);
    }

    // Nor may a template edit reach a control block — the template's editable
    // surface is prose, acceptance criteria and tasks (R12).
    expect(
      workflowLiveEditOperationSchema.safeParse({
        type: "edit-loop-template",
        loopGroupId: "refine",
        operations: [
          {
            type: "update-context",
            contextId: "worker",
            contextValidator: null,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a template-content edit while the execution is running", () => {
    const execution = startedLoop();

    const refusal = issueCodes(
      apply(execution, [
        {
          type: "edit-loop-template",
          loopGroupId: "refine",
          operations: [
            {
              type: "update-context",
              contextId: "worker",
              acceptanceCriteria: "Ship the narrower slice",
            },
          ],
        },
      ]),
    );

    expect(refusal.code).toBe("requires_pause");
  });

  it("accepts a template-content edit at quiescence, bumps the version, and clones it into the next pass", () => {
    let execution = startedLoop();

    const edited = apply(quiesce(execution, "paused"), [
      {
        type: "edit-loop-template",
        loopGroupId: "refine",
        operations: [
          {
            type: "update-context",
            contextId: "worker",
            acceptanceCriteria: "Ship the narrower slice",
          },
          {
            type: "add-task",
            id: "task-review",
            contextId: "worker",
            title: "Re-read the judge notes",
            instructions: "Start from the prior pass's notes.",
          },
        ],
      },
    ]);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    execution = { ...edited.execution, status: "running" };

    const group = execution.workingDefinition.loopGroups?.[0];
    expect(group?.templateVersion).toBe(2);
    expect(
      group?.template.contexts.find((entry) => entry.id === "worker")
        ?.acceptanceCriteria,
    ).toBe("Ship the narrower slice");
    expect(group?.template.tasks.map((entry) => entry.id)).toContain(
      "task-review",
    );

    // Already-materialized pass 1 is untouched: a template edit reaches the
    // passes cloned AFTER it, never the ones already running.
    expect(
      execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === P1_WORKER,
      )?.acceptanceCriteria,
    ).toBe("worker is done");

    execution = failPass(execution, P1_WORKER, P1_JUDGE).execution;

    expect(
      execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === P2_WORKER,
      )?.acceptanceCriteria,
    ).toBe("Ship the narrower slice");
    expect(
      execution.workingDefinition.tasks
        .filter((entry) => entry.contextId === P2_WORKER)
        .map((entry) => entry.id),
    ).toContain("refine__p2__task-review");

    // Every pass records the template version it cloned.
    expect(execution.loopStates["refine"]?.passTemplateVersions).toEqual({
      "1": 1,
      "2": 2,
    });
  });

  it("records the accepted template edit as an audited loop-control amendment (D10)", () => {
    const execution = startedLoop();

    const edited = apply(quiesce(execution, "paused"), [
      {
        type: "edit-loop-template",
        loopGroupId: "refine",
        operations: [
          {
            type: "update-context",
            contextId: "worker",
            acceptanceCriteria: "Ship the narrower slice",
          },
        ],
      },
    ]);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    // D10 admits no exception: EVERY accepted loop-control op bumps the control
    // revision, the template edit included.
    expect(edited.execution.loopStates["refine"]?.loopControlRevision).toBe(1);
    expect(edited.execution.loopControlAmendments).toEqual([
      {
        seq: 1,
        loopGroupId: "refine",
        kind: "edit-template",
        rationale: null,
        loopControlRevision: 1,
        templateVersion: 2,
        maxPasses: 3,
        source: "cli",
        amendedAt: NOW,
      },
    ]);
  });

  it("refuses an edit addressed at a completed pass instance", () => {
    let execution = startedLoop();
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail", notes: "again" });
    execution = quiesce(runPass(execution).execution, "paused");

    // Directly, through the ordinary context vocabulary...
    expect(
      issueCodes(
        apply(execution, [
          {
            type: "update-context",
            contextId: P1_JUDGE,
            acceptanceCriteria: "Rewritten after the fact",
          },
        ]),
      ),
    ).toMatchObject({ code: "frozen", issues: ["context-frozen"] });

    // ...and through the template vocabulary, which only addresses template ids.
    expect(
      issueCodes(
        apply(execution, [
          {
            type: "edit-loop-template",
            loopGroupId: "refine",
            operations: [
              {
                type: "update-context",
                contextId: P1_JUDGE,
                acceptanceCriteria: "Rewritten after the fact",
              },
            ],
          },
        ]),
      ).issues,
    ).toContain("unknown-loop-template-context");
  });
});

describe("exit predicate amendment (R11.2, R12.2)", () => {
  const LOOSENED = {
    schema: {
      type: "object",
      properties: { notes: { type: "string" } },
      required: ["notes"],
    },
  };

  it("refuses an amendment carrying no rationale", () => {
    expect(
      workflowLiveEditOperationSchema.safeParse({
        type: "amend-loop-predicate",
        loopGroupId: "refine",
        until: LOOSENED,
      }).success,
    ).toBe(false);
    expect(
      workflowLiveEditOperationSchema.safeParse({
        type: "amend-loop-predicate",
        loopGroupId: "refine",
        until: LOOSENED,
        rationale: "   ",
      }).success,
    ).toBe(false);
  });

  it("refuses an amendment while the execution is running, and while it is merely paused", () => {
    const execution = startedLoop();
    const operation = {
      type: "amend-loop-predicate",
      loopGroupId: "refine",
      until: LOOSENED,
      rationale: "the judge can never say pass without a spec change",
    };

    expect(issueCodes(apply(execution, [operation])).code).toBe(
      "requires_pause",
    );
    expect(
      issueCodes(apply(quiesce(execution, "paused"), [operation])).issues,
    ).toContain("loop-predicate-requires-halt");
  });

  it("accepts an amendment while halted, recording the rationale and bumping the control revision", () => {
    let execution = startedLoop();
    const halt = failPass(execution, P1_WORKER, P1_JUDGE);
    execution = halt.execution;

    const amended = apply(
      quiesce(execution, "halted", {
        type: "loop_limit_reached",
        scope: "loop",
        loopGroupId: "refine",
        pass: 1,
        maxPasses: 3,
        verdict: "unsatisfied",
        passCount: 1,
        totalPassCount: 1,
        contextId: P1_JUDGE,
        message: "budget reached",
        summary: null,
      }),
      [
        {
          type: "amend-loop-predicate",
          loopGroupId: "refine",
          until: LOOSENED,
          rationale: "the judge can never say pass without a spec change",
        },
      ],
    );
    expect(amended.ok).toBe(true);
    if (!amended.ok) return;

    expect(amended.execution.workingDefinition.loopGroups?.[0]?.until).toEqual(
      LOOSENED,
    );
    expect(amended.execution.loopStates["refine"]?.loopControlRevision).toBe(1);
    expect(amended.execution.loopControlAmendments).toEqual([
      {
        seq: 1,
        loopGroupId: "refine",
        kind: "amend-predicate",
        rationale: "the judge can never say pass without a spec change",
        loopControlRevision: 1,
        templateVersion: 1,
        maxPasses: 3,
        source: "cli",
        amendedAt: NOW,
      },
    ]);
  });
});

describe("the pass cap on a started loop (R11.2)", () => {
  it("raises maxPasses and takes effect at the next decision", () => {
    let execution = startedLoop(2);
    execution = failPass(execution, P1_WORKER, P1_JUDGE).execution;

    // Pass 2 exhausts the declared budget.
    completeContext(execution, P2_WORKER);
    completeContext(execution, P2_JUDGE, { verdict: "fail", notes: "again" });
    const exhausted = runPass(execution);
    execution = exhausted.execution;
    expect(exhausted.halt).toMatchObject({
      type: "loop_limit_reached",
      scope: "loop",
      loopGroupId: "refine",
      maxPasses: 2,
    });

    const raised = apply(quiesce(execution, "halted", exhausted.halt), [
      { type: "raise-loop-max-passes", loopGroupId: "refine", maxPasses: 4 },
    ]);
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;
    expect(raised.execution.workingDefinition.loopGroups?.[0]?.maxPasses).toBe(
      4,
    );
    expect(raised.execution.loopStates["refine"]?.loopControlRevision).toBe(1);

    // Resume: the same exit output is re-decided under the raised cap.
    const resumed = runPass({ ...raised.execution, status: "running" });
    expect(resumed.halt).toBeNull();
    expect(resumed.materialized.map((request) => request.nextPass)).toEqual([
      3,
    ]);
    expect(
      resumed.execution.workingDefinition.executionContexts.map(
        (entry) => entry.id,
      ),
    ).toContain(P3_WORKER);
  });

  it("refuses a cap that does not raise the budget", () => {
    let execution = startedLoop(3);
    execution = quiesce(execution, "paused");

    expect(
      issueCodes(
        apply(execution, [
          {
            type: "raise-loop-max-passes",
            loopGroupId: "refine",
            maxPasses: 2,
          },
        ]),
      ).issues,
    ).toContain("loop-max-passes-not-raised");
  });

  it("refuses a cap above the unraisable execution backstop", () => {
    const execution = quiesce(startedLoop(3), "paused");

    expect(
      issueCodes(
        apply(execution, [
          {
            type: "raise-loop-max-passes",
            loopGroupId: "refine",
            maxPasses: 26,
          },
        ]),
      ).issues,
    ).toContain("loop-max-passes-exceeds-backstop");
  });
});

describe("trip → repair → resume re-decision (R12.2)", () => {
  it("re-decides the final pass under an amended predicate with no cap raise, and keeps prior verdicts", () => {
    let execution = startedLoop(3);
    execution = failPass(execution, P1_WORKER, P1_JUDGE, "pass 1").execution;
    execution = failPass(execution, P2_WORKER, P2_JUDGE, "pass 2").execution;

    completeContext(execution, P3_WORKER);
    completeContext(execution, P3_JUDGE, { verdict: "fail", notes: "pass 3" });
    const tripped = runPass(execution);
    execution = tripped.execution;
    expect(tripped.halt).toMatchObject({
      type: "loop_limit_reached",
      scope: "loop",
      pass: 3,
      verdict: "unsatisfied",
    });

    const priorDecisions = execution.loopStates["refine"]?.decisions;
    expect(priorDecisions?.["1"]).toMatchObject({
      verdict: "unsatisfied",
      outcome: "materialized",
      loopControlRevision: 0,
    });
    expect(priorDecisions?.["2"]).toMatchObject({
      verdict: "unsatisfied",
      outcome: "materialized",
      loopControlRevision: 0,
    });

    const repaired = apply(quiesce(execution, "halted", tripped.halt), [
      {
        type: "amend-loop-predicate",
        loopGroupId: "refine",
        until: {
          schema: {
            type: "object",
            properties: { notes: { type: "string" } },
            required: ["notes"],
          },
        },
        rationale:
          "the judge's pass bar needs a spec change; recorded notes are the real exit condition",
      },
    ]);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;

    // Resume: no cap was raised, so only the amended predicate can move this.
    const resumed = runPass({ ...repaired.execution, status: "running" });
    expect(resumed.halt).toBeNull();
    expect(resumed.materialized).toEqual([]);

    const state = resumed.execution.loopStates["refine"];
    expect(state?.activation).toBe("concluded");
    expect(state?.concludingExitContextId).toBe(P3_JUDGE);
    expect(state?.decisions["3"]).toMatchObject({
      verdict: "satisfied",
      outcome: "concluded",
      loopControlRevision: 1,
    });

    // Non-retroactive: the passes that already ran keep the verdicts they ran
    // under, at the control revision they were decided at.
    expect(state?.decisions["1"]).toEqual(priorDecisions?.["1"]);
    expect(state?.decisions["2"]).toEqual(priorDecisions?.["2"]);
  });
});
