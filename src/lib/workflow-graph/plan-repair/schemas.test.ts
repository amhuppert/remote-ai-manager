import { describe, expect, it } from "vitest";
import { findProviderStrictSchemaViolations } from "@/lib/agent-backends/testing/provider-strict-schema";
import { makeSeededValidatorAssignment } from "../test-fixtures";
import {
  decodePlanRepairAgentOutput,
  expandPlanRepairOperations,
  PLAN_REPAIR_VERDICT_JSON_SCHEMA,
  planRepairVerdictSchema,
  validatePlanRepairOperations,
  type ExpandPlanRepairOperationsResult,
  type PlanRepairCohortSite,
} from "./schemas";

/**
 * The cohort the narrowing ops below are judged against: the seeded
 * acceptance-criteria verifier (blocking, no authored instructions) plus one
 * authored specialist of each authority.
 */
const CONTEXTS: PlanRepairCohortSite[] = [
  {
    id: "ctx-1",
    contextValidator: {
      enabled: true,
      assignments: [
        makeSeededValidatorAssignment({ id: "general", authority: "blocking" }),
        makeSeededValidatorAssignment({
          id: "security",
          authority: "blocking",
          focus: "Judge the auth boundary only.",
        }),
        makeSeededValidatorAssignment({ id: "perf", authority: "advisory" }),
      ],
    },
  },
];

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
    expect(schema.properties?.operations?.items?.required).toContain("payload");
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

  it("stays inside the strict subset a provider-native backend accepts", () => {
    expect(
      findProviderStrictSchemaViolations(PLAN_REPAIR_VERDICT_JSON_SCHEMA),
    ).toEqual([]);
  });

  it("decodes strict operation envelopes into domain operations", () => {
    const decoded = decodePlanRepairAgentOutput({
      planningDefect: true,
      diagnosis: "The criterion names a removed endpoint",
      operations: [
        {
          type: "update-context",
          payload: JSON.stringify({
            contextId: "ctx-1",
            acceptanceCriteria: "Use the supported endpoint",
          }),
        },
      ],
    });

    expect(decoded).toEqual({
      ok: true,
      verdict: {
        planningDefect: true,
        diagnosis: "The criterion names a removed endpoint",
        operations: [
          {
            type: "update-context",
            contextId: "ctx-1",
            acceptanceCriteria: "Use the supported endpoint",
          },
        ],
      },
    });
  });

  it("rejects an operation payload that is not a JSON object", () => {
    const decoded = decodePlanRepairAgentOutput({
      planningDefect: true,
      diagnosis: "The criterion names a removed endpoint",
      operations: [{ type: "update-context", payload: "[]" }],
    });

    expect(decoded).toEqual({
      ok: false,
      error: "operations[0].payload must encode a JSON object",
    });
  });
});

