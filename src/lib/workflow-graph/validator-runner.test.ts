import { describe, expect, it, vi } from "vitest";
import {
  extractValidatorResult,
  parseValidatorResponse,
  buildTaskValidationPrompt,
  createValidatorRunner,
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
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";

// -- Test helpers for task runner mocks ----------------------------------------

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

// -- Pure function tests ------------------------------------------------------

describe("extractValidatorResult", () => {
  it("returns kind=pass for valid JSON with pass=true and empty issues", () => {
    const text = [
      "I reviewed the task output carefully.",
      "",
      "```json",
      JSON.stringify({
        pass: true,
        summary: "All checks passed",
        issues: [],
      }),
      "```",
    ].join("\n");

    const outcome = extractValidatorResult(text, "claude");
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass") {
      expect(outcome.summary).toBe("All checks passed");
      expect(outcome.issues).toEqual([]);
    }
  });

  it("returns kind=fail using the last JSON block when multiple are present", () => {
    const text = [
      "Here is some analysis:",
      "```json",
      JSON.stringify({ pass: true, summary: "early draft" }),
      "```",
      "Actually, after further review:",
      "```json",
      JSON.stringify({
        pass: false,
        summary: "Missing test coverage",
        issues: [{ title: "No tests", description: "Add unit tests." }],
      }),
      "```",
    ].join("\n");

    const outcome = extractValidatorResult(text, "claude");
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.summary).toBe("Missing test coverage");
      expect(outcome.issues).toEqual([
        { title: "No tests", description: "Add unit tests." },
      ]);
    }
  });

  it("returns kind=pass applying Zod defaults for omitted optional fields", () => {
    const text = [
      "```json",
      JSON.stringify({ pass: true, summary: "Looks good" }),
      "```",
    ].join("\n");

    const outcome = extractValidatorResult(text, "claude");
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass") {
      expect(outcome.issues).toEqual([]);
    }
  });

  it("returns kind=fail when pass=true but issues is non-empty (normalization)", () => {
    const text = [
      "```json",
      JSON.stringify({
        pass: true,
        summary: "Looks mostly good, but…",
        issues: [{ title: "Minor", description: "Nit" }],
      }),
      "```",
    ].join("\n");

    const outcome = extractValidatorResult(text, "claude");
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.issues).toHaveLength(1);
    }
  });

  it("returns infra_error reason=unparseable when no JSON block is found", () => {
    const outcome = extractValidatorResult(
      "I could not produce a structured result.",
      "claude",
    );
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("unparseable");
      expect(outcome.engine).toBe("claude");
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  it("returns infra_error reason=unparseable when JSON is malformed", () => {
    const text = ["```json", "{ not valid json }", "```"].join("\n");

    const outcome = extractValidatorResult(text, "codex");
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("unparseable");
      expect(outcome.engine).toBe("codex");
    }
  });

  it("returns infra_error reason=schema_mismatch when JSON does not match the schema", () => {
    const text = [
      "```json",
      JSON.stringify({ pass: "maybe", summary: 42 }),
      "```",
    ].join("\n");

    const outcome = extractValidatorResult(text, "claude");
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("schema_mismatch");
      expect(outcome.engine).toBe("claude");
    }
  });
});

const validatorConfig: GraphWorkflowAgentValidatorConfig = {
  type: "claude",
  enabled: true,
  continuity: { enabled: true },
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
  instructions: "Verify that all files have proper error handling.",
};

