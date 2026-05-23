import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
  GraphWorkflowTaskState,
} from "@/types";

type ExecutionIndexContext =
  | GraphWorkflowExecutionContextDefinition
  | GraphWorkflowResolvedContext;

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