describe("validatePlanRepairOperations — the plan/controls split (fail closed)", () => {
  it("accepts the full allowed vocabulary", () => {
    const result = validatePlanRepairOperations(
      [
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
        {
          type: "reorder-tasks",
          contextId: "ctx-1",
          orderedTaskIds: ["task-1"],
        },
      ],
      CONTEXTS,
    );

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
    const result = validatePlanRepairOperations([op], CONTEXTS);
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
    const result = validatePlanRepairOperations(
      [
        {
          type: "update-context",
          contextId: "ctx-1",
          [block]: controlValues[block],
        },
      ],
      CONTEXTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain(block);
  });

  // R11/D10: the narrowing ops below are the ONLY way a repair reaches a
  // validator assignment. Writing the cohort block itself stays refused, so a
  // repair can never reorder the roster, swap a profile, or drop the reviewer
  // that keeps objecting. Proven against a POPULATED cohort and a real
  // implementer swap — the disabled-empty shapes above cannot show a rejected
  // roster edit.
  it("refuses a plan-repair batch that reorders or refocuses the validator cohort", () => {
    const result = validatePlanRepairOperations(
      [
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
      ],
      CONTEXTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { index: 1, message: expect.stringContaining("contextValidator") },
    ]);
  });

  it("refuses a plan-repair batch that swaps the implementer assignment", () => {
    const result = validatePlanRepairOperations(
      [
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
      ],
      CONTEXTS,
    );

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
    const result = validatePlanRepairOperations(
      [{ type: "update-context", contextId: "ctx-1", outputSchema }],
      CONTEXTS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations[0]).toMatchObject({
      type: "update-context",
      contextId: "ctx-1",
      outputSchema,
    });
  });

  it("accepts an update-context that drops the outputSchema entirely", () => {
    const result = validatePlanRepairOperations(
      [{ type: "update-context", contextId: "ctx-1", outputSchema: null }],
      CONTEXTS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations[0]).toMatchObject({ outputSchema: null });
  });

  it("rejects a schema-invalid op with the underlying issue", () => {
    const result = validatePlanRepairOperations(
      [{ type: "update-task", taskId: "task-1" }],
      CONTEXTS,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects non-array input", () => {
    const result = validatePlanRepairOperations(
      { type: "amend-charter" },
      CONTEXTS,
    );
    expect(result.ok).toBe(false);
  });
});

/**
 * R10/D10: the repair agent may defuse a mis-scoped blocking standard — rewrite
 * what a seat is told to judge, or take its blocking authority away — and may
 * never mint blocking authority, because a halt is the worst moment to create a
 * new way to fail. The op names one assignment; the cohort around it is carried
 * through by the engine, never written by the agent.
 */
describe("validatePlanRepairOperations — narrowing-only validator-assignment ops", () => {
  /**
   * The supervisor's real sequence: admit the agent's output against the
   * snapshot it was shown, then expand against the snapshot the apply lands on.
   * They are the same cohort here unless a test says otherwise.
   */
  function narrow(
    raw: unknown,
    applySnapshot: PlanRepairCohortSite[] = CONTEXTS,
  ): ExpandPlanRepairOperationsResult {
    const validated = validatePlanRepairOperations(raw, CONTEXTS);
    if (!validated.ok) return validated;
    return expandPlanRepairOperations(validated.operations, applySnapshot);
  }

  function cohortOf(result: {
    ok: boolean;
    operations?: unknown[];
  }): Array<Record<string, unknown>> {
    const operation = (result.operations ?? [])[0] as {
      contextValidator?: { assignments?: Array<Record<string, unknown>> };
    };
    return operation.contextValidator?.assignments ?? [];
  }

  it("admits an instructions edit, carrying the rest of the cohort through untouched", () => {
    const result = narrow([
      {
        type: "update-validator-assignment",
        contextId: "ctx-1",
        assignmentId: "security",
        instructions: "Judge only the token lifetime, nothing else.",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations[0]).toMatchObject({
      type: "update-context",
      contextId: "ctx-1",
    });
    const assignments = cohortOf(result);
    // Order, membership, and every other seat's configuration are the cohort's,
    // not the agent's: it named one assignment and one field.
    expect(assignments.map((entry) => entry.id)).toEqual([
      "general",
      "security",
      "perf",
    ]);
    expect(assignments[1]).toMatchObject({
      focus: "Judge only the token lifetime, nothing else.",
      authority: "blocking",
    });
    expect(assignments[2]).toMatchObject({ id: "perf", authority: "advisory" });
    // The resolved bytes are the engine's to recompose from the edited seat.
    expect(assignments[1]).not.toHaveProperty("profileSnapshot");
  });

  it("admits a blocking-to-advisory demotion", () => {
    const result = narrow([
      {
        type: "update-validator-assignment",
        contextId: "ctx-1",
        assignmentId: "security",
        authority: "advisory",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(cohortOf(result)[1]).toMatchObject({
      id: "security",
      authority: "advisory",
      // The demoted seat keeps its authored instructions — they stop being a
      // mandate and become its use-site focus.
      focus: "Judge the auth boundary only.",
    });
  });

  it("refuses an advisory-to-blocking promotion, fail closed", () => {
    const result = validatePlanRepairOperations(
      [
        {
          type: "update-validator-assignment",
          contextId: "ctx-1",
          assignmentId: "perf",
          authority: "blocking",
        },
      ],
      CONTEXTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ index: 0 });
    expect(result.issues[0]?.message).toContain("blocking");
  });

  it("refuses the whole batch when a promotion rides along with a legal narrowing", () => {
    const result = validatePlanRepairOperations(
      [
        {
          type: "update-validator-assignment",
          contextId: "ctx-1",
          assignmentId: "security",
          authority: "advisory",
        },
        {
          type: "update-validator-assignment",
          contextId: "ctx-1",
          assignmentId: "perf",
          authority: "blocking",
        },
      ],
      CONTEXTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.index)).toEqual([1]);
  });

  it("keeps both narrowings when two ops edit the same cohort", () => {
    const result = narrow([
      {
        type: "update-validator-assignment",
        contextId: "ctx-1",
        assignmentId: "general",
        instructions: "Judge the migration order only.",
      },
      {
        type: "update-validator-assignment",
        contextId: "ctx-1",
        assignmentId: "security",
        authority: "advisory",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Each op replaces the whole cohort, so the second must be built on the
    // first — otherwise the last write silently drops the earlier narrowing.
    const assignments = (
      result.operations[1] as {
        contextValidator: { assignments: Array<Record<string, unknown>> };
      }
    ).contextValidator.assignments;
    expect(assignments[0]).toMatchObject({
      id: "general",
      focus: "Judge the migration order only.",
    });
    expect(assignments[1]).toMatchObject({
      id: "security",
      authority: "advisory",
    });
  });

  it("refuses an op naming an assignment the cohort does not have", () => {
    const result = validatePlanRepairOperations(
      [
        {
          type: "update-validator-assignment",
          contextId: "ctx-1",
          assignmentId: "ghost",
          authority: "advisory",
        },
      ],
      CONTEXTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("ghost");
  });

  it("refuses an op naming a context the working definition does not have", () => {
    const result = validatePlanRepairOperations(
      [
        {
          type: "update-validator-assignment",
          contextId: "ctx-missing",
          assignmentId: "security",
          authority: "advisory",
        },
      ],
      CONTEXTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("ctx-missing");
  });

  it("refuses an op that names an assignment but changes nothing", () => {
    const result = validatePlanRepairOperations(
      [
        {
          type: "update-validator-assignment",
          contextId: "ctx-1",
          assignmentId: "security",
        },
      ],
      CONTEXTS,
    );

    expect(result.ok).toBe(false);
  });

  // The agent's turn is minutes long, and an operator can edit the cohort
  // throughout it. Admission judges what the agent was shown; the write is
  // built from what it lands on, so a one-seat narrowing stays a one-seat
  // change no matter what moved underneath it.
  const DEMOTE_SECURITY = [
    {
      type: "update-validator-assignment",
      contextId: "ctx-1",
      assignmentId: "security",
      authority: "advisory",
    },
  ];

  it("writes the cohort the apply lands on, not the one admission was judged against", () => {
    const afterOperatorEdit: PlanRepairCohortSite[] = [
      {
        id: "ctx-1",
        contextValidator: {
          enabled: true,
          assignments: [
            makeSeededValidatorAssignment({
              id: "general",
              authority: "blocking",
            }),
            makeSeededValidatorAssignment({
              id: "security",
              authority: "blocking",
              focus: "Judge the auth boundary only.",
            }),
            makeSeededValidatorAssignment({
              id: "perf",
              authority: "advisory",
              focus: "Hot paths only, as of the operator's edit.",
            }),
            makeSeededValidatorAssignment({
              id: "docs",
              authority: "advisory",
            }),
          ],
        },
      },
    ];

    const result = narrow(DEMOTE_SECURITY, afterOperatorEdit);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assignments = cohortOf(result);
    // The seat the operator added survives, and their refocus of `perf` is not
    // reverted — neither exists in the snapshot admission saw.
    expect(assignments.map((entry) => entry.id)).toEqual([
      "general",
      "security",
      "perf",
      "docs",
    ]);
    expect(assignments[2]).toMatchObject({
      focus: "Hot paths only, as of the operator's edit.",
    });
    expect(assignments[1]).toMatchObject({
      id: "security",
      authority: "advisory",
    });
  });

  it.each([
    [
      "assignment",
      [
        {
          id: "ctx-1",
          contextValidator: {
            enabled: true,
            assignments: [
              makeSeededValidatorAssignment({
                id: "general",
                authority: "blocking",
              }),
            ],
          },
        },
      ],
      "security",
    ],
    ["context", [], "ctx-1"],
  ])(
    "refuses the batch when the %s it names is gone by apply time",
    (_label, applySnapshot, mentioned) => {
      const result = narrow(
        DEMOTE_SECURITY,
        applySnapshot as PlanRepairCohortSite[],
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0]).toMatchObject({ index: 0 });
      expect(result.issues[0]?.message).toContain(mentioned);
    },
  );

  it("passes plan operations through expansion untouched", () => {
    const result = narrow([
      { type: "update-task", taskId: "task-1", title: "Sharper title" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations).toEqual([
      { type: "update-task", taskId: "task-1", title: "Sharper title" },
    ]);
  });
});