const context: GraphWorkflowExecutionContextDefinition = {
  id: "context-implement",
  title: "Implement Feature",
  description: "Build the widget",
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
  mutability: { allowAgentTaskAdd: false },
  circuitBreaker: {},
  iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
  taskValidation: validatorConfig,
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

describe("buildTaskValidationPrompt", () => {
  it("includes the validator instructions", () => {
    const prompt = buildTaskValidationPrompt({
      context,
      task: tasks[0]!,
      tasks,
      summary: "Created widget component with props interface.",
      validator: validatorConfig,
    });

    expect(prompt).toContain(
      "Verify that all files have proper error handling",
    );
  });

  it("includes the completed task details and summary", () => {
    const prompt = buildTaskValidationPrompt({
      context,
      task: tasks[0]!,
      tasks,
      summary: "Created widget component with props interface.",
      validator: validatorConfig,
    });

    expect(prompt).toContain("Write component");
    expect(prompt).toContain("Created widget component with props interface.");
  });

  it("lists sibling task IDs for task context", () => {
    const prompt = buildTaskValidationPrompt({
      context,
      task: tasks[0]!,
      tasks,
      summary: "Done.",
      validator: validatorConfig,
    });

    expect(prompt).toContain("task-1");
    expect(prompt).toContain("task-2");
  });

  it("includes the required output field descriptions", () => {
    const prompt = buildTaskValidationPrompt({
      context,
      task: tasks[0]!,
      tasks,
      summary: "Done.",
      validator: validatorConfig,
    });

    expect(prompt).toContain("`pass`");
    expect(prompt).toContain("`summary`");
    expect(prompt).toContain("`issues`");
    expect(prompt).not.toContain("`reopenTaskIds`");
  });
});

// -- createValidatorRunner integration ----------------------------------------

function buildExecutionWithTaskValidation(): GraphWorkflowExecution {
  const definition = createWorkflowDefinition({
    executionContexts: createWorkflowDefinition().executionContexts.map(
      (ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              taskValidation: {
                type: "claude" as const,
                enabled: true,
                continuity: { enabled: true },
                agent: {
                  backend: "claude" as const,
                  model: "sonnet" as const,
                  reasoningEffort: "medium" as const,
                },
                instructions: "Check for correctness.",
              },
            }
          : ctx,
    ),
  });
  return createWorkflowExecution({
    status: "running",
    activeContextId: "context-plan",
    workingDefinition: definition,
  });
}

describe("createValidatorRunner", () => {
  it("runTaskValidator passes the prompt to the task runner and returns the parsed result", async () => {
    const agentResponse = [
      "I reviewed the code.",
      "```json",
      JSON.stringify({
        pass: true,
        summary: "Task completed correctly",
        issues: [],
      }),
      "```",
    ].join("\n");

    const claudeRun = vi.fn(async () => taskResult(agentResponse));
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(claudeRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
    });

    const execution = buildExecutionWithTaskValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "conversation-1",
      summary: "Inspected the codebase thoroughly.",
      validator: contextDef.taskValidation!,
    });

    expect(claudeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/worktree",
        modelId: "sonnet",
        reasoningEffort: "medium",
        autonomous: true,
      }),
    );
    expect(result.result.kind).toBe("pass");
    if (result.result.kind === "pass") {
      expect(result.result.summary).toBe("Task completed correctly");
    }
  });

  it("runTaskValidator returns infra_error unparseable when the agent produces no JSON", async () => {
    const claudeRun = vi.fn(async () =>
      taskResult("I could not find anything to review."),
    );
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(claudeRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
    });

    const execution = buildExecutionWithTaskValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "conversation-1",
      summary: "Done.",
      validator: contextDef.taskValidation!,
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("unparseable");
      expect(result.result.engine).toBe("claude");
    }
  });

  it("runTaskValidator returns infra_error exception when the runner throws (claude)", async () => {
    const claudeRun = vi.fn(async () => {
      throw new Error("SDK connection failed");
    });
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(claudeRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
    });

    const execution = buildExecutionWithTaskValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "conversation-1",
      summary: "Done.",
      validator: contextDef.taskValidation!,
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("exception");
      expect(result.result.engine).toBe("claude");
      expect(result.result.message).toContain("SDK connection failed");
    }
  });

  it("runTaskValidator returns infra_error exception with engine=codex when codex runner throws", async () => {
    const codexRun = vi.fn(async () => {
      throw new Error("Codex rate limit exceeded");
    });
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(vi.fn(), codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
    });

    const execution = buildExecutionWithTaskValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;

    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
      instructions: "Check.",
    };

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "conversation-1",
      summary: "Done.",
      validator: codexValidator,
    });

    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("exception");
      expect(result.result.engine).toBe("codex");
      expect(result.result.message).toContain("Codex rate limit exceeded");
    }
  });

  it("runTaskValidator passes outputSchema to the task runner for claude type", async () => {
    const agentResponse = [
      "```json",
      JSON.stringify({
        pass: true,
        summary: "OK",
        issues: [],
      }),
      "```",
    ].join("\n");

    const claudeRun = vi.fn(async () => taskResult(agentResponse));
    const codexRun = vi.fn();
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(claudeRun, codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
    });

    const execution = buildExecutionWithTaskValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;

    await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "conversation-1",
      summary: "Done.",
      validator: contextDef.taskValidation!,
    });

    expect(claudeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSchema: VALIDATOR_OUTPUT_SCHEMA,
      }),
    );
    expect(codexRun).not.toHaveBeenCalled();
  });

  it("runTaskValidator calls codex task runner for codex type", async () => {
    const codexResponse = JSON.stringify({
      pass: true,
      summary: "Codex OK",
      issues: [],
    });

    const claudeRun = vi.fn();
    const codexRun = vi.fn(async () => taskResult(codexResponse));
    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(claudeRun, codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
    });

    const execution = buildExecutionWithTaskValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;

    const codexValidator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: { model: "gpt-5.4", reasoningEffort: "high" },
      instructions: "Check for correctness.",
    };

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "conversation-1",
      summary: "Done.",
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
    expect(claudeRun).not.toHaveBeenCalled();
    expect(result.result.kind).toBe("pass");
    if (result.result.kind === "pass") {
      expect(result.result.summary).toBe("Codex OK");
    }
  });
});

