import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "../test-fixtures";
import type { GraphWorkflowExecution } from "../schemas";
import {
  buildPlanRepairPrompt,
  toPlanRepairValidationVerdict,
  type PlanRepairPromptInput,
} from "./prompt";

function makeInput(
  overrides: Partial<PlanRepairPromptInput> = {},
): PlanRepairPromptInput {
  const base = createWorkflowExecution({
    status: "halted",
    haltReason: {
      type: "circuit_breaker",
      contextId: "context-implement",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    },
  });
  const execution: GraphWorkflowExecution = {
    ...base,
    taskStates: {
      ...base.taskStates,
      "task-implement-1": {
        taskId: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: "endpoint /v2/users does not exist",
        failureHistory: [
          {
            message: "endpoint /v2/users does not exist",
            timestamp: "2026-07-29T00:01:00.000Z",
          },
        ],
      },
    },
  };
  return {
    execution,
    contextId: "context-implement",
    haltReason: execution.haltReason!,
    attempt: 1,
    validationHistory: [
      {
        pass: false,
        summary: "AC requires calling /v2/users which was removed",
        issues: [
          {
            taskId: "task-implement-1",
            title: "Impossible endpoint",
            description: "The API surface has no /v2/users route",
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("buildPlanRepairPrompt", () => {
  it("embeds the failure evidence, plan artifacts, and budgets", () => {
    const prompt = buildPlanRepairPrompt(makeInput());

    // Halt + budgets
    expect(prompt).toContain("circuit_breaker");
    expect(prompt).toContain("3"); // failure count vs threshold rendering
    // Context plan artifacts
    expect(prompt).toContain("Feature implemented"); // fixture AC
    // Failure evidence
    expect(prompt).toContain("endpoint /v2/users does not exist");
    expect(prompt).toContain("AC requires calling /v2/users which was removed");
    // Charter digest (fixture charter content renders)
    expect(prompt.toLowerCase()).toContain("charter");
    // Decision framework + guardrail
    expect(prompt).toContain("Do not weaken acceptance criteria");
    expect(prompt).toContain("planningDefect");
    // Op vocabulary with EXACT JSON shapes (live-proof regression: the agent
    // emitted typeless operations when only prose named the vocabulary).
    expect(prompt).toContain('"type": "amend-charter"');
    expect(prompt).toContain('"type": "update-context"');
    expect(prompt).toContain('"type": "update-task"');
  });

  // The op vocabulary is the agent's ONLY view of what it may change: a field
  // absent from these shapes is a capability it never uses. An
  // `output_schema_validation` breaker trip is unrepairable without it.
  it("offers outputSchema on update-context so a too-tight output contract is repairable", () => {
    const prompt = buildPlanRepairPrompt(makeInput());

    expect(prompt).toContain('"outputSchema"');
    const updateContextShape = prompt
      .split("\n")
      .find((line) => line.includes('"type": "update-context"'));
    expect(updateContextShape).toBeDefined();
    expect(updateContextShape).toContain('"outputSchema"');
    // `null` is the only way to return a context to free-form output.
    expect(updateContextShape).toContain("null");
  });

  it("frames an output_schema_validation trip as a contract failure and shows the declared schema", () => {
    const base = makeInput();
    const outputSchema = {
      type: "object",
      properties: { migrationId: { type: "string" } },
      required: ["migrationId"],
      additionalProperties: false,
    };
    const contexts = base.execution.workingDefinition.executionContexts.map(
      (context) =>
        context.id === "context-implement"
          ? { ...context, outputSchema }
          : context,
    );
    const haltReason = {
      type: "circuit_breaker" as const,
      contextId: "context-implement",
      condition: "output_schema_validation" as const,
      failureCount: 3,
      summary: "$.migrationId: required property is missing",
    };
    const execution: GraphWorkflowExecution = {
      ...base.execution,
      haltReason,
      workingDefinition: {
        ...base.execution.workingDefinition,
        executionContexts: contexts,
      },
    };

    const prompt = buildPlanRepairPrompt({ ...base, execution, haltReason });

    expect(prompt).toContain("### Declared output schema");
    expect(prompt).toContain('"migrationId"');
    expect(prompt).toContain("output-contract failure, not a work failure");
    // A retry_exhaustion trip must not pick up the contract framing.
    expect(buildPlanRepairPrompt(makeInput())).not.toContain(
      "output-contract failure",
    );
  });

  it("caps the validation history at the five most recent verdicts", () => {
    const history = Array.from({ length: 7 }, (_, i) => ({
      pass: false,
      summary: `verdict-${i + 1}`,
      issues: [],
    }));
    const prompt = buildPlanRepairPrompt(
      makeInput({ validationHistory: history }),
    );

    expect(prompt).not.toContain("verdict-1");
    expect(prompt).not.toContain("verdict-2");
    expect(prompt).toContain("verdict-3");
    expect(prompt).toContain("verdict-7");
  });

  it("adds the budget-mechanics warning for max_iterations halts", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({
        haltReason: {
          type: "max_iterations",
          contextId: "context-implement",
          iterationCount: 10,
          summary: null,
        },
      }),
    );

    expect(prompt).toContain("maxIterations");
    expect(prompt).toContain("re-halt immediately");
  });

  it("renders prior repair rounds so the agent sees what already failed", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({
        attempt: 2,
        priorRounds: [
          {
            seq: 1,
            contextId: "context-implement",
            haltType: "circuit_breaker",
            startedAt: "2026-07-28T00:00:00.000Z",
            settledAt: "2026-07-28T00:05:00.000Z",
            outcome: "repaired",
            planningDefect: true,
            diagnosis: "First repair clarified the AC wording",
            operationCount: 1,
            resumed: true,
            conversationId: "conv-1",
          },
        ],
      }),
    );

    expect(prompt).toContain("First repair clarified the AC wording");
    expect(prompt).toContain("attempt 2");
  });
});

// R14.1: a breaker trip from a multi-validator cohort. What the repair agent
// must be able to tell apart is "one reviewer keeps failing the same thing"
// from "several lenses each found something different" — the first is usually
// an implementation problem, the second is where a planning defect lives.
describe("buildPlanRepairPrompt: cohort evidence", () => {
  const COHORT_VERDICT = {
    pass: false,
    summary: "general: ok\nsecurity: no\nperf: no",
    issues: [
      {
        taskId: "task-implement-1",
        title: "Secrets in the log line",
        description: "The handler logs the bearer token.",
        assignmentId: "security",
      },
      {
        taskId: "task-implement-1",
        title: "N+1 on the members query",
        description: "One query per row.",
        assignmentId: "perf",
      },
    ],
    specialists: [
      {
        assignmentId: "general",
        profile: { tier: "builtin", id: "general-reviewer", revision: 1 },
        pass: true,
        summary: "general: ok",
        issues: [],
      },
      {
        assignmentId: "security",
        profile: { tier: "project", id: "security-reviewer", revision: 4 },
        pass: false,
        summary: "security: no",
        issues: [
          {
            taskId: "task-implement-1",
            title: "Secrets in the log line",
            description: "The handler logs the bearer token.",
            assignmentId: "security",
          },
        ],
      },
      {
        assignmentId: "perf",
        profile: { tier: "global", id: "perf-reviewer", revision: 7 },
        pass: false,
        summary: "perf: no",
        issues: [
          {
            taskId: "task-implement-1",
            title: "N+1 on the members query",
            description: "One query per row.",
            assignmentId: "perf",
          },
        ],
      },
    ],
  };

  it("groups findings by assignment and names the profile that produced each", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({ validationHistory: [COHORT_VERDICT] }),
    );

    expect(prompt).toContain(
      "- security (project/security-reviewer rev 4) [fail]",
    );
    expect(prompt).toContain("- perf (global/perf-reviewer rev 7) [fail]");
    // A passing member is shown too: "two of three objected" is a different
    // diagnosis from "the whole cohort objected".
    expect(prompt).toContain(
      "- general (builtin/general-reviewer rev 1) [pass]",
    );

    // Each finding sits under the specialist that raised it.
    const securityBlock = prompt.slice(
      prompt.indexOf("- security ("),
      prompt.indexOf("- perf ("),
    );
    expect(securityBlock).toContain("Secrets in the log line");
    expect(securityBlock).not.toContain("N+1 on the members query");
  });

  it("keeps the flat rendering for a single-reviewer round", () => {
    const prompt = buildPlanRepairPrompt(makeInput());

    expect(prompt).toContain("Impossible endpoint");
    expect(prompt).not.toContain("rev 1) [");
  });

  // The repair agent may rewrite plan artifacts, never the cohort. A vocabulary
  // that offered assignment operations would let a repair silence the reviewer
  // that keeps objecting instead of fixing what it objects to.
  it("offers no assignment operations, even for a cohort trip", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({ validationHistory: [COHORT_VERDICT] }),
    );

    const vocabulary = prompt.slice(
      prompt.indexOf("## Allowed repair operations"),
    );
    for (const forbidden of [
      "add-validator",
      "remove-validator",
      "update-validator",
      "set-validator",
      "add-assignment",
      "remove-assignment",
      "update-assignment",
      "contextValidator",
      "assignments",
      "profileSnapshot",
      "implementer",
    ]) {
      expect(vocabulary).not.toContain(forbidden);
    }
    // The allowed vocabulary is exactly the plan-artifact set.
    expect(
      // Line-anchored: each operation shape occupies its own line, so a
      // nested `{"type": "object"}` inside a JSON Schema example is not one.
      [...vocabulary.matchAll(/^\{"type": "([a-z-]+)"/gm)].map(
        (match) => match[1],
      ),
    ).toEqual([
      "amend-charter",
      "update-context",
      "add-task",
      "update-task",
      "remove-task",
      "reorder-tasks",
    ]);
  });
});

describe("toPlanRepairValidationVerdict", () => {
  it("carries the aggregate's specialist entries into the prompt's evidence", () => {
    const verdict = toPlanRepairValidationVerdict({
      pass: false,
      summary: "security: no",
      issues: [{ taskId: "t", title: "a", description: "b" }],
      specialists: [
        {
          assignmentId: "security",
          profile: { tier: "project", id: "security-reviewer", revision: 4 },
          pass: false,
          summary: "security: no",
          issues: [{ taskId: "t", title: "a", description: "b" }],
        },
      ],
    });

    expect(verdict.specialists).toHaveLength(1);
    expect(verdict.specialists?.[0]?.profile.revision).toBe(4);
  });

  it("omits the grouping entirely for a legacy row with no entries", () => {
    const verdict = toPlanRepairValidationVerdict({
      pass: true,
      summary: "ok",
      issues: [],
      specialists: [],
    });

    expect(verdict.specialists).toBeUndefined();
  });
});
