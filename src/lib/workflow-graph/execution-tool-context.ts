import type { GraphWorkflowExecutionRepository } from "./execution-repository";
import { unchanged } from "@/lib/workflow-graph/execution-mutation";
import { mutationValue } from "@/lib/workflow-graph/execution-mutation";

import { changed } from "@/lib/workflow-graph/execution-mutation";
import type { LiveOccupancySnapshot } from "@/lib/conversations/live-occupancy";
import { createLogger } from "@/lib/logging";
import {
  evaluateContextLimit,
  type ContextLimitMetrics,
} from "@/lib/workflows/primitives/context-limit-gate";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { buildLifecycleSnapshot } from "@/lib/workflow-graph/context-transitions";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { getExecutionLogger } from "./execution-logger";
import { graphLaneContextMetrics } from "./graph-lane-store";
import type {
  GraphWorkflowEventDelivery,
  PublishLiveEditAppliedInput,
} from "./execution-events";

import type { ExecutionTarget } from "./execution-target-resolver";
import type { AgentAddedTask, AgentTaskAddResult } from "./runtime-edits";
import type {
  SharedDocumentMergeOutcome,
  SharedDocumentUpsertInput,
} from "./shared-documents";
import type { GraphWorkflowCollaborationContextBlock } from "./lane-tool-service";
import {
  assertGraphExecutionContractAccepted,
  type GraphExecutionContract,
  type LoadedGraphExecutionLiveEditContract,
} from "./execution-contract-port";

const logger = createLogger("graph-workflow-execution-tool-context");

interface GraphWorkflowExecutionToolContextRuntimeEditService {
  applyAgentTaskAdd(
    execution: GraphWorkflowExecution,
    contextId: string,
    task: AgentAddedTask,
    executionContract: LoadedGraphExecutionLiveEditContract,
  ): AgentTaskAddResult;
}

interface GraphWorkflowExecutionToolContextSharedDocumentRegistry {
  /** Resolve + validate the canonical path (async, no durable I/O). */
  prepareUpsert(
    worktreePath: string,
    input: SharedDocumentUpsertInput,
  ): Promise<{ relativePath: string }>;
  /** Best-effort slow content capture; never throws. */
  captureContent(input: {
    executionId: string;
    worktreePath: string;
    relativePath: string;
  }): Promise<void>;
  /**
   * Pure, synchronous merge of the resolved entry into the execution, returning
   * the next execution and the inert merge outcome (logged post-commit).
   */
  applyUpsert(
    execution: GraphWorkflowExecution,
    input: {
      relativePath: string;
      description: string;
      readWhen: string;
      conversationId: string | null;
    },
  ): {
    nextExecution: GraphWorkflowExecution;
    outcome: SharedDocumentMergeOutcome;
  };
  /** Emit the registration log for a completed merge, after finalize commits. */
  logUpsert(executionId: string, outcome: SharedDocumentMergeOutcome): void;
}

export interface GraphWorkflowExecutionToolContextDeps {
  executionRepository: Pick<GraphWorkflowExecutionRepository, "mutateActive">;
  runtimeEditService: GraphWorkflowExecutionToolContextRuntimeEditService;
  sharedDocumentRegistry: GraphWorkflowExecutionToolContextSharedDocumentRegistry;
  publishLiveEditApplied(
    input: PublishLiveEditAppliedInput,
  ): GraphWorkflowEventDelivery;
  readLiveOccupancy(conversationId: string): LiveOccupancySnapshot | null;
  executionContract: GraphExecutionContract;
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
  const executionContract = deps.executionContract;

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

