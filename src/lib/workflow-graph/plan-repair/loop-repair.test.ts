/**
 * The D4 loop extensions to plan repair (R12.1, R12.2): `loop_limit_reached`
 * joining the trigger table under the loop's OWN seed-resolved policy, the
 * three loop-control ops joining the allowlist, and the fail-closed refusals
 * that keep membership, structural and backstop edits out of a repair agent's
 * reach.
 *
 * The freeze rules those ops answer to — quiescence, the required rationale,
 * non-retroactivity, and the resume re-decision — are pinned in
 * `loop-template-freeze.test.ts`; this file pins the REPAIR path into them.
 */

import { describe, expect, it } from "vitest";
import { applyLiveExecutionEdits } from "../runtime-edits";
import {
  P1_JUDGE,
  P1_WORKER,
  completeContext,
  executionFor,
  makeLiveEditDeps,
  runPass,
  workerJudgeDefinition,
} from "../loop-test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  PlanRepairRound,
} from "../schemas";
import {
  expandPlanRepairOperations,
  validatePlanRepairOperations,
} from "./schemas";
import { evaluatePlanRepairTrigger } from "./trigger";

function loopHalt(
  overrides: Partial<
    Extract<GraphWorkflowHaltReason, { type: "loop_limit_reached" }>
  > = {},
): GraphWorkflowHaltReason {
  return {
    type: "loop_limit_reached",
    scope: "loop",
    loopGroupId: "refine",
    pass: 3,
    maxPasses: 3,
    verdict: "unsatisfied",
    passCount: 3,
    totalPassCount: 3,
    contextId: "refine__p3__judge",
    message: 'loop "refine" reached its 3-pass budget',
    summary: null,
    ...overrides,
  };
}

function round(
  seq: number,
  overrides: Partial<PlanRepairRound> = {},
): PlanRepairRound {
  return {
    seq,
    contextId: "refine__p1__judge",
    haltType: "loop_limit_reached",
    loopGroupId: "refine",
    startedAt: "2026-08-04T00:00:00.000Z",
    settledAt: null,
    outcome: null,
    planningDefect: null,
    diagnosis: null,
    operationCount: 0,
    resumed: false,
    conversationId: null,
    ...overrides,
  };
}

function haltedLoopExecution(
  halt: GraphWorkflowHaltReason = loopHalt(),
  planRepairRounds: PlanRepairRound[] = [],
): GraphWorkflowExecution {
  return {
    ...executionFor(workerJudgeDefinition()),
    status: "halted",
    haltReason: halt,
    planRepairRounds,
  };
}

const LOOSENED_PREDICATE = {
  schema: {
    type: "object",
    properties: { notes: { type: "string" } },
    required: ["notes"],
  },
};

/** The loop context the supervisor derives from an eligible loop trigger. */
const REFINE_LOOP = { loopGroupId: "refine", scope: "loop" } as const;

