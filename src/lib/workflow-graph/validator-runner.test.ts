import { describe, expect, it, vi } from "vitest";
import {
  extractValidatorResult,
  buildTaskValidationPrompt,
  buildContextValidationPrompt,
  createValidatorRunner,
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
        reopenTaskIds: [],
      }),
      "```",
    ].join("\n");

    const result = extractValidatorResult(text);
    expect(result).toEqual({
      pass: true,
      summary: "All checks passed",
      issues: [],
      reopenTaskIds: [],
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
        reopenTaskIds: ["task-1"],
      }),
      "```",
    ].join("\n");

    const result = extractValidatorResult(text);
    expect(result).toEqual({
      pass: false,
      summary: "Missing test coverage",
      issues: [{ title: "No tests", description: "Add unit tests." }],
      reopenTaskIds: ["task-1"],
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
    expect(result.reopenTaskIds).toEqual([]);
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
  enabled: true,
  autoCreateFixTasks: false,
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
  iterationPolicy: { maxIterations: 5 },
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

  it("lists sibling task IDs for reopenTaskIds reference", () => {
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

  it("includes the required JSON output schema", () => {
    const prompt = buildTaskValidationPrompt({
      context,
      task: tasks[0]!,
      tasks,
      summary: "Done.",
      validator: validatorConfig,
    });

    expect(prompt).toContain("```json");
    expect(prompt).toContain('"pass"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"issues"');
    expect(prompt).toContain('"reopenTaskIds"');
  });
});

describe("buildContextValidationPrompt", () => {
  it("includes the validator instructions", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      validator: validatorConfig,
    });

    expect(prompt).toContain(
      "Verify that all files have proper error handling",
    );
  });

  it("lists all tasks in the context", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      validator: validatorConfig,
    });

    expect(prompt).toContain("Write component");
    expect(prompt).toContain("Add tests");
  });

  it("includes the required JSON output schema", () => {
    const prompt = buildContextValidationPrompt({
      context,
      tasks,
      validator: validatorConfig,
    });

    expect(prompt).toContain("```json");
    expect(prompt).toContain('"pass"');
    expect(prompt).toContain('"reopenTaskIds"');
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
                enabled: true,
                autoCreateFixTasks: false,
                agent: { model: "sonnet", reasoningEffort: "medium" },
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

function buildExecutionWithContextValidation(): GraphWorkflowExecution {
  const definition = createWorkflowDefinition({
    executionContexts: createWorkflowDefinition().executionContexts.map(
      (ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              contextValidation: {
                agentValidator: {
                  enabled: true,
                  autoCreateFixTasks: false,
                  agent: { model: "opus", reasoningEffort: "high" },
                  instructions: "Validate the overall plan quality.",
                },
                onFail: {
                  mode: "retry" as const,
                  retryScope: "same_context" as const,
                  maxAttempts: 2,
                },
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
        reopenTaskIds: [],
      }),
      "```",
    ].join("\n");

    const executeValidatorAgent = vi.fn(async () => agentResponse);
    const runner = createValidatorRunner({ executeValidatorAgent });

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
    expect(result.pass).toBe(true);
    expect(result.summary).toBe("Task completed correctly");
  });

  it("runTaskValidator returns a failing result when the agent produces no JSON", async () => {
    const executeValidatorAgent = vi.fn(
      async () => "I could not find anything to review.",
    );
    const runner = createValidatorRunner({ executeValidatorAgent });

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

    expect(result.pass).toBe(false);
    expect(result.summary).toContain("did not return structured output");
  });

  it("runContextAgentValidator executes with the correct model and returns parsed result", async () => {
    const agentResponse = [
      "```json",
      JSON.stringify({
        pass: false,
        summary: "Plan lacks error handling strategy",
        issues: [
          {
            title: "Missing error strategy",
            description: "No error handling plan was documented.",
          },
        ],
        reopenTaskIds: ["task-plan-1"],
      }),
      "```",
    ].join("\n");

    const executeValidatorAgent = vi.fn(async () => agentResponse);
    const runner = createValidatorRunner({ executeValidatorAgent });

    const execution = buildExecutionWithContextValidation();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;

    const result = await runner.runContextAgentValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextDef,
      validator: contextDef.contextValidation!.agentValidator!,
    });

    expect(executeValidatorAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "opus",
        reasoningEffort: "high",
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.reopenTaskIds).toEqual(["task-plan-1"]);
  });

  it("runTaskValidator propagates executor errors as a failing result", async () => {
    const executeValidatorAgent = vi.fn(async () => {
      throw new Error("SDK connection failed");
    });
    const runner = createValidatorRunner({ executeValidatorAgent });

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

    expect(result.pass).toBe(false);
    expect(result.summary).toContain("SDK connection failed");
  });
});
