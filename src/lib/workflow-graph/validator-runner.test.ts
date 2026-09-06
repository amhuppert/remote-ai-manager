import {
  WHOLE_TREE_CANDIDATE_SCOPE,
  type CandidateScope,
} from "@/lib/git/diff";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  buildContextValidationPrompt as buildContextValidationPromptWithValidation,
  createValidatorRunner,
  parseValidatorResponse,
  resolveValidatorAskUserQuestionsEnabled,
  type BuildContextValidationPromptInput,
  type ValidatorOutcome,
  buildValidatorOutputSchema,
} from "./validator-runner";
import {
  createExecutionLogger,
  registerExecutionLogger,
  unregisterExecutionLogger,
} from "./execution-logger";
import type { ValidationDiffScope } from "./validation-diff-scope";
import {
  formatQuestionAnswersBlock,
  splitQuestionAnswersBlock,
} from "@/lib/conversations/question-answers-block";
import type { AskQuestionAnswer } from "@/lib/conversations/schemas";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import { QUERY_SLOT_ADMISSION_TIMEOUT_CODE } from "@/lib/shared/query-semaphore";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  SeededValidatorAssignment,
  ValidatorAssignment,
} from "@/lib/workflow-graph/config-schemas";
import { laneStateKey } from "@/lib/workflow-graph/lane-identity";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
  seedAssignment,
} from "./test-fixtures";
import {
  createGraphLaneContinuity,
  type GraphLaneContinuityDeps,
} from "@/lib/workflow-graph/lane-continuity";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import type { BackendContinuityAdapter } from "@/lib/agent-backends/continuity";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
} from "@/lib/agent-backends/registry-core";
import { bootstrapBackends } from "@/lib/agent-backends/registry";
import {
  createTestFakeBackend,
  TESTFAKE_BACKEND_ID,
} from "@/lib/agent-backends/testing/testfake-backend";
import type { ValidationPromptSelections } from "./validation-prompt-section";

const EMPTY_VALIDATION_SELECTIONS = {
  registry: "none",
  enabled: { kind: "commands", commands: [] },
  disabled: [],
  scriptGate: { kind: "off" },
} satisfies ValidationPromptSelections;

type TestBuildContextValidationPromptInput = Omit<
  BuildContextValidationPromptInput,
  "validationSelections"
> & {
  validationSelections?: ValidationPromptSelections;
};

function buildContextValidationPrompt(
  input: TestBuildContextValidationPromptInput,
): string {
  return buildContextValidationPromptWithValidation({
    ...input,
    validationSelections:
      input.validationSelections ?? EMPTY_VALIDATION_SELECTIONS,
  });
}

const emptyUsage = {
  costUsd: null,
  durationMs: null,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
};

interface TaskRunResultOverrides {
  backendRef?: AgentSessionRef | null;
  continuationDisposition?: "retain" | "clear";
}

function textTaskRun(
  text: string,
  overrides: TaskRunResultOverrides = {},
): TaskRunResult {
  return {
    kind: "text",
    text,
    usage: emptyUsage,
    backendRef: overrides.backendRef ?? null,
    continuationDisposition: overrides.continuationDisposition ?? "retain",
  };
}

/**
 * A blocking validator's passing verdict, in the exact shape its dispatched
 * output schema requires — both arrays present, nothing extra. Anything less is
 * refused as `schema_mismatch`, so a fixture that hand-rolls a partial payload
 * silently tests the infra path instead of the verdict path.
 */
function verdictJson(summary: string): string {
  return JSON.stringify({ summary, issues: [], advisories: [] });
}

function errorTaskRun(
  error: string,
  overrides: TaskRunResultOverrides = {},
): TaskRunResult {
  return {
    kind: "error",
    error,
    aborted: false,
    usage: emptyUsage,
    backendRef: overrides.backendRef ?? null,
    continuationDisposition: overrides.continuationDisposition ?? "retain",
  };
}

// A real directory, not a name: the runner composes its lane write envelope
// before dispatching, and that composition canonicalizes the candidate worktree
// and fails closed when it cannot. A validator only ever runs against a
// worktree that exists, so the stub reflects that.
const stubWorktreeDir = mkdtempSync(path.join(tmpdir(), "cc-validator-wt-"));
const stubWorktreePath = async () => stubWorktreeDir;
/** The session worktree a resolver returns when a test asserts on that path. */
const sessionWorktreeDir = mkdtempSync(path.join(tmpdir(), "cc-session-wt-"));
/** A lane worktree supplied as an `executionTarget` override. */
const laneWorktreeDir = mkdtempSync(path.join(tmpdir(), "cc-lane-wt-"));
const stubTimeoutMs = async () => 300_000;
const stubProjectDisplayName = () => "test-project";

const validatorConfig: ValidatorAssignment = {
  id: "general",
  profile: { tier: "builtin", id: "general-reviewer" },
  strategy: "conversation",
  authority: "blocking",
  agent: {
    backend: "claude",
    modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
  },
  continuity: { enabled: true },
};

// The runner takes ONE assignment, so these fixtures pull it out of the
// context's cohort. Throwing beats a non-null assertion: a fixture that lost
// its assignment should fail loudly here, not inside the runner.
/**
 * Validator lane state lives under the reviewing assignment's key. Every
 * fixture context here is reviewed by the single seeded `general` reviewer.
 */
const VALIDATOR_LANE_KEY = laneStateKey("context_validator", "general");

function soleAssignment(
  context: GraphWorkflowResolvedContext,
): SeededValidatorAssignment {
  const [assignment] = context.contextValidator.assignments;
  if (!assignment) {
    throw new Error(`Fixture context "${context.id}" has an empty cohort`);
  }
  return assignment;
}

const context: GraphWorkflowResolvedContext = {
  placement: { lane: "context-implement", mode: "full" as const },
  id: "context-implement",
  title: "Implement Feature",
  description: "Build the widget",
  acceptanceCriteria:
    "Every task summary is complete and the final plan document is updated.",
  implementer: {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    profileSnapshot: makeProfileSnapshot(),
    agent: {
      backend: "claude",
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
    },
  },
  contextValidator: {
    enabled: true,
    assignments: [seedAssignment(validatorConfig)],
  },
  scriptValidator: { commands: [] },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
  circuitBreaker: {},
  iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
};

const charter: WorkflowCharter = {
  mission: "Ship the widget that adheres to the published API contract.",
  nonGoals: ["Do not redesign the storage layer."],
  sourcesOfTruth: [
    {
      rank: 1,
      id: "api-contract",
      label: "Published API Contract",
      type: "spec",
      locator: "docs/api-contract.md",
      description: "The authoritative request/response shapes for the widget.",
      appliesTo: "src/widget/**",
      accessPolicy: "worktree-relative",
    },
    {
      rank: 2,
      id: "acceptance-criteria",
      label: "Context Acceptance Criteria",
      type: "other",
      locator: "context:acceptance",
      description: "Per-context acceptance criteria authored by the planner.",
      accessPolicy: "worktree-relative",
    },
  ],
};

const tasks: GraphWorkflowTaskDefinition[] = [
  {
    id: "task-1",
    contextId: "context-implement",
    order: 1,
    title: "Write component",
    instructions: "Create the widget component.",
    source: "user",
  },
  {
    id: "task-2",
    contextId: "context-implement",
    order: 2,
    title: "Add tests",
    instructions: "Write unit tests for the widget.",
    source: "user",
  },
];

const taskStates: GraphWorkflowExecution["taskStates"] = {
  "task-1": {
    taskId: "task-1",
    contextId: "context-implement",
    order: 1,
    status: "completed",
    summary: "Created the widget component with error states.",
    startedAt: "2026-03-27T16:00:00.000Z",
    completedAt: "2026-03-27T16:05:00.000Z",
    lastConversationId: "conversation-1",
    failureMessage: null,
    failureHistory: [],
  },
  "task-2": {
    taskId: "task-2",
    contextId: "context-implement",
    order: 2,
    status: "completed",
    summary: "Added unit tests for the widget and loading states.",
    startedAt: "2026-03-27T16:05:00.000Z",
    completedAt: "2026-03-27T16:10:00.000Z",
    lastConversationId: "conversation-2",
    failureMessage: null,
    failureHistory: [],
  },
};

function buildExecutionWithContextValidation(
  validator: ValidatorAssignment = validatorConfig,
): GraphWorkflowExecution {
  const definition = createResolvedWorkflowDefinition({
    executionContexts: createResolvedWorkflowDefinition().executionContexts.map(
      (ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              acceptanceCriteria:
                "Every task summary is complete and the final plan document is updated.",
              contextValidator: {
                enabled: true,
                assignments: [seedAssignment(validator)],
              },
            }
          : ctx,
    ),
    tasks: [
      {
        id: "task-plan-1",
        contextId: "context-plan",
        order: 1,
        title: "Inspect code",
        instructions: "Read the relevant files.",
        source: "user",
      },
      {
        id: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        title: "Write plan",
        instructions: "Document the implementation plan.",
        source: "user",
      },
      ...createResolvedWorkflowDefinition().tasks.filter(
        (task) => task.contextId !== "context-plan",
      ),
    ],
  });

  return createWorkflowExecution({
    status: "running",
    activeContextIds: ["context-plan"],
    workingDefinition: definition,
    contextStates: {
      ...createWorkflowExecution().contextStates,
      "context-plan": {
        ...createWorkflowExecution().contextStates["context-plan"]!,
        totalTaskCount: 2,
        completedTaskCount: 2,
      },
    },
    taskStates: {
      ...createWorkflowExecution().taskStates,
      "task-plan-1": {
        ...createWorkflowExecution().taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Inspected the codebase and documented the current behavior.",
      },
      "task-plan-2": {
        taskId: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        status: "completed",
        summary: "Drafted the implementation plan and linked the updated doc.",
        startedAt: "2026-03-27T16:05:00.000Z",
        completedAt: "2026-03-27T16:10:00.000Z",
        lastConversationId: "conversation-seed",
        failureMessage: null,
        failureHistory: [],
      },
    },
  });
}

