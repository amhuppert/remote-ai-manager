import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession, mutateSession } from "@/lib/state-store";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import { createExecutionTargetResolver } from "@/lib/workflow-graph/execution-target-resolver";
import { createGraphWorkflowExecutionToolContext } from "@/lib/workflow-graph/execution-tool-context";
import { createGraphWorkflowRuntimeEditService } from "@/lib/workflow-graph/runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "@/lib/workflow-graph/shared-documents";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { createParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";
import { createGraphWorkflowManager } from "@/lib/workflow-graph/workflow-manager";
import {
  registerGraphWorkflowExecutionTools,
  type GraphWorkflowToolServerContext,
} from "@/lib/workflow-graph/tool-server";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
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

export function resolveBoundConversationId(
  execution: GraphWorkflowExecution,
  contextId: string,
): string | null {
  for (const taskState of Object.values(execution.taskStates)) {
    if (taskState.contextId !== contextId) {
      continue;
    }
    if (taskState.status !== "running") {
      continue;
    }
    if (taskState.lastConversationId) {
      return taskState.lastConversationId;
    }
  }

  const laneByKind = execution.laneStates[contextId];
  if (laneByKind) {
    for (const lane of Object.values(laneByKind)) {
      if (lane.workflowConversationId) {
        return lane.workflowConversationId;
      }
    }
  }

  return null;
}

const eventPublisher = createGraphWorkflowExecutionEventPublisher({
  dispatchPush: dispatchPushForGraphWorkflowEvent,
});

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession,
  mutateSession,
  eventPublisher,
});

const workflowStorage = createWorkflowStorageService();
const workflowManager = createGraphWorkflowManager({
  executionRepository,
  loadDefinition: (projectPath, definitionId) =>
    workflowStorage.get(projectPath, definitionId),
  parallelWorktrees: createParallelWorktrees(),
  getSession,
});

const runtimeEditService = createGraphWorkflowRuntimeEditService();
const sharedDocumentRegistry =
  createGraphWorkflowSharedDocumentRegistryService();
const executionTargetResolver = createExecutionTargetResolver();
const executionToolContextFactory = createGraphWorkflowExecutionToolContext({
  workflowManager,
  runtimeEditService,
  sharedDocumentRegistry,
});

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

    const conversationId = resolveBoundConversationId(execution, contextId);
    if (!conversationId) {
      logger.warn("graph-workflow.tool_context.bind_missing_conversation", {
        executionId,
        contextId,
      });
      throw new McpRouteError(
        409,
        "Workflow execution context has no active agent conversation",
      );
    }

    const executionTarget = executionTargetResolver.resolve({
      execution,
      contextId,
      session,
    });

    return executionToolContextFactory.create({
      projectPath,
      sessionName,
      executionId,
      contextId,
      conversationId,
      executionTarget,
      executionContextTitle: executionContext.title,
      allowAgentTaskAdd: executionContext.mutability.allowAgentTaskAdd,
    });
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
