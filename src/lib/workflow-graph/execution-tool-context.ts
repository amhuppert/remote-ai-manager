import type { LiveOccupancySnapshot } from "@/lib/conversations/live-occupancy";
import { createLogger } from "@/lib/logging";
import {
  evaluateContextLimit,
  type ContextLimitMetrics,
} from "@/lib/workflows/primitives/context-limit-gate";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { buildLifecycleSnapshot } from "@/lib/workflow-graph/context-transitions";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { getExecutionLogger } from "./execution-logger";
import { graphLaneContextMetrics } from "./graph-lane-store";
import type { PublishLiveEditAppliedInput } from "./execution-events";
import type { MutateActiveResult } from "./execution-repository";
import type { ExecutionTarget } from "./execution-target-resolver";
import type { AgentAddedTask } from "./runtime-edits";
import type { SharedDocumentUpsertInput } from "./shared-documents";
import type { GraphWorkflowCollaborationContextBlock } from "./lane-tool-service";

const logger = createLogger("graph-workflow-execution-tool-context");

interface GraphWorkflowExecutionToolContextRuntimeEditService {
  applyAgentTaskAdd(
    execution: GraphWorkflowExecution,
    contextId: string,
    task: AgentAddedTask,
  ): GraphWorkflowExecution;
}

interface GraphWorkflowExecutionToolContextSharedDocumentRegistry {
  upsert(
    worktreePath: string,
    execution: GraphWorkflowExecution,
    input: SharedDocumentUpsertInput,
  ): Promise<GraphWorkflowExecution>;
}

interface GraphWorkflowExecutionToolContextWorkflowManager {
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) =>
      | MutateActiveResult
      | GraphWorkflowExecution
      | Promise<MutateActiveResult | GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
}

export interface GraphWorkflowExecutionToolContextDeps {
  workflowManager: GraphWorkflowExecutionToolContextWorkflowManager;
  runtimeEditService: GraphWorkflowExecutionToolContextRuntimeEditService;
  sharedDocumentRegistry: GraphWorkflowExecutionToolContextSharedDocumentRegistry;
  publishLiveEditApplied(
    input: PublishLiveEditAppliedInput,
  ): GraphWorkflowExecutionEvent[];
  readLiveOccupancy(conversationId: string): LiveOccupancySnapshot | null;
  now?(): string;
}

/**
 * The mid-turn context-limit decision surfaced by `completeTask`. Non-null only
 * when the implementer lane was scheduled to rotate; `lane-tool-service` composes the
 * cooperative stop instruction from it. `contextTokens` is the occupancy the
 * decision used (live reading, else the lane's persisted fallback), and
 * `source` records which of those it came from.
 */
export interface CompleteTaskContextLimitStop {
  contextTokens: number | null;
  contextLimitTokens: number | null;
  compactedThisTurn: boolean;
  alreadyScheduled: boolean;
  source: "live" | "lane" | "none";
}

export interface CompleteTaskResult {
  execution: GraphWorkflowExecution;
  contextLimitStop: CompleteTaskContextLimitStop | null;
}

interface CreateGraphWorkflowExecutionToolContextInput {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
  conversationId: string;
  executionTarget: ExecutionTarget;
  executionContextTitle: string;
  allowAgentTaskAdd: boolean;
  allowAgentCollaboration: boolean;
  collaboration?: GraphWorkflowCollaborationContextBlock;
}

interface BoundGraphWorkflowExecutionToolContext {
  executionContextTitle: string;
  allowAgentTaskAdd: boolean;
  allowAgentCollaboration: boolean;
  collaboration?: GraphWorkflowCollaborationContextBlock;
  completeTask(taskId: string, summary: string): Promise<CompleteTaskResult>;
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

