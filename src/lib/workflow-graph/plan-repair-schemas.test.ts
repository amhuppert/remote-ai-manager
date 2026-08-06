import { describe, expect, it } from "vitest";
import { graphWorkflowPlanRepairPolicySchema } from "./config-schemas";
import {
  graphWorkflowExecutionSchema,
  graphWorkflowHaltReasonSchema,
  planRepairRoundSchema,
} from "./schemas";
import { graphWorkflowResolvedContextSchema } from "./definition-schemas";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { makeProfileSnapshot } from "./test-fixtures";

describe("graphWorkflowPlanRepairPolicySchema", () => {
  it("defaults to enabled with two attempts per context (F4: default ON)", () => {
    const parsed = graphWorkflowPlanRepairPolicySchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.maxAttemptsPerContext).toBe(2);
    expect(parsed.agent).toBeUndefined();
  });

  it("round-trips explicit values including an agent override", () => {
    const parsed = graphWorkflowPlanRepairPolicySchema.parse({
      enabled: false,
      maxAttemptsPerContext: 3,
      agent: { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
    });
    expect(parsed).toEqual({
      enabled: false,
      maxAttemptsPerContext: 3,
      agent: { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
    });
  });

  it("rejects a non-positive attempt cap", () => {
    expect(
      graphWorkflowPlanRepairPolicySchema.safeParse({
        maxAttemptsPerContext: 0,
      }).success,
    ).toBe(false);
  });
});

describe("planRepairRoundSchema", () => {
  it("parses a just-started round with pending-outcome defaults", () => {
    const parsed = planRepairRoundSchema.parse({
      seq: 1,
      contextId: "ctx-1",
      haltType: "circuit_breaker",
      startedAt: "2026-07-29T00:00:00.000Z",
    });
    expect(parsed.settledAt).toBeNull();
    expect(parsed.outcome).toBeNull();
    expect(parsed.planningDefect).toBeNull();
    expect(parsed.diagnosis).toBeNull();
    expect(parsed.operationCount).toBe(0);
    expect(parsed.resumed).toBe(false);
    expect(parsed.conversationId).toBeNull();
  });

  it("parses a settled repaired round losslessly", () => {
    const round = {
      seq: 2,
      contextId: "ctx-1",
      haltType: "max_iterations",
      startedAt: "2026-07-29T00:00:00.000Z",
      settledAt: "2026-07-29T00:05:00.000Z",
      outcome: "repaired",
      planningDefect: true,
      diagnosis: "AC demanded a nonexistent endpoint",
      operationCount: 3,
      resumed: true,
      conversationId: "conv-repair-1",
    };
    expect(planRepairRoundSchema.parse(round)).toEqual(round);
  });
});

describe("execution schema — plan repair fields", () => {
  it("admits a pre-D1 execution with no planRepairRounds via the additive default", () => {
    const raw = buildMaximalGraphWorkflowExecution() as Record<string, unknown>;
    delete raw["planRepairRounds"];
    const parsed = graphWorkflowExecutionSchema.parse(raw);
    expect(parsed.planRepairRounds).toEqual([]);
  });

  it("defaults max_iterations halt summary to null and preserves a set value", () => {
    const bare = graphWorkflowHaltReasonSchema.parse({
      type: "max_iterations",
      contextId: "ctx-1",
      iterationCount: 7,
    });
    if (bare.type !== "max_iterations") throw new Error("wrong variant");
    expect(bare.summary).toBeNull();

    const withSummary = graphWorkflowHaltReasonSchema.parse({
      type: "max_iterations",
      contextId: "ctx-1",
      iterationCount: 7,
      summary: "not a planning defect: implementation approach keeps failing",
    });
    if (withSummary.type !== "max_iterations") throw new Error("wrong variant");
    expect(withSummary.summary).toBe(
      "not a planning defect: implementation approach keeps failing",
    );
  });
});

describe("resolved context schema — planRepair", () => {
  it("defaults planRepair for pre-D1 resolved contexts (default ON)", () => {
    const parsed = graphWorkflowResolvedContextSchema.parse({
      id: "ctx-1",
      title: "Context",
      acceptanceCriteria: "must pass",
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        profileSnapshot: makeProfileSnapshot(),
        agent: { backend: "claude", model: "opus", reasoningEffort: "medium" },
      },
      contextValidator: { enabled: false, assignments: [] },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: { consecutiveFailureThreshold: 3 },
      iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    });
    expect(parsed.planRepair).toEqual({
      enabled: true,
      maxAttemptsPerContext: 2,
    });
  });
});
