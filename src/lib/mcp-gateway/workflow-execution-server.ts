import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, mutateSession } from "@/lib/state";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-dispatcher";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import { createGraphWorkflowRuntimeEditService } from "@/lib/workflow-graph/runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "@/lib/workflow-graph/shared-documents";
import {
  registerGraphWorkflowExecutionTools,
  type GraphWorkflowToolServerContext,
} from "@/lib/workflows/graph-workflow/tool-server";
import type { GraphWorkflowExecution } from "@/types";
import { McpRouteError } from "./route-handler";

const logger = createLogger("workflow-execution-server");

export interface WorkflowExecutionMcpServerParams {
  name: string;
  session: string;
  executionId: string;
  contextId: string;
}

export interface WorkflowExecutionMcpServerDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  loadExecutionContext(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<GraphWorkflowToolServerContext | null>;
  registerGraphWorkflowExecutionTools(
    server: McpServer,
    context: GraphWorkflowToolServerContext,
  ): void;
}

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
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
    activeContextId: execution.activeContextId,
    recoveryMode: "none" as const,
    hasLiveIteration: true,
  };
}

function resolveConversationId(
  execution: GraphWorkflowExecution,
  taskId?: string,
): string {
  const direct = taskId
    ? execution.taskStates[taskId]?.lastConversationId
    : null;
  const fallback =
    Object.values(execution.taskStates).find(
      (taskState) =>
        taskState.contextId === execution.activeContextId &&
        taskState.lastConversationId,
    )?.lastConversationId ?? null;
  const resolved = direct ?? fallback;
  if (!resolved) {
    throw new Error(
      "Workflow execution tool call is not bound to an active agent conversation",
    );
  }
  return resolved;
}

const eventPublisher = createGraphWorkflowExecutionEventPublisher({
  dispatchPush: dispatchPushForGraphWorkflowEvent,
});

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession,
  mutateSession,
  eventPublisher,
});

const runtimeEditService = createGraphWorkflowRuntimeEditService();
const sharedDocumentRegistry =
  createGraphWorkflowSharedDocumentRegistryService();

const defaultWorkflowExecutionMcpServerDeps: WorkflowExecutionMcpServerDeps = {
  resolveProjectPath,
  async loadExecutionContext(projectPath, sessionName, executionId, contextId) {
    const session = await getSession(projectPath, sessionName);
    if (!session) {
      throw new McpRouteError(404, "Session not found");
    }

    const execution = session.graphWorkflowExecution;
    if (!execution || execution.id !== executionId) {
      return null;
    }

    const executionContext = execution.workingDefinition.executionContexts.find(
      (context) => context.id === contextId,
    );
    if (!executionContext) {
      return null;
    }

    return {
      executionContextTitle: executionContext.title,
      allowAgentTaskAdd: executionContext.mutability.allowAgentTaskAdd,
      async completeTask(taskId, summary) {
        const preValidationExecution = await executionRepository.getActive(
          projectPath,
          sessionName,
        );
        if (
          !preValidationExecution ||
          preValidationExecution.id !== executionId
        ) {
          throw new Error(
            "Session does not have the requested graph workflow execution",
          );
        }

        const taskStateBeforeValidation =
          preValidationExecution.taskStates[taskId];
        if (taskStateBeforeValidation?.status === "completed") {
          logger.info("graph-workflow.task.completion_idempotent", {
            executionId: preValidationExecution.id,
            contextId,
            taskId,
            firstCompletedAt: taskStateBeforeValidation.completedAt,
          });
          return preValidationExecution;
        }

        const conversationId = resolveConversationId(
          preValidationExecution,
          taskId,
        );
        const nextExecution = cloneExecution(preValidationExecution);
        const taskState = nextExecution.taskStates[taskId];
        if (!taskState) {
          throw new Error(`Task "${taskId}" does not exist in runtime state`);
        }
        if (taskState.contextId !== contextId) {
          throw new Error(
            `Task "${taskId}" does not belong to context "${contextId}"`,
          );
        }
        if (taskState.status === "completed") {
          throw new Error(`Task "${taskId}" is already completed`);
        }

        const contextState = nextExecution.contextStates[taskState.contextId];
        if (!contextState) {
          throw new Error(
            `Execution context "${taskState.contextId}" does not exist in runtime state`,
          );
        }

        taskState.status = "completed";
        taskState.summary = summary;
        taskState.completedAt = new Date().toISOString();
        taskState.lastConversationId = conversationId;
        taskState.failureMessage = null;
        contextState.completedTaskCount = countCompletedTasks(
          nextExecution,
          taskState.contextId,
        );
        nextExecution.machineSnapshot = buildMachineSnapshot(nextExecution);

        await executionRepository.update(
          projectPath,
          sessionName,
          nextExecution,
        );
        return nextExecution;
      },
      async addTask(task) {
        const activeExecution = await executionRepository.getActive(
          projectPath,
          sessionName,
        );
        if (!activeExecution || activeExecution.id !== executionId) {
          throw new Error(
            "Session does not have the requested graph workflow execution",
          );
        }

        const updated = runtimeEditService.applyAgentTaskAdd(
          activeExecution,
          contextId,
          task,
        );
        await executionRepository.update(projectPath, sessionName, updated);
        return updated;
      },
      async upsertSharedDocument(document) {
        const activeSession = await getSession(projectPath, sessionName);
        if (!activeSession) {
          throw new Error("Session not found");
        }

        const activeExecution = await executionRepository.getActive(
          projectPath,
          sessionName,
        );
        if (!activeExecution || activeExecution.id !== executionId) {
          throw new Error(
            "Session does not have the requested graph workflow execution",
          );
        }

        const updated = sharedDocumentRegistry.upsert(
          activeSession.worktreePath,
          activeExecution,
          {
            ...document,
            conversationId: resolveConversationId(activeExecution),
          },
        );
        await executionRepository.update(projectPath, sessionName, updated);
        return updated;
      },
    };
  },
  registerGraphWorkflowExecutionTools,
};

export async function createWorkflowExecutionMcpServer(
  params: WorkflowExecutionMcpServerParams,
  deps: WorkflowExecutionMcpServerDeps = defaultWorkflowExecutionMcpServerDeps,
): Promise<McpServer> {
  const projectPath = await deps.resolveProjectPath(params.name);
  if (!projectPath) {
    throw new McpRouteError(404, "Project not found");
  }

  const context = await deps.loadExecutionContext(
    projectPath,
    params.session,
    params.executionId,
    params.contextId,
  );
  if (!context) {
    throw new McpRouteError(404, "Workflow execution context not found");
  }

  const server = new McpServer({
    name: "cc-graph-workflow",
    version: "1.0.0",
  });
  deps.registerGraphWorkflowExecutionTools(server, context);
  return server;
}