describe("the loop_limit_reached trigger (R12.1)", () => {
  it("fires on a loop halt, naming the loop and its seed-resolved policy", () => {
    const verdict = evaluatePlanRepairTrigger(haltedLoopExecution());

    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.haltType).toBe("loop_limit_reached");
    expect(verdict.loopGroupId).toBe("refine");
    expect(verdict.loopScope).toBe("loop");
    expect(verdict.attempt).toBe(1);
    // Resolved onto the GROUP at seed (decision D10), not read off the pass
    // instance's context — that context is a clone with its own policy copy.
    expect(verdict.policy.maxAttemptsPerContext).toBe(2);
  });

  it("fires on a backstop halt too — a predicate or template amendment is still a remedy", () => {
    const verdict = evaluatePlanRepairTrigger(
      haltedLoopExecution(loopHalt({ scope: "execution", totalPassCount: 25 })),
    );

    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.loopScope).toBe("execution");
  });

  it("keys attempt accounting on the loop group, not the pass instance", () => {
    // Each pass instance is a FRESH context, so counting per context would
    // hand every pass a brand-new budget of repairs.
    const verdict = evaluatePlanRepairTrigger(
      haltedLoopExecution(loopHalt(), [
        round(1, { contextId: "refine__p1__judge" }),
      ]),
    );

    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.attempt).toBe(2);
  });

  it("does not count another loop's rounds, nor a context halt's, toward this loop", () => {
    const verdict = evaluatePlanRepairTrigger(
      haltedLoopExecution(loopHalt(), [
        round(1, { loopGroupId: "other-loop" }),
        round(2, {
          haltType: "circuit_breaker",
          loopGroupId: null,
          contextId: "seed",
        }),
      ]),
    );

    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.attempt).toBe(1);
  });

  it("exhausts after the loop's own attempt budget", () => {
    expect(
      evaluatePlanRepairTrigger(
        haltedLoopExecution(loopHalt(), [round(1), round(2)]),
      ),
    ).toEqual({ eligible: false, reason: "context_attempts_exhausted" });
  });

  it("does not fire when the loop group disables planRepair", () => {
    const base = haltedLoopExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      workingDefinition: {
        ...base.workingDefinition,
        loopGroups: base.workingDefinition.loopGroups?.map((group) => ({
          ...group,
          planRepair: { enabled: false, maxAttemptsPerContext: 2 },
        })),
      },
    };

    expect(evaluatePlanRepairTrigger(execution)).toEqual({
      eligible: false,
      reason: "disabled",
    });
  });

  it("reports an unknown loop group distinctly", () => {
    expect(
      evaluatePlanRepairTrigger(
        haltedLoopExecution(loopHalt({ loopGroupId: "no-such-loop" })),
      ),
    ).toEqual({ eligible: false, reason: "unknown_loop_group" });
  });
});

