import { describe, expect, it, vi } from "vitest";
import {
  buildContextValidationPrompt,
  createValidatorRunner,
  extractValidatorResult,
  parseValidatorResponse,
  VALIDATOR_OUTPUT_SCHEMA,
} from "./validator-runner";
import type {
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
} from "@/types";
import type { AgentBackendId } from "@/lib/agent-backends/types";
import type {
  AgentTaskRunner,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { createWorkflowContinuityService } from "@/lib/workflows/graph-workflow/workflow-continuity-service";
import { graphWorkflowExecutionSchema } from "@/lib/schemas";

function mockGetTaskRunner(
  claudeRun: ReturnType<typeof vi.fn> = vi.fn(),
  codexRun: ReturnType<typeof vi.fn> = vi.fn(),
): (backend: AgentBackendId) => AgentTaskRunner {
  return (backend: AgentBackendId) => ({
    backend,
    run: backend === "claude" ? claudeRun : codexRun,
  });
}

function taskResult(
  text: string | null,
  overrides: Partial<AgentTaskResult> = {},
): AgentTaskResult {
  return {
    text,
    usage: null,
    error: null,
    timedOut: false,
    ...overrides,
  };
}

const stubWorktreePath = async () => "/worktree";
const stubTimeoutMs = async () => 300_000;

const validatorConfig: GraphWorkflowAgentValidatorConfig = {
  type: "claude",
  enabled: true,
  continuity: { enabled: true },
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
  acceptanceCriteria:
    "Every task summary is complete and the final plan document is updated.",
};

const context: GraphWorkflowExecutionContextDefinition = {
  id: "context-implement",
  title: "Implement Feature",
  description: "Build the widget",
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
  mutability: { allowAgentTaskAdd: false },
  circuitBreaker: {},
  iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
  contextValidation: validatorConfig,
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
  const definition = createWorkflowDefinition({
    executionContexts: createWorkflowDefinition().executionContexts.map(
      (ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              contextValidation: validator,
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
      ...createWorkflowDefinition().tasks.filter(
        (task) => task.contextId !== "context-plan",
      ),
    ],
  });

  return createWorkflowExecution({
    status: "running",
    activeContextId: "context-plan",
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
  it("runContextValidator passes the prompt to the task runner and returns the parsed result", async () => {
    const agentResponse = JSON.stringify({
      summary: "Context completed correctly",
      issues: [],
    });

    const claudeRun = vi.fn(async () => taskResult(agentResponse));
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(claudeRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
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
      validator: contextDef.contextValidation!,
    });

    expect(claudeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/worktree",
        modelId: "sonnet",
        reasoningEffort: "medium",
        autonomous: true,
        outputSchema: VALIDATOR_OUTPUT_SCHEMA,
        prompt: expect.stringContaining(
          "Every task summary is complete and the final plan document is updated.",
        ),
      }),
    );
    expect(result.result.kind).toBe("pass");
  });

  it("runContextValidator returns infra_error unparseable when the agent produces no JSON", async () => {
    const claudeRun = vi.fn(async () =>
      taskResult("I could not find anything to review."),
    );
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(claudeRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
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
      validator: contextDef.contextValidation!,
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("unparseable");
      expect(result.result.engine).toBe("claude");
    }
  });

  it("runContextValidator returns infra_error exception with engine=codex when codex runner throws", async () => {
    const codexRun = vi.fn(async () => {
      throw new Error("Codex rate limit exceeded");
    });
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(vi.fn(), codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
    });

    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
      acceptanceCriteria: "Check the completed context.",
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

  it("runContextValidator returns infra_error exception when codex returns a non-null error without throwing", async () => {
    const codexRun = vi.fn(async () =>
      taskResult(null, {
        error:
          "thread/resume failed: no rollout found for thread id phantom-123",
      }),
    );
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(vi.fn(), codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
    });

    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
      acceptanceCriteria: "Check the completed context.",
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

  it("runContextValidator calls the codex task runner with hardened execution settings", async () => {
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

    const codexRun = vi.fn(async () => taskResult(codexResponse));
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(vi.fn(), codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
    });

    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: { model: "gpt-5.4", reasoningEffort: "high" },
      acceptanceCriteria: "Check for correctness.",
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

    expect(codexRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-5.4",
        reasoningEffort: "high",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
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
      async update(_p: string, _s: string, exec: GraphWorkflowExecution) {
        state = exec;
      },
      read(): GraphWorkflowExecution {
        return state;
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

    const claudeRun = vi.fn().mockResolvedValue(
      taskResult(passResponseJson, {
        backendRef: { backend: "claude", sessionId: "sdk-session-1" },
      }),
    );

    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(claudeRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
    });

    const result1 = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: contextDef.contextValidation!,
    });

    expect(result1.metadata.sessionRef).toMatchObject({
      backend: "claude",
      sessionId: "sdk-session-1",
    });
    expect(createConversation).toHaveBeenCalledOnce();
    expect(repo.read().laneStates["context_validator"]?.engine).toBe("claude");

    const result2 = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution: repo.read(),
      context: contextDef,
      validator: contextDef.contextValidation!,
    });

    expect(createConversation).toHaveBeenCalledOnce();
    expect(claudeRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resumeRef: { backend: "claude", sessionId: "sdk-session-1" },
      }),
    );
    expect(result2.metadata.sessionRef).toMatchObject({
      backend: "claude",
      sessionId: "sdk-session-1",
    });
  });

  it("resumes the Codex context-validator thread after a schema round-trip", async () => {
    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
      acceptanceCriteria: "Validate.",
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

    const codexRun = vi.fn().mockResolvedValue(
      taskResult(passResponseJson, {
        backendRef: { backend: "codex", threadId: "thread-real-1" },
        usage: null,
      }),
    );

    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(vi.fn(), codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
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
    await repo.update("/repo", "session-1", deserialized);

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
      acceptanceCriteria: "Validate.",
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

    const codexRun = vi.fn().mockResolvedValue(
      taskResult(null, {
        error: "Codex Exec exited with code 1: schema invalid",
      }),
    );

    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(vi.fn(), codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService,
      executionRepository: repo,
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
      repo.read().laneStates["context_validator"]?.rotateBeforeNextTurn,
    ).toBe(true);
  });
});
