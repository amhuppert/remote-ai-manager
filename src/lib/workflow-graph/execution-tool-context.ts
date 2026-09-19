import type { GraphWorkflowExecutionRepository } from "./execution-repository";
import { unchanged } from "@/lib/workflow-graph/execution-mutation";
import { mutationValue } from "@/lib/workflow-graph/execution-mutation";

import { changed } from "@/lib/workflow-graph/execution-mutation";
import { createLogger } from "@/lib/logging";
import { StaleLoopFenceError } from "./loop-fence";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { buildLifecycleSnapshot } from "@/lib/workflow-graph/context-transitions";
import { getExecutionLogger } from "./execution-logger";
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
  assertWritable(execution: GraphWorkflowExecution, relativePath: string): void;
  /** Capture immutable bytes before the fenced registration. */
  captureContent(input: {
    executionId: string;
    worktreePath: string;
    relativePath: string;
  }): Promise<{ contentHash: string }>;
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
      contentHash: string;
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
  executionContract: GraphExecutionContract;
  now?(): string;
}

export interface CompleteTaskResult {
  execution: GraphWorkflowExecution;
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

    async function completeTask(
      taskId: string,
      summary: string,
    ): Promise<CompleteTaskResult> {
      // Diagnostics captured (pure) inside the reducer and emitted AFTER the
      // mutation commits, so the write-queue critical section performs no
      // logging I/O (`no-slow-work-in-critical-section`).

      const { execution: execution, idempotentFirstCompletedAt } =
        await deps.executionRepository
          .mutateActive(input.projectPath, input.sessionName, (draft) => {
            let idempotentFirstCompletedAt: string | null = null;

            ensureBoundContextActive(draft);

            const taskState = draft.taskStates[taskId];
            if (!taskState) {
              throw new Error(
                `Task "${taskId}" does not exist in runtime state`,
              );
            }
            if (taskState.contextId !== input.contextId) {
              throw new Error(
                `Task "${taskId}" does not belong to context "${input.contextId}"`,
              );
            }

            const conversationId = resolveConversationId(draft, taskId);

            if (taskState.status === "completed") {
              idempotentFirstCompletedAt = taskState.completedAt;
              return unchanged({
                idempotentFirstCompletedAt,
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
            return changed(draft, {
              idempotentFirstCompletedAt,
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
      return { execution };
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
      // Capture creates an immutable candidate outside the write queue. Only
      // the fenced finalize publishes its reference, so a refused mutation
      // cannot alter the bytes named by an existing registration.
      const reservation = await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (execution) => {
          ensureBoundContextActive(execution);
          deps.sharedDocumentRegistry.assertWritable(
            execution,
            document.relativePath,
          );
          return unchanged();
        })
        .then((mutation) => mutation.execution);

      const { relativePath } = await deps.sharedDocumentRegistry.prepareUpsert(
        input.executionTarget.worktreePath,
        { ...document },
      );

      const { contentHash } = await deps.sharedDocumentRegistry.captureContent({
        executionId: input.executionId,
        worktreePath: input.executionTarget.worktreePath,
        relativePath,
      });

      const { execution: execution, mergeOutcome } =
        await deps.executionRepository
          .mutateActive(input.projectPath, input.sessionName, (current) => {
            let mergeOutcome: SharedDocumentMergeOutcome | null = null;

            ensureBoundContextActive(current);
            if (current.loopEpoch !== reservation.loopEpoch) {
              throw new StaleLoopFenceError(
                {
                  projectPath: input.projectPath,
                  sessionName: input.sessionName,
                  executionId: input.executionId,
                  loopEpoch: reservation.loopEpoch,
                },
                current,
              );
            }
            const { nextExecution, outcome } =
              deps.sharedDocumentRegistry.applyUpsert(current, {
                relativePath,
                description: document.description,
                readWhen: document.readWhen,
                contentHash,
                conversationId: resolveConversationId(current),
              });
            mergeOutcome = outcome;
            return changed(nextExecution, { mergeOutcome });
          })
          .then((mutation) => ({
            execution: mutation.execution,
            ...mutationValue(mutation),
          }));

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