describe("buildValidatorOutputSchema", () => {
  const ADVISORY_ITEMS = {
    type: "array",
    items: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["implementation", "plan", "out_of_scope"],
        },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["kind", "title", "description"],
      additionalProperties: false,
    },
  };

  // `minLength: 1` on every field is the Zod contract's non-emptiness reaching
  // the provider's gate — the plan-defect items are projected from
  // `workflowValidatorPlanDefectSchema` rather than hand-written, so a blank
  // justification is refused before the verdict is ever parsed.
  const NON_EMPTY_STRING = { type: "string", minLength: 1 };
  const PLAN_DEFECT_ITEMS = {
    type: "array",
    items: {
      type: "object",
      properties: {
        title: NON_EMPTY_STRING,
        description: NON_EMPTY_STRING,
        whyNotLocallyRemediable: NON_EMPTY_STRING,
        conflictingContract: NON_EMPTY_STRING,
      },
      required: [
        "title",
        "description",
        "whyNotLocallyRemediable",
        "conflictingContract",
      ],
      additionalProperties: false,
    },
  };

  /** The whole blocking schema, parameterized by the fields under test. */
  function blockingSchema(input: {
    taskId: Record<string, unknown>;
    criterionId: Record<string, unknown>;
    issueRequired: string[];
  }) {
    return {
      type: "object",
      properties: {
        summary: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              taskId: input.taskId,
              criterionId: input.criterionId,
              title: { type: "string" },
              description: { type: "string" },
            },
            required: input.issueRequired,
            additionalProperties: false,
          },
        },
        advisories: ADVISORY_ITEMS,
        planDefects: PLAN_DEFECT_ITEMS,
      },
      required: ["summary", "issues", "advisories"],
      additionalProperties: false,
    };
  }

  it("binds the acceptance seat's issues to the task set and REQUIRES a criterionId from the criterion enum", () => {
    // The context's task and criterion sets ARE the schema, so a hallucinated
    // id is refused at the structured-output gate and retried, instead of
    // arriving as a verdict the runner can only reject as an infrastructure
    // failure. The acceptance seat judges the criteria themselves, so every
    // blocking issue must cite the criterion it fails.
    expect(
      buildValidatorOutputSchema({
        authority: "blocking",
        taskIds: ["task-1", "task-2"],
        criterionIds: ["summaries-complete", "plan-updated"],
        issueCriterionCitation: "required",
      }),
    ).toEqual(
      blockingSchema({
        taskId: { type: "string", enum: ["task-1", "task-2"] },
        criterionId: {
          type: "string",
          enum: ["summaries-complete", "plan-updated"],
        },
        issueRequired: ["taskId", "criterionId", "title", "description"],
      }),
    );
  });

  it("keeps criterionId optional on a specialist blocking seat, still bound to the criterion enum", () => {
    // A specialist's blocking basis is its assigned mandate, not the criteria;
    // a criterion id appears only when a mandate finding also contradicts one,
    // so the field stays optional while a present value is still contained.
    expect(
      buildValidatorOutputSchema({
        authority: "blocking",
        taskIds: ["task-1", "task-2"],
        criterionIds: ["summaries-complete", "plan-updated"],
        issueCriterionCitation: "optional",
      }),
    ).toEqual(
      blockingSchema({
        taskId: { type: "string", enum: ["task-1", "task-2"] },
        criterionId: {
          type: "string",
          enum: ["summaries-complete", "plan-updated"],
        },
        issueRequired: ["taskId", "title", "description"],
      }),
    );
  });

  it("gives an advisory validator neither an issues nor a planDefects field", () => {
    const schema = buildValidatorOutputSchema({
      authority: "advisory",
      taskIds: ["task-1"],
      criterionIds: ["summaries-complete"],
      issueCriterionCitation: "optional",
    });

    // Both blocking responses are withheld the same way and for the same
    // reason: an advisory seat cannot fail a context, and routing one to plan
    // repair fails it harder than reopening a task does.
    expect(schema).toEqual({
      type: "object",
      properties: {
        summary: { type: "string" },
        advisories: ADVISORY_ITEMS,
      },
      required: ["summary", "advisories"],
      additionalProperties: false,
    });
  });

  it("makes planDefects optional on a blocking seat, so a clean verdict omits it", () => {
    // Required would force every passing validator to emit an empty array for
    // the rarest of the three responses; `issues` stays required because its
    // empty array is the pass signal itself.
    const schema = buildValidatorOutputSchema({
      authority: "blocking",
      taskIds: ["task-1"],
      criterionIds: ["summaries-complete"],
      issueCriterionCitation: "required",
    });

    expect(schema.required).toEqual(["summary", "issues", "advisories"]);
  });

  it("leaves taskId and criterionId free-form when the context has nothing to enumerate", () => {
    // An empty enum matches nothing and providers reject it outright, so the
    // degenerate context falls back rather than dispatching a broken schema.
    expect(
      buildValidatorOutputSchema({
        authority: "blocking",
        taskIds: [],
        criterionIds: [],
        issueCriterionCitation: "required",
      }),
    ).toEqual(
      blockingSchema({
        taskId: { type: "string" },
        criterionId: { type: "string" },
        issueRequired: ["taskId", "criterionId", "title", "description"],
      }),
    );
  });
});

describe("parseValidatorResponse fenced-block parsing", () => {
  it("returns kind=pass with empty reopenTaskIds when issues is empty", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "All checks passed",
        issues: [],
        advisories: [],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse({
      text,
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass") {
      expect(outcome.reopenTaskIds).toEqual([]);
      expect(outcome.issues).toEqual([]);
    }
  });

  it("returns kind=fail with reopenTaskIds derived from issue taskIds", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "Tests are incomplete.",
        issues: [
          {
            taskId: "task-2",
            title: "Coverage gap",
            description: "Add missing tests.",
          },
        ],
        advisories: [],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse({
      text,
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.reopenTaskIds).toEqual(["task-2"]);
    }
  });

  it("dedupes reopenTaskIds when multiple issues target the same task", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "Two problems in one task.",
        issues: [
          {
            taskId: "task-2",
            title: "Coverage gap",
            description: "Add missing tests.",
          },
          {
            taskId: "task-2",
            title: "Edge cases",
            description: "Handle empty input.",
          },
          {
            taskId: "task-1",
            title: "Doc drift",
            description: "README is stale.",
          },
        ],
        advisories: [],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse({
      text,
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.reopenTaskIds).toEqual(["task-2", "task-1"]);
    }
  });

  it("returns infra_error when an issue references a task outside the context", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "Wrong issue task",
        issues: [
          {
            taskId: "task-missing",
            title: "Wrong task",
            description: "Issue points outside the context.",
          },
        ],
        advisories: [],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse({
      text,
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("schema_mismatch");
    }
  });

  it("carries a cited criterionId through to the fail outcome's issues", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "The plan document was never updated.",
        issues: [
          {
            taskId: "task-2",
            criterionId: "plan-updated",
            title: "Stale plan document",
            description: "The final plan document still shows the draft.",
          },
        ],
        advisories: [],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse({
      text,
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
      allowedCriterionIds: ["summaries-complete", "plan-updated"],
      requireIssueCriterionId: true,
    }).result;
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.issues[0]?.criterionId).toBe("plan-updated");
    }
  });

  it("returns infra_error schema_mismatch when the acceptance seat omits the required criterionId", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "The plan document was never updated.",
        issues: [
          {
            taskId: "task-2",
            title: "Stale plan document",
            description: "The final plan document still shows the draft.",
          },
        ],
        advisories: [],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse({
      text,
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
      allowedCriterionIds: ["summaries-complete", "plan-updated"],
      requireIssueCriterionId: true,
    }).result;
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("schema_mismatch");
    }
  });

  it("returns infra_error when an issue cites a criterion outside the context", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "Wrong criterion cited.",
        issues: [
          {
            taskId: "task-2",
            criterionId: "criterion-missing",
            title: "Stale plan document",
            description: "The final plan document still shows the draft.",
          },
        ],
        advisories: [],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse({
      text,
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
      allowedCriterionIds: ["summaries-complete", "plan-updated"],
      requireIssueCriterionId: false,
    }).result;
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("schema_mismatch");
    }
  });

  it("accepts a specialist issue without criterionId when citation is optional", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "Mandate finding.",
        issues: [
          {
            taskId: "task-1",
            title: "Unparameterized query",
            description: "The lookup concatenates user input into SQL.",
          },
        ],
        advisories: [],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse({
      text,
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
      allowedCriterionIds: ["summaries-complete", "plan-updated"],
      requireIssueCriterionId: false,
    }).result;
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.reopenTaskIds).toEqual(["task-1"]);
    }
  });

  it("returns infra_error schema_mismatch when an issue omits taskId", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "Coverage gap",
        issues: [
          {
            title: "Coverage gap",
            description: "Add missing tests.",
          },
        ],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse({
      text,
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("schema_mismatch");
    }
  });
});