// -- Continuity service wiring ------------------------------------------------

describe("continuity service wiring", () => {
  const passResult = JSON.stringify({
    pass: true,
    summary: "All good",
    issues: [],
  });

  function buildSimpleExecution(): GraphWorkflowExecution {
    return buildExecutionWithTaskValidation();
  }

  it("routes claude task validator through continuity service and records turn outcome", async () => {
    const execution = buildSimpleExecution();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;
    const validator: GraphWorkflowAgentValidatorConfig = {
      type: "claude",
      enabled: true,
      continuity: { enabled: true },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      instructions: "Validate.",
    };

    const claudeRun = vi.fn().mockResolvedValue(
      taskResult(passResult, {
        backendRef: { backend: "claude", sessionId: "sdk-session-1" },
      }),
    );

    const resolvedExecution = {
      ...execution,
      laneStates: { task_validator: {} },
    } as unknown as GraphWorkflowExecution;
    const resolveValidatorCall = vi.fn().mockResolvedValue({
      execution: resolvedExecution,
      sessionAction: "create",
      engine: "claude",
      conversationId: "continuity-conv-id",
    });
    const recordClaudeTurnOutcome = vi.fn().mockReturnValue(resolvedExecution);
    const recordCodexTurnOutcome = vi.fn();

    const repositoryUpdate = vi.fn();

    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(claudeRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService: {
        resolveValidatorCall,
        recordClaudeTurnOutcome,
        recordCodexTurnOutcome,
      },
      executionRepository: { update: repositoryUpdate },
    });

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "caller-conv-id",
      summary: "Done.",
      validator,
    });

    expect(resolveValidatorCall).toHaveBeenCalledOnce();
    // Task runner called with no resumeRef (sessionAction: "create" clears cache)
    expect(claudeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        autonomous: true,
      }),
    );
    expect(recordClaudeTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "task_validator",
        // Task runner does not expose context token counts
        contextTokens: null,
        contextWindowMax: null,
      }),
    );
    expect(repositoryUpdate).toHaveBeenCalledOnce();
    expect(result.result.kind).toBe("pass");
  });

  it("routes codex task validator through continuity service and records thread outcome", async () => {
    const execution = buildSimpleExecution();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;
    const validator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
      instructions: "Validate.",
    };

    const codexRun = vi.fn().mockResolvedValue(
      taskResult(passResult, {
        backendRef: { backend: "codex", threadId: "real-thread-123" },
        usage: null,
      }),
    );

    const resolvedExecution = {
      ...execution,
      laneStates: {},
    } as GraphWorkflowExecution;
    const resolveValidatorCall = vi.fn().mockResolvedValue({
      execution: resolvedExecution,
      sessionAction: "create",
      engine: "codex",
      threadId: "placeholder-id",
    });
    const recordClaudeTurnOutcome = vi.fn();
    const recordCodexTurnOutcome = vi.fn().mockReturnValue(resolvedExecution);
    const repositoryUpdate = vi.fn();

    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(vi.fn(), codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService: {
        resolveValidatorCall,
        recordClaudeTurnOutcome,
        recordCodexTurnOutcome,
      },
      executionRepository: { update: repositoryUpdate },
    });

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "caller-conv-id",
      summary: "Done.",
      validator,
    });

    expect(resolveValidatorCall).toHaveBeenCalledOnce();
    // Codex runner called with correct settings
    expect(codexRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      }),
    );
    expect(recordCodexTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "task_validator",
        newThreadId: "real-thread-123",
      }),
    );
    expect(repositoryUpdate).toHaveBeenCalledOnce();
    expect(result.result.kind).toBe("pass");
    expect(result.metadata.reviewArtifact).toMatchObject({
      engine: "codex",
      threadId: "real-thread-123",
    });
  });

  // -- fix-d5668089: Codex review artifact uses wrong field name ---------------

  it("codex review artifact uses 'response' field name (not 'finalResponse')", async () => {
    const execution = buildSimpleExecution();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;
    const validator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
      instructions: "Validate.",
    };

    const validatorResponseText = JSON.stringify({
      pass: true,
      summary: "Looks good",
      issues: [],
    });

    const codexRun = vi.fn().mockResolvedValue(
      taskResult(validatorResponseText, {
        backendRef: { backend: "codex", threadId: "thread-abc" },
        usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
      }),
    );

    const resolvedExecution = {
      ...execution,
      laneStates: {},
    } as GraphWorkflowExecution;
    const resolveValidatorCall = vi.fn().mockResolvedValue({
      execution: resolvedExecution,
      sessionAction: "create",
      engine: "codex",
      threadId: undefined,
    });
    const recordClaudeTurnOutcome = vi.fn();
    const recordCodexTurnOutcome = vi.fn().mockReturnValue({
      ...resolvedExecution,
      laneStates: {
        task_validator: {
          engine: "codex",
          lane: "task_validator",
          contextId: "context-plan",
          sessionRef: {
            engine: "codex",
            lane: "task_validator",
            threadId: "thread-abc",
          },
          lastTurnUsage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            outputTokens: 50,
          },
          rotateBeforeNextTurn: false,
          limitEvaluation: "disabled",
          lastUsedAt: "2026-03-27T16:00:00.000Z",
        },
      },
    });
    const repositoryUpdate = vi.fn();

    const runner = createValidatorRunner({
      getTaskRunner: mockGetTaskRunner(vi.fn(), codexRun),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      continuityService: {
        resolveValidatorCall,
        recordClaudeTurnOutcome,
        recordCodexTurnOutcome,
      },
      executionRepository: { update: repositoryUpdate },
    });

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "caller-conv-id",
      summary: "Done.",
      validator,
    });

    expect(result.metadata.reviewArtifact).toMatchObject({
      engine: "codex",
      threadId: "thread-abc",
      response: validatorResponseText,
    });
    // Must NOT use the old field name
    expect(result.metadata.reviewArtifact).not.toHaveProperty("finalResponse");
  });
});

