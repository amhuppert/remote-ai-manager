import { describe, expect, it, vi } from "vitest";
import {
  buildContextValidationPrompt,
  createValidatorRunner,
  extractValidatorResult,
  parseValidatorResponse,
  VALIDATOR_OUTPUT_SCHEMA,
} from "./validator-runner";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { AgentSessionRef } from "@/lib/agent-backends/types";
import type {
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecution,
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflows/schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { createWorkflowContinuityService } from "@/lib/workflow-graph/workflow-continuity-service";
import { graphWorkflowExecutionSchema } from "@/lib/workflows/schemas";

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

describe("extractValidatorResult", () => {
  it("returns kind=pass with empty reopenTaskIds when issues is empty", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "All checks passed",
        issues: [],
      }),
      "```",
    ].join("\n");

    const outcome = extractValidatorResult(text, "claude", [
      "task-1",
      "task-2",
    ]);
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

    const outcome = extractValidatorResult(text, "claude", [
      "task-1",
      "task-2",
    ]);
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

    const outcome = extractValidatorResult(text, "claude", [
      "task-1",
      "task-2",
    ]);
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

    const outcome = extractValidatorResult(text, "claude", [
      "task-1",
      "task-2",
    ]);
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

    const outcome = extractValidatorResult(text, "claude", [
      "task-1",
      "task-2",
    ]);
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
});

describe("createValidatorRunner", () => {
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
      skipStructuredOutputGate: true,
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

    const continuityService = createWorkflowContinuityService({
      createConversation,
      getConversation,
      startCodexThread: vi.fn(),
      resumeCodexThread: vi.fn(),
      now: () => NOW,
    });

    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) =>
        textTaskRun(passResponseJson, {
          backendRef: { backend: "claude", sessionId: "sdk-session-1" },
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

    expect(result1.metadata.sessionRef).toMatchObject({
      backend: "claude",
      sessionId: "sdk-session-1",
    });
    expect(createConversation).toHaveBeenCalledOnce();
    expect(
      repo.read().laneStates["context-plan"]?.["context_validator"]?.engine,
    ).toBe("claude");

    const result2 = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution: repo.read(),
      context: contextDef,
      validator: contextDef.contextValidator!,
    });

    expect(createConversation).toHaveBeenCalledOnce();
    expect(result2.metadata.sessionRef).toMatchObject({
      backend: "claude",
      sessionId: "sdk-session-1",
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

    const startCodexThread = vi.fn(async () => ({
      threadId: "thread-placeholder",
    }));
    const resumeCodexThread = vi.fn(async (id: string) => ({ threadId: id }));

    const continuityService = createWorkflowContinuityService({
      createConversation: vi.fn(),
      getConversation: vi.fn(),
      startCodexThread,
      resumeCodexThread,
      now: () => NOW,
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      textTaskRun(passResponseJson, {
        backendRef: { backend: "codex", threadId: "thread-real-1" },
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

    expect(startCodexThread).toHaveBeenCalledOnce();
    expect(result1.metadata.reviewArtifact).toMatchObject({
      engine: "codex",
      threadId: "thread-real-1",
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

    expect(resumeCodexThread).toHaveBeenCalledWith("thread-real-1");
    expect(result2.metadata.reviewArtifact).toMatchObject({
      engine: "codex",
      threadId: "thread-real-1",
    });
  });

  it("marks the Codex lane for rotation after a failed turn so phantom threads are not reused", async () => {
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

    const startCodexThread = vi.fn(async () => ({
      threadId: "thread-placeholder",
    }));
    const resumeCodexThread = vi.fn(async (id: string) => ({ threadId: id }));

    const continuityService = createWorkflowContinuityService({
      createConversation: vi.fn(),
      getConversation: vi.fn(),
      startCodexThread,
      resumeCodexThread,
      now: () => NOW,
    });

    const executeWorkflowTaskRun = vi.fn(async () =>
      errorTaskRun("Codex Exec exited with code 1: schema invalid"),
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
      repo.read().laneStates["context-plan"]?.["context_validator"]
        ?.rotateBeforeNextTurn,
    ).toBe(true);
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