    /**
     * Mid-turn context-limit gate. Runs inside the completion mutation so the
     * lane flag rides the same serialized write as the task record. Reads live
     * occupancy for the resolved conversation (falling back to the lane's
     * persisted normalized occupancy), defers the rotation decision to
     * `evaluateContextLimit` (never an inline numeric comparison), and on
     * `rotation_required` sets the sticky `rotateBeforeNextTurn` flag and
     * returns the stop descriptor. Skipped when the lane is missing, the
     * policy is disabled, or the backend does not expose occupancy metrics.
     */
    function evaluateMidTurnContextLimit(
      execution: GraphWorkflowExecution,
      taskId: string,
      conversationId: string,
    ): CompleteTaskContextLimitStop | null {
      const lane = execution.laneStates[input.contextId]?.["implementer"];
      if (!lane) {
        return null;
      }

      const executionContext =
        execution.workingDefinition.executionContexts.find(
          (context) => context.id === input.contextId,
        );
      const contextLimitTokens =
        executionContext?.iterationPolicy.continuity.contextLimitTokens;
      if (contextLimitTokens === undefined) {
        return null;
      }
      const supportsContextMetrics =
        getBackendDescriptor(lane.backend).conversation?.capabilities
          .contextWindowMetrics === true;
      if (!supportsContextMetrics) {
        return null;
      }

      const live = deps.readLiveOccupancy(conversationId);
      const persisted = graphLaneContextMetrics(lane);

      let contextTokens: number | undefined;
      let source: CompleteTaskContextLimitStop["source"];
      if (live?.contextTokens != null) {
        contextTokens = live.contextTokens;
        source = "live";
      } else if (persisted.contextTokens != null) {
        contextTokens = persisted.contextTokens;
        source = "lane";
      } else {
        contextTokens = undefined;
        source = "none";
      }

      const compactedThisTurn = live?.compactedThisTurn ?? false;

      const metrics: ContextLimitMetrics = {
        backend: lane.backend,
        rotateBeforeNextTurn: lane.metrics.rotateBeforeNextTurn,
        ...(contextTokens !== undefined ? { contextTokens } : {}),
      };

      const evaluation = evaluateContextLimit({
        metrics,
        policy: { contextLimitTokens },
        compactedThisTurn,
      });

      if (evaluation !== "rotation_required") {
        return null;
      }

      const alreadyScheduled = lane.metrics.rotateBeforeNextTurn;
      lane.metrics = { ...lane.metrics, rotateBeforeNextTurn: true };
      lane.lastUsedAt = now();

      const stop: CompleteTaskContextLimitStop = {
        contextTokens: contextTokens ?? null,
        contextLimitTokens: contextLimitTokens ?? null,
        compactedThisTurn,
        alreadyScheduled,
        source,
      };

      const logPayload = {
        executionId: execution.id,
        contextId: input.contextId,
        taskId,
        conversationId,
        contextTokens: stop.contextTokens,
        contextLimitTokens: stop.contextLimitTokens,
        compactedThisTurn,
        source,
        alreadyScheduled,
      };
      logger.info("graph-workflow.context_limit.mid_turn_stop", logPayload);
      getExecutionLogger(execution.id)?.decision(
        "rotation.scheduled_mid_turn",
        logPayload,
      );

      return stop;
    }

    async function completeTask(
      taskId: string,
      summary: string,
    ): Promise<CompleteTaskResult> {
      let contextLimitStop: CompleteTaskContextLimitStop | null = null;

      const execution = await deps.workflowManager.mutateActive(
        input.projectPath,
        input.sessionName,
        (draft) => {
          ensureBoundContextActive(draft);

          const taskState = draft.taskStates[taskId];
          if (!taskState) {
            throw new Error(`Task "${taskId}" does not exist in runtime state`);
          }
          if (taskState.contextId !== input.contextId) {
            throw new Error(
              `Task "${taskId}" does not belong to context "${input.contextId}"`,
            );
          }

          const conversationId = resolveConversationId(draft, taskId);

          if (taskState.status === "completed") {
            logger.info("graph-workflow.task.completion_idempotent", {
              executionId: draft.id,
              contextId: input.contextId,
              taskId,
              firstCompletedAt: taskState.completedAt,
            });
            contextLimitStop = evaluateMidTurnContextLimit(
              draft,
              taskId,
              conversationId,
            );
            return draft;
          }

          const completedAt = now();
          taskState.status = "completed";
          taskState.summary = summary;
          taskState.completedAt = completedAt;
          taskState.lastConversationId = conversationId;
          taskState.failureMessage = null;

          const contextState = draft.contextStates[input.contextId];
          if (contextState) {
            contextState.completedTaskCount = countCompletedTasks(
              draft,
              input.contextId,
            );
          }

          draft.machineSnapshot = buildLifecycleSnapshot(draft, {
            hasLiveIteration: true,
          });
          contextLimitStop = evaluateMidTurnContextLimit(
            draft,
            taskId,
            conversationId,
          );
          return draft;
        },
      );

      return { execution, contextLimitStop };
    }

    async function addTask(
      task: AgentAddedTask,
    ): Promise<GraphWorkflowExecution> {
      return deps.workflowManager.mutateActive(
        input.projectPath,
        input.sessionName,
        (execution) => {
          ensureBoundContextActive(execution);
          const next = deps.runtimeEditService.applyAgentTaskAdd(
            execution,
            input.contextId,
            task,
          );
          // Lane-agent add_task is an accepted live edit and MUST emit the
          // mandatory graph-workflow-live-edit-applied event (doc 06 D12/D16)
          // with the server-derived `source`. The publisher broadcasts on the
          // wire; its returned rows ride this same mutation so the audit row is
          // persisted atomically (the repository extra-events path never
          // broadcasts). A single `add-task` affects exactly its target context.
          const events = deps.publishLiveEditApplied({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            executionId: next.id,
            liveRevision: next.liveRevision,
            operationCount: 1,
            affectedContextIds: [input.contextId],
            source: "lane-agent",
          });
          return { execution: next, events };
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
      allowAgentCollaboration: input.allowAgentCollaboration,
      ...(input.collaboration ? { collaboration: input.collaboration } : {}),
      completeTask,
      addTask,
      upsertSharedDocument,
    };
  }

  return { create };
}