describe("parseValidatorResponse", () => {
  it("prefers structuredOutput when available and returns kind=pass", () => {
    const structured = {
      pass: true,
      summary: "All good",
      issues: [],
    };
    const result = parseValidatorResponse("some text", "claude", structured);
    expect(result.result.kind).toBe("pass");
    if (result.result.kind === "pass") {
      expect(result.result.summary).toBe("All good");
      expect(result.result.issues).toEqual([]);
    }
    expect(result.parsePath).toBe("structured_output");
  });

  it("parses raw JSON string when no structuredOutput", () => {
    const json = JSON.stringify({
      pass: false,
      summary: "Needs work",
      issues: [{ title: "Bug", description: "Fix" }],
    });
    const result = parseValidatorResponse(json, "claude");
    expect(result.result.kind).toBe("fail");
    if (result.result.kind === "fail") {
      expect(result.result.issues).toHaveLength(1);
    }
    expect(result.parsePath).toBe("raw_json");
  });

  it("falls back to fenced block extraction", () => {
    const text = [
      "Here is my review:",
      "```json",
      JSON.stringify({
        pass: true,
        summary: "OK",
        issues: [],
      }),
      "```",
    ].join("\n");
    const result = parseValidatorResponse(text, "claude");
    expect(result.result.kind).toBe("pass");
    expect(result.parsePath).toBe("fenced_json_block");
  });

  it("returns infra_error reason=unparseable when all parsing paths fail", () => {
    const result = parseValidatorResponse("no json here", "claude");
    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("unparseable");
      expect(result.result.engine).toBe("claude");
    }
    expect(result.parsePath).toBe("fenced_json_block");
  });

  it("returns infra_error reason=schema_mismatch when fenced JSON fails schema validation", () => {
    const text = [
      "```json",
      JSON.stringify({ pass: "bad", summary: 42 }),
      "```",
    ].join("\n");
    const result = parseValidatorResponse(text, "codex");
    expect(result.result.kind).toBe("infra_error");
    if (result.result.kind === "infra_error") {
      expect(result.result.reason).toBe("schema_mismatch");
      expect(result.result.engine).toBe("codex");
    }
  });

  it("ignores invalid structuredOutput and falls back to text", () => {
    const json = JSON.stringify({
      pass: true,
      summary: "Text parse",
      issues: [],
    });
    const result = parseValidatorResponse(json, "claude", { invalid: true });
    expect(result.result.kind).toBe("pass");
    if (result.result.kind === "pass") {
      expect(result.result.summary).toBe("Text parse");
    }
    expect(result.parsePath).toBe("raw_json");
  });
});