describe("buildContextValidationPrompt", () => {
  it("judges a structured reader's input artifacts without attributing the producer's diff to that reader", () => {
    const prompt = buildContextValidationPrompt({
      context: {
        ...context,
        placement: { lane: "session", mode: "readOnly" },
        outputSchema: { type: "object" },
      },
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      diffScopeSection:
        "These are the uncommitted changes this context produced",
    });
    expect(prompt).toContain("input artifacts");
    expect(prompt).not.toContain("changes this context produced");
  });

  it("shows the exact captured handoff separately from task summaries", () => {
    const value = {
      issueIds: ["issue-1"],
      instructions:
        "Preserve the entire instruction, including its final requirement.",
    };
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      outputCandidate: {
        value,
        capturedAt: "2026-09-05T00:00:00Z",
        iteration: 1,
        parse: { source: "native" },
      },
    });
    expect(prompt).toContain("Captured handoff under review");
    expect(prompt).toContain(JSON.stringify(value, null, 2));
    expect(prompt).toContain("issue IDs");
  });

  it("requires resolved validation selections", () => {
    expectTypeOf<
      BuildContextValidationPromptInput["validationSelections"]
    >().toEqualTypeOf<ValidationPromptSelections>();
  });

  it("includes the exact acceptance criteria and ordered task summaries", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(prompt).toContain(
      "Every task summary is complete and the final plan document is updated.",
    );
    expect(prompt).toContain("task-1");
    expect(prompt).toContain("task-2");
    expect(prompt).toContain("Created the widget component with error states.");
    expect(prompt).toContain(
      "Added unit tests for the widget and loading states.",
    );
  });

  it("renders prose acceptance criteria as a one-record numbered list", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(prompt).toContain(
      "1. [ac-1] Every task summary is complete and the final plan document is updated.",
    );
  });

  it("renders record acceptance criteria as the same numbered list shape", () => {
    const prompt = buildContextValidationPrompt({
      context: {
        ...context,
        acceptanceCriteria: [
          {
            id: "summaries-complete",
            statement: "Every task summary is complete.",
          },
          {
            id: "plan-updated",
            statement: "The final plan document is updated.",
          },
        ],
      },
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(prompt).toContain(
      [
        "1. [summaries-complete] Every task summary is complete.",
        "2. [plan-updated] The final plan document is updated.",
      ].join("\n"),
    );
  });

  it("documents the issues-only response contract", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(prompt).toContain("`issues`");
    expect(prompt).toContain("`taskId`");
    expect(prompt).toContain("empty");
    expect(prompt).toContain("inspect files and verify the agent's claims");
    expect(prompt).not.toContain("`pass`");
    expect(prompt).not.toContain("`reopenTaskIds`");
  });

  it("instructs the acceptance seat to cite the violated criterion id in each blocking issue, naming the response field", () => {
    // The default general-reviewer seat judges the criteria themselves, so its
    // issue contract carries the citation: the exact field (`criterionId`) and
    // where its value comes from (the numbered list above).
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(prompt).toContain("`{ taskId, criterionId, title, description }`");
    expect(prompt).toContain(
      "set `criterionId` to the violated criterion's id from the numbered Acceptance Criteria list above",
    );
  });

  it("offers a specialist blocking seat an optional criterionId tied to its mandate", () => {
    const specialist: ValidatorAssignment = {
      ...validatorConfig,
      id: "security",
      profile: { tier: "project", id: "security-auditor" },
      focus: "auth boundaries",
    };
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(specialist),
    });

    expect(prompt).toContain("`{ taskId, title, description, criterionId? }`");
    expect(prompt).toContain(
      "only when your finding also contradicts that specific criterion",
    );
    expect(prompt).not.toContain(
      "`{ taskId, criterionId, title, description }`",
    );
  });

  it("describes `planDefects` to a blocking seat, whose dispatched schema admits it", () => {
    // The section enumerates the fields the seat's authority admits, so it has
    // to name the third response too — a seat told only about issues and
    // advisories reads the response this ticket added as one it may not use.
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(prompt).toContain("`planDefects`");
    expect(prompt).toContain("`whyNotLocallyRemediable`");
    expect(prompt).toContain("`conflictingContract`");
  });

  it("does not tell a blocking seat that an empty `issues` array alone is a pass", () => {
    // It is not: a verdict carrying plan defects concludes the round as a plan
    // defect however empty `issues` is, so the unqualified equivalence would
    // describe a pass the engine never renders.
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(prompt).not.toContain(
      "An empty `issues` array means the context passes validation.",
    );
  });

  it("tells an advisory seat about neither, matching its dispatched schema", () => {
    // Withheld for the reason `issues` is: the advisory schema has no such
    // field, so describing one only produces verdicts that fail the output gate
    // and burn the lane's attempts.
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment({ ...validatorConfig, authority: "advisory" }),
    });

    expect(prompt).not.toContain("`planDefects`");
    expect(prompt).not.toContain("`issues`");
  });

  it("frames validation as intent-based judgment rather than literal matching", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    const lowered = prompt.toLowerCase();
    expect(lowered).toContain("intent");
    expect(lowered).toMatch(/imprecise|judgment|close enough|closely enough/);
    expect(prompt).not.toContain("exact acceptance criteria");
    expect(lowered).not.toContain("literal");
  });

  it("instructs the validator to skip deterministic checks (tests, types, lint, build)", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    const lowered = prompt.toLowerCase();
    expect(lowered).toMatch(/do not|don't|must not/);
    expect(lowered).toContain("tests");
    expect(lowered).toMatch(/type (errors|checks|checking)/);
    expect(lowered).toMatch(/lint|build|compile/);
  });

  it("names the actual script-gate selection when selections are provided", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
      validationSelections: {
        registry: "loaded",
        enabled: { kind: "commands", commands: [{ name: "test", cost: 4 }] },
        disabled: ["typecheck", "format"],
        scriptGate: { kind: "commands", commands: ["typecheck", "test"] },
      },
    });

    expect(prompt).toContain(
      "The script gate for this context runs `typecheck`, `test` separately",
    );
    expect(prompt).not.toContain("pre-merge validation script");
    // The generated section lists the validator's own effective commands.
    expect(prompt).toContain("## Validation Commands");
    expect(prompt).toContain("Enabled for you in this context: test (cost 4).");
    expect(prompt).toContain(
      "Disabled for you in this context: typecheck, format.",
    );
    expect(prompt).toContain(
      "If a run is refused for capacity, continue other work and retry later, or re-run with `--queue-if-busy` to join the FIFO queue.",
    );
  });

  it("attributes an absent script gate to workflow policy", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
      validationSelections: {
        registry: "none",
        enabled: { kind: "commands", commands: [] },
        disabled: [],
        scriptGate: { kind: "off" },
      },
    });

    expect(prompt).toContain("## Validation Commands");
    expect(prompt).toContain(
      "No validation commands are enabled for you in this context.",
    );
    expect(prompt).toContain(
      "No validation commands are disabled by policy in this context.",
    );
    expect(prompt).toContain("No script gate is selected for this context.");
    expect(prompt).toContain("workflow policy disables it");
    expect(prompt).not.toContain("pre-merge validation script");
  });

  it("uses selection-aware guidance for an explicit empty policy", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
      validationSelections: {
        registry: "none",
        enabled: { kind: "commands", commands: [] },
        disabled: [],
        scriptGate: { kind: "off" },
      },
    });

    expect(prompt).toContain("## Validation Commands");
    expect(prompt).toContain("workflow policy disables it");
    expect(prompt).not.toContain("pre-merge validation script");
  });

  it("instructs the validator to respect context scope boundaries with downstream contexts", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    const lowered = prompt.toLowerCase();
    expect(lowered).toContain("scope");
    expect(lowered).toMatch(
      /downstream|other context|another context|later context/,
    );
  });

  it("requires a production call path and both accepted forms of explicit deferral evidence", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    const guidance = prompt.slice(prompt.indexOf("## Evaluation Guidance"));
    expect(guidance).toContain("production call path");
    expect(guidance).toContain("no production caller");
    expect(guidance).toContain(
      "this context's acceptance criteria explicitly name that downstream owner",
    );
    expect(guidance).toContain(
      "the downstream owner's acceptance criteria contain the matching obligation",
    );
    expect(guidance).toContain("only to a graph-downstream owner");
    expect(guidance).toContain(
      "ownership claim alone cannot invent the handoff",
    );
  });

  it("instructs the validator to check each charter invariant and cite its id when invariants are declared", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      charter: {
        ...charter,
        invariants: [
          {
            id: "server-side-enforcement",
            statement: "Every gate is enforced server-side.",
          },
        ],
      },
    });

    const guidance = prompt.slice(prompt.indexOf("## Evaluation Guidance"));
    expect(guidance.toLowerCase()).toContain("invariant");
    expect(guidance).toContain("cite the invariant id");
    // The digest above the guidance carries the declared invariant itself.
    expect(prompt).toContain("server-side-enforcement");
  });

  it("tells the validator a process-shaped invariant is satisfied by its outcome, never by proof of process", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      charter: {
        ...charter,
        invariants: [
          {
            id: "tests-first",
            statement: "Behavior changes start with a failing test.",
          },
        ],
      },
    });

    const guidance = prompt.slice(prompt.indexOf("## Evaluation Guidance"));
    expect(guidance).toContain("how the work was produced");
    expect(guidance).toContain(
      "never raise an issue for missing process evidence",
    );
  });

  it("renders no amendment log or access-policy text in the charter section", () => {
    // The prompt diet (change 3): the validator reads the current rules from
    // its prompt; amendment history and access bookkeeping live only in
    // charter.md and the durable record.
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      charter,
    });

    expect(prompt).not.toContain("Amendment log");
    expect(prompt).not.toContain("Access:");
    expect(prompt).not.toContain("permission-gated");
  });

  it("renders only global sources plus sources scoped to the validated context", () => {
    const scopedCharter: WorkflowCharter = {
      ...charter,
      sourcesOfTruth: [
        ...charter.sourcesOfTruth,
        {
          rank: 3,
          id: "verify-notes",
          label: "Verification Notes",
          type: "document",
          locator: "docs/verify-notes.md",
          description: "Notes that only concern the verification context.",
          appliesTo: { contextIds: ["context-verify"] },
        },
      ],
    };

    const outOfScope = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      charter: scopedCharter,
    });
    const inScope = buildContextValidationPrompt({
      context,
      charterContextId: "context-verify",
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      charter: scopedCharter,
    });

    // The validated context is `context-implement`; the rank-3 source is scoped
    // to `context-verify`, so it renders only when that id is the rendering
    // context (charterContextId overrides context.id for loop instances).
    expect(outOfScope).not.toContain("Verification Notes");
    expect(inScope).toContain("Verification Notes");
    expect(outOfScope).toContain("Published API Contract");
    expect(inScope).toContain("Published API Contract");
  });

  it("omits the invariant-check instruction when the charter declares no invariants", () => {
    const withoutInvariants = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      charter,
    });
    const withoutCharter = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    for (const prompt of [withoutInvariants, withoutCharter]) {
      const guidance = prompt.slice(prompt.indexOf("## Evaluation Guidance"));
      expect(guidance.toLowerCase()).not.toContain("invariant");
    }
  });

  it("begins with the charter digest and a pointer to charter.md when a charter is supplied", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      charter,
    });

    expect(prompt.startsWith("# Workflow Charter")).toBe(true);
    expect(prompt).toContain(
      "Ship the widget that adheres to the published API contract.",
    );
    expect(prompt).toContain(".cc/graph-workflow-docs/charter.md");
    // The charter digest must precede the validation header.
    expect(prompt.indexOf("# Workflow Charter")).toBeLessThan(
      prompt.indexOf("# Context Validation"),
    );
  });

  it("begins with the context validation header when no charter is supplied", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(prompt.startsWith("# Context Validation")).toBe(true);
    expect(prompt).not.toContain("# Workflow Charter");
  });

  it("carries no charter-conflict deferral rule (conflicts are resolved at plan time)", () => {
    // Change 3 retired the runtime deferral judgment: the validator judges the
    // contract, and unresolved source conflicts are plan defects, not per-round
    // reconciliation work.
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      charter,
    });

    const guidance = prompt.slice(prompt.indexOf("## Evaluation Guidance"));
    const lowered = guidance.toLowerCase();

    expect(lowered).not.toContain("higher-ranked source");
    expect(lowered).not.toContain("prevailing source");
    expect(lowered).not.toContain("charter conflict");
  });

  it("embeds the framed answers block on a validator resume", () => {
    const questionBatchId = "batch-validator-1";
    const answers: Record<string, AskQuestionAnswer> = {
      q1: {
        selected: ["Reopen task-2"],
        note: null,
        skipped: false,
        question: "Should the missing coverage reopen task-2?",
      },
    };

    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      resumeUserInput: { questionBatchId, answers },
    });

    const split = splitQuestionAnswersBlock(prompt);
    expect(split).not.toBeNull();
    expect(split?.block.questionBatchId).toBe(questionBatchId);
    expect(split?.block.answers).toEqual(answers);
    expect(prompt).toContain(
      formatQuestionAnswersBlock(questionBatchId, answers),
    );
    expect(prompt).toContain("## Your Question Was Answered");
  });

  it("omits the answers section without a validator resume", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(splitQuestionAnswersBlock(prompt)).toBeNull();
    expect(prompt).not.toContain("## Your Question Was Answered");
  });

  it("adds the ask-protocol reminder when askUserQuestionsEnabled is true", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      askUserQuestionsEnabled: true,
    });

    expect(prompt).toContain("## Asking the User");
    expect(prompt).toContain("cctl ask");
    expect(prompt).toMatch(/end your turn/i);
    expect(prompt).toMatch(/pause/i);
    expect(prompt).toMatch(/best judgment/i);
  });

  it("omits the ask-protocol reminder when askUserQuestionsEnabled is false or undefined", () => {
    const disabled = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      askUserQuestionsEnabled: false,
    });
    const unset = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(disabled).not.toContain("## Asking the User");
    expect(unset).not.toContain("## Asking the User");
  });
});

