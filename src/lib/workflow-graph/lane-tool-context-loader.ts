import { randomUUID } from "node:crypto";
import path from "node:path";
import { readConfig } from "@/lib/config/loader";
import { readLiveOccupancy } from "@/lib/conversations/live-occupancy";
import { createLogger } from "@/lib/logging";
import {
  getSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
} from "@/lib/state-store";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import { createExecutionTargetResolver } from "@/lib/workflow-graph/execution-target-resolver";
import { createGraphWorkflowExecutionToolContext } from "@/lib/workflow-graph/execution-tool-context";
import { createRegisteredGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { buildImplementerCollaborationContext } from "@/lib/workflow-graph/implementer-collaboration-context";
import { resolveLaneToolCollaborationConfig } from "@/lib/workflow-graph/lane-collaboration-resolver";
import { coerceGlobalDefaults } from "@/lib/workflow-graph/resolve-config";
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "@/lib/workflow-graph/constants";
import { createGraphWorkflowRuntimeEditService } from "@/lib/workflow-graph/runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "@/lib/workflow-graph/shared-documents";
import { createSharedDocumentStore } from "@/lib/workflow-graph/shared-document-store";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { scopeForTier } from "@/lib/workflow-graph/template-library-service";
import { createParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";
import { createGraphWorkflowCollaborationCoordinator } from "@/lib/workflow-graph/workflow-collaboration-coordinator";
import { createWorkflowCollaboratorCaller } from "@/lib/workflow-graph/workflow-collaborator-caller";
import { createGraphWorkflowManager } from "@/lib/workflow-graph/workflow-manager";
import type { GraphWorkflowToolServerContext } from "@/lib/workflow-graph/lane-tool-service";
import { createCollaborationProductionAgentCaller } from "@/lib/workflows/collaboration/agent-caller-production";
import { decideCollaborationNextStep } from "@/lib/workflows/collaboration/policy";
import { createWorkflowCollaborationEnvelope } from "@/lib/workflows/collaboration/workflow-envelope";
import { appendCollaborationArtifact } from "@/lib/workflows/collaboration/artifacts-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createSessionLaneStoreForProduction } from "@/lib/workflows/primitives/lane-store";
import { createStatusBus } from "@/lib/events/status-bus";
import { publishScopedStatus } from "@/lib/events/publication";
import { safeAppendTranscriptEntry } from "@/lib/prompt/transcript";
import { createSessionWorkflowEnvelopeStoreForProduction } from "@/lib/workflows/primitives/default-session-workflow-envelope-store";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * Production loader for the graph-workflow lane tool context — the single
 * wiring of `completeTask`/`addTask`/`upsertSharedDocument`/collaboration plus
 * the pre-dispatch halt inspection that the token-gated lane HTTP endpoints
 * (`lane-route-handlers.ts`) consume. This is the "halt-check logic relocated
 * per §4" step of the CLI migration decommission plan.
 */

const logger = createLogger("graph-workflow-lane-tool-context-loader");

/**
 * The conversation an in-flight lane tool call is bound to: the running task's
 * `lastConversationId` where one exists, else any running task's, else the
 * lane's `workflowConversationId`. `null` when nothing in the context is live.
 */
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

/**
 * The runtime state a halted lane needs to compute reminders (doc 04 §6): the
 * halt-path handler has no post-mutation execution to read from, so the loader
 * snapshots the pre-halt iteration/threshold/remaining figures alongside the
 * context. The success path reads the freshest values off the returned
 * execution instead (`lane-route-handlers.ts` completeTask).
 */
export interface LaneReminderState {
  iterationCount: number;
  circuitBreakerThreshold: number;
  remainingTaskCount: number;
}

export type LoadLaneToolContextResult =
  | {
      ok: true;
      context: GraphWorkflowToolServerContext;
      reminderState: LaneReminderState;
    }
  | { ok: false; status: number; error: string };

const eventPublisher = createGraphWorkflowExecutionEventPublisher({
  dispatchPush: dispatchPushForGraphWorkflowEvent,
});

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  eventPublisher,
});

const workflowStorage = createWorkflowStorageService();
const workflowManager = createGraphWorkflowManager({
  executionRepository,
  loadDefinition: (projectPath, definitionId, tier) =>
    workflowStorage.get(scopeForTier(tier, projectPath), definitionId),
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
  publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
  readLiveOccupancy: (conversationId) => readLiveOccupancy(conversationId),
  executionContract: createRegisteredGraphExecutionContract(),
});