// -- Continuity runtime integration (real service) ----------------------------
// These tests use the real createWorkflowContinuityService to exercise the full
// lane-reuse path through an in-memory repository, rather than mocking the
// service interface. They cover: session reuse across consecutive calls, Codex
// thread resume after a schema round-trip (restart recovery), and Codex review
// artifact persistence through serialization.

describe("continuity runtime integration (real service)", () => {
  const passResponseJson = JSON.stringify({
    pass: true,
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

  it("reuses Claude task-validator session across two consecutive calls via persisted lane state", async () => {
    const execution = buildExecutionWithTaskValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = execution.workingDefinition.tasks.find(
      (t) => t.id === "task-plan-1",
    )!;
    const validator: GraphWorkflowAgentValidatorConfig = {
      type: "claude",
      enabled: true,
      continuity: { enabled: true },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      instructions: "Validate.",
    };
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

    // Call 1: no lane state yet → creates a fresh session
    const result1 = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "impl-conv",
      summary: "Done.",
      validator,
    });

    // Backend ref from the task runner is captured as metadata sessionRef
    expect(result1.metadata.sessionRef).toMatchObject({
      backend: "claude",
      sessionId: "sdk-session-1",
    });
    expect(createConversation).toHaveBeenCalledOnce();
    expect(repo.read().laneStates["task_validator"]?.engine).toBe("claude");

    // Call 2: lane state now in repo → reuses the same session
    const result2 = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution: repo.read(),
      context: contextDef,
      task: taskDef,
      conversationId: "impl-conv",
      summary: "Done again.",
      validator,
    });

    // Continuity service reuses the conversation (no second createConversation call)
    expect(createConversation).toHaveBeenCalledOnce();
    // The cached backend ref is used as resumeRef on the second call
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

  it("resumes Codex task-validator thread after schema round-trip (restart recovery)", async () => {
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                taskValidation: {
                  type: "codex" as const,
                  enabled: true,
                  continuity: { enabled: true },
                  codex: {},
                  instructions: "Validate.",
                },
              }
            : ctx,
      ),
    });
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      workingDefinition: definition,
    });
    const contextDef = definition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = definition.tasks.find((t) => t.id === "task-plan-1")!;
    const validator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
      instructions: "Validate.",
    };
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

    // First Codex run returns a real thread ID via backendRef
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

    // Call 1: starts a new thread via startCodexThread
    const result1 = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "impl-conv",
      summary: "Done.",
      validator,
    });

    expect(startCodexThread).toHaveBeenCalledOnce();
    expect(resumeCodexThread).not.toHaveBeenCalled();
    // The review artifact records the real thread ID from backendRef
    expect(result1.metadata.reviewArtifact).toMatchObject({
      engine: "codex",
      threadId: "thread-real-1",
    });

    // Simulate restart: round-trip execution through the schema parser
    const deserialized = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(repo.read())),
    );
    await repo.update("/repo", "session-1", deserialized);

    // Call 2 after restart: lane state loaded from deserialized execution must
    // cause resumeCodexThread to be called with the real thread ID
    const result2 = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution: repo.read(),
      context: contextDef,
      task: taskDef,
      conversationId: "impl-conv",
      summary: "Done again.",
      validator,
    });

    expect(startCodexThread).toHaveBeenCalledOnce();
    expect(resumeCodexThread).toHaveBeenCalledWith("thread-real-1");
    expect(result2.metadata.reviewArtifact).toMatchObject({
      engine: "codex",
      threadId: "thread-real-1",
    });
  });

  it("codex review artifact is null when task runner returns no backendRef", async () => {
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                taskValidation: {
                  type: "codex" as const,
                  enabled: true,
                  continuity: { enabled: true },
                  codex: {},
                  instructions: "Validate.",
                },
              }
            : ctx,
      ),
    });
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      workingDefinition: definition,
    });
    const contextDef = definition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = definition.tasks.find((t) => t.id === "task-plan-1")!;
    const validator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
      instructions: "Validate.",
    };
    const repo = createInMemoryRepo(execution);

    const startCodexThread = vi.fn(async () => ({
      threadId: "thread-placeholder",
    }));

    const continuityService = createWorkflowContinuityService({
      createConversation: vi.fn(),
      getConversation: vi.fn(),
      startCodexThread,
      resumeCodexThread: vi.fn(),
      now: () => NOW,
    });

    // Codex runner returns NO backendRef (e.g. API didn't provide a thread ID)
    const codexRun = vi.fn().mockResolvedValue(
      taskResult(passResponseJson, {
        backendRef: undefined,
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

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      task: taskDef,
      conversationId: "impl-conv",
      summary: "Done.",
      validator,
    });

    // With no backendRef, the review artifact should be null rather than
    // containing an empty threadId that fails schema validation.
    expect(result.metadata.reviewArtifact).toBeNull();
    expect(result.result.kind).toBe("pass");
  });

  it("Codex review artifact survives schema round-trip and thread resumes on next validator call", async () => {
    // Build a definition with a Codex task validator
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                taskValidation: {
                  type: "codex" as const,
                  enabled: true,
                  continuity: { enabled: true },
                  codex: {},
                  instructions: "Validate.",
                },
              }
            : ctx,
      ),
    });
    const contextDef = definition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const taskDef = definition.tasks.find((t) => t.id === "task-plan-1")!;

    // Simulate a previous run that ended with a Codex artifact in execution history
    // and a persisted lane state containing the Codex thread ID.
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: vi.fn(),
      now: () => NOW,
    });
    const priorExecution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      workingDefinition: definition,
      laneStates: {
        task_validator: {
          engine: "codex",
          lane: "task_validator",
          contextId: "context-plan",
          sessionRef: {
            engine: "codex",
            lane: "task_validator",
            threadId: "thread-prior",
          },
          lastTurnUsage: null,
          rotateBeforeNextTurn: false,
          limitEvaluation: "disabled",
          lastUsedAt: NOW,
        },
      },
    });
    const executionWithHistory = eventPublisher.publishValidationResult({
      projectPath: "/repo",
      sessionName: "session-1",
      execution: priorExecution,
      contextId: "context-plan",
      validatorType: "task",
      pass: true,
      summary: "Passed on prior run",
      sessionRef: { backend: "codex", threadId: "thread-prior" },
      reviewArtifact: {
        engine: "codex",
        threadId: "thread-prior",
        response: passResponseJson,
        usage: null,
      },
    });

    // Simulate restart: round-trip through schema parser
    const deserialized = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(executionWithHistory)),
    );

    // Verify the review artifact survived the round-trip
    const historyEntry = deserialized.history.find(
      (e) =>
        e.event.type === "graph-workflow-validation-result" &&
        e.event.reviewArtifact != null,
    );
    expect(historyEntry).toBeDefined();
    const artifact =
      historyEntry?.event.type === "graph-workflow-validation-result"
        ? historyEntry.event.reviewArtifact
        : null;
    expect(artifact).toMatchObject({
      engine: "codex",
      threadId: "thread-prior",
    });

    // Run another validator call using the deserialized execution with lane state
    const repo = createInMemoryRepo(deserialized);
    const resumeCodexThread = vi.fn(async (id: string) => ({ threadId: id }));
    const startCodexThread = vi.fn(async () => ({ threadId: "thread-fresh" }));

    const continuityService = createWorkflowContinuityService({
      createConversation: vi.fn(),
      getConversation: vi.fn(),
      startCodexThread,
      resumeCodexThread,
      now: () => NOW,
    });

    const codexRun = vi.fn().mockResolvedValue(
      taskResult(passResponseJson, {
        backendRef: { backend: "codex", threadId: "thread-prior" },
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

    const validator: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: {},
      instructions: "Validate.",
    };

    const result = await runner.runTaskValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution: deserialized,
      context: contextDef,
      task: taskDef,
      conversationId: "impl-conv",
      summary: "Done.",
      validator,
    });

    // Thread resumed from persisted lane state, not created fresh
    expect(resumeCodexThread).toHaveBeenCalledWith("thread-prior");
    expect(startCodexThread).not.toHaveBeenCalled();
    // Review artifact from this turn also references the resumed thread
    expect(result.metadata.reviewArtifact).toMatchObject({
      engine: "codex",
      threadId: "thread-prior",
    });
  });
});