describe("resolveValidatorAskUserQuestionsEnabled (Req 8.1, codex suppression)", () => {
  const claudeValidator: ValidatorAssignment = {
    id: "general",
    profile: { tier: "builtin", id: "general-reviewer" },
    strategy: "conversation",
    authority: "blocking",
    agent: {
      backend: "claude",
      modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
    },
    continuity: { enabled: true },
  };
  const codexValidator: ValidatorAssignment = {
    id: "general",
    profile: { tier: "builtin", id: "general-reviewer" },
    strategy: "task",
    authority: "blocking",
    agent: {
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "medium", fast: "false" },
      },
    },
    continuity: { enabled: true },
  };

  it("is true only for a claude validator when the toggle is enabled", () => {
    const enabledContext: GraphWorkflowResolvedContext = {
      ...context,
      askUserQuestions: { enabled: true },
    };
    expect(
      resolveValidatorAskUserQuestionsEnabled(claudeValidator, enabledContext),
    ).toBe(true);
  });

  it("is false for a codex validator even when the toggle is enabled (suppressed)", () => {
    const enabledContext: GraphWorkflowResolvedContext = {
      ...context,
      askUserQuestions: { enabled: true },
    };
    expect(
      resolveValidatorAskUserQuestionsEnabled(codexValidator, enabledContext),
    ).toBe(false);
  });

  // The two suppression clauses are independent: strategy decides whether the
  // lane has an ask transport at all, the backend decides whether that
  // transport can deliver a mid-turn ask. A task-strategy lane has no
  // conversation to park, so it never sees the tool even on a backend that
  // supports asking (amended R9).
  it("is false for a task-strategy validator on an asking-capable backend", () => {
    const taskStrategyOnClaude: ValidatorAssignment = {
      ...claudeValidator,
      strategy: "task",
    };
    const enabledContext: GraphWorkflowResolvedContext = {
      ...context,
      askUserQuestions: { enabled: true },
    };
    expect(
      resolveValidatorAskUserQuestionsEnabled(
        taskStrategyOnClaude,
        enabledContext,
      ),
    ).toBe(false);
  });

  it("is false for a claude validator when the toggle is disabled", () => {
    expect(
      resolveValidatorAskUserQuestionsEnabled(claudeValidator, context),
    ).toBe(false);
  });

  it("a codex-validator prompt built with the derived flag carries no reminder", () => {
    const enabledContext: GraphWorkflowResolvedContext = {
      ...context,
      askUserQuestions: { enabled: true },
    };
    const derived = resolveValidatorAskUserQuestionsEnabled(
      codexValidator,
      enabledContext,
    );
    const prompt = buildContextValidationPrompt({
      context: enabledContext,
      tasks,
      taskStates,
      validator: seedAssignment(codexValidator),
      askUserQuestionsEnabled: derived,
    });

    expect(derived).toBe(false);
    expect(prompt).not.toContain("## Asking the User");
  });
});

describe("parseValidatorResponse", () => {
  it("prefers structuredOutput and derives reopenTaskIds from issue taskIds", () => {
    const result = parseValidatorResponse({
      text: "ignored",
      engine: "claude",
      authority: "blocking",
      structuredOutput: {
        summary: "Needs work",
        issues: [{ taskId: "task-1", title: "Bug", description: "Fix" }],
        advisories: [],
      },
      allowedTaskIds: ["task-1", "task-2"],
    });

    expect(result.result.kind).toBe("fail");
    if (result.result.kind === "fail") {
      expect(result.result.reopenTaskIds).toEqual(["task-1"]);
    }
    expect(result.parsePath).toBe("structured_output");
  });

  // Pins the deliberate shared-chain widening for this consumer (Phase 3
  // review F5, approved in the 2026-07-13 addendum to the Phase 1 slice
  // designs): an INVALID native candidate does not hard-fail the turn — the
  // chain falls through to a schema-valid fenced-JSON candidate in the same
  // turn's text. Guards against a consumer-level "stop after invalid native"
  // regression.
  it("falls through an invalid native candidate to a valid fenced-JSON text candidate", () => {
    const validFencedText = [
      "Here is my verdict:",
      "```json",
      JSON.stringify({
        summary: "Recovered via fenced JSON.",
        issues: [{ taskId: "task-1", title: "Bug", description: "Fix" }],
        advisories: [],
      }),
      "```",
    ].join("\n");

    // Native payload omits the required `summary` field — invalid against the
    // validator schema.
    const result = parseValidatorResponse({
      text: validFencedText,
      engine: "claude",
      authority: "blocking",
      structuredOutput: { issues: [] },
      allowedTaskIds: ["task-1", "task-2"],
    });

    expect(result.result.kind).toBe("fail");
    if (result.result.kind === "fail") {
      expect(result.result.reopenTaskIds).toEqual(["task-1"]);
    }
    expect(result.parsePath).toBe("fenced_json_block");
  });
});