/**
 * Resolve the fully-wired lane tool context for one active execution context,
 * or a status/error describing why it is unavailable (404 execution/context
 * not found, 409 no live agent conversation). Returned context carries the
 * production `getPendingHaltReason`/`getPendingToolBlock` closures so callers
 * can run the pre-dispatch halt check before any mutation.
 */
export async function loadGraphWorkflowLaneToolContext(
  projectPath: string,
  sessionName: string,
  executionId: string,
  contextId: string,
): Promise<LoadLaneToolContextResult> {
  const session = await getSession(projectPath, sessionName);
  if (!session) {
    return { ok: false, status: 404, error: "Session not found" };
  }

  const execution = await getActiveGraphWorkflowExecution(
    projectPath,
    sessionName,
  );
  if (!execution || execution.id !== executionId) {
    return {
      ok: false,
      status: 404,
      error: "Workflow execution context not found",
    };
  }

  const executionContext = execution.workingDefinition.executionContexts.find(
    (context) => context.id === contextId,
  );
  if (!executionContext) {
    return {
      ok: false,
      status: 404,
      error: "Workflow execution context not found",
    };
  }

  const conversationId = resolveBoundConversationId(execution, contextId);
  if (!conversationId) {
    logger.warn("graph-workflow.tool_context.bind_missing_conversation", {
      executionId,
      contextId,
    });
    return {
      ok: false,
      status: 409,
      error: "Workflow execution context has no active agent conversation",
    };
  }

  const executionTarget = executionTargetResolver.resolve({
    execution,
    contextId,
    session,
  });

  const contextState = execution.contextStates[contextId];
  const iterationCount = contextState?.iterationCount ?? 0;
  const circuitBreakerThreshold =
    executionContext.circuitBreaker.consecutiveFailureThreshold ??
    DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;
  const remainingTaskCount = contextState
    ? Math.max(0, contextState.totalTaskCount - contextState.completedTaskCount)
    : 0;

  // Prefer the collaboration config frozen on the execution's working copy at
  // seed time so a saved-definition edit cannot leak into a running execution
  // (doc 06, D11). Only pre-field executions with no snapshot fall back to
  // reloading the raw saved definition to feed the provenance cascade with the
  // original per-node + workflow-level overrides.
  const resolvedCollaboration = await resolveLaneToolCollaborationConfig(
    executionContext,
    {
      loadFallbackInputs: async () => {
        const globalConfig = await readConfig();
        const definitionRecord = await workflowStorage.get(
          scopeForTier(execution.launchedTier, projectPath),
          execution.seedDefinitionId,
        );
        const contextDefinition =
          definitionRecord?.definition.executionContexts.find(
            (context) => context.id === contextId,
          ) ?? {
            id: executionContext.id,
            title: executionContext.title,
            acceptanceCriteria: executionContext.acceptanceCriteria,
          };
        return {
          globalDefaults: coerceGlobalDefaults(globalConfig.workflowDefaults),
          workflowConfig: definitionRecord?.definition.workflowConfig ?? {},
          contextDefinition,
        };
      },
    },
  );

  const allowAgentCollaboration = resolvedCollaboration.enabled.value;
  const collaboration = buildImplementerCollaborationContext(
    {
      projectPath,
      sessionName,
      executionId,
      contextId,
      conversationId,
      iterationIndex: iterationCount,
      resolvedCollaboration,
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
                const outcome = publishScopedStatus({
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
    allowAgentCollaboration,
    ...(allowAgentCollaboration ? { collaboration } : {}),
  });

  return {
    ok: true,
    reminderState: {
      iterationCount,
      circuitBreakerThreshold,
      remainingTaskCount,
    },
    context: {
      ...baseContext,
      getPendingHaltReason: async () => {
        const freshExecution = await getActiveGraphWorkflowExecution(
          projectPath,
          sessionName,
        );
        return freshExecution?.pendingHaltReason ?? null;
      },
      getPendingToolBlock: async () => {
        const freshExecution = await getActiveGraphWorkflowExecution(
          projectPath,
          sessionName,
        );
        const pending =
          freshExecution?.pendingCollaborations[contextId] ?? null;
        if (!pending) {
          return null;
        }
        return {
          type: "pending_collaboration",
          workflowId: pending.workflowId,
          contextId,
        };
      },
    },
  };
}
