import { createLogger } from "@/lib/logging";
import type { GraphWorkflowExecution } from "@/types";
import type { ExecutionTarget } from "./execution-target-resolver";
import type { AgentAddedTask } from "./runtime-edits";
import type { SharedDocumentUpsertInput } from "./shared-documents";

const logger = createLogger("graph-workflow-execution-tool-context");

export interface GraphWorkflowExecutionToolContextRuntimeEditService {
  applyAgentTaskAdd(
    execution: GraphWorkflowExecution,
    contextId: string,
    task: AgentAddedTask,
  ): GraphWorkflowExecution;
}

export interface GraphWorkflowExecutionToolContextSharedDocumentRegistry {
  upsert(
    worktreePath: string,
    execution: GraphWorkflowExecution,
    input: SharedDocumentUpsertInput,
  ): Promise<GraphWorkflowExecution>;
}

export interface GraphWorkflowExecutionToolContextWorkflowManager {
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
}

export interface GraphWorkflowExecutionToolContextDeps {
  workflowManager: GraphWorkflowExecutionToolContextWorkflowManager;
  runtimeEditService: GraphWorkflowExecutionToolContextRuntimeEditService;
  sharedDocumentRegistry: GraphWorkflowExecutionToolContextSharedDocumentRegistry;
  now?(): string;
}

export interface CreateGraphWorkflowExecutionToolContextInput {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
  conversationId: string;
  executionTarget: ExecutionTarget;
  executionContextTitle: string;
  allowAgentTaskAdd: boolean;
}

export interface BoundGraphWorkflowExecutionToolContext {
  executionContextTitle: string;
  allowAgentTaskAdd: boolean;
  completeTask(
    taskId: string,
    summary: string,
  ): Promise<GraphWorkflowExecution>;
  addTask(task: AgentAddedTask): Promise<GraphWorkflowExecution>;
  upsertSharedDocument(
    document: Omit<SharedDocumentUpsertInput, "conversationId">,
  ): Promise<GraphWorkflowExecution>;
}

export interface GraphWorkflowExecutionToolContextFactory {
  create(
    input: CreateGraphWorkflowExecutionToolContextInput,
  ): BoundGraphWorkflowExecutionToolContext;
}

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

function buildMachineSnapshot(execution: GraphWorkflowExecution) {
  return {
    schemaVersion: 1,
    lifecycleStatus: execution.status,
    activeContextId: execution.activeContextIds[0] ?? null,
    recoveryMode: "none" as const,
    hasLiveIteration: true,
  };
}

export function createGraphWorkflowExecutionToolContext(
  deps: GraphWorkflowExecutionToolContextDeps,
): GraphWorkflowExecutionToolContextFactory {
  const now = deps.now ?? (() => new Date().toISOString());

  function create(
    input: CreateGraphWorkflowExecutionToolContextInput,
  ): BoundGraphWorkflowExecutionToolContext {
    function ensureBoundContextActive(execution: GraphWorkflowExecution): void {
      if (execution.id !== input.executionId) {
        throw new Error(
          "Session does not have the requested graph workflow execution",
        );
      }
      if (!execution.activeContextIds.includes(input.contextId)) {
        throw new Error(
          `Execution context "${input.contextId}" is no longer in the active set`,
        );
      }
      const contextState = execution.contextStates[input.contextId];
      if (!contextState) {
        throw new Error(
          `Execution context "${input.contextId}" does not exist in runtime state`,
        );
      }
      if (contextState.status !== "running") {
        throw new Error(
          `Execution context "${input.contextId}" is not running`,
        );
      }
    }

    function resolveConversationId(
      execution: GraphWorkflowExecution,
      taskId?: string,
    ): string {
      if (taskId) {
        const direct = execution.taskStates[taskId]?.lastConversationId;
        if (direct) {
          return direct;
        }
      }

      for (const taskState of Object.values(execution.taskStates)) {
        if (taskState.contextId !== input.contextId) {
          continue;
        }
        if (taskState.status !== "running") {
          continue;
        }
        if (taskState.lastConversationId) {
          return taskState.lastConversationId;
        }
      }

      return input.conversationId;
    }

    async function completeTask(
      taskId: string,
      summary: string,
    ): Promise<GraphWorkflowExecution> {
      return deps.workflowManager.mutateActive(
        input.projectPath,
        input.sessionName,
        (execution) => {
          ensureBoundContextActive(execution);

          const taskState = execution.taskStates[taskId];
          if (!taskState) {
            throw new Error(`Task "${taskId}" does not exist in runtime state`);
          }
          if (taskState.contextId !== input.contextId) {
            throw new Error(
              `Task "${taskId}" does not belong to context "${input.contextId}"`,
            );
          }

          if (taskState.status === "completed") {
            logger.info("graph-workflow.task.completion_idempotent", {
              executionId: execution.id,
              contextId: input.contextId,
              taskId,
              firstCompletedAt: taskState.completedAt,
            });
            return execution;
          }

          const conversationId = resolveConversationId(execution, taskId);
          const completedAt = now();
          taskState.status = "completed";
          taskState.summary = summary;
          taskState.completedAt = completedAt;
          taskState.lastConversationId = conversationId;
          taskState.failureMessage = null;

          const contextState = execution.contextStates[input.contextId];
          if (contextState) {
            contextState.completedTaskCount = countCompletedTasks(
              execution,
              input.contextId,
            );
          }

          execution.machineSnapshot = buildMachineSnapshot(execution);
          return execution;
        },
      );
    }

    async function addTask(
      task: AgentAddedTask,
    ): Promise<GraphWorkflowExecution> {
      return deps.workflowManager.mutateActive(
        input.projectPath,
        input.sessionName,
        (execution) => {
          ensureBoundContextActive(execution);
          return deps.runtimeEditService.applyAgentTaskAdd(
            execution,
            input.contextId,
            task,
          );
        },
      );
    }

    async function upsertSharedDocument(
      document: Omit<SharedDocumentUpsertInput, "conversationId">,
    ): Promise<GraphWorkflowExecution> {
      return deps.workflowManager.mutateActive(
        input.projectPath,
        input.sessionName,
        async (execution) => {
          ensureBoundContextActive(execution);
          return deps.sharedDocumentRegistry.upsert(
            input.executionTarget.worktreePath,
            execution,
            {
              ...document,
              conversationId: resolveConversationId(execution),
            },
          );
        },
      );
    }

    return {
      executionContextTitle: input.executionContextTitle,
      allowAgentTaskAdd: input.allowAgentTaskAdd,
      completeTask,
      addTask,
      upsertSharedDocument,
    };
  }

  return { create };
}
