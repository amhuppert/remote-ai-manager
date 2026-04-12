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
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { createWorkflowContinuityService } from "@/lib/workflows/graph-workflow/workflow-continuity-service";
import { graphWorkflowExecutionSchema } from "@/lib/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";

describe("extractValidatorResult", () => {
  it("extracts a valid result from a ```json fenced block", () => {
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

    const result = extractValidatorResult(text);
    expect(result).toEqual({
      pass: true,
      summary: "All checks passed",
      issues: [],
    });
  });

  it("extracts the last JSON block when multiple are present", () => {
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

    const result = extractValidatorResult(text);
    expect(result).toEqual({
      pass: false,
      summary: "Missing test coverage",
      issues: [{ title: "No tests", description: "Add unit tests." }],
    });
  });

  it("applies Zod defaults for omitted optional fields", () => {
    const text = [
      "```json",
      JSON.stringify({ pass: true, summary: "Looks good" }),
      "```",
    ].join("\n");

    const result = extractValidatorResult(text);
    expect(result.issues).toEqual([]);
  });

  it("returns a failing result when no JSON block is found", () => {
    const result = extractValidatorResult(
      "I could not produce a structured result.",
    );
    expect(result.pass).toBe(false);
    expect(result.summary).toContain("did not return structured output");
  });

  it("returns a failing result when JSON is malformed", () => {
    const text = ["```json", "{ not valid json }", "```"].join("\n");

    const result = extractValidatorResult(text);
    expect(result.pass).toBe(false);
    expect(result.summary).toContain("returned invalid structured output");
  });

  it("returns a failing result when JSON does not match the schema", () => {
    const text = [
      "```json",
      JSON.stringify({ pass: "maybe", summary: 42 }),
      "```",
    ].join("\n");

    const result = extractValidatorResult(text);
    expect(result.pass).toBe(false);
    expect(result.summary).toContain("returned invalid structured output");
  });
});

const validatorConfig: GraphWorkflowAgentValidatorConfig = {
  type: "claude",
  enabled: true,
  continuity: { enabled: true },
  agent: { model: "sonnet", reasoningEffort: "medium" },
  instructions: "Verify that all files have proper error handling.",
};