      // Purely computational inside the write-queue critical section: the
      // rotation decision is recorded on the draft, but its observability log
      // (a file write) is emitted by `completeTask` AFTER the mutation commits
      // (`no-slow-work-in-critical-section`).
      return stop;
    }

    async function completeTask(
      taskId: string,
      summary: string,
    ): Promise<CompleteTaskResult> {
      // Diagnostics captured (pure) inside the reducer and emitted AFTER the
      // mutation commits, so the write-queue critical section performs no
      // logging I/O (`no-slow-work-in-critical-section`).

      const {
        execution: execution,
        resolvedConversationId,
        idempotentFirstCompletedAt,
        contextLimitStop,
      } = await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (draft) => {
          let contextLimitStop: CompleteTaskContextLimitStop | null = null;
          let resolvedConversationId = input.conversationId;
          let idempotentFirstCompletedAt: string | null = null;

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
          resolvedConversationId = conversationId;

          if (taskState.status === "completed") {
            idempotentFirstCompletedAt = taskState.completedAt;
            contextLimitStop = evaluateMidTurnContextLimit(
              draft,
              conversationId,
            );
            if (contextLimitStop === null || contextLimitStop.alreadyScheduled)
              return unchanged({
                resolvedConversationId,
                idempotentFirstCompletedAt,
                contextLimitStop,
              });
            return changed(draft, {
              resolvedConversationId,
              idempotentFirstCompletedAt,
              contextLimitStop,
            });
          }

          assertGraphExecutionContractAccepted(
            executionContract.validateTaskCompletion(draft, taskId),
          );

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
          contextLimitStop = evaluateMidTurnContextLimit(draft, conversationId);
          return changed(draft, {
            resolvedConversationId,
            idempotentFirstCompletedAt,
            contextLimitStop,
          });
        })
        .then((mutation) => ({
          execution: mutation.execution,
          ...mutationValue(mutation),
        }));

      // Post-commit diagnostics (file writes) — outside the critical section.
      if (idempotentFirstCompletedAt !== null) {
        logger.info("graph-workflow.task.completion_idempotent", {
          executionId: execution.id,
          contextId: input.contextId,
          taskId,
          firstCompletedAt: idempotentFirstCompletedAt,
        });
      }
      if (contextLimitStop !== null) {
        const stop: CompleteTaskContextLimitStop = contextLimitStop;
        const logPayload = {
          executionId: execution.id,
          contextId: input.contextId,
          taskId,
          conversationId: resolvedConversationId,
          contextTokens: stop.contextTokens,
          contextLimitTokens: stop.contextLimitTokens,
          compactedThisTurn: stop.compactedThisTurn,
          source: stop.source,
          alreadyScheduled: stop.alreadyScheduled,
        };
        logger.info("graph-workflow.context_limit.mid_turn_stop", logPayload);
        getExecutionLogger(execution.id)?.decision(
          "rotation.scheduled_mid_turn",
          logPayload,
        );
      }

      return { execution, contextLimitStop };
    }

    async function addTask(
      task: AgentAddedTask,
    ): Promise<GraphWorkflowExecution> {
      // Observability captured (pure) inside the reducer and emitted AFTER the
      // mutation commits, so the write-queue critical section performs no
      // logging I/O (`no-slow-work-in-critical-section`). The mutation returns
      // the task details needed by post-commit observability.

      const { execution: execution, addedBox } = await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (current) => {
          const addedBox: { value: AgentTaskAddResult["added"] | null } = {
            value: null,
          };

          const liveEditContract = executionContract.loadLiveEdit(current);
          ensureBoundContextActive(current);
          const applied = deps.runtimeEditService.applyAgentTaskAdd(
            current,
            input.contextId,
            task,
            liveEditContract,
          );
          addedBox.value = applied.added;
          // Lane-agent add_task is an accepted live edit and MUST emit the
          // mandatory graph-workflow-live-edit-applied event (doc 06 D12/D16)
          // with the server-derived `source`. Its rows ride this same mutation
          // so the audit row is persisted atomically; the mutation seam
          // broadcasts the wire signal after the append commits. A single
          // `add-task` affects exactly its target context.
          const delivery = deps.publishLiveEditApplied({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            executionId: applied.execution.id,
            liveRevision: applied.execution.liveRevision,
            operationCount: 1,
            affectedContextIds: [input.contextId],
            source: "lane-agent",
          });
          return changed(applied.execution, { addedBox }, { ...delivery });
        })
        .then((mutation) => ({
          execution: mutation.execution,
          ...mutationValue(mutation),
        }));

      // Post-commit observability (file I/O) — outside the critical section.
      const added = addedBox.value;
      if (added !== null) {
        getExecutionLogger(added.executionId)?.task(
          added.contextId,
          "task.added_by_agent",
          {
            taskId: added.taskId,
            title: added.title,
            instructionsLength: added.instructionsLength,
          },
        );
        logger.info("graph-workflow.task.added_by_agent", {
          executionId: added.executionId,
          contextId: added.contextId,
          taskId: added.taskId,
          title: added.title,
        });
      }

      return execution;
    }

    async function upsertSharedDocument(
      document: Omit<SharedDocumentUpsertInput, "conversationId">,
    ): Promise<GraphWorkflowExecution> {
      // Staged protocol (Design 3.1) with a genuine reserve→work→finalize order
      // and no side effect a refused finalize would have to compensate for:
      //
      //  1. RESERVE — a short sync mutation that pins the loop fence and checks
      //     the bound context is still active/running. A stale or invalid
      //     request is rejected HERE, before any path resolution or capture, so
      //     it can never resolve a path or touch the central store.
      //  2. Slow canonical-path resolution OUTSIDE the write queue (no durable
      //     I/O; surfaces an escaping/invalid path before the finalize).
      //  3. FINALIZE — a short sync mutation that re-pins the fence, re-checks
      //     the context, and merges the entry. Pure (no logging).
      //  4. Best-effort content capture runs AFTER the finalize COMMITS. Placing
      //     the only durable side effect after the commit means a refused
      //     finalize (superseded fence / deactivated context) captures nothing —
      //     there is no orphaned central-store write to restore or remove.
      await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (execution) => {
          ensureBoundContextActive(execution);
          return unchanged();
        })
        .then((mutation) => mutation.execution);

      const { relativePath } = await deps.sharedDocumentRegistry.prepareUpsert(
        input.executionTarget.worktreePath,
        { ...document },
      );

      const { execution: execution, mergeOutcome } =
        await deps.executionRepository
          .mutateActive(input.projectPath, input.sessionName, (current) => {
            let mergeOutcome: SharedDocumentMergeOutcome | null = null;

            ensureBoundContextActive(current);
            const { nextExecution, outcome } =
              deps.sharedDocumentRegistry.applyUpsert(current, {
                relativePath,
                description: document.description,
                readWhen: document.readWhen,
                conversationId: resolveConversationId(current),
              });
            mergeOutcome = outcome;
            return changed(nextExecution, { mergeOutcome });
          })
          .then((mutation) => ({
            execution: mutation.execution,
            ...mutationValue(mutation),
          }));

      // Post-commit: capture content and emit the registration log — both file
      // I/O, kept out of the write-queue critical section.
      await deps.sharedDocumentRegistry.captureContent({
        executionId: input.executionId,
        worktreePath: input.executionTarget.worktreePath,
        relativePath,
      });
      if (mergeOutcome !== null) {
        deps.sharedDocumentRegistry.logUpsert(execution.id, mergeOutcome);
      }

      return execution;
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
