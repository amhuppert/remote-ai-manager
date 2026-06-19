import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readConfig } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
} from "@/lib/state-store";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import { createExecutionTargetResolver } from "@/lib/workflow-graph/execution-target-resolver";
import { createGraphWorkflowExecutionToolContext } from "@/lib/workflow-graph/execution-tool-context";
import { buildImplementerCollaborationContext } from "@/lib/workflow-graph/implementer-collaboration-context";
import { coerceGlobalDefaults } from "@/lib/workflow-graph/resolve-config";
import { createGraphWorkflowRuntimeEditService } from "@/lib/workflow-graph/runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "@/lib/workflow-graph/shared-documents";
import { createSharedDocumentStore } from "@/lib/workflow-graph/shared-document-store";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { createParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";
import { createGraphWorkflowCollaborationCoordinator } from "@/lib/workflow-graph/workflow-collaboration-coordinator";
import { createWorkflowCollaboratorCaller } from "@/lib/workflow-graph/workflow-collaborator-caller";
import { createGraphWorkflowManager } from "@/lib/workflow-graph/workflow-manager";
import {
  registerGraphWorkflowExecutionTools,
  type GraphWorkflowToolServerContext,
} from "@/lib/workflow-graph/tool-server";
import { createCollaborationProductionAgentCaller } from "@/lib/workflows/collaboration/agent-caller-production";
import { decideCollaborationNextStep } from "@/lib/workflows/collaboration/policy";
import { createWorkflowCollaborationEnvelope } from "@/lib/workflows/collaboration/workflow-envelope";
import { appendCollaborationArtifact } from "@/lib/workflows/collaboration/artifacts-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createSessionLaneStoreForProduction } from "@/lib/workflows/primitives/lane-store";
import { createStatusBus } from "@/lib/workflows/primitives/status-bus";
import { publishScopedStatusEvent } from "@/lib/workflows/primitives/default-session-status-bus";
import { safeAppendTranscriptEntry } from "@/lib/prompt/transcript";
import { createSessionWorkflowEnvelopeStoreForProduction } from "@/lib/workflows/primitives/default-session-workflow-envelope-store";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import { McpRouteError } from "./route-handler";
import path from "node:path";

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
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
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
const workflowCollaborationCoordinator =
  createGraphWorkflowCollaborationCoordinator({
    workflowManager,
  });

const runtimeEditService = createGraphWorkflowRuntimeEditService();
const sharedDocumentStore = createSharedDocumentStore();
const sharedDocumentRegistry = createGraphWorkflowSharedDocumentRegistryService(
  {
    captureDocumentContent: (input) =>
      sharedDocumentStore.captureFromWorktree(input),
  },
);
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

    // Per-context collaboration overrides live on the raw workflow definition;
    // the resolved working definition used at execution time drops the
    // `collaboration` field. Load the raw definition to feed the provenance
    // cascade with the original per-node + workflow-level overrides.
    const globalConfig = await readConfig();
    const definitionRecord = await workflowStorage.get(
      projectPath,
      execution.seedDefinitionId,
    );
    const rawExecutionContext =
      definitionRecord?.definition.executionContexts.find(
        (context) => context.id === contextId,
      ) ?? {
        id: executionContext.id,
        title: executionContext.title,
        acceptanceCriteria: executionContext.acceptanceCriteria,
      };
    const rawWorkflowConfig = definitionRecord?.definition.workflowConfig ?? {};

    const iterationCount =
      execution.contextStates[contextId]?.iterationCount ?? 0;

    const collaboration = buildImplementerCollaborationContext(
      {
        projectPath,
        sessionName,
        executionId,
        contextId,
        conversationId,
        iterationIndex: iterationCount,
        globalDefaults: coerceGlobalDefaults(globalConfig.workflowDefaults),
        workflowConfig: rawWorkflowConfig,
        executionContextDefinition: rawExecutionContext,
      },
      {
        parentImplementerTurnIdFactory: () =>
          `impl-${executionId}-${contextId}-iter${iterationCount}-${randomUUID().slice(0, 8)}`,
        setPendingHaltReason: async (reason) => {
          await workflowManager.recordPendingHaltReason({
            projectPath,
            sessionName,
            reason,
          });
        },
        triggerWorkflowCollaboration: async (args) =>
          workflowCollaborationCoordinator.trigger({
            projectPath,
            sessionName,
            executionId,
            contextId,
            conversationId: args.conversationId,
            parentImplementerTurnId: args.parentImplementerTurnId,
            iterationIndex: args.iterationIndex,
            brief: args.brief,
            resolvedConfig: args.resolvedConfig,
            runCollaboration: async (run) => {
              const projectName = path.basename(projectPath);
              const sessionKey = `${projectPath}::${sessionName}`;
              const laneService = createLaneService({
                store: createSessionLaneStoreForProduction({
                  projectPath,
                  sessionName,
                }),
              });
              const agentCaller = createCollaborationProductionAgentCaller({
                workflowId: run.workflowId,
                projectPath,
                sessionName,
                worktreePath: executionTarget.worktreePath,
                sessionKey,
                originatingConversationId: run.conversationId,
                laneService,
              });
              const statusBus = createStatusBus({
                broadcast: (envelopeEvent) => {
                  const outcome = publishScopedStatusEvent({
                    scope: envelopeEvent.scope,
                    scopeId: envelopeEvent.scopeId,
                    status: envelopeEvent.status,
                    timestamp: envelopeEvent.timestamp,
                    projectName,
                    sessionName,
                    payload: envelopeEvent.payload,
                  });
                  if (!outcome.delivered) {
                    logger.warn(
                      "workflow-collab.status_bus.sse_delivery_failed",
                      {
                        scope: envelopeEvent.scope,
                        scopeId: envelopeEvent.scopeId,
                        status: envelopeEvent.status,
                      },
                    );
                  }
                },
              });
              const envelope = createWorkflowCollaborationEnvelope({
                envelopeStore: createSessionWorkflowEnvelopeStoreForProduction({
                  projectPath,
                  sessionName,
                }),
                policyDecide: decideCollaborationNextStep,
                collaboratorCaller: createWorkflowCollaboratorCaller({
                  resolvedConfig: run.resolvedConfig,
                  worktreePath: executionTarget.worktreePath,
                  brief: run.brief,
                  parentImplementerTurnId: run.parentImplementerTurnId,
                  executionContextId: run.executionContextId,
                  conversationId: run.conversationId,
                  workflowId: run.workflowId,
                  sessionKey,
                  agentCaller,
                  laneService,
                }),
                statusBus,
                appendArtifact: (workflowId, entry) =>
                  appendCollaborationArtifact(workflowId, entry),
                appendTranscriptEntry: (conversationId, entry) =>
                  safeAppendTranscriptEntry(
                    conversationId,
                    entry,
                    undefined,
                    undefined,
                    { projectName, sessionName },
                  ),
                workflowIdFactory: () => run.workflowId,
              });
              return envelope.start(run);
            },
          }),
      },
    );

    const baseContext = executionToolContextFactory.create({
      projectPath,
      sessionName,
      executionId,
      contextId,
      conversationId,
      executionTarget,
      executionContextTitle: executionContext.title,
      allowAgentTaskAdd: executionContext.mutability.allowAgentTaskAdd,
      allowAgentCollaboration: true,
      collaboration,
    });

    return {
      ...baseContext,
      getPendingHaltReason: async () => {
        const freshSession = await getSession(projectPath, sessionName);
        return freshSession?.graphWorkflowExecution?.pendingHaltReason ?? null;
      },
      getPendingToolBlock: async () => {
        const freshSession = await getSession(projectPath, sessionName);
        const pending =
          freshSession?.graphWorkflowExecution?.pendingCollaborations[
            contextId
          ] ?? null;
        if (!pending) {
          return null;
        }
        return {
          type: "pending_collaboration",
          workflowId: pending.workflowId,
          contextId,
        };
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