const context: GraphWorkflowExecutionContextDefinition = {
  id: "context-implement",
  title: "Implement Feature",
  description: "Build the widget",
  agent: { model: "sonnet", reasoningEffort: "medium" },
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
  it("runTaskValidator passes the prompt to the executor and returns the parsed result", async () => {
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

    const executeValidatorAgent = vi.fn(async () => ({
      text: agentResponse,
      structuredOutput: undefined,
    }));
    const executeValidatorCodex = vi.fn();
    const runner = createValidatorRunner({
      executeValidatorAgent,
      executeValidatorCodex,
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

    expect(executeValidatorAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/repo",
        sessionName: "session-1",
        model: "sonnet",
        reasoningEffort: "medium",
      }),
    );
    expect(result.result.pass).toBe(true);
    expect(result.result.summary).toBe("Task completed correctly");
  });

  it("runTaskValidator returns a failing result when the agent produces no JSON", async () => {
    const executeValidatorAgent = vi.fn(async () => ({
      text: "I could not find anything to review.",
      structuredOutput: undefined,
    }));
    const executeValidatorCodex = vi.fn();
    const runner = createValidatorRunner({
      executeValidatorAgent,
      executeValidatorCodex,
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

    expect(result.result.pass).toBe(false);
    expect(result.result.summary).toContain("did not return structured output");
  });

  it("runTaskValidator propagates executor errors as a failing result", async () => {
    const executeValidatorAgent = vi.fn(async () => {
      throw new Error("SDK connection failed");
    });
    const executeValidatorCodex = vi.fn();
    const runner = createValidatorRunner({
      executeValidatorAgent,
      executeValidatorCodex,
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

    expect(result.result.pass).toBe(false);
    expect(result.result.summary).toContain("SDK connection failed");
  });

  it("runTaskValidator calls executeValidatorAgent with outputFormat for claude type", async () => {
    const agentResponse = [
      "```json",
      JSON.stringify({
        pass: true,
        summary: "OK",
        issues: [],
      }),
      "```",
    ].join("\n");

    const executeValidatorAgent = vi.fn(async () => ({
      text: agentResponse,
      structuredOutput: undefined,
    }));
    const executeValidatorCodex = vi.fn();
    const runner = createValidatorRunner({
      executeValidatorAgent,
      executeValidatorCodex,
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

    expect(executeValidatorAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFormat: { type: "json_schema", schema: VALIDATOR_OUTPUT_SCHEMA },
      }),
    );
    expect(executeValidatorCodex).not.toHaveBeenCalled();
  });

  it("runTaskValidator calls executeValidatorCodex for codex type", async () => {
    const executeValidatorAgent = vi.fn();
    const executeValidatorCodex = vi.fn(async () =>
      JSON.stringify({
        pass: true,
        summary: "Codex OK",
        issues: [],
      }),
    );
    const runner = createValidatorRunner({
      executeValidatorAgent,
      executeValidatorCodex,
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
      codex: { model: "o3", reasoningEffort: "high" },
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

    expect(executeValidatorCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "o3",
        reasoningEffort: "high",
      }),
    );
    expect(executeValidatorAgent).not.toHaveBeenCalled();
    expect(result.result.pass).toBe(true);
    expect(result.result.summary).toBe("Codex OK");
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
      agent: { model: "sonnet", reasoningEffort: "medium" },
      instructions: "Validate.",
    };

    const executeValidatorAgent = vi.fn().mockResolvedValue({
      text: passResult,
      structuredOutput: undefined,
      contextTokens: 10000,
      contextWindowMax: 200000,
    });
    const executeValidatorCodex = vi.fn();

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
      executeValidatorAgent,
      executeValidatorCodex,
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
    // Claude agent called with the conversationId from the continuity service
    expect(executeValidatorAgent).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "continuity-conv-id" }),
    );
    expect(recordClaudeTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "task_validator",
        contextTokens: 10000,
        contextWindowMax: 200000,
      }),
    );
    expect(repositoryUpdate).toHaveBeenCalledOnce();
    expect(result.result.pass).toBe(true);
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

    const executeValidatorAgent = vi.fn();
    const executeValidatorCodex = vi.fn().mockResolvedValue({
      text: passResult,
      realThreadId: "real-thread-123",
      usage: null,
    });

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
      executeValidatorAgent,
      executeValidatorCodex,
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
    expect(executeValidatorCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionAction: "create",
        storedThreadId: "placeholder-id",
      }),
    );
    expect(recordCodexTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "task_validator",
        newThreadId: "real-thread-123",
      }),
    );
    expect(repositoryUpdate).toHaveBeenCalledOnce();
    expect(result.result.pass).toBe(true);
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

    const executeValidatorAgent = vi.fn();
    const executeValidatorCodex = vi.fn().mockResolvedValue({
      text: validatorResponseText,
      realThreadId: "thread-abc",
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
    });

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
      executeValidatorAgent,
      executeValidatorCodex,
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
  it("prefers structuredOutput when available", () => {
    const structured = {
      pass: true,
      summary: "All good",
      issues: [],
    };
    const result = parseValidatorResponse("some text", structured);
    expect(result.result).toEqual(structured);
    expect(result.parsePath).toBe("structured_output");
  });

  it("parses raw JSON string when no structuredOutput", () => {
    const json = JSON.stringify({
      pass: false,
      summary: "Needs work",
      issues: [{ title: "Bug", description: "Fix" }],
    });
    const result = parseValidatorResponse(json);
    expect(result.result.pass).toBe(false);
    expect(result.result.issues).toHaveLength(1);
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
    const result = parseValidatorResponse(text);
    expect(result.result.pass).toBe(true);
    expect(result.parsePath).toBe("fenced_json_block");
  });

  it("returns failing result when all parsing paths fail", () => {
    const result = parseValidatorResponse("no json here");
    expect(result.result.pass).toBe(false);
    expect(result.result.summary).toContain("did not return structured output");
    expect(result.parsePath).toBe("fenced_json_block");
  });

  it("ignores invalid structuredOutput and falls back to text", () => {
    const json = JSON.stringify({
      pass: true,
      summary: "Text parse",
      issues: [],
    });
    const result = parseValidatorResponse(json, { invalid: true });
    expect(result.result.pass).toBe(true);
    expect(result.result.summary).toBe("Text parse");
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
      agent: { model: "sonnet", reasoningEffort: "medium" },
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

    const executeValidatorAgent = vi.fn().mockResolvedValue({
      text: passResponseJson,
      structuredOutput: undefined,
      contextTokens: 10_000,
      contextWindowMax: 200_000,
    });

    const runner = createValidatorRunner({
      executeValidatorAgent,
      executeValidatorCodex: vi.fn(),
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

    expect(result1.metadata.sessionRef).toMatchObject({
      engine: "claude",
      conversationId: "conv-val-1",
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

    expect(createConversation).toHaveBeenCalledOnce();
    expect(result2.metadata.sessionRef).toMatchObject({
      engine: "claude",
      conversationId: "conv-val-1",
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

    // First Codex run returns a real thread ID after the turn completes
    const executeValidatorCodex = vi.fn().mockResolvedValue({
      text: passResponseJson,
      realThreadId: "thread-real-1",
      usage: null,
    });

    const runner = createValidatorRunner({
      executeValidatorAgent: vi.fn(),
      executeValidatorCodex,
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
    // The review artifact records the real thread ID captured after the turn
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
      sessionRef: {
        engine: "codex",
        lane: "task_validator",
        threadId: "thread-prior",
      },
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

    const runner = createValidatorRunner({
      executeValidatorAgent: vi.fn(),
      executeValidatorCodex: vi.fn().mockResolvedValue({
        text: passResponseJson,
        realThreadId: "thread-prior",
        usage: null,
      }),
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