describe("parseValidatorResponse advisories", () => {
  const ADVISORY = {
    kind: "implementation" as const,
    title: "Duplicated retry helper",
    description: "Both lanes hand-roll the same backoff.",
  };

  function fenced(payload: unknown): string {
    return ["```json", JSON.stringify(payload), "```"].join("\n");
  }

  it("carries a blocking validator's advisories through a passing verdict", () => {
    const outcome = parseValidatorResponse({
      text: fenced({
        summary: "Criteria met.",
        issues: [],
        advisories: [ADVISORY],
      }),
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;

    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    expect(outcome.advisories).toEqual([ADVISORY]);
  });

  it("carries advisories through a rejecting verdict alongside its issues", () => {
    const outcome = parseValidatorResponse({
      text: fenced({
        summary: "One blocker, one suggestion.",
        issues: [
          {
            taskId: "task-2",
            title: "Coverage gap",
            description: "Add tests.",
          },
        ],
        advisories: [ADVISORY],
      }),
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;

    expect(outcome.kind).toBe("fail");
    if (outcome.kind !== "fail") return;
    expect(outcome.reopenTaskIds).toEqual(["task-2"]);
    expect(outcome.advisories).toEqual([ADVISORY]);
  });

  it("parses an advisory validator's verdict, which carries no issues field", () => {
    const outcome = parseValidatorResponse({
      text: fenced({ summary: "Two observations.", advisories: [ADVISORY] }),
      engine: "claude",
      authority: "advisory",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;

    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    expect(outcome.advisories).toEqual([ADVISORY]);
    // An advisory assignment can never reopen a task, whatever it observed.
    expect(outcome.issues).toEqual([]);
    expect(outcome.reopenTaskIds).toEqual([]);
  });

  it("refuses issues from an advisory validator, taking the structured-output retry path", () => {
    const outcome = parseValidatorResponse({
      text: fenced({
        summary: "Trying to block.",
        advisories: [],
        issues: [
          { taskId: "task-1", title: "Blocker", description: "Reopen this." },
        ],
      }),
      engine: "claude",
      authority: "advisory",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;

    // Authority is structural: an advisory validator cannot smuggle a blocking
    // finding through by emitting the blocking shape.
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind !== "infra_error") return;
    expect(outcome.reason).toBe("schema_mismatch");
  });

  it("passes an advisory about out-of-context code verbatim, spending no attempt", () => {
    const outOfContext = {
      kind: "out_of_scope" as const,
      title: "task-elsewhere leaks a handle",
      description: "src/other/pool.ts, owned by no task in this context.",
    };

    for (const authority of ["blocking", "advisory"] as const) {
      const outcome = parseValidatorResponse({
        text: fenced({
          summary: "Nothing blocking here.",
          ...(authority === "blocking" ? { issues: [] } : {}),
          advisories: [outOfContext],
        }),
        engine: "claude",
        authority,
        allowedTaskIds: ["task-1", "task-2"],
      }).result;

      // The same reference raised as an ISSUE is an infra_error that costs the
      // lane an attempt (see the task-id containment tests above). Raised as an
      // advisory it never reaches that check: the verdict settles as a pass,
      // and only an infra_error dispatch increments a lane's attempt count.
      expect(outcome.kind, `authority=${authority}`).toBe("pass");
      if (outcome.kind !== "pass") return;
      expect(outcome.advisories).toEqual([outOfContext]);
    }
  });
});

/**
 * The fallback parse paths (raw JSON, fenced block) are not a laxer contract
 * than the dispatched schema — they are the SAME contract read back. A backend
 * with no native structured output reaches the engine through here, so anything
 * these twins accept is a verdict shape that authority never gated. Each case
 * below is a payload the dispatched schema refuses (`required`, or
 * `additionalProperties: false`) and therefore one the parser must also refuse,
 * turning it into the retry that the structured-output gate would have run.
 */
describe("parseValidatorResponse verdict shape is the dispatched schema", () => {
  const ADVISORY = {
    kind: "implementation" as const,
    title: "Duplicated retry helper",
    description: "Both lanes hand-roll the same backoff.",
  };
  const ISSUE = {
    taskId: "task-1",
    title: "Coverage gap",
    description: "Add missing tests.",
  };
  const PLAN_DEFECT = {
    title: "Criterion 3 requires downstream-owned wiring",
    description:
      "The route this context must call is created by `wire-routes`, two contexts later.",
    whyNotLocallyRemediable:
      "No task here owns the route module, and creating it would take this context's scope.",
    conflictingContract:
      "Acceptance criterion 3 vs. the `wire-routes` boundary",
  };

  function fenced(payload: unknown): string {
    return ["```json", JSON.stringify(payload), "```"].join("\n");
  }

  function parseFenced(
    authority: "blocking" | "advisory",
    payload: unknown,
  ): ValidatorOutcome {
    return parseValidatorResponse({
      text: fenced(payload),
      engine: "claude",
      authority,
      allowedTaskIds: ["task-1", "task-2"],
    }).result;
  }

  function expectSchemaMismatch(
    outcome: ValidatorOutcome,
    label: string,
  ): void {
    expect(outcome.kind, label).toBe("infra_error");
    if (outcome.kind !== "infra_error") return;
    expect(outcome.reason, label).toBe("schema_mismatch");
  }

  const REFUSED: Array<{
    label: string;
    authority: "blocking" | "advisory";
    payload: unknown;
  }> = [
    {
      label: "advisory verdict omitting advisories",
      authority: "advisory",
      payload: { summary: "Nothing to report." },
    },
    {
      label: "blocking verdict omitting advisories",
      authority: "blocking",
      payload: { summary: "Criteria met.", issues: [] },
    },
    {
      label: "blocking verdict omitting issues",
      authority: "blocking",
      payload: { summary: "Criteria met.", advisories: [] },
    },
    {
      label: "advisory item carrying a taskId",
      authority: "advisory",
      payload: {
        summary: "Observation.",
        advisories: [{ ...ADVISORY, taskId: "task-1" }],
      },
    },
    {
      label: "blocking verdict whose advisory carries a taskId",
      authority: "blocking",
      payload: {
        summary: "Observation.",
        issues: [],
        advisories: [{ ...ADVISORY, taskId: "task-1" }],
      },
    },
    {
      label: "blocking verdict with an unknown top-level key",
      authority: "blocking",
      payload: {
        summary: "Criteria met.",
        issues: [],
        advisories: [],
        verdict: "approved",
      },
    },
    {
      label: "advisory verdict with an unknown top-level key",
      authority: "advisory",
      payload: { summary: "Observation.", advisories: [], issueCount: 0 },
    },
    {
      label: "issue carrying an unknown key",
      authority: "blocking",
      payload: {
        summary: "One blocker.",
        issues: [{ ...ISSUE, severity: "high" }],
        advisories: [],
      },
    },
    {
      // The advisory schema has no planDefects field, so a seat with no
      // blocking authority cannot route a context to plan repair either.
      label: "advisory verdict carrying planDefects",
      authority: "advisory",
      payload: {
        summary: "Observation.",
        advisories: [],
        planDefects: [PLAN_DEFECT],
      },
    },
    {
      label: "plan defect omitting whyNotLocallyRemediable",
      authority: "blocking",
      payload: {
        summary: "Contract is unsatisfiable.",
        issues: [],
        advisories: [],
        planDefects: [
          {
            title: PLAN_DEFECT.title,
            description: PLAN_DEFECT.description,
            conflictingContract: PLAN_DEFECT.conflictingContract,
          },
        ],
      },
    },
    {
      label: "plan defect omitting conflictingContract",
      authority: "blocking",
      payload: {
        summary: "Contract is unsatisfiable.",
        issues: [],
        advisories: [],
        planDefects: [
          {
            title: PLAN_DEFECT.title,
            description: PLAN_DEFECT.description,
            whyNotLocallyRemediable: PLAN_DEFECT.whyNotLocallyRemediable,
          },
        ],
      },
    },
    {
      // A plan defect names no task by construction — one that could would
      // reintroduce exactly the misrouting the response exists to replace.
      label: "plan defect carrying a taskId",
      authority: "blocking",
      payload: {
        summary: "Contract is unsatisfiable.",
        issues: [],
        advisories: [],
        planDefects: [{ ...PLAN_DEFECT, taskId: "task-1" }],
      },
    },
  ];

  it.each(REFUSED)(
    "refuses a $label on the fenced-JSON path",
    ({ label, authority, payload }) => {
      expectSchemaMismatch(parseFenced(authority, payload), label);
    },
  );

  it.each([REFUSED[0]!])(
    "refuses a $label on the raw-JSON path",
    ({ label, authority, payload }) => {
      const outcome = parseValidatorResponse({
        text: JSON.stringify(payload),
        engine: "claude",
        authority,
        allowedTaskIds: ["task-1", "task-2"],
      }).result;

      expectSchemaMismatch(outcome, label);
    },
  );

  it.each([REFUSED[0]!])(
    "refuses a $label on the native structured-output path",
    ({ label, authority, payload }) => {
      const outcome = parseValidatorResponse({
        text: "The verdict is above.",
        engine: "claude",
        authority,
        structuredOutput: payload,
        allowedTaskIds: ["task-1", "task-2"],
      }).result;

      expectSchemaMismatch(outcome, label);
    },
  );

  it("accepts the exact dispatched shape on every parse path", () => {
    const blocking = { summary: "Criteria met.", issues: [], advisories: [] };
    const advisory = { summary: "Observation.", advisories: [ADVISORY] };

    expect(parseFenced("blocking", blocking).kind).toBe("pass");
    expect(parseFenced("advisory", advisory).kind).toBe("pass");
    expect(
      parseValidatorResponse({
        text: JSON.stringify(blocking),
        engine: "claude",
        authority: "blocking",
        allowedTaskIds: ["task-1", "task-2"],
      }).result.kind,
    ).toBe("pass");
    expect(
      parseValidatorResponse({
        text: "The verdict is above.",
        engine: "claude",
        authority: "advisory",
        structuredOutput: advisory,
        allowedTaskIds: ["task-1", "task-2"],
      }).result.kind,
    ).toBe("pass");
  });
});

describe("parseValidatorResponse plan defects", () => {
  const PLAN_DEFECT = {
    title: "Criterion 3 requires downstream-owned wiring",
    description:
      "The route this context must call is created by `wire-routes`, two contexts later.",
    whyNotLocallyRemediable:
      "No task here owns the route module, and creating it would take this context's scope.",
    conflictingContract:
      "Acceptance criterion 3 vs. the `wire-routes` boundary",
  };
  const ISSUE = {
    taskId: "task-2",
    title: "Coverage gap",
    description: "Add missing tests.",
  };
  const ADVISORY = {
    kind: "plan" as const,
    title: "Two contexts describe the same module",
    description: "Worth reconciling before the next round.",
  };

  function parseBlocking(payload: unknown): ValidatorOutcome {
    return parseValidatorResponse({
      text: ["```json", JSON.stringify(payload), "```"].join("\n"),
      engine: "claude",
      authority: "blocking",
      allowedTaskIds: ["task-1", "task-2"],
    }).result;
  }

  it("concludes plan_defect and carries the findings when a blocking seat reports one", () => {
    const outcome = parseBlocking({
      summary: "The assigned contract cannot be satisfied here.",
      issues: [],
      advisories: [ADVISORY],
      planDefects: [PLAN_DEFECT],
    });

    expect(outcome.kind).toBe("plan_defect");
    if (outcome.kind !== "plan_defect") return;
    expect(outcome.planDefects).toEqual([PLAN_DEFECT]);
    expect(outcome.summary).toBe(
      "The assigned contract cannot be satisfied here.",
    );
    expect(outcome.advisories).toEqual([ADVISORY]);
    expect(outcome.engine).toBe("claude");
  });

  it("takes precedence over issues, preserving them as evidence", () => {
    // A defect and a reopen are not both actionable: reopening a task cannot
    // remedy a contract no task owns, so the round routes to plan repair and
    // the issues travel with it as what the seat also saw.
    const outcome = parseBlocking({
      summary: "Contradictory contract, plus a test gap.",
      issues: [ISSUE],
      advisories: [],
      planDefects: [PLAN_DEFECT],
    });

    expect(outcome.kind).toBe("plan_defect");
    if (outcome.kind !== "plan_defect") return;
    expect(outcome.issues).toEqual([ISSUE]);
    expect(outcome.planDefects).toEqual([PLAN_DEFECT]);
  });

  it("cannot reopen a task: the outcome has no reopenTaskIds to carry one", () => {
    const outcome = parseBlocking({
      summary: "Contradictory contract, plus a test gap.",
      issues: [ISSUE],
      advisories: [],
      planDefects: [PLAN_DEFECT],
    });

    expect(outcome.kind).toBe("plan_defect");
    if (outcome.kind !== "plan_defect") return;
    expectTypeOf(outcome).not.toHaveProperty("reopenTaskIds");
    expect(outcome).not.toHaveProperty("reopenTaskIds");
  });

  it("leaves the two-response behaviour unchanged when planDefects is absent or empty", () => {
    expect(
      parseBlocking({ summary: "Criteria met.", issues: [], advisories: [] })
        .kind,
    ).toBe("pass");
    expect(
      parseBlocking({
        summary: "Criteria met.",
        issues: [],
        advisories: [],
        planDefects: [],
      }).kind,
    ).toBe("pass");
    expect(
      parseBlocking({
        summary: "One blocker.",
        issues: [ISSUE],
        advisories: [],
        planDefects: [],
      }).kind,
    ).toBe("fail");
  });
});

describe("createValidatorRunner", () => {
  it("dispatches an agent validator through its configured backend instead of its legacy validator-type label", async () => {
    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(verdictJson("All good")),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });
    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (candidate) => candidate.id === "context-plan",
    )!;
    const validator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "conversation",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(validator),
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actorInput: expect.objectContaining({
          conversation: expect.objectContaining({ agentBackend: "codex" }),
        }),
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      }),
    );
  });

  // Construction-site contract (Design 4, AC #3): a `__validator__:*` lane has no
  // persisted ConversationState record, so its runtime is constructed with an
  // explicit `persistence: "ephemeral"` choice. This is the exact site that
  // logged 1,314 `Conversation not found in session` mutation failures before the
  // adapter existed — one per syncDerived / mark-read / mark-unread transition of
  // every validator turn. The compaction-lane half of AC #3 is asserted in
  // context-artifacts/service.test.ts.
  it("constructs the validator lane as an ephemeral runtime (no ConversationState record)", async () => {
    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(verdictJson("All good")),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });
    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (candidate) => candidate.id === "context-plan",
    )!;

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(validatorConfig),
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.stringMatching(/^__validator__:/),
        actorInput: expect.objectContaining({ persistence: "ephemeral" }),
      }),
    );
  });

  it("dispatches a registered third backend through the semantic conversation strategy", async () => {
    const fake = createTestFakeBackend();
    _registerBackendForTesting(fake.descriptor);
    try {
      const executeWorkflowTaskRun = vi.fn(async () =>
        textTaskRun(verdictJson("All good"), {
          backendRef: {
            backend: TESTFAKE_BACKEND_ID,
            ref: "testfake-review-ref",
          },
        }),
      );
      const runner = createValidatorRunner({
        resolveWorktreePath: stubWorktreePath,
        resolveTimeoutMs: stubTimeoutMs,
        executeWorkflowTaskRun,
        getProjectDisplayName: stubProjectDisplayName,
        continuityService: {
          async resolveValidatorCall(input) {
            return {
              execution: input.execution,
              sessionAction: "create",
              strategy: "conversation",
              backend: input.backend,
              conversationId: "testfake-conversation",
            };
          },
          async recordLaneTurnOutcome(input) {
            return input.execution;
          },
        },
      });
      const execution = buildExecutionWithContextValidation();
      const contextDef = execution.workingDefinition.executionContexts.find(
        (candidate) => candidate.id === "context-plan",
      )!;
      const validator: ValidatorAssignment = {
        id: "general",
        profile: { tier: "builtin", id: "general-reviewer" },
        strategy: "conversation",
        authority: "blocking",
        continuity: { enabled: true },
        // The per-backend union only knows the registered production backends,
        // so a test-only backend needs the cast; the rest of the assignment is
        // typed normally.
        agent: {
          backend: TESTFAKE_BACKEND_ID,
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        } as unknown as ValidatorAssignment["agent"],
      };

      const result = await runner.runContextValidator({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        context: contextDef,
        validator: seedAssignment(validator),
      });

      expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          actorInput: expect.objectContaining({
            conversation: expect.objectContaining({
              agentBackend: TESTFAKE_BACKEND_ID,
            }),
          }),
        }),
      );
      expect(result.metadata.reviewArtifact).toEqual({
        backend: TESTFAKE_BACKEND_ID,
        kind: "conversation",
        ref: "testfake-conversation",
        usage: null,
      });
      expect(result.metadata.sessionRef).toEqual({
        backend: TESTFAKE_BACKEND_ID,
        ref: "testfake-conversation",
        lane: "context_validator",
        assignmentId: soleAssignment(contextDef).id,
        refKind: "conversation",
        workflowConversationId: "testfake-conversation",
      });
    } finally {
      _resetBackendRegistryForTesting();
      bootstrapBackends();
    }
  });

  it("attaches transcript-derived usage to conversation-strategy review artifacts", async () => {
    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(verdictJson("All good")),
    );
    const readValidatorConversationTelemetry = vi.fn(async () => ({
      costUsd: 4.21,
      apiTurns: 9,
    }));
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
      readValidatorConversationTelemetry,
      continuityService: {
        async resolveValidatorCall(input) {
          return {
            execution: input.execution,
            sessionAction: "create",
            strategy: "conversation",
            backend: input.backend,
            conversationId: "conv-val-9",
          };
        },
        async recordLaneTurnOutcome(input) {
          return input.execution;
        },
      },
    });
    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (candidate) => candidate.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(readValidatorConversationTelemetry).toHaveBeenCalledWith(
      "conv-val-9",
    );
    expect(result.metadata.reviewArtifact).toEqual({
      backend: "claude",
      kind: "conversation",
      ref: "conv-val-9",
      usage: { costUsd: 4.21, apiTurns: 9 },
    });
  });

  it("records a null-usage conversation artifact when telemetry is unreadable", async () => {
    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(verdictJson("All good")),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
      readValidatorConversationTelemetry: async () => null,
      continuityService: {
        async resolveValidatorCall(input) {
          return {
            execution: input.execution,
            sessionAction: "create",
            strategy: "conversation",
            backend: input.backend,
            conversationId: "conv-val-10",
          };
        },
        async recordLaneTurnOutcome(input) {
          return input.execution;
        },
      },
    });
    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (candidate) => candidate.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(result.metadata.reviewArtifact).toEqual({
      backend: "claude",
      kind: "conversation",
      ref: "conv-val-10",
      usage: null,
    });
  });

  it("runContextValidator forwards the prompt and schema to executeWorkflowTaskRun and returns the parsed result", async () => {
    const agentResponse = JSON.stringify({
      summary: "Context completed correctly",
      issues: [],
      advisories: [],
    });

    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) => textTaskRun(agentResponse),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input).toMatchObject({
      kind: "task_run",
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
      outputFormat: {
        type: "json_schema",
        // The dispatched schema is the one this seat's authority selects, with
        // its issue ids bound to this context's tasks and criterion records —
        // prose criteria wrap as the single `ac-1` record, and the acceptance
        // seat's citation is required.
        schema: buildValidatorOutputSchema({
          authority: "blocking",
          taskIds: ["task-plan-1", "task-plan-2"],
          criterionIds: ["ac-1"],
          issueCriterionCitation: "required",
        }),
      },
    });
    expect(input.prompt).toContain(
      "Every task summary is complete and the final plan document is updated.",
    );
    expect(result.result.kind).toBe("pass");
  });

  it("filters scoped charter invariants from the dispatched validator prompt", async () => {
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) =>
        textTaskRun(verdictJson("Context completed correctly")),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });
    const execution = buildExecutionWithContextValidation();
    const charter: WorkflowCharter = {
      mission: "Apply invariants only to their declared graph contexts.",
      invariants: [
        { id: "global", statement: "Global-validator-sentinel" },
        {
          id: "verify-only",
          statement: "Out-of-scope-validator-sentinel",
          appliesTo: { contextIds: ["context-verify"] },
        },
      ],
      sourcesOfTruth: [],
    };
    execution.charter = charter;
    const contextDef = execution.workingDefinition.executionContexts.find(
      (candidate) => candidate.id === "context-plan",
    )!;
    contextDef.charter = charter;

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Global-validator-sentinel");
    expect(input.prompt).not.toContain("Out-of-scope-validator-sentinel");
  });

  it("runContextValidator persists the agent transcript alongside validation.jsonl", async () => {
    const TEST_DIR = path.join(__dirname, "__test-logs-validator-transcript__");
    const transcript = [
      {
        seq: 0,
        backend: "claude" as const,
        type: "reasoning",
        raw: { type: "reasoning", text: "weigh AC vs prototype" },
      },
      {
        seq: 1,
        backend: "claude" as const,
        type: "agent_message",
        raw: { type: "agent_message", text: "GO" },
      },
    ];
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult> => ({
        kind: "text",
        text: verdictJson("ok"),
        transcript,
        usage: emptyUsage,
        backendRef: null,
        continuationDisposition: "retain",
      }),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const logger = createExecutionLogger(execution.id, { configDir: TEST_DIR });
    registerExecutionLogger(logger);

    try {
      await runner.runContextValidator({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        context: contextDef,
        validator: soleAssignment(contextDef),
      });

      const transcriptPath = path.join(
        logger.logDir,
        "contexts",
        "context-plan",
        "validators",
        soleAssignment(contextDef).id,
        "validation-transcript.jsonl",
      );
      const entries = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(entries[0]).toMatchObject({
        event: "validator.transcript_begin",
        lane: "context_validator",
        engine: soleAssignment(contextDef).agent.backend,
        attempt: 0,
        entryCount: 2,
      });
      expect(
        entries
          .filter((e) => e.event === "validator.transcript_item")
          .map((e) => e.itemType),
      ).toEqual(["reasoning", "agent_message"]);
    } finally {
      unregisterExecutionLogger(execution.id);
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("runContextValidator persists a captured transcript when the task run returns an infra error", async () => {
    const TEST_DIR = path.join(
      __dirname,
      "__test-logs-validator-error-transcript__",
    );
    const transcript = [
      {
        seq: 0,
        backend: "claude" as const,
        type: "assistant",
        raw: { type: "assistant", text: "partial validation" },
      },
    ];
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult> => ({
        kind: "error",
        error: "validator backend failed",
        aborted: false,
        transcript,
        usage: emptyUsage,
        backendRef: null,
        continuationDisposition: "retain",
      }),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const logger = createExecutionLogger(execution.id, { configDir: TEST_DIR });
    registerExecutionLogger(logger);

    try {
      const result = await runner.runContextValidator({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        context: contextDef,
        validator: soleAssignment(contextDef),
      });

      expect(result.result.kind).toBe("infra_error");
      const entries = readFileSync(
        path.join(
          logger.logDir,
          "contexts",
          "context-plan",
          "validators",
          soleAssignment(contextDef).id,
          "validation-transcript.jsonl",
        ),
        "utf-8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(entries[0]).toMatchObject({
        event: "validator.transcript_begin",
        entryCount: 1,
      });
      expect(entries[1]).toMatchObject({
        event: "validator.transcript_item",
        itemType: "assistant",
        raw: { type: "assistant", text: "partial validation" },
      });
    } finally {
      unregisterExecutionLogger(execution.id);
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("runContextValidator passes the context charter into the prompt ahead of the validation header", async () => {
    const agentResponse = JSON.stringify({
      summary: "Context completed correctly",
      issues: [],
      advisories: [],
    });

    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) => textTaskRun(agentResponse),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const contextWithCharter: GraphWorkflowResolvedContext = {
      ...contextDef,
      charter,
    };

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextWithCharter,
      validator: soleAssignment(contextWithCharter),
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    // The composer prepends the acceptance-criteria deferral cohort to every
    // dispatched validator prompt, so the charter digest opens the builder's
    // section rather than the whole prompt — it still precedes the validation
    // header, which is the ordering the charter contract asserts.
    expect(input.prompt.indexOf("# Workflow Charter")).toBeGreaterThan(-1);
    expect(input.prompt.indexOf("# Workflow Charter")).toBeLessThan(
      input.prompt.indexOf("# Context Validation"),
    );
    expect(input.prompt).toContain(
      "Ship the widget that adheres to the published API contract.",
    );
    expect(input.prompt).toContain(".cc/graph-workflow-docs/charter.md");
  });

  /**
   * The deferral cohort derives from the working definition alone, so it must
   * reach a PLAIN graph run — no spec binding, therefore no prompt projection.
   * Asserting on the renderer alone would pass even if dispatch never composed
   * it, which is exactly the gap this pins: the base validator prompt states
   * the two-route deferral rule unconditionally, so route 2 (the downstream
   * owner's criteria carry the obligation) is uncheckable without the cohort.
   */
  it("runContextValidator renders the deferral cohort on a non-spec run with no prompt projection", async () => {
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) =>
        textTaskRun(verdictJson("Context completed correctly")),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain(
      "## Acceptance-criteria cohort for deferral checks",
    );
    expect(input.prompt).toContain(
      "### `context-plan` — Plan (current context)",
    );
    // Both graph-downstream contexts, verbatim — the route-2 evidence.
    expect(input.prompt).toContain("### `context-implement` — Implement");
    expect(input.prompt).toContain("Feature implemented");
    expect(input.prompt).toContain("### `context-verify` — Verify");
    expect(input.prompt).toContain("Verification passes");
    expect(input.prompt).toContain(
      "Ownership alone never authorizes a production-capability deferral",
    );
    // No projection on a plain run, so nothing may point at a section the
    // validator was never given.
    expect(input.prompt).not.toContain("Spec ownership");
  });

  it("runContextValidator returns infra_error unparseable when the agent produces no JSON", async () => {
    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun("I could not find anything to review."),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("unparseable");
      expect(result.result.engine).toBe("claude");
    }
  });

  it("runContextValidator reports queue pressure as its own outcome, not as an infra error", async () => {
    // The specialist never started: the global query semaphore never admitted
    // it. Reporting that as `infra_error` would make the cohort spend one of the
    // specialist's three attempts on a dispatch that never reached a provider.
    const executeWorkflowTaskRun = vi.fn(async () =>
      errorTaskRun(
        `Query semaphore timeout after 300000ms waiting for slot (label: prompt:session-1) [${QUERY_SLOT_ADMISSION_TIMEOUT_CODE}]`,
      ),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(result.result.kind).toBe("queue_admission_timeout");
  });

  it("runContextValidator still reports a real dispatch failure as an infra error", async () => {
    const executeWorkflowTaskRun = vi.fn(async () =>
      errorTaskRun("provider returned 500"),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(result.result.kind).toBe("infra_error");
  });

  it("runContextValidator returns asked_user when the lane conversation has a pending question, without parsing the verdict", async () => {
    // The turn ends with no parseable verdict — normally infra_error/unparseable.
    // Because the lane conversation has a pending question batch, the runner must
    // short-circuit to asked_user before the verdict parser is ever consulted
    // (design "Park detection → Validator"; Req 3.2).
    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun("Let me ask the operator before I decide."),
    );
    const pendingQuestions = [
      {
        id: "q-1",
        question: "Which approach should the validator prefer?",
        options: [
          { label: "A", recommended: false },
          { label: "B", recommended: false },
        ],
        multiSelect: false,
        required: true,
        allowNote: true,
      },
    ];
    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: "batch-validator-1",
      pendingQuestions,
    }));
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
      readLaneConversation,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(readLaneConversation).toHaveBeenCalledTimes(1);
    expect(result.result.kind).toBe("asked_user");
    if (result.result.kind === "asked_user") {
      expect(result.result.questionBatchId).toBe("batch-validator-1");
      expect(result.result.questions).toHaveLength(1);
      expect(result.result.questions[0]!.question).toBe(
        "Which approach should the validator prefer?",
      );
      expect(result.result.conversationId.length).toBeGreaterThan(0);
    }
  });

  it("runContextValidator parses the verdict normally when the lane conversation has no pending question", async () => {
    // The reader returns null (Codex validator lanes, or no question asked) →
    // the runner falls through to normal verdict parsing (deny-by-default).
    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(verdictJson("Looks good")),
    );
    const readLaneConversation = vi.fn(async () => null);
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
      readLaneConversation,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(result.result.kind).toBe("pass");
  });

  it("runContextValidator returns infra_error exception with engine=codex when executeWorkflowTaskRun throws", async () => {
    const executeWorkflowTaskRun = vi.fn(async () => {
      throw new Error("Codex rate limit exceeded");
    });
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const codexValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "task",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };
    const execution = buildExecutionWithContextValidation(codexValidator);
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(codexValidator),
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("exception");
      expect(result.result.engine).toBe("codex");
    }
  });

  it("runContextValidator returns infra_error exception when codex returns an error result", async () => {
    const executeWorkflowTaskRun = vi.fn(async () =>
      errorTaskRun(
        "thread/resume failed: no rollout found for thread id phantom-123",
      ),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const codexValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "task",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };
    const execution = buildExecutionWithContextValidation(codexValidator);
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(codexValidator),
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("exception");
      expect(result.result.engine).toBe("codex");
      expect(result.result.message).toContain("no rollout found");
    }
  });

  it("runContextValidator forwards the complete codex selection to executeWorkflowTaskRun", async () => {
    const codexResponse = JSON.stringify({
      summary: "Reopen one task.",
      issues: [
        {
          taskId: "task-plan-2",
          // The acceptance seat's issues cite the failed criterion; the
          // fixture context's prose criteria wrap as the single `ac-1` record.
          criterionId: "ac-1",
          title: "Missing tests",
          description: "Add the missing tests.",
        },
      ],
      advisories: [],
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(codexResponse),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const codexValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "task",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };
    const execution = buildExecutionWithContextValidation(codexValidator);
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(codexValidator),
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      }),
    );
    expect(result.result.kind).toBe("fail");
    if (result.result.kind === "fail") {
      expect(result.result.reopenTaskIds).toEqual(["task-plan-2"]);
    }
  });
});

