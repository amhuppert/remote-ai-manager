import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  GraphWorkflowExecution,
  WorkflowGraphValidationError,
  GraphWorkflowTaskDefinition,
  WorkflowRuntimeEditRequest,
} from "@/types";
import {
  validateWorkflowDefinition,
  validateWorkflowRuntimeEdit,
} from "./validation";

const logger = createLogger("graph-workflow-runtime-edits");

export interface AgentAddedTask {
  slug?: string;
  title: string;
  instructions: string;
}

export class GraphWorkflowRuntimeEditValidationError extends Error {
  readonly errors: WorkflowGraphValidationError[];

  constructor(errors: WorkflowGraphValidationError[]) {
    super("Runtime edit validation failed");
    this.name = "GraphWorkflowRuntimeEditValidationError";
    this.errors = errors;
  }
}

export interface GraphWorkflowRuntimeEditServiceDeps {
  createTaskId(): string;
  now(): string;
}

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

function getContextTaskOrder(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .reduce((maxOrder, task) => Math.max(maxOrder, task.order), 0);
}

function getContextDefinition(
  execution: GraphWorkflowExecution,
  contextId: string,
) {
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new Error(`Execution context "${contextId}" was not found`);
  }

  return context;
}

function getContextTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowTaskDefinition[] {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.order - right.order);
}

function getTaskDefinition(
  execution: GraphWorkflowExecution,
  taskId: string,
): GraphWorkflowTaskDefinition {
  const task = execution.workingDefinition.tasks.find(
    (entry) => entry.id === taskId,
  );
  if (!task) {
    throw new Error(`Task "${taskId}" was not found`);
  }

  return task;
}

function setContextTaskOrder(
  execution: GraphWorkflowExecution,
  contextId: string,
  orderedTaskIds: string[],
): void {
  const taskById = new Map(
    execution.workingDefinition.tasks.map((task) => [task.id, task]),
  );

  orderedTaskIds.forEach((taskId, index) => {
    const task = taskById.get(taskId);
    if (!task) {
      return;
    }

    task.order = index + 1;
    const taskState = execution.taskStates[taskId];
    if (taskState) {
      taskState.order = index + 1;
      taskState.contextId = contextId;
    }
  });
}

function syncContextState(
  execution: GraphWorkflowExecution,
  contextId: string,
): void {
  const contextState = execution.contextStates[contextId];
  if (!contextState) {
    return;
  }

  contextState.totalTaskCount = execution.workingDefinition.tasks.filter(
    (task) => task.contextId === contextId,
  ).length;
  contextState.completedTaskCount = countCompletedTasks(execution, contextId);
}

function createTaskDefinition(input: {
  taskId: string;
  contextId: string;
  order: number;
  task: AgentAddedTask;
}): GraphWorkflowTaskDefinition {
  return {
    id: input.taskId,
    contextId: input.contextId,
    order: input.order,
    title: input.task.title,
    instructions: input.task.instructions,
    source: "agent",
  };
}

function createUserTaskDefinition(input: {
  taskId: string;
  contextId: string;
  order: number;
  title: string;
  instructions: string;
  metadata?: Record<string, string>;
}): GraphWorkflowTaskDefinition {
  return {
    id: input.taskId,
    contextId: input.contextId,
    order: input.order,
    title: input.title,
    instructions: input.instructions,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    source: "user",
  };
}

const defaultDeps: GraphWorkflowRuntimeEditServiceDeps = {
  createTaskId() {
    return `task-${randomUUID()}`;
  },
  now() {
    return new Date().toISOString();
  },
};

function countCompletedTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return execution.workingDefinition.tasks.filter((task) => {
    if (task.contextId !== contextId) {
      return false;
    }

    return execution.taskStates[task.id]?.status === "completed";
  }).length;
}

