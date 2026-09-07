import type { GraphWorkflowExecutionRepository } from "./execution-repository";
import {
  unchanged,
  mutationValue,
} from "@/lib/workflow-graph/execution-mutation";

import { changed } from "@/lib/workflow-graph/execution-mutation";
import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { transitionContextStatus } from "@/lib/workflow-graph/context-transitions";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type {
  ResolvedCollaborationConfig,
  WorkflowCollaborationResult,
} from "@/lib/workflow-graph/collaboration-schemas";

const logger = createLogger("graph-workflow-collaboration-coordinator");

export interface TriggerWorkflowCollaborationInput {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
  conversationId: string;
  parentImplementerTurnId: string;
  iterationIndex: number;
  brief: string;
  resolvedConfig: ResolvedCollaborationConfig;
  runCollaboration(input: TriggeredWorkflowCollaborationRun): Promise<{
    result: WorkflowCollaborationResult;
    roundsConsumed: number;
  }>;
}

export interface TriggeredWorkflowCollaborationRun {
  workflowId: string;
  brief: string;
  resolvedConfig: ResolvedCollaborationConfig;
  parentImplementerTurnId: string;
  executionContextId: string;
  conversationId: string;
  executionId: string;
  iterationIndex: number;
}

interface WorkflowCollaborationCoordinatorWorkflowManager {
  recordPendingHaltReason(input: {
    projectPath: string;
    sessionName: string;
    reason: GraphWorkflowHaltReason;
    applyAdditionalMutation?(execution: GraphWorkflowExecution): void;
  }): Promise<{ execution: GraphWorkflowExecution; accepted: boolean }>;
}

export interface WorkflowCollaborationCoordinatorDeps {
  executionRepository: Pick<GraphWorkflowExecutionRepository, "mutateActive">;
  workflowManager: WorkflowCollaborationCoordinatorWorkflowManager;
  now?(): string;
  createWorkflowId?(): string;
}

export interface WorkflowCollaborationCoordinator {
  trigger(input: TriggerWorkflowCollaborationInput): Promise<{
    workflowId: string;
  }>;
}

function getNow(deps: WorkflowCollaborationCoordinatorDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function createWorkflowId(deps: WorkflowCollaborationCoordinatorDeps): string {
  return deps.createWorkflowId?.() ?? randomUUID();
}

function buildCollaborationFailureSummary(
  result: WorkflowCollaborationResult,
): string {
  const conflictCount = result.openConflicts.length;
  const plural = conflictCount === 1 ? "conflict" : "conflicts";
  return `collaboration ended with status=${result.status}; ${conflictCount} open ${plural}`;
}

function removePendingCollaboration(
  execution: GraphWorkflowExecution,
  contextId: string,
  workflowId: string,
): boolean {
  const pending = execution.pendingCollaborations?.[contextId];
  if (!pending || pending.workflowId !== workflowId) {
    return false;
  }

  delete execution.pendingCollaborations[contextId];
  return true;
}

export function createGraphWorkflowCollaborationCoordinator(
  deps: WorkflowCollaborationCoordinatorDeps,
): WorkflowCollaborationCoordinator {
  async function completeConverged(
    input: TriggerWorkflowCollaborationInput,
    workflowId: string,
    output: { result: WorkflowCollaborationResult; roundsConsumed: number },
  ): Promise<void> {
    const completedAt = getNow(deps);
    const nextExecution = await deps.executionRepository
      .mutateActive(input.projectPath, input.sessionName, (execution) => {
        const next = structuredClone(execution);
        if (!removePendingCollaboration(next, input.contextId, workflowId)) {
          return changed(next);
        }

        next.collaborationContinuations ??= {};
        const continuations =
          next.collaborationContinuations[input.contextId] ?? [];
        next.collaborationContinuations[input.contextId] = [
          ...continuations,
          {
            workflowId,
            brief: input.brief,
            result: output.result,
            roundsConsumed: output.roundsConsumed,
            completedAt,
            deliveredAt: null,
          },
        ];

        const contextState = next.contextStates[input.contextId];
        if (contextState?.status === "running") {
          transitionContextStatus(next, input.contextId, "ready", {
            reason: "collaboration_coordinator.continuation_recorded",
          });
        }
        if (!next.activeContextIds.includes(input.contextId)) {
          next.activeContextIds = [...next.activeContextIds, input.contextId];
        }

        return changed(next);
      })
      .then((mutation) => mutation.execution);

    logger.info("graph-workflow.collaboration.completed", {
      executionId: nextExecution.id,
      contextId: input.contextId,
      workflowId,
      status: output.result.status,
      roundsConsumed: output.roundsConsumed,
    });
  }

  async function completeNonConverged(
    input: TriggerWorkflowCollaborationInput,
    workflowId: string,
    output: { result: WorkflowCollaborationResult; roundsConsumed: number },
  ): Promise<void> {
    const haltReason: GraphWorkflowHaltReason = {
      type: "collaboration_failure",
      status: output.result.status,
      brief: input.brief,
      executionContextId: input.contextId,
      conversationId: input.conversationId,
      summary: buildCollaborationFailureSummary(output.result),
    };

    const haltResult = await deps.workflowManager.recordPendingHaltReason({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      reason: haltReason,
      applyAdditionalMutation: (execution) => {
        removePendingCollaboration(execution, input.contextId, workflowId);
      },
    });

    logger.warn("graph-workflow.collaboration.non_converged", {
      executionId: haltResult.execution.id,
      contextId: input.contextId,
      workflowId,
      status: output.result.status,
      acceptedHalt: haltResult.accepted,
      roundsConsumed: output.roundsConsumed,
    });
  }

  async function failCollaboration(
    input: TriggerWorkflowCollaborationInput,
    workflowId: string,
    error: unknown,
  ): Promise<void> {
    const haltResult = await deps.workflowManager.recordPendingHaltReason({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      reason: {
        type: "recovery_error",
        message: `Collaboration workflow "${workflowId}" failed: ${getErrorMessage(error)}`,
      },
      applyAdditionalMutation: (execution) => {
        removePendingCollaboration(execution, input.contextId, workflowId);
      },
    });

    logger.error("graph-workflow.collaboration.failed", {
      executionId: haltResult.execution.id,
      contextId: input.contextId,
      workflowId,
      acceptedHalt: haltResult.accepted,
      error: getErrorMessage(error),
    });
  }

  async function runInBackground(
    input: TriggerWorkflowCollaborationInput,
    workflowId: string,
  ): Promise<void> {
    try {
      const output = await input.runCollaboration({
        workflowId,
        brief: input.brief,
        resolvedConfig: input.resolvedConfig,
        parentImplementerTurnId: input.parentImplementerTurnId,
        executionContextId: input.contextId,
        conversationId: input.conversationId,
        executionId: input.executionId,
        iterationIndex: input.iterationIndex,
      });

      if (output.result.status === "converged") {
        await completeConverged(input, workflowId, output);
        return;
      }

      await completeNonConverged(input, workflowId, output);
    } catch (error) {
      await failCollaboration(input, workflowId, error);
    }
  }

  async function trigger(input: TriggerWorkflowCollaborationInput): Promise<{
    workflowId: string;
  }> {
    const requestedWorkflowId = createWorkflowId(deps);
    const {
      execution: nextExecution,
      workflowId,
      shouldStart,
    } = await deps.executionRepository
      .mutateActive(input.projectPath, input.sessionName, (execution) => {
        let workflowId = requestedWorkflowId;
        let shouldStart = false;
        if (execution.id !== input.executionId) {
          throw new Error(
            "Session does not have the requested graph workflow execution",
          );
        }

        const next = structuredClone(execution);
        next.pendingCollaborations ??= {};
        const existing = next.pendingCollaborations[input.contextId];
        if (existing) {
          workflowId = existing.workflowId;
          return unchanged({ workflowId, shouldStart });
        }

        if (!next.contextStates[input.contextId]) {
          throw new Error(
            `Execution context "${input.contextId}" does not exist in runtime state`,
          );
        }

        next.pendingCollaborations[input.contextId] = {
          workflowId,
          contextId: input.contextId,
          conversationId: input.conversationId,
          parentImplementerTurnId: input.parentImplementerTurnId,
          brief: input.brief,
          startedAt: getNow(deps),
        };
        shouldStart = true;
        return changed(next, { workflowId, shouldStart });
      })
      .then((mutation) => ({
        execution: mutation.execution,
        ...mutationValue(mutation),
      }));

    if (!shouldStart) {
      logger.info("graph-workflow.collaboration.trigger_duplicate", {
        executionId: nextExecution.id,
        contextId: input.contextId,
        workflowId,
      });
      return { workflowId };
    }

    logger.info("graph-workflow.collaboration.triggered", {
      executionId: nextExecution.id,
      contextId: input.contextId,
      workflowId,
      conversationId: input.conversationId,
      parentImplementerTurnId: input.parentImplementerTurnId,
    });

    void runInBackground(input, workflowId).catch((error) => {
      logger.error("graph-workflow.collaboration.background_unhandled", {
        executionId: input.executionId,
        contextId: input.contextId,
        workflowId,
        error: getErrorMessage(error),
      });
    });
    return { workflowId };
  }

  return { trigger };
}