describe("context validator continuity runtime integration", () => {
  const passResponseJson = JSON.stringify({
    summary: "All good",
    issues: [],
    advisories: [],
  });
  const NOW = "2026-04-01T10:00:00.000Z";

  function createInMemoryRepo(initial: GraphWorkflowExecution) {
    let state = initial;
    return {
      async mutateActive(
        _p: string,
        _s: string,
        fn: (
          execution: GraphWorkflowExecution,
        ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
      ): Promise<GraphWorkflowExecution> {
        const next = await fn(structuredClone(state));
        state = next;
        return next;
      },
      read(): GraphWorkflowExecution {
        return state;
      },
      write(exec: GraphWorkflowExecution) {
        state = exec;
      },
    };
  }

  function makeThreadAdapter(
    overrides: Partial<
      Record<"start" | "resumeOrRecover", ReturnType<typeof vi.fn>>
    > = {},
  ) {
    const start =
      overrides.start ??
      vi.fn(async () => ({ backend: "codex" as const, ref: "thread-1" }));
    const resumeOrRecover =
      overrides.resumeOrRecover ??
      vi.fn(async (ref: { backend: "codex"; ref: string }) => ({
        ref,
        recovered: false,
      }));
    const adapter: BackendContinuityAdapter = {
      backend: "codex",
      start,
      resumeOrRecover,
      validate: vi.fn(async () => ({ status: "valid" as const })),
      fork: vi.fn(),
    };
    return { adapter, start, resumeOrRecover };
  }

  function makeLaneContinuityService(
    repo: ReturnType<typeof createInMemoryRepo>,
    deps: Partial<GraphLaneContinuityDeps> = {},
  ): ReturnType<typeof createGraphLaneContinuity> {
    return createGraphLaneContinuity({
      laneService: createLaneService({
        store: createInMemoryLaneStore(),
        now: () => NOW,
      }),
      executionRepository: repo,
      createConversation: vi.fn(),
      getConversation: vi.fn(),
      continuityAdapter: () => makeThreadAdapter().adapter,
      now: () => NOW,
      ...deps,
    });
  }

  it("reuses the Claude context-validator session across consecutive calls", async () => {
    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const repo = createInMemoryRepo(execution);

    let convCounter = 0;
    const createConversation = vi.fn(async () => ({
      id: `conv-val-${++convCounter}`,
    }));
    const getConversation = vi.fn(
      async (_p: string, _s: string, id: string) => ({ id }),
    );

    const continuityService = makeLaneContinuityService(repo, {
      createConversation,
      getConversation,
    });

    let sdkSessionCounter = 0;
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) =>
        textTaskRun(passResponseJson, {
          backendRef: {
            backend: "claude",
            ref: `sdk-session-${++sdkSessionCounter}`,
          },
        }),
    );

    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const result1 = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(result1.metadata.sessionRef).toEqual({
      backend: "claude",
      ref: "conv-val-1",
      lane: "context_validator",
      assignmentId: soleAssignment(contextDef).id,
      refKind: "conversation",
      workflowConversationId: "conv-val-1",
    });
    expect(result1.metadata.reviewArtifact).toEqual({
      backend: "claude",
      kind: "conversation",
      ref: "conv-val-1",
      usage: null,
    });
    expect(createConversation).toHaveBeenCalledOnce();
    expect(
      repo.read().laneStates["context-plan"]?.[VALIDATOR_LANE_KEY]?.backend,
    ).toBe("claude");

    const result2 = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution: repo.read(),
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(createConversation).toHaveBeenCalledOnce();
    expect(result2.metadata.sessionRef).toEqual({
      backend: "claude",
      ref: "conv-val-1",
      lane: "context_validator",
      assignmentId: soleAssignment(contextDef).id,
      refKind: "conversation",
      workflowConversationId: "conv-val-1",
    });
    expect(result2.metadata.reviewArtifact).toEqual({
      backend: "claude",
      kind: "conversation",
      ref: "conv-val-1",
      usage: null,
    });
    // Conversation actor handles resumeRef threading internally; the validator
    // routes through executeWorkflowTaskRun with the same conversationId across
    // calls so the actor can persist backendRef and resume the session.
    const conversationIds = executeWorkflowTaskRun.mock.calls.map(
      ([input]) => input.conversationId,
    );
    expect(conversationIds[0]).toBeDefined();
    expect(conversationIds[0]).toBe(conversationIds[1]);
  });

  it("persists the Claude validator lane before dispatch so cancellation can find the in-flight turn", async () => {
    // Active cancellation (pause/abort/halt/resume) collects abortable
    // conversations from execution.laneStates. A lane resolved only in local
    // state until after the turn is invisible for the whole first (and every
    // rotated) validator run.
    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const repo = createInMemoryRepo(execution);

    const createConversation = vi.fn(async () => ({ id: "conv-val-1" }));
    const continuityService = makeLaneContinuityService(repo, {
      createConversation,
      getConversation: vi.fn(async (_p: string, _s: string, id: string) => ({
        id,
      })),
    });

    let laneAtDispatch: unknown = null;
    let dispatchedConversationId: string | null = null;
    const executeWorkflowTaskRun = vi.fn(
      async (input: ExecuteWorkflowTaskRunInput) => {
        laneAtDispatch =
          repo.read().laneStates["context-plan"]?.[VALIDATOR_LANE_KEY] ?? null;
        dispatchedConversationId = input.conversationId;
        return textTaskRun(passResponseJson, {
          backendRef: { backend: "claude", ref: "sdk-session-1" },
        });
      },
    );

    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(dispatchedConversationId).toBe("conv-val-1");
    expect(laneAtDispatch).toMatchObject({
      lane: "context_validator",
      backend: "claude",
      workflowConversationId: "conv-val-1",
    });
  });

  it("persists the Codex validator lane with its synthetic conversation id before dispatch", async () => {
    // Codex validator turns dispatch under a deterministic synthetic
    // conversation id that is registered in the abort registry; without
    // persisting it on the lane state, no codex validator turn is ever
    // discoverable by cancellation.
    const codexValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "task",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };
    const execution = buildExecutionWithContextValidation(codexValidator);
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const repo = createInMemoryRepo(execution);

    const continuityService = makeLaneContinuityService(repo);

    let laneAtDispatch: unknown = null;
    let dispatchedConversationId: string | null = null;
    const executeWorkflowTaskRun = vi.fn(
      async (input: ExecuteWorkflowTaskRunInput) => {
        laneAtDispatch =
          repo.read().laneStates["context-plan"]?.[VALIDATOR_LANE_KEY] ?? null;
        dispatchedConversationId = input.conversationId;
        return textTaskRun(passResponseJson, {
          backendRef: { backend: "codex", ref: "thread-1" },
        });
      },
    );

    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(codexValidator),
    });

    expect(dispatchedConversationId).toBe(
      "__validator__:execution-1:context-plan:context_validator:general:codex",
    );
    expect(laneAtDispatch).toMatchObject({
      lane: "context_validator",
      backend: "codex",
      workflowConversationId:
        "__validator__:execution-1:context-plan:context_validator:general:codex",
    });
  });

  it("records limitEvaluation=metrics_unavailable for a Claude validator turn when a limit is configured", async () => {
    const limitedClaudeValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "conversation",
      authority: "blocking",
      agent: {
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
      },
      continuity: { enabled: true, contextLimitTokens: 100_000 },
    };
    const execution = buildExecutionWithContextValidation(
      limitedClaudeValidator,
    );
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const repo = createInMemoryRepo(execution);

    let convCounter = 0;
    const createConversation = vi.fn(async () => ({
      id: `conv-val-${++convCounter}`,
    }));
    const getConversation = vi.fn(
      async (_p: string, _s: string, id: string) => ({ id }),
    );

    const continuityService = makeLaneContinuityService(repo, {
      createConversation,
      getConversation,
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(passResponseJson, {
        backendRef: { backend: "claude", ref: "sdk-session-1" },
      }),
    );

    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(limitedClaudeValidator),
    });

    // The Claude validator turn is recorded with contextTokens: null, so with a
    // configured limit the honest label is metrics_unavailable (never a
    // fabricated "supported").
    expect(result.metadata.limitEvaluation).toBe("metrics_unavailable");
    expect(
      repo.read().laneStates["context-plan"]?.[VALIDATOR_LANE_KEY]
        ?.limitEvaluation,
    ).toBe("metrics_unavailable");
  });

  it("resumes the Codex context-validator thread after a schema round-trip", async () => {
    const codexValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "task",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };
    const execution = buildExecutionWithContextValidation(codexValidator);
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const repo = createInMemoryRepo(execution);

    const threadAdapter = makeThreadAdapter({
      start: vi.fn(async () => ({
        backend: "codex" as const,
        ref: "thread-placeholder",
      })),
    });

    const continuityService = makeLaneContinuityService(repo, {
      continuityAdapter: () => threadAdapter.adapter,
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(passResponseJson, {
        backendRef: { backend: "codex", ref: "thread-real-1" },
      }),
    );

    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const result1 = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(codexValidator),
    });

    expect(threadAdapter.start).toHaveBeenCalledOnce();
    expect(result1.metadata.reviewArtifact).toMatchObject({
      backend: "codex",
      kind: "response",
      ref: "thread-real-1",
    });

    const deserialized = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(repo.read())),
    );
    repo.write(deserialized);

    const result2 = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution: repo.read(),
      context: contextDef,
      validator: seedAssignment(codexValidator),
    });

    expect(threadAdapter.resumeOrRecover).toHaveBeenCalledWith(
      { backend: "codex", ref: "thread-real-1" },
      { projectPath: "/repo", sessionName: "session-1" },
    );
    expect(result2.metadata.reviewArtifact).toMatchObject({
      backend: "codex",
      kind: "response",
      ref: "thread-real-1",
    });
  });

  it("carries codex validator token usage and estimated costUsd into the review artifact", async () => {
    const codexValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "task",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };
    const execution = buildExecutionWithContextValidation(codexValidator);
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const repo = createInMemoryRepo(execution);

    const continuityService = makeLaneContinuityService(repo, {
      continuityAdapter: () =>
        makeThreadAdapter({
          start: vi.fn(async () => ({
            backend: "codex" as const,
            ref: "thread-usage-1",
          })),
        }).adapter,
    });

    const executeWorkflowTaskRun = vi.fn(
      async (): Promise<TaskRunResult> => ({
        kind: "text",
        text: passResponseJson,
        usage: {
          ...emptyUsage,
          inputTokens: 1000,
          cachedInputTokens: 400,
          outputTokens: 50,
          costUsd: 0.0042,
        },
        backendRef: { backend: "codex", ref: "thread-usage-1" },
        continuationDisposition: "retain",
      }),
    );

    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(codexValidator),
    });

    expect(result.metadata.reviewArtifact).toMatchObject({
      backend: "codex",
      kind: "response",
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 50,
        costUsd: 0.0042,
      },
    });
  });

  it("persists the Codex validator transcript on the continuity path", async () => {
    const TEST_DIR = path.join(
      __dirname,
      "__test-logs-codex-validator-transcript__",
    );
    const codexValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "task",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };
    const execution = buildExecutionWithContextValidation(codexValidator);
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const repo = createInMemoryRepo(execution);

    const continuityService = makeLaneContinuityService(repo, {
      continuityAdapter: () =>
        makeThreadAdapter({
          start: vi.fn(async () => ({
            backend: "codex" as const,
            ref: "thread-placeholder",
          })),
        }).adapter,
    });

    const transcript = [
      {
        seq: 0,
        backend: "codex" as const,
        type: "reasoning",
        raw: { type: "reasoning", text: "compare against ~/.aerospace.toml" },
      },
      {
        seq: 1,
        backend: "codex" as const,
        type: "command_execution",
        raw: { type: "command_execution", command: "npm run verify" },
      },
    ];
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult> => ({
        kind: "text",
        text: passResponseJson,
        transcript,
        usage: emptyUsage,
        backendRef: { backend: "codex", ref: "thread-real-1" },
        continuationDisposition: "retain",
      }),
    );

    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const logger = createExecutionLogger(execution.id, { configDir: TEST_DIR });
    registerExecutionLogger(logger);

    try {
      await runner.runContextValidator({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        context: contextDef,
        validator: seedAssignment(codexValidator),
      });

      const entries = readFileSync(
        path.join(
          logger.logDir,
          "contexts",
          "context-plan",
          "validators",
          soleAssignment(contextDef).id,
          "validation-transcript.jsonl",
        ),
        "utf-8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(entries[0]).toMatchObject({
        event: "validator.transcript_begin",
        engine: "codex",
        entryCount: 2,
      });
      expect(
        entries
          .filter((e) => e.event === "validator.transcript_item")
          .map((e) => e.itemType),
      ).toEqual(["reasoning", "command_execution"]);
    } finally {
      unregisterExecutionLogger(execution.id);
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("marks the Codex lane for rotation when the adapter clears continuation after a failed turn", async () => {
    const codexValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "task",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };
    const execution = buildExecutionWithContextValidation(codexValidator);
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const repo = createInMemoryRepo(execution);

    const continuityService = makeLaneContinuityService(repo, {
      continuityAdapter: () =>
        makeThreadAdapter({
          start: vi.fn(async () => ({
            backend: "codex" as const,
            ref: "thread-placeholder",
          })),
        }).adapter,
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      errorTaskRun("Codex Exec exited with code 1: schema invalid", {
        continuationDisposition: "clear",
      }),
    );

    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(codexValidator),
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("exception");
      expect(result.result.engine).toBe("codex");
    }
    expect(
      repo.read().laneStates["context-plan"]?.[VALIDATOR_LANE_KEY]?.metrics
        .rotateBeforeNextTurn,
    ).toBe(true);
  });

  it("retains a viable Codex validator thread when a failed turn carries the adapter retain verdict", async () => {
    const codexValidator: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "task",
      authority: "blocking",
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      },
      continuity: { enabled: true },
    };
    const execution = buildExecutionWithContextValidation(codexValidator);
    const contextDef = execution.workingDefinition.executionContexts.find(
      (candidate) => candidate.id === "context-plan",
    )!;
    const repo = createInMemoryRepo(execution);
    const continuityService = makeLaneContinuityService(repo, {
      continuityAdapter: () =>
        makeThreadAdapter({
          start: vi.fn(async () => ({
            backend: "codex" as const,
            ref: "thread-placeholder",
          })),
        }).adapter,
    });
    const executeWorkflowTaskRun = vi.fn(async () =>
      errorTaskRun("transient transport failure", {
        backendRef: { backend: "codex", ref: "thread-still-viable" },
        continuationDisposition: "retain",
      }),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: seedAssignment(codexValidator),
    });

    expect(result.result.kind).toBe("infra_error");
    expect(
      repo.read().laneStates["context-plan"]?.[VALIDATOR_LANE_KEY],
    ).toMatchObject({
      backend: "codex",
      sessionRef: { backend: "codex", ref: "thread-still-viable" },
      metrics: { rotateBeforeNextTurn: false },
    });
  });
});

