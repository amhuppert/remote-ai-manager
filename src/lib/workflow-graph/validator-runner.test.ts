import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildContextValidationPrompt,
  createValidatorRunner,
  parseValidatorResponse,
  resolveValidatorAskUserQuestionsEnabled,
  VALIDATOR_OUTPUT_SCHEMA,
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
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowAgentValidatorConfig } from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
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

const stubWorktreePath = async () => "/worktree";
const stubTimeoutMs = async () => 300_000;
const stubProjectDisplayName = () => "test-project";

const validatorConfig: GraphWorkflowAgentValidatorConfig = {
  type: "claude",
  enabled: true,
  continuity: { enabled: true },
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
};

const context: GraphWorkflowResolvedContext = {
  id: "context-implement",
  title: "Implement Feature",
  description: "Build the widget",
  acceptanceCriteria:
    "Every task summary is complete and the final plan document is updated.",
  implementer: {
    backend: "claude",
    model: "sonnet",
    reasoningEffort: "medium",
  },
  contextValidator: validatorConfig,
  scriptValidator: { enabled: false },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  mutability: { allowAgentTaskAdd: false },
  circuitBreaker: {},
  iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
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
  validator: GraphWorkflowAgentValidatorConfig = validatorConfig,
): GraphWorkflowExecution {
  const definition = createResolvedWorkflowDefinition({
    executionContexts: createResolvedWorkflowDefinition().executionContexts.map(
      (ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              acceptanceCriteria:
                "Every task summary is complete and the final plan document is updated.",
              contextValidator: validator,
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

describe("parseValidatorResponse fenced-block parsing", () => {
  it("returns kind=pass with empty reopenTaskIds when issues is empty", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "All checks passed",
        issues: [],
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse(text, "claude", undefined, [
      "task-1",
      "task-2",
    ]).result;
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
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse(text, "claude", undefined, [
      "task-1",
      "task-2",
    ]).result;
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
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse(text, "claude", undefined, [
      "task-1",
      "task-2",
    ]).result;
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
      }),
      "```",
    ].join("\n");

    const outcome = parseValidatorResponse(text, "claude", undefined, [
      "task-1",
      "task-2",
    ]).result;
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("schema_mismatch");
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

    const outcome = parseValidatorResponse(text, "claude", undefined, [
      "task-1",
      "task-2",
    ]).result;
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("schema_mismatch");
    }
  });
});

