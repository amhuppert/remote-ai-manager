import { describe, expect, it } from "vitest";
import type { GraphWorkflowTaskState } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
  ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { createWorkflowExecution } from "./test-fixtures";
import { createExecutionIndex } from "./execution-index";

function createContext(id: string, title = id): GraphWorkflowResolvedContext {
  return {
    id,
    title,
    acceptanceCriteria: "Context acceptance criteria",
    implementer: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
    contextValidator: null,
    scriptValidator: { enabled: false },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: false },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  };
}

function createTask(
  id: string,
  contextId: string,
  order: number,
): GraphWorkflowTaskDefinition {
  return {
    id,
    contextId,
    order,
    title: id,
    instructions: `Instructions for ${id}`,
    source: "user",
  };
}

function createTaskState(
  taskId: string,
  contextId: string,
  order: number,
  status: GraphWorkflowTaskState["status"] = "pending",
): GraphWorkflowTaskState {
  return {
    taskId,
    contextId,
    order,
    status,
    summary: null,
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
  };
}

function createDefinition(
  executionContexts: GraphWorkflowResolvedContext[],
  tasks: GraphWorkflowTaskDefinition[],
): ResolvedWorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    executionContexts,
    tasks,
    edges: [],
  };
}

describe("createExecutionIndex", () => {
  it("returns empty indexes for an empty definition", () => {
    const index = createExecutionIndex({
      executionContexts: [],
      tasks: [],
    });

    expect(index.contextById.size).toBe(0);
    expect(index.taskById.size).toBe(0);
    expect(index.tasksByContext.size).toBe(0);
    expect(index.taskStatesByContext.size).toBe(0);
  });

  it("indexes one context with multiple tasks in order", () => {
    const context = createContext("ctx-a", "Context A");
    const taskA = createTask("task-a", "ctx-a", 2);
    const taskB = createTask("task-b", "ctx-a", 1);
    const definition = createDefinition([context], [taskA, taskB]);

    const index = createExecutionIndex(definition);

    expect(index.contextById.get("ctx-a")).toBe(context);
    expect(index.taskById.get("task-a")).toBe(taskA);
    expect(index.tasksByContext.get("ctx-a")).toEqual([taskB, taskA]);
  });

  it("keeps tasks grouped by their own context", () => {
    const contextA = createContext("ctx-a", "Context A");
    const contextB = createContext("ctx-b", "Context B");
    const taskA = createTask("task-a", "ctx-a", 1);
    const taskB = createTask("task-b", "ctx-b", 1);
    const definition = createDefinition([contextA, contextB], [taskA, taskB]);

    const index = createExecutionIndex(definition);

    expect(index.tasksByContext.get("ctx-a")).toEqual([taskA]);
    expect(index.tasksByContext.get("ctx-b")).toEqual([taskB]);
  });

  it("groups execution task states by context", () => {
    const contextA = createContext("ctx-a", "Context A");
    const contextB = createContext("ctx-b", "Context B");
    const taskA = createTask("task-a", "ctx-a", 1);
    const taskB = createTask("task-b", "ctx-b", 1);
    const definition = createDefinition([contextA, contextB], [taskA, taskB]);
    const taskStateA = createTaskState("task-a", "ctx-a", 1, "completed");
    const taskStateB = createTaskState("task-b", "ctx-b", 1, "running");
    const execution = createWorkflowExecution({
      workingDefinition: definition,
      taskStates: {
        "task-a": taskStateA,
        "task-b": taskStateB,
      },
    });

    const index = createExecutionIndex(definition, execution);

    expect(index.taskStatesByContext.get("ctx-a")).toEqual({
      "task-a": taskStateA,
    });
    expect(index.taskStatesByContext.get("ctx-b")).toEqual({
      "task-b": taskStateB,
    });
  });
});