describe("validator-runner executionTarget override", () => {
  it("uses executionTarget.worktreePath as the working directory when provided, ignoring resolveWorktreePath", async () => {
    const agentResponse = JSON.stringify({
      summary: "All good",
      issues: [],
      advisories: [],
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(agentResponse),
    );
    const resolveWorktreePath = vi.fn(async () => sessionWorktreeDir);
    const runner = createValidatorRunner({
      resolveWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
      executionTarget: {
        worktreePath: laneWorktreeDir,
        branchName: "csm/session-1-context-plan",
        isolation: "worktree",
        laneId: null,
      },
    });

    // worktreePath flows through to the actor input that drives the runner.
    expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actorInput: expect.objectContaining({
          sessionWorktreePath: laneWorktreeDir,
        }),
      }),
    );
    expect(resolveWorktreePath).not.toHaveBeenCalled();
    expect(result.result.kind).toBe("pass");
  });

  it("falls back to resolveWorktreePath when no executionTarget is provided", async () => {
    const agentResponse = JSON.stringify({
      summary: "All good",
      issues: [],
      advisories: [],
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(agentResponse),
    );
    const resolveWorktreePath = vi.fn(async () => sessionWorktreeDir);
    const runner = createValidatorRunner({
      resolveWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(resolveWorktreePath).toHaveBeenCalledWith("/repo", "session-1");
    expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actorInput: expect.objectContaining({
          sessionWorktreePath: sessionWorktreeDir,
        }),
      }),
    );
  });
});