describe("buildContextValidationPrompt", () => {
  it("includes the exact acceptance criteria and ordered task summaries", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
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

  it("documents the issues-only response contract", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
    });

    expect(prompt).toContain("`issues`");
    expect(prompt).toContain("`taskId`");
    expect(prompt).toContain("empty");
    expect(prompt).toContain("inspect files and verify the agent's claims");
    expect(prompt).not.toContain("`pass`");
    expect(prompt).not.toContain("`reopenTaskIds`");
  });

  it("frames validation as intent-based judgment rather than literal matching", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
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
      validator: validatorConfig,
    });

    const lowered = prompt.toLowerCase();
    expect(lowered).toMatch(/do not|don't|must not/);
    expect(lowered).toContain("tests");
    expect(lowered).toMatch(/type (errors|checks|checking)/);
    expect(lowered).toMatch(/lint|build|compile/);
  });

  it("instructs the validator to respect context scope boundaries with downstream contexts", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
    });

    const lowered = prompt.toLowerCase();
    expect(lowered).toContain("scope");
    expect(lowered).toMatch(
      /downstream|other context|another context|later context/,
    );
  });

  it("requires a production call path for wiring criteria and allows only named downstream deferral", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
    });

    const guidance = prompt.slice(prompt.indexOf("## Evaluation Guidance"));
    expect(guidance).toContain("production call path");
    expect(guidance).toContain("no production caller");
    // Deferral must be explicit: only an acceptance-criteria clause naming the
    // downstream owner exempts missing wiring from failing this context.
    expect(guidance.toLowerCase()).toContain(
      "the downstream context that owns the wiring",
    );
  });

  it("instructs the validator to check each charter invariant and cite its id when invariants are declared", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
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

  it("renders the charter amendment log so the validator judges against the amended rules", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
      charter,
      charterAmendments: [
        {
          seq: 1,
          amendedAt: "2026-07-29T10:00:00.000Z",
          source: "cli",
          rationale: "Invariant inv-old retracted; it contradicted the API",
          fieldsChanged: ["invariants"],
          charterHash: "hash-1",
        },
      ],
    });

    expect(prompt).toContain("## Amendment log");
    expect(prompt).toContain("Invariant inv-old retracted");
  });

  it("omits the invariant-check instruction when the charter declares no invariants", () => {
    const withoutInvariants = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
      charter,
    });
    const withoutCharter = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
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
      validator: validatorConfig,
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
      validator: validatorConfig,
    });

    expect(prompt.startsWith("# Context Validation")).toBe(true);
    expect(prompt).not.toContain("# Workflow Charter");
  });

  it("instructs the validator to defer to a higher-ranked source and record the conflict in the summary", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
      charter,
    });

    const guidance = prompt.slice(prompt.indexOf("## Evaluation Guidance"));
    const lowered = guidance.toLowerCase();

    // 5.1 / 5.2: higher-ranked source prevails; do not fail the context for
    // the acceptance-criterion mismatch when the implementation follows it.
    expect(lowered).toContain("higher-ranked source");
    expect(lowered).toMatch(/do not|don't|must not/);
    expect(lowered).toContain("acceptance criterion");
    // 5.3: record the conflict (criterion, prevailing source, resolution) in
    // the existing summary field.
    expect(lowered).toContain("summary");
    expect(lowered).toContain("prevailing source");
    expect(lowered).toContain("resolution");
    // 5.5: precedence is evaluated within each source's applicability scope.
    expect(lowered).toMatch(/applicability scope|appliesto|applies to/);
  });

  it("requires taskId on each issue in the structured output schema", () => {
    const issueSchema = VALIDATOR_OUTPUT_SCHEMA.properties.issues.items;
    expect(issueSchema.properties).toHaveProperty("taskId");
    expect(issueSchema.required).toEqual(
      expect.arrayContaining(["taskId", "title", "description"]),
    );
    expect(VALIDATOR_OUTPUT_SCHEMA.required).toEqual(
      expect.arrayContaining(["summary", "issues"]),
    );
    expect(VALIDATOR_OUTPUT_SCHEMA.required).not.toEqual(
      expect.arrayContaining(["pass"]),
    );
    expect(VALIDATOR_OUTPUT_SCHEMA.properties).not.toHaveProperty("pass");
    expect(VALIDATOR_OUTPUT_SCHEMA.properties).not.toHaveProperty(
      "reopenTaskIds",
    );
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
      validator: validatorConfig,
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
      validator: validatorConfig,
    });

    expect(splitQuestionAnswersBlock(prompt)).toBeNull();
    expect(prompt).not.toContain("## Your Question Was Answered");
  });

  it("adds the ask-protocol reminder when askUserQuestionsEnabled is true", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
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
      validator: validatorConfig,
      askUserQuestionsEnabled: false,
    });
    const unset = buildContextValidationPrompt({
      context,
      tasks,
      taskStates,
      validator: validatorConfig,
    });

    expect(disabled).not.toContain("## Asking the User");
    expect(unset).not.toContain("## Asking the User");
  });
});

describe("resolveValidatorAskUserQuestionsEnabled (Req 8.1, codex suppression)", () => {
  const claudeValidator: GraphWorkflowAgentValidatorConfig = {
    type: "claude",
    enabled: true,
    continuity: { enabled: true },
    agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
  };
  const codexValidator: GraphWorkflowAgentValidatorConfig = {
    type: "codex",
    enabled: true,
    continuity: { enabled: true },
    codex: {},
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
      validator: codexValidator,
      askUserQuestionsEnabled: derived,
    });

    expect(derived).toBe(false);
    expect(prompt).not.toContain("## Asking the User");
  });
});

describe("parseValidatorResponse", () => {
  it("prefers structuredOutput and derives reopenTaskIds from issue taskIds", () => {
    const result = parseValidatorResponse(
      "ignored",
      "claude",
      {
        summary: "Needs work",
        issues: [{ taskId: "task-1", title: "Bug", description: "Fix" }],
      },
      ["task-1", "task-2"],
    );

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
      }),
      "```",
    ].join("\n");

    // Native payload omits the required `summary` field — invalid against the
    // validator schema.
    const result = parseValidatorResponse(
      validFencedText,
      "claude",
      { issues: [] },
      ["task-1", "task-2"],
    );

    expect(result.result.kind).toBe("fail");
    if (result.result.kind === "fail") {
      expect(result.result.reopenTaskIds).toEqual(["task-1"]);
    }
    expect(result.parsePath).toBe("fenced_json_block");
  });
});