describe("the loop-control op allowlist (R12.1)", () => {
  it("admits the three loop-control ops on a loop halt", () => {
    const result = validatePlanRepairOperations(
      [
        { type: "raise-loop-max-passes", loopGroupId: "refine", maxPasses: 5 },
        {
          type: "amend-loop-predicate",
          loopGroupId: "refine",
          until: LOOSENED_PREDICATE,
          rationale: "the judge's bar cannot be met without a spec change",
        },
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
      ],
      [],
      REFINE_LOOP,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations.map((operation) => operation.type)).toEqual([
      "raise-loop-max-passes",
      "amend-loop-predicate",
      "edit-loop-template",
    ]);
  });

  it("refuses loop-control ops fail-closed when the halt is not a loop halt", () => {
    // The default is no-loop-context, so a caller that forgets to thread the
    // trigger's loop through refuses the ops rather than admitting them.
    const result = validatePlanRepairOperations([
      { type: "raise-loop-max-passes", loopGroupId: "refine", maxPasses: 5 },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("loop_limit_reached");
  });

  it("refuses a loop-control op addressed at a different loop group", () => {
    const result = validatePlanRepairOperations(
      [
        {
          type: "raise-loop-max-passes",
          loopGroupId: "some-other-loop",
          maxPasses: 5,
        },
      ],
      [],
      REFINE_LOOP,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("some-other-loop");
  });

  it("refuses a cap raise on a backstop halt — the execution backstop is unraisable", () => {
    const result = validatePlanRepairOperations(
      [{ type: "raise-loop-max-passes", loopGroupId: "refine", maxPasses: 5 }],
      [],
      { loopGroupId: "refine", scope: "execution" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/backstop/i);

    // The other two remain the remedy for a backstop halt.
    expect(
      validatePlanRepairOperations(
        [
          {
            type: "amend-loop-predicate",
            loopGroupId: "refine",
            until: LOOSENED_PREDICATE,
            rationale: "conclude the running loops so the budget frees up",
          },
        ],
        [],
        { loopGroupId: "refine", scope: "execution" },
      ).ok,
    ).toBe(true);
  });

  it("refuses a predicate amendment carrying no rationale", () => {
    const result = validatePlanRepairOperations(
      [
        {
          type: "amend-loop-predicate",
          loopGroupId: "refine",
          until: LOOSENED_PREDICATE,
        },
      ],
      [],
      REFINE_LOOP,
    );

    expect(result.ok).toBe(false);
  });

  it("refuses every membership and structural op fail-closed", () => {
    // Membership, addressed through the template vocabulary...
    for (const nested of [
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
    ]) {
      expect(
        validatePlanRepairOperations(
          [
            {
              type: "edit-loop-template",
              loopGroupId: "refine",
              operations: [nested],
            },
          ],
          [],
          REFINE_LOOP,
        ).ok,
        `${nested.type} must be refused inside a template edit`,
      ).toBe(false);
    }

    // ...and structural ops addressed at the scheduled graph directly, plus
    // the engine-only unroll op, which no agent may ever emit.
    for (const operation of [
      {
        type: "add-context",
        id: "reviewer",
        title: "R",
        acceptanceCriteria: "x",
      },
      { type: "remove-context", contextId: "judge" },
      { type: "add-edge", sourceContextId: "seed", targetContextId: "publish" },
      { type: "remove-edge", edgeId: "seed__worker" },
      { type: "update-edge", edgeId: "seed__worker", guard: null },
      { type: "materialize-loop-pass", loopGroupId: "refine", pass: 4 },
    ]) {
      expect(
        validatePlanRepairOperations([operation], [], REFINE_LOOP).ok,
        `${operation.type} must be refused fail-closed`,
      ).toBe(false);
    }
  });
});

describe("validated repair ops apply through the live-edit core (R12.1)", () => {
  it("raises the cap and amends the predicate on a real tripped loop", () => {
    // Trip a REAL loop: one pass, one failing verdict, budget gone.
    let execution = executionFor(
      workerJudgeDefinition(undefined, { maxPasses: 1 }),
    );
    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail", notes: "not yet" });
    const tripped = runPass(execution);

    expect(tripped.halt).toMatchObject({
      type: "loop_limit_reached",
      scope: "loop",
      loopGroupId: "refine",
    });

    const halted: GraphWorkflowExecution = {
      ...tripped.execution,
      status: "halted",
      haltReason: tripped.halt,
    };

    // The supervisor's exact chain: trigger → validate → apply.
    const trigger = evaluatePlanRepairTrigger(halted);
    expect(trigger.eligible).toBe(true);
    if (!trigger.eligible || trigger.loopGroupId === null) return;

    const validated = validatePlanRepairOperations(
      [
        { type: "raise-loop-max-passes", loopGroupId: "refine", maxPasses: 3 },
        {
          type: "amend-loop-predicate",
          loopGroupId: "refine",
          until: LOOSENED_PREDICATE,
          rationale: "recorded notes are the real exit condition",
        },
      ],
      halted.workingDefinition.executionContexts,
      { loopGroupId: trigger.loopGroupId, scope: trigger.loopScope ?? "loop" },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const expanded = expandPlanRepairOperations(
      validated.operations,
      halted.workingDefinition.executionContexts,
    );
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;

    const applied = applyLiveExecutionEdits(
      halted,
      { operations: expanded.operations, source: "plan-repair" },
      makeLiveEditDeps(),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const group = applied.execution.workingDefinition.loopGroups?.[0];
    expect(group?.maxPasses).toBe(3);
    expect(group?.until).toEqual(LOOSENED_PREDICATE);
    // Both control ops bumped the revision, which is what makes the resume
    // re-decide the pass that already had a verdict (D10).
    expect(applied.execution.loopStates["refine"]?.loopControlRevision).toBe(2);
    expect(
      applied.execution.loopControlAmendments.map((entry) => ({
        kind: entry.kind,
        source: entry.source,
        rationale: entry.rationale,
      })),
    ).toEqual([
      { kind: "raise-max-passes", source: "plan-repair", rationale: null },
      {
        kind: "amend-predicate",
        source: "plan-repair",
        rationale: "recorded notes are the real exit condition",
      },
    ]);

    // Resume re-decides the final pass under the amended predicate.
    const resumed = runPass({ ...applied.execution, status: "running" });
    expect(resumed.halt).toBeNull();
    expect(resumed.execution.loopStates["refine"]?.activation).toBe(
      "concluded",
    );
  });
});
