import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "../test-fixtures";
import type {
  GraphWorkflowExecution,
  PlanRepairRound,
} from "../schemas";
import { evaluatePlanRepairTrigger } from "./trigger";

function round(
  contextId: string,
  seq: number,
  overrides: Partial<PlanRepairRound> = {},
): PlanRepairRound {
  return {
    seq,
    contextId,
    haltType: "circuit_breaker",
    startedAt: "2026-07-29T00:00:00.000Z",
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

function haltedExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "halted",
    haltReason: {
      type: "circuit_breaker",
      contextId: "context-implement",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    },
    ...overrides,
  });
}

describe("evaluatePlanRepairTrigger", () => {
  it("fires on a circuit_breaker halt with attempts remaining", () => {
    const verdict = evaluatePlanRepairTrigger(haltedExecution());

    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.contextId).toBe("context-implement");
    expect(verdict.haltType).toBe("circuit_breaker");
    expect(verdict.attempt).toBe(1);
    expect(verdict.policy.maxAttemptsPerContext).toBe(2);
  });

  it("fires on a max_iterations halt", () => {
    const verdict = evaluatePlanRepairTrigger(
      haltedExecution({
        haltReason: {
          type: "max_iterations",
          contextId: "context-implement",
          iterationCount: 10,
          summary: null,
        },
      }),
    );

    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.haltType).toBe("max_iterations");
  });

  it("counts prior rounds for the context toward the attempt number", () => {
    const verdict = evaluatePlanRepairTrigger(
      haltedExecution({
        planRepairRounds: [round("context-implement", 1)],
      }),
    );

    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.attempt).toBe(2);
  });

  it("does not fire when the execution is not halted", () => {
    const verdict = evaluatePlanRepairTrigger(
      createWorkflowExecution({ status: "running" }),
    );
    expect(verdict).toEqual({ eligible: false, reason: "not_halted" });
  });

  it("does not fire for non-retry-exhaustion halt kinds", () => {
    const verdict = evaluatePlanRepairTrigger(
      createWorkflowExecution({
        status: "halted",
        haltReason: { type: "aborted" },
      }),
    );
    expect(verdict).toEqual({ eligible: false, reason: "halt_kind" });
  });

  it("does not fire when the tripped context disables planRepair", () => {
    const base = haltedExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      workingDefinition: {
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (ctx) =>
            ctx.id === "context-implement"
              ? {
                  ...ctx,
                  planRepair: { enabled: false, maxAttemptsPerContext: 2 },
                }
              : ctx,
        ),
      },
    };

    expect(evaluatePlanRepairTrigger(execution)).toEqual({
      eligible: false,
      reason: "disabled",
    });
  });

  it("exhausts after maxAttemptsPerContext rounds for the tripped context (crashed rounds count)", () => {
    const verdict = evaluatePlanRepairTrigger(
      haltedExecution({
        planRepairRounds: [
          round("context-implement", 1, { outcome: "repaired" }),
          round("context-implement", 2),
        ],
      }),
    );

    expect(verdict).toEqual({
      eligible: false,
      reason: "context_attempts_exhausted",
    });
  });

  it("enforces the hard per-execution backstop across contexts", () => {
    const verdict = evaluatePlanRepairTrigger(
      haltedExecution({
        planRepairRounds: [
          round("context-plan", 1),
          round("context-verify", 2),
          round("context-plan", 3),
          round("context-verify", 4),
          round("context-verify", 5),
        ],
      }),
    );

    expect(verdict).toEqual({
      eligible: false,
      reason: "execution_rounds_exhausted",
    });
  });

  it("reports an unknown tripped context distinctly", () => {
    const verdict = evaluatePlanRepairTrigger(
      haltedExecution({
        haltReason: {
          type: "circuit_breaker",
          contextId: "no-such-context",
          condition: "retry_exhaustion",
          failureCount: 3,
          summary: null,
        },
      }),
    );

    expect(verdict).toEqual({ eligible: false, reason: "unknown_context" });
  });
});
