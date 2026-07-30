import { describe, expect, it } from "vitest";
import {
  PLAN_REPAIR_VERDICT_JSON_SCHEMA,
  planRepairVerdictSchema,
  validatePlanRepairOperations,
} from "./schemas";

describe("planRepairVerdictSchema", () => {
  it("parses a repair verdict and defaults operations to empty", () => {
    const parsed = planRepairVerdictSchema.parse({
      planningDefect: false,
      diagnosis: "Failures are implementation-side: the test flake is real",
    });
    expect(parsed.planningDefect).toBe(false);
    expect(parsed.operations).toEqual([]);
  });

  it("rejects an empty diagnosis", () => {
    expect(
      planRepairVerdictSchema.safeParse({
        planningDefect: true,
        diagnosis: "",
        operations: [],
      }).success,
    ).toBe(false);
  });

  it("exports a generated JSON schema for the structured-output gate", () => {
    const schema = PLAN_REPAIR_VERDICT_JSON_SCHEMA as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toBeDefined();
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["planningDefect", "diagnosis", "operations"]),
    );
  });
});

describe("validatePlanRepairOperations — the plan/controls split (fail closed)", () => {
  it("accepts the full allowed vocabulary", () => {
    const result = validatePlanRepairOperations([
      {
        type: "amend-charter",
        rationale: "The mission referenced a removed endpoint",
        mission: "Corrected mission",
      },
      {
        type: "update-context",
        contextId: "ctx-1",
        acceptanceCriteria: "Achievable criteria",
        iterationPolicy: { maxIterations: 12, continuity: { enabled: true } },
        circuitBreaker: { consecutiveFailureThreshold: 4 },
      },
      {
        type: "add-task",
        contextId: "ctx-1",
        title: "Bridge task",
        instructions: "Add the missing migration before the API change",
      },
      { type: "update-task", taskId: "task-1", title: "Sharper title" },
      { type: "remove-task", taskId: "task-2" },
      { type: "reorder-tasks", contextId: "ctx-1", orderedTaskIds: ["task-1"] },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations).toHaveLength(6);
  });

  it.each([
    ["add-context", { type: "add-context", id: "x", title: "t", acceptanceCriteria: "a" }],
    ["remove-context", { type: "remove-context", contextId: "ctx-1" }],
    ["add-edge", { type: "add-edge", sourceContextId: "a", targetContextId: "b" }],
    ["remove-edge", { type: "remove-edge", sourceContextId: "a", targetContextId: "b" }],
    ["move-task", { type: "move-task", taskId: "task-1", targetContextId: "b" }],
  ])("rejects structural op type %s", (_label, op) => {
    const result = validatePlanRepairOperations([op]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("not permitted");
  });

  it.each([
    "implementer",
    "contextValidator",
    "scriptValidator",
    "humanApprovalGate",
    "askUserQuestions",
    "mutability",
    "collaboration",
    "planRepair",
  ])("rejects update-context touching the %s control block", (block) => {
    const controlValues: Record<string, unknown> = {
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
      contextValidator: null,
      scriptValidator: { enabled: false },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd: true },
      collaboration: {
        enabled: { value: false, source: "global" },
        secondAgent: {
          value: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          source: "global",
        },
        negotiationRounds: { value: 3, source: "global" },
        autonomousResolutionThreshold: { value: "minor", source: "global" },
      },
      planRepair: { enabled: true, maxAttemptsPerContext: 99 },
    };
    const result = validatePlanRepairOperations([
      {
        type: "update-context",
        contextId: "ctx-1",
        [block]: controlValues[block],
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain(block);
  });

  it("rejects a schema-invalid op with the underlying issue", () => {
    const result = validatePlanRepairOperations([
      { type: "update-task", taskId: "task-1" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects non-array input", () => {
    const result = validatePlanRepairOperations({ type: "amend-charter" });
    expect(result.ok).toBe(false);
  });
});