describe("createValidatorRunner", () => {
  it("dispatches an agent validator through its configured backend instead of its legacy validator-type label", async () => {
    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(JSON.stringify({ summary: "All good", issues: [] })),
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
    const validator: GraphWorkflowAgentValidatorConfig = {
      type: "claude",
      enabled: true,
      continuity: { enabled: true },
      agent: {
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
    };

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator,
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actorInput: expect.objectContaining({
          conversation: expect.objectContaining({ agentBackend: "codex" }),
        }),
        modelId: "gpt-5.4",
        effort: "high",
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
      textTaskRun(JSON.stringify({ summary: "All good", issues: [] })),
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
      validator: validatorConfig,
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
        textTaskRun(JSON.stringify({ summary: "All good", issues: [] }), {
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
      const validator = {
        type: "claude",
        enabled: true,
        continuity: { enabled: true },
        agent: {
          backend: TESTFAKE_BACKEND_ID,
          model: "sonnet",
          reasoningEffort: "medium",
        },
      } as unknown as GraphWorkflowAgentValidatorConfig;

      const result = await runner.runContextValidator({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        context: contextDef,
        validator,
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
      textTaskRun(JSON.stringify({ summary: "All good", issues: [] })),
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
      validator: contextDef.contextValidator!,
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
      textTaskRun(JSON.stringify({ summary: "All good", issues: [] })),
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
      validator: contextDef.contextValidator!,
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
      validator: contextDef.contextValidator!,
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input).toMatchObject({
      kind: "task_run",
      modelId: "sonnet",
      effort: "medium",
      outputFormat: {
        type: "json_schema",
        schema: VALIDATOR_OUTPUT_SCHEMA,
      },
    });
    expect(input.prompt).toContain(
      "Every task summary is complete and the final plan document is updated.",
    );
    expect(result.result.kind).toBe("pass");
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
        text: JSON.stringify({ summary: "ok", issues: [] }),
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
        validator: contextDef.contextValidator!,
      });

      const transcriptPath = path.join(
        logger.logDir,
        "contexts",
        "context-plan",
        "validation-transcript.jsonl",
      );
      const entries = readFileSync(transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(entries[0]).toMatchObject({
        event: "validator.transcript_begin",
        lane: "context_validator",
        engine: contextDef.contextValidator!.type,
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
        validator: contextDef.contextValidator!,
      });

      expect(result.result.kind).toBe("infra_error");
      const entries = readFileSync(
        path.join(
          logger.logDir,
          "contexts",
          "context-plan",
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

  it("runContextValidator passes the context charter into the prompt so it begins with the digest", async () => {
    const agentResponse = JSON.stringify({
      summary: "Context completed correctly",
      issues: [],
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
      validator: contextWithCharter.contextValidator!,
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt.startsWith("# Workflow Charter")).toBe(true);
    expect(input.prompt).toContain(
      "Ship the widget that adheres to the published API contract.",
    );
    expect(input.prompt).toContain(".cc/graph-workflow-docs/charter.md");
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
      validator: contextDef.contextValidator!,
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("unparseable");
      expect(result.result.engine).toBe("claude");
    }
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
      validator: contextDef.contextValidator!,
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
      textTaskRun(JSON.stringify({ summary: "Looks good", issues: [] })),
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
      validator: contextDef.contextValidator!,
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

    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
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
      validator: codexValidator,
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

    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
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
      validator: codexValidator,
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("exception");
      expect(result.result.engine).toBe("codex");
      expect(result.result.message).toContain("no rollout found");
    }
  });

  it("runContextValidator forwards codex model and reasoningEffort overrides to executeWorkflowTaskRun", async () => {
    const codexResponse = JSON.stringify({
      summary: "Reopen one task.",
      issues: [
        {
          taskId: "task-plan-2",
          title: "Missing tests",
          description: "Add the missing tests.",
        },
      ],
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

    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: { model: "gpt-5.4", reasoningEffort: "high" },
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
      validator: codexValidator,
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-5.4",
        effort: "high",
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
      validator: contextDef.contextValidator!,
    });

    expect(result1.metadata.sessionRef).toEqual({
      backend: "claude",
      ref: "conv-val-1",
      lane: "context_validator",
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
      repo.read().laneStates["context-plan"]?.["context_validator"]?.backend,
    ).toBe("claude");

    const result2 = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution: repo.read(),
      context: contextDef,
      validator: contextDef.contextValidator!,
    });

    expect(createConversation).toHaveBeenCalledOnce();
    expect(result2.metadata.sessionRef).toEqual({
      backend: "claude",
      ref: "conv-val-1",
      lane: "context_validator",
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
          repo.read().laneStates["context-plan"]?.["context_validator"] ?? null;
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
      validator: contextDef.contextValidator!,
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
    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
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
          repo.read().laneStates["context-plan"]?.["context_validator"] ?? null;
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
      validator: codexValidator,
    });

    expect(dispatchedConversationId).toBe(
      "__validator__:execution-1:context-plan:context_validator:codex",
    );
    expect(laneAtDispatch).toMatchObject({
      lane: "context_validator",
      backend: "codex",
      workflowConversationId:
        "__validator__:execution-1:context-plan:context_validator:codex",
    });
  });

  it("records limitEvaluation=metrics_unavailable for a Claude validator turn when a limit is configured", async () => {
    const limitedClaudeValidator: GraphWorkflowAgentValidatorConfig = {
      type: "claude",
      enabled: true,
      continuity: { enabled: true, contextLimitTokens: 100_000 },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
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
      validator: limitedClaudeValidator,
    });

    // The Claude validator turn is recorded with contextTokens: null, so with a
    // configured limit the honest label is metrics_unavailable (never a
    // fabricated "supported").
    expect(result.metadata.limitEvaluation).toBe("metrics_unavailable");
    expect(
      repo.read().laneStates["context-plan"]?.["context_validator"]
        ?.limitEvaluation,
    ).toBe("metrics_unavailable");
  });

  it("resumes the Codex context-validator thread after a schema round-trip", async () => {
    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
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
      validator: codexValidator,
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
      validator: codexValidator,
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
    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
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
      validator: codexValidator,
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
    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
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
        validator: codexValidator,
      });

      const entries = readFileSync(
        path.join(
          logger.logDir,
          "contexts",
          "context-plan",
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
    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
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
      validator: codexValidator,
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("exception");
      expect(result.result.engine).toBe("codex");
    }
    expect(
      repo.read().laneStates["context-plan"]?.["context_validator"]?.metrics
        .rotateBeforeNextTurn,
    ).toBe(true);
  });

  it("retains a viable Codex validator thread when a failed turn carries the adapter retain verdict", async () => {
    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
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
      validator: codexValidator,
    });

    expect(result.result.kind).toBe("infra_error");
    expect(
      repo.read().laneStates["context-plan"]?.["context_validator"],
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
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(agentResponse),
    );
    const resolveWorktreePath = vi.fn(async () => "/session-worktree");
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
      validator: contextDef.contextValidator!,
      executionTarget: {
        worktreePath: "/repo/.worktrees/session-1.context-plan",
        branchName: "csm/session-1-context-plan",
        isolation: "worktree",
        laneId: null,
      },
    });

    // worktreePath flows through to the actor input that drives the runner.
    expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actorInput: expect.objectContaining({
          sessionWorktreePath: "/repo/.worktrees/session-1.context-plan",
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
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(agentResponse),
    );
    const resolveWorktreePath = vi.fn(async () => "/session-worktree");
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
      validator: contextDef.contextValidator!,
    });

    expect(resolveWorktreePath).toHaveBeenCalledWith("/repo", "session-1");
    expect(executeWorkflowTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actorInput: expect.objectContaining({
          sessionWorktreePath: "/session-worktree",
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
      validator: validatorConfig,
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
      validator: validatorConfig,
    });

    expect(prompt).not.toContain("## Changes Under Review");
  });
});