describe("buildContextValidationPrompt diff scope", () => {
  it("inserts the diff-scope section after the acceptance criteria and before the context section", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
      diffScopeSection: "## Changes Under Review\n\nSCOPE_MARKER_BODY",
    });

    const acIdx = prompt.indexOf("Every task summary is complete");
    const scopeIdx = prompt.indexOf("SCOPE_MARKER_BODY");
    const contextIdx = prompt.indexOf("## Context");
    expect(acIdx).toBeGreaterThanOrEqual(0);
    expect(acIdx).toBeLessThan(scopeIdx);
    expect(scopeIdx).toBeLessThan(contextIdx);
  });

  it("omits the diff-scope section when none is supplied", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: seedAssignment(validatorConfig),
    });

    expect(prompt).not.toContain("## Changes Under Review");
  });
});

describe("createValidatorRunner diff scope", () => {
  const availableScope: ValidationDiffScope = {
    kind: "available",
    candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
    treeHash: "tree-1",
    diff: {
      files: [
        {
          filePath: "src/widget.ts",
          additions: 1,
          deletions: 0,
          hunks: [
            {
              header: "@@ -0,0 +1 @@",
              lines: [
                { type: "hunk-header", content: "@@ -0,0 +1 @@" },
                { type: "add", content: "export const widget = true;" },
              ],
            },
          ],
        },
      ],
      totalAdditions: 1,
      totalDeletions: 0,
    },
    fileCount: 1,
    totalAdditions: 1,
    totalDeletions: 0,
  };

  function planContext(execution: GraphWorkflowExecution) {
    return execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
  }

  it("computes diff scope from the resolved session worktree and injects it into the prompt", async () => {
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) =>
        textTaskRun(verdictJson("ok")),
    );
    const computeValidationDiffScope = vi.fn(
      async (_wt: string, _scope: CandidateScope) => availableScope,
    );
    const resolveWorktreePath = vi.fn(async () => sessionWorktreeDir);
    const runner = createValidatorRunner({
      resolveWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
      computeValidationDiffScope,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = planContext(execution);

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(computeValidationDiffScope).toHaveBeenCalledWith(
      sessionWorktreeDir,
      WHOLE_TREE_CANDIDATE_SCOPE,
    );
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("## Changes Under Review");
    expect(input.prompt).toContain("src/widget.ts");
    expect(input.prompt).toContain("+export const widget = true;");
  });

  it("computes diff scope from executionTarget.worktreePath when supplied", async () => {
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) =>
        textTaskRun(verdictJson("ok")),
    );
    const computeValidationDiffScope = vi.fn(
      async (_wt: string, _scope: CandidateScope) => availableScope,
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
      computeValidationDiffScope,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = planContext(execution);

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
      executionTarget: {
        worktreePath: laneWorktreeDir,
        branchName: "csm/session-1-context-plan",
        isolation: "worktree",
        laneId: null,
      },
    });

    expect(computeValidationDiffScope).toHaveBeenCalledWith(
      laneWorktreeDir,
      WHOLE_TREE_CANDIDATE_SCOPE,
    );
  });

  it("still dispatches the validator turn when diff scope is unavailable", async () => {
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) =>
        textTaskRun(verdictJson("ok")),
    );
    const computeValidationDiffScope = vi.fn(
      async (): Promise<ValidationDiffScope> => ({
        kind: "unavailable",
        candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
        reason: "git boom",
      }),
    );
    const runner = createValidatorRunner({
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
      computeValidationDiffScope,
    });

    const execution = buildExecutionWithContextValidation();
    const contextDef = planContext(execution);

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: soleAssignment(contextDef),
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Diff scope unavailable (git boom)");
    expect(result.result.kind).toBe("pass");
  });
});
