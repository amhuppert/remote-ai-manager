import { describe, expect, it } from "vitest";
import {
  derivePlanRepairActivity,
  planRepairStatement,
} from "./derive-plan-repair-activity";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  PlanRepairRound,
} from "@/lib/workflow-graph/schemas";

const NOW = Date.parse("2026-08-25T12:10:00.000Z");

function round(overrides: Partial<PlanRepairRound> = {}): PlanRepairRound {
  return {
    seq: 1,
    contextId: "context-plan",
    haltType: "circuit_breaker",
    loopGroupId: null,
    startedAt: "2026-08-25T12:04:00.000Z",
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

const breakerHalt: GraphWorkflowHaltReason = {
  type: "circuit_breaker",
  contextId: "context-plan",
  condition: "retry_exhaustion",
  failureCount: 3,
  summary: null,
};

function haltedExecution(
  rounds: PlanRepairRound[],
  haltReason: GraphWorkflowHaltReason = breakerHalt,
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "halted",
    haltReason,
    planRepairRounds: rounds,
  });
}

describe("derivePlanRepairActivity", () => {
  it("reports a repair agent as working while its round is unsettled", () => {
    const open = round({ seq: 2 });
    const activity = derivePlanRepairActivity(
      haltedExecution([
        round({
          seq: 1,
          settledAt: "2026-08-25T12:03:00.000Z",
          outcome: "failed",
        }),
        open,
      ]),
      { now: NOW },
    );

    expect(activity.kind).toBe("working");
    expect(activity.openRound).toEqual(open);
    expect(activity.rounds).toHaveLength(2);
  });

  it("reports nothing working once every round has settled", () => {
    const settled = round({
      seq: 1,
      settledAt: "2026-08-25T12:08:00.000Z",
      outcome: "declined",
      diagnosis: "the plan is sound; the validator disagrees with the work",
    });
    const activity = derivePlanRepairActivity(haltedExecution([settled]));

    expect(activity.kind).toBe("stopped");
    expect(activity.openRound).toBeNull();
    expect(activity.rounds).toEqual([settled]);
  });

  it("reports nothing working on a halt repair never ran for", () => {
    const activity = derivePlanRepairActivity(haltedExecution([]));

    expect(activity.kind).toBe("stopped");
    expect(activity.openRound).toBeNull();
    expect(activity.rounds).toEqual([]);
  });

  it("stops believing an open round once its agent's turn budget has elapsed", () => {
    // A server restart mid-turn leaves `settledAt` null forever, and the
    // supervisor bounds the turn — so a round still open long past that budget
    // has no agent behind it, and reporting one is the same lie in reverse.
    const orphaned = round({ seq: 1, startedAt: "2026-08-25T10:00:00.000Z" });
    const activity = derivePlanRepairActivity(haltedExecution([orphaned]), {
      now: NOW,
    });

    expect(activity.kind).toBe("stopped");
    expect(activity.openRound).toBeNull();
    // Still reported as a round of this halt: it was charged an attempt.
    expect(activity.rounds).toEqual([orphaned]);
  });

  it("omits settled rounds that answered a different halt than the standing one", () => {
    // An earlier halt on another context, already repaired and resumed past.
    const stale = round({
      seq: 1,
      contextId: "context-build",
      settledAt: "2026-08-25T11:40:00.000Z",
      outcome: "repaired",
      resumed: true,
    });
    const answering = round({
      seq: 2,
      settledAt: "2026-08-25T12:08:00.000Z",
      outcome: "declined",
    });
    const activity = derivePlanRepairActivity(
      haltedExecution([stale, answering]),
    );

    expect(activity.rounds).toEqual([answering]);
  });

  it("keys a loop halt's rounds on the loop group rather than the pass instance", () => {
    const loopHalt: GraphWorkflowHaltReason = {
      type: "loop_limit_reached",
      loopGroupId: "loop-review",
      contextId: "context-review-pass-3",
      scope: "loop",
      pass: 3,
      maxPasses: 3,
      verdict: "unsatisfied",
      passCount: 3,
      totalPassCount: 3,
      message: "budget exhausted",
      summary: null,
    };
    const earlierPass = round({
      seq: 1,
      haltType: "loop_limit_reached",
      loopGroupId: "loop-review",
      contextId: "context-review-pass-2",
      settledAt: "2026-08-25T11:55:00.000Z",
      outcome: "repaired",
    });

    const activity = derivePlanRepairActivity(
      haltedExecution([earlierPass], loopHalt),
    );

    expect(activity.rounds).toEqual([earlierPass]);
  });
});

describe("planRepairStatement", () => {
  it("says an agent is working, and since when, while a round is open", () => {
    const statement = planRepairStatement(
      derivePlanRepairActivity(haltedExecution([round({ seq: 2 })]), {
        now: NOW,
      }),
      { now: NOW },
    );

    expect(statement.working).toBe(true);
    expect(statement.label).toBe("repair agent working");
    expect(statement.sentence).toContain("6m ago");
    expect(statement.sentence).toContain("context-plan");
  });

  it("says no agent is working, and what the last round decided", () => {
    const statement = planRepairStatement(
      derivePlanRepairActivity(
        haltedExecution([
          round({
            seq: 1,
            settledAt: "2026-08-25T12:08:00.000Z",
            outcome: "declined",
          }),
        ]),
      ),
      { now: NOW },
    );

    expect(statement.working).toBe(false);
    expect(statement.label).toBe("no agent working");
    expect(statement.sentence).toContain("declined");
    expect(statement.sentence).toContain("waiting on you");
  });

  it("names an abandoned round rather than claiming it is still being worked", () => {
    const statement = planRepairStatement(
      derivePlanRepairActivity(
        haltedExecution([
          round({ seq: 1, startedAt: "2026-08-25T10:00:00.000Z" }),
        ]),
        { now: NOW },
      ),
      { now: NOW },
    );

    expect(statement.working).toBe(false);
    expect(statement.sentence).toMatch(/never settled|no agent/i);
    expect(statement.sentence).toContain("waiting on you");
  });

  it("says no agent is working when repair never ran", () => {
    const statement = planRepairStatement(
      derivePlanRepairActivity(haltedExecution([])),
      { now: NOW },
    );

    expect(statement.working).toBe(false);
    expect(statement.sentence).toContain("waiting on you");
  });
});