export function createGraphWorkflowRuntimeEditService(
  deps: Partial<GraphWorkflowRuntimeEditServiceDeps> = {},
) {
  const resolvedDeps = { ...defaultDeps, ...deps };

  function applyAgentTaskAdd(
    execution: GraphWorkflowExecution,
    contextId: string,
    task: AgentAddedTask,
  ): GraphWorkflowExecution {
    if (execution.status !== "running") {
      throw new Error(
        "Agent task creation is allowed only while execution is running",
      );
    }

    if (execution.activeContextId !== contextId) {
      throw new Error(
        `Agents can add tasks only to the currently executing context "${execution.activeContextId}"`,
      );
    }

    const context = getContextDefinition(execution, contextId);
    if (!context.mutability.allowAgentTaskAdd) {
      throw new Error(
        `Execution context "${contextId}" does not allow agent task creation`,
      );
    }

    const contextState = execution.contextStates[contextId];
    if (!contextState) {
      throw new Error(
        `Execution context "${contextId}" does not exist in runtime state`,
      );
    }

    if (contextState.status !== "running") {
      throw new Error(
        `Agent task creation is allowed only while context "${contextId}" is running`,
      );
    }

    const nextExecution = cloneExecution(execution);
    const order = getContextTaskOrder(nextExecution, contextId) + 1;
    const taskId = task.slug ?? resolvedDeps.createTaskId();

    nextExecution.workingDefinition.tasks.push(
      createTaskDefinition({
        taskId,
        contextId,
        order,
        task,
      }),
    );
    nextExecution.taskStates[taskId] = {
      taskId,
      contextId,
      order,
      status: "pending",
      summary: null,
      startedAt: null,
      completedAt: null,
      lastConversationId: null,
      reopenedCount: 0,
      lastReopenedAt: null,
      failureMessage: null,
      failureHistory: [],
    };
    nextExecution.contextStates[contextId] = {
      ...contextState,
      totalTaskCount: contextState.totalTaskCount + 1,
    };

    const execLogger = getExecutionLogger(execution.id);
    execLogger?.task(contextId, "task.added_by_agent", {
      taskId,
      title: task.title,
      instructionsLength: task.instructions.length,
    });
    logger.info("graph-workflow.task.added_by_agent", {
      executionId: execution.id,
      contextId,
      taskId,
      title: task.title,
    });

    return nextExecution;
  }

  function applyUserEdits(
    execution: GraphWorkflowExecution,
    request: WorkflowRuntimeEditRequest,
  ): GraphWorkflowExecution {
    if (execution.status !== "running") {
      throw new Error(
        "User runtime edits are allowed only while execution is running",
      );
    }

    const validation = validateWorkflowRuntimeEdit(
      execution.workingDefinition,
      execution,
      request,
    );
    if (!validation.ok) {
      throw new GraphWorkflowRuntimeEditValidationError(validation.errors);
    }

    const nextExecution = cloneExecution(execution);

    for (const operation of request.operations) {
      if (operation.type === "add") {
        const order =
          getContextTaskOrder(nextExecution, operation.contextId) + 1;
        const taskId = resolvedDeps.createTaskId();
        nextExecution.workingDefinition.tasks.push(
          createUserTaskDefinition({
            taskId,
            contextId: operation.contextId,
            order,
            title: operation.title,
            instructions: operation.instructions,
            metadata: operation.metadata,
          }),
        );
        nextExecution.taskStates[taskId] = {
          taskId,
          contextId: operation.contextId,
          order,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
          failureHistory: [],
        };
        syncContextState(nextExecution, operation.contextId);
        continue;
      }

      if (operation.type === "update") {
        const task = getTaskDefinition(nextExecution, operation.taskId);
        if (operation.title !== undefined) {
          task.title = operation.title;
        }
        if (operation.instructions !== undefined) {
          task.instructions = operation.instructions;
        }
        if (operation.metadata === null) {
          delete task.metadata;
        } else if (operation.metadata !== undefined) {
          task.metadata = operation.metadata;
        }
        continue;
      }

      if (operation.type === "remove") {
        const task = getTaskDefinition(nextExecution, operation.taskId);
        nextExecution.workingDefinition.tasks =
          nextExecution.workingDefinition.tasks.filter(
            (entry) => entry.id !== operation.taskId,
          );
        delete nextExecution.taskStates[operation.taskId];
        setContextTaskOrder(
          nextExecution,
          task.contextId,
          getContextTasks(nextExecution, task.contextId).map(
            (entry) => entry.id,
          ),
        );
        syncContextState(nextExecution, task.contextId);
        continue;
      }

      if (operation.type === "reorder") {
        const contextTasks = getContextTasks(
          nextExecution,
          operation.contextId,
        );
        const reorderedEditableIds = [...operation.orderedTaskIds];
        const orderedIds = contextTasks.map((task) => {
          const status = nextExecution.taskStates[task.id]?.status;
          if (
            status === "completed" ||
            status === "running" ||
            status === "interrupted"
          ) {
            return task.id;
          }

          return reorderedEditableIds.shift()!;
        });
        setContextTaskOrder(nextExecution, operation.contextId, orderedIds);
        syncContextState(nextExecution, operation.contextId);
        continue;
      }

      const task = getTaskDefinition(nextExecution, operation.taskId);
      const taskState = nextExecution.taskStates[operation.taskId];
      if (!taskState) {
        throw new Error(
          `Task "${operation.taskId}" does not exist in runtime state`,
        );
      }

      if (task.contextId === operation.targetContextId) {
        const orderedIds = getContextTasks(nextExecution, task.contextId)
          .map((entry) => entry.id)
          .filter((taskId) => taskId !== operation.taskId);
        const insertIndex = Math.max(
          0,
          Math.min(operation.targetOrder - 1, orderedIds.length),
        );
        orderedIds.splice(insertIndex, 0, operation.taskId);
        setContextTaskOrder(nextExecution, task.contextId, orderedIds);
        syncContextState(nextExecution, task.contextId);
        continue;
      }

      const sourceContextId = task.contextId;
      const sourceOrderedIds = getContextTasks(nextExecution, sourceContextId)
        .map((entry) => entry.id)
        .filter((taskId) => taskId !== operation.taskId);
      const targetOrderedIds = getContextTasks(
        nextExecution,
        operation.targetContextId,
      ).map((entry) => entry.id);
      const insertIndex = Math.max(
        0,
        Math.min(operation.targetOrder - 1, targetOrderedIds.length),
      );
      targetOrderedIds.splice(insertIndex, 0, operation.taskId);

      task.contextId = operation.targetContextId;
      taskState.contextId = operation.targetContextId;

      setContextTaskOrder(nextExecution, sourceContextId, sourceOrderedIds);
      setContextTaskOrder(
        nextExecution,
        operation.targetContextId,
        targetOrderedIds,
      );
      syncContextState(nextExecution, sourceContextId);
      syncContextState(nextExecution, operation.targetContextId);
    }

    const semanticValidation = validateWorkflowDefinition(
      nextExecution.workingDefinition,
    );
    if (!semanticValidation.ok) {
      throw new GraphWorkflowRuntimeEditValidationError(
        semanticValidation.errors,
      );
    }

    return nextExecution;
  }

  return {
    applyAgentTaskAdd,
    applyUserEdits,
  };
}
