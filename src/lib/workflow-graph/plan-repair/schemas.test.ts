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

  it("rejects an operation entry without a type field at the verdict layer", () => {
    // The backend's native structured output enforces the generated JSON
    // schema, so requiring `type` here makes the model produce well-shaped
    // ops instead of failing later at the allowlist (live-proof regression).
    expect(
      planRepairVerdictSchema.safeParse({
        planningDefect: true,
        diagnosis: "fix",
        operations: [{ contextId: "ctx-1", acceptanceCriteria: "x" }],
      }).success,
    ).toBe(false);
  });

  it("generates a JSON schema whose operation items require type", () => {
    const schema = PLAN_REPAIR_VERDICT_JSON_SCHEMA as {
      properties?: {
        operations?: {
          items?: { required?: string[] };
        };
      };
    };
    expect(schema.properties?.operations?.items?.required).toContain("type");
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
    [
      "add-context",
      { type: "add-context", id: "x", title: "t", acceptanceCriteria: "a" },
    ],
    ["remove-context", { type: "remove-context", contextId: "ctx-1" }],
    [
      "add-edge",
      { type: "add-edge", sourceContextId: "a", targetContextId: "b" },
    ],
    [
      "remove-edge",
      { type: "remove-edge", sourceContextId: "a", targetContextId: "b" },
    ],
    [
      "move-task",
      { type: "move-task", taskId: "task-1", targetContextId: "b" },
    ],
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
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
      },
      contextValidator: { enabled: false, assignments: [] },
      scriptValidator: { commands: [] },
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

  // R11: assignment editing rides the update-context control blocks rather than
  // a new op kind, so the allowlist that already fences those blocks off is
  // what refuses it. Proven against a POPULATED cohort and a real implementer
  // swap — the disabled-empty shapes above cannot show a rejected roster edit.
  it("refuses a plan-repair batch that reorders or refocuses the validator cohort", () => {
    const result = validatePlanRepairOperations([
      { type: "update-task", taskId: "task-1", title: "Legal plan edit" },
      {
        type: "update-context",
        contextId: "ctx-1",
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "perf",
              profile: { tier: "project", id: "perf-reviewer" },
              focus: "Hot paths only",
              strategy: "conversation",
              agent: {
                backend: "claude",
                model: "sonnet",
                reasoningEffort: "medium",
              },
              continuity: { enabled: true },
            },
          ],
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { index: 1, message: expect.stringContaining("contextValidator") },
    ]);
  });

  it("refuses a plan-repair batch that swaps the implementer assignment", () => {
    const result = validatePlanRepairOperations([
      {
        type: "update-context",
        contextId: "ctx-1",
        implementer: {
          id: "implementer",
          profile: { tier: "project", id: "sharper-implementer" },
          focus: "Rewrite the failing module",
          agent: {
            backend: "codex",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("implementer");
  });

  // D2/D4: a too-tight `outputSchema` is exactly the impossible-contract class
  // plan repair exists for, so the repair agent may rewrite or drop it. It is a
  // plan artifact, NOT one of the controls the split fences off.
  it("accepts an update-context that rewrites a too-tight outputSchema", () => {
    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    const result = validatePlanRepairOperations([
      { type: "update-context", contextId: "ctx-1", outputSchema },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations[0]).toMatchObject({
      type: "update-context",
      contextId: "ctx-1",
      outputSchema,
    });
  });

  it("accepts an update-context that drops the outputSchema entirely", () => {
    const result = validatePlanRepairOperations([
      { type: "update-context", contextId: "ctx-1", outputSchema: null },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations[0]).toMatchObject({ outputSchema: null });
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
