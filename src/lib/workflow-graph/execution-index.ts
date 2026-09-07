import { type GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";

import type { GraphWorkflowTaskState } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowCascadeContext,
} from "@/lib/workflow-graph/definition-schemas";
// The cascade shape, not the seeded one: the index only keys contexts by id, so
// typing it on the wider (snapshot-free) shape lets one index serve both the
// builder preview and a running execution's working definition.
type ExecutionIndexContext =
  | GraphWorkflowExecutionContextDefinition
  | GraphWorkflowCascadeContext;

export interface ExecutionIndexDefinition {
  executionContexts: ExecutionIndexContext[];
  tasks: GraphWorkflowTaskDefinition[];
}

export interface ExecutionIndex {
  contextById: Map<string, ExecutionIndexContext>;
  taskById: Map<string, GraphWorkflowTaskDefinition>;
  tasksByContext: Map<string, GraphWorkflowTaskDefinition[]>;
  taskStatesByContext: Map<string, Record<string, GraphWorkflowTaskState>>;
}

export function createExecutionIndex(
  definition: ExecutionIndexDefinition,
  execution?: GraphWorkflowExecution | null,
): ExecutionIndex {
  const contextById = new Map<string, ExecutionIndexContext>();
  for (const context of definition.executionContexts) {
    contextById.set(context.id, context);
  }

  const taskById = new Map<string, GraphWorkflowTaskDefinition>();
  const tasksByContext = new Map<string, GraphWorkflowTaskDefinition[]>();
  for (const task of definition.tasks) {
    taskById.set(task.id, task);

    const tasks = tasksByContext.get(task.contextId);
    if (tasks) {
      tasks.push(task);
      continue;
    }

    tasksByContext.set(task.contextId, [task]);
  }

  for (const tasks of tasksByContext.values()) {
    tasks.sort((left, right) => left.order - right.order);
  }

  const taskStatesByContext = new Map<
    string,
    Record<string, GraphWorkflowTaskState>
  >();
  if (execution) {
    for (const [taskId, taskState] of Object.entries(execution.taskStates)) {
      const taskStates = taskStatesByContext.get(taskState.contextId) ?? {};
      taskStates[taskId] = taskState;
      taskStatesByContext.set(taskState.contextId, taskStates);
    }
  }

  return {
    contextById,
    taskById,
    tasksByContext,
    taskStatesByContext,
  };
}

export function getContextDefinition(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowResolvedContext {
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new Error(`Execution context "${contextId}" was not found`);
  }

  return context;
}

export function getContextTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowTaskDefinition[] {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.order - right.order);
}

export function getIncompleteTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowTaskDefinition[] {
  return getContextTasks(execution, contextId).filter(
    (task) => execution.taskStates[task.id]?.status !== "completed",
  );
}

export function countCompletedTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return getContextTasks(execution, contextId).filter(
    (task) => execution.taskStates[task.id]?.status === "completed",
  ).length;
}

export function countRemainingTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return getIncompleteTasks(execution, contextId).length;
}

interface ExecutionTopology {
  executionContexts: readonly { id: string }[];
  edges: readonly { sourceContextId: string; targetContextId: string }[];
}

export function getEntryContextIds(definition: ExecutionTopology): string[] {
  const targets = new Set(definition.edges.map((edge) => edge.targetContextId));
  return definition.executionContexts
    .map((context) => context.id)
    .filter((contextId) => !targets.has(contextId));
}

export function getTerminalContextIds(definition: ExecutionTopology): string[] {
  const sources = new Set(definition.edges.map((edge) => edge.sourceContextId));
  return definition.executionContexts
    .map((context) => context.id)
    .filter((contextId) => !sources.has(contextId));
}