describe("createValidatorRunner diff scope", () => {
  const availableScope: ValidationDiffScope = {
    kind: "available",
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
        textTaskRun(JSON.stringify({ summary: "ok", issues: [] })),
    );
    const computeValidationDiffScope = vi.fn(
      async (_wt: string) => availableScope,
    );
    const resolveWorktreePath = vi.fn(async () => "/session-worktree");
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
      validator: contextDef.contextValidator!,
    });

    expect(computeValidationDiffScope).toHaveBeenCalledWith(
      "/session-worktree",
    );
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("## Changes Under Review");
    expect(input.prompt).toContain("src/widget.ts");
    expect(input.prompt).toContain("+export const widget = true;");
  });

  it("computes diff scope from executionTarget.worktreePath when supplied", async () => {
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) =>
        textTaskRun(JSON.stringify({ summary: "ok", issues: [] })),
    );
    const computeValidationDiffScope = vi.fn(
      async (_wt: string) => availableScope,
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
      validator: contextDef.contextValidator!,
      executionTarget: {
        worktreePath: "/repo/.worktrees/session-1.context-plan",
        branchName: "csm/session-1-context-plan",
        isolation: "worktree",
        laneId: null,
      },
    });

    expect(computeValidationDiffScope).toHaveBeenCalledWith(
      "/repo/.worktrees/session-1.context-plan",
    );
  });

  it("still dispatches the validator turn when diff scope is unavailable", async () => {
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) =>
        textTaskRun(JSON.stringify({ summary: "ok", issues: [] })),
    );
    const computeValidationDiffScope = vi.fn(
      async (): Promise<ValidationDiffScope> => ({
        kind: "unavailable",
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
      validator: contextDef.contextValidator!,
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Diff scope unavailable (git boom)");
    expect(result.result.kind).toBe("pass");
  });
});
