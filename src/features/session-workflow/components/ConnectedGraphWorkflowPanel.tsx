"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useGraphWorkflowEventsQuery,
  useGraphWorkflowExecutionQuery,
  useGraphWorkflowHistoryQuery,
  useWorkflowDefinitionQuery,
} from "@/lib/workflows/queries";
import {
  useAbortGraphWorkflowMutation,
  useApproveGraphWorkflowDefinitionMutation,
  useClearGraphWorkflowMutation,
  usePauseGraphWorkflowMutation,
  useResetExecutionContextAssignmentMutation,
  useResetExecutionContextMutation,
  useResumeGraphWorkflowMutation,
  useRuntimeEditGraphWorkflowMutation,
} from "@/lib/workflows/mutations";
import { ApiCallError } from "@/lib/api/errors";
import { createClientLogger } from "@/lib/logging/client-logger";
import { pushToast } from "@/stores/toast.store";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { ExecutionMobilePanel } from "../SessionWorkflowPage";
import type { ExecutionControlAction } from "./ExecutionStatusBar";
import GraphWorkflowPanel from "./GraphWorkflowPanel";

const logger = createClientLogger("session-workflow");

function definitionApprovalErrorMessage(error: Error | null): string | null {
  if (!(error instanceof ApiCallError)) return error?.message ?? null;

  const unmetConditions = error.details?.unmetConditions;
  const instruction = error.details?.instruction;
  const recoveryGuidance = [
    ...(Array.isArray(unmetConditions)
      ? unmetConditions.filter(
          (condition): condition is string => typeof condition === "string",
        )
      : []),
    ...(typeof instruction === "string" ? [instruction] : []),
  ];

  return recoveryGuidance.length > 0
    ? recoveryGuidance.join(" ")
    : error.message;
}

function pauseFailureMessage(error: Error): string {
  if (
    error instanceof ApiCallError &&
    error.code === "workflow_transition_conflict" &&
    error.details?.action === "pause" &&
    error.details.currentStatus === "completed"
  ) {
    return "Workflow completed before pause could be applied.";
  }
  return `Couldn't pause workflow: ${error.message}`;
}

interface ConnectedGraphWorkflowPanelProps {
  projectName: string;
  sessionName: string;
  isMobile: boolean;
  mobilePanel: ExecutionMobilePanel;
  autoSwitchPanel: (panel: ExecutionMobilePanel) => void;
}

export default function ConnectedGraphWorkflowPanel({
  projectName,
  sessionName,
  isMobile,
  mobilePanel,
  autoSwitchPanel,
}: ConnectedGraphWorkflowPanelProps) {
  const executionQuery = useGraphWorkflowExecutionQuery(
    projectName,
    sessionName,
  );
  const execution = executionQuery.data ?? null;
  const executionId = execution?.id ?? null;
  const seedDefinitionId = execution?.seedDefinitionId ?? null;
  const seedDefinitionRevision = execution?.seedDefinitionRevision ?? null;
  const seedDefinitionQuery = useWorkflowDefinitionQuery(
    projectName,
    seedDefinitionId,
  );
  // The session's finished runs. `archived: false` entries are the terminal
  // ACTIVE execution, which the panel already renders in full — showing it in
  // "previous runs" too would double-report the run on screen.
  const historyQuery = useGraphWorkflowHistoryQuery(projectName, sessionName);
  const archivedExecutions = useMemo(
    () => (historyQuery.data ?? []).filter((item) => item.archived),
    [historyQuery.data],
  );
  const pauseMutation = usePauseGraphWorkflowMutation(projectName, sessionName);
  const resumeMutation = useResumeGraphWorkflowMutation(
    projectName,
    sessionName,
  );
  const abortMutation = useAbortGraphWorkflowMutation(projectName, sessionName);
  const clearMutation = useClearGraphWorkflowMutation(projectName, sessionName);
  const approveDefinitionMutation = useApproveGraphWorkflowDefinitionMutation(
    projectName,
    sessionName,
  );
  const previousApprovalExecutionId = useRef(executionId);
  const resetDefinitionApprovalMutation = approveDefinitionMutation.reset;
  useEffect(() => {
    const previousExecutionId = previousApprovalExecutionId.current;
    if (previousExecutionId === executionId) return;

    previousApprovalExecutionId.current = executionId;
    resetDefinitionApprovalMutation();
    logger.info("session_workflow.definition_approval.identity_changed", {
      projectName,
      sessionName,
      previousExecutionId,
      executionId,
    });
  }, [executionId, projectName, resetDefinitionApprovalMutation, sessionName]);
  const runtimeEditMutation = useRuntimeEditGraphWorkflowMutation(
    projectName,
    sessionName,
  );
  // A dedicated instance for config-tab saves so its pending/conflict/success
  // state drives the Config tab's affordances without being conflated with
  // task-edit runs on the same endpoint.
  const configEditMutation = useRuntimeEditGraphWorkflowMutation(
    projectName,
    sessionName,
  );
  const resetContextMutation = useResetExecutionContextMutation(
    projectName,
    sessionName,
  );
  const resetAssignmentMutation = useResetExecutionContextAssignmentMutation(
    projectName,
    sessionName,
  );

  // Live edits carry the concurrency guard (executionId + the current
  // liveRevision) read from the fetched execution; the mutation self-identifies
  // as source "ui" (doc 06, D15). Guard on a present execution — the task-edit
  // affordances only render once one exists.
  const handleAddTask = useCallback(
    (contextId: string, title: string, instructions: string) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [{ type: "add-task", contextId, title, instructions }],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleUpdateTask = useCallback(
    (taskId: string, updates: { title?: string; instructions?: string }) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [
          {
            type: "update-task",
            taskId,
            ...(updates.title ? { title: updates.title } : {}),
            ...(updates.instructions
              ? { instructions: updates.instructions }
              : {}),
          },
        ],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleRemoveTask = useCallback(
    (taskId: string) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [{ type: "remove-task", taskId }],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleMoveTask = useCallback(
    (taskId: string, targetContextId: string, targetOrder: number) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [
          {
            type: "move-task",
            taskId,
            targetContextId,
            // The server owns the numeric order; a relative position is the
            // live-edit contract (doc 06). Order 1 → start, else append.
            position: targetOrder <= 1 ? { at: "start" } : { at: "end" },
          },
        ],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleReorderTask = useCallback(
    (contextId: string, orderedTaskIds: string[]) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [{ type: "reorder-tasks", contextId, orderedTaskIds }],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleSaveContextConfig = useCallback(
    (operations: WorkflowLiveEditOperation[]) => {
      if (!execution || operations.length === 0) return;
      configEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations,
      });
    },
    [execution, configEditMutation],
  );

  const configEditConflict =
    configEditMutation.error instanceof ApiCallError &&
    configEditMutation.error.code === "revision_conflict";

  const eventsQuery = useGraphWorkflowEventsQuery(
    projectName,
    sessionName,
    executionId,
  );
  const handleResetContext = useCallback(
    (contextId: string) => {
      if (!executionId) return;
      resetContextMutation.mutate({ executionId, contextId });
    },
    [executionId, resetContextMutation],
  );
  const handleResetAssignment = useCallback(
    (contextId: string, assignmentId: string) => {
      if (!executionId) return;
      resetAssignmentMutation.mutate({ executionId, contextId, assignmentId });
    },
    [executionId, resetAssignmentMutation],
  );
  const handleApproveDefinition = useCallback(() => {
    if (!executionId || !seedDefinitionId || !seedDefinitionRevision) return;

    logger.info("session_workflow.definition_approval.requested", {
      projectName,
      sessionName,
      executionId,
      definitionId: seedDefinitionId,
      definitionRevision: seedDefinitionRevision,
    });
    approveDefinitionMutation.mutate(
      {
        executionId,
        definitionId: seedDefinitionId,
        definitionRevision: seedDefinitionRevision,
      },
      {
        onSuccess: () => {
          logger.info("session_workflow.definition_approval.completed", {
            projectName,
            sessionName,
            executionId,
            definitionId: seedDefinitionId,
            definitionRevision: seedDefinitionRevision,
          });
        },
        onError: (error) => {
          logger.warn("session_workflow.definition_approval.failed", {
            projectName,
            sessionName,
            executionId,
            definitionId: seedDefinitionId,
            definitionRevision: seedDefinitionRevision,
            error: error.message,
          });
        },
      },
    );
  }, [
    approveDefinitionMutation,
    executionId,
    projectName,
    seedDefinitionId,
    seedDefinitionRevision,
    sessionName,
  ]);

  const pendingAction: ExecutionControlAction | null = pauseMutation.isPending
    ? "pause"
    : resumeMutation.isPending
      ? "resume"
      : abortMutation.isPending
        ? "abort"
        : clearMutation.isPending
          ? "clear"
          : null;

  const handlePause = useCallback(() => {
    pauseMutation.mutate(undefined, {
      onError: (error) => {
        const transitionConflict =
          error instanceof ApiCallError &&
          error.code === "workflow_transition_conflict";
        const fields = {
          projectName,
          sessionName,
          executionId,
          error: error.message,
          currentStatus:
            error instanceof ApiCallError
              ? error.details?.currentStatus
              : undefined,
        };
        if (transitionConflict) {
          logger.info("session_workflow.pause.transition_rejected", fields);
        } else {
          logger.warn("session_workflow.pause.failed", fields);
        }
        pushToast(pauseFailureMessage(error));
      },
    });
  }, [executionId, pauseMutation, projectName, sessionName]);

  return (
    <GraphWorkflowPanel
      projectName={projectName}
      sessionName={sessionName}
      execution={execution}
      events={eventsQuery.data ?? []}
      archivedExecutions={archivedExecutions}
      layout={seedDefinitionQuery.data?.item.layout ?? null}
      onPause={handlePause}
      onResume={(conflictGuidance) =>
        resumeMutation.mutate(
          conflictGuidance && conflictGuidance.length > 0
            ? { conflictGuidance }
            : undefined,
        )
      }
      onAbort={() => abortMutation.mutate()}
      onClear={() => clearMutation.mutate()}
      onApproveDefinition={handleApproveDefinition}
      onAddTask={handleAddTask}
      onUpdateTask={handleUpdateTask}
      onRemoveTask={handleRemoveTask}
      onMoveTask={handleMoveTask}
      onReorderTask={handleReorderTask}
      onResetContext={handleResetContext}
      onResetAssignment={handleResetAssignment}
      resettingAssignmentId={
        resetAssignmentMutation.isPending
          ? (resetAssignmentMutation.variables?.assignmentId ?? null)
          : null
      }
      onSaveContextConfig={handleSaveContextConfig}
      isSavingConfig={configEditMutation.isPending}
      isPausingExecution={pauseMutation.isPending}
      isResumingExecution={resumeMutation.isPending}
      isApprovingDefinition={approveDefinitionMutation.isPending}
      definitionApprovalError={definitionApprovalErrorMessage(
        approveDefinitionMutation.error,
      )}
      configEditConflict={configEditConflict}
      configSaveSucceeded={configEditMutation.isSuccess}
      isMutating={
        pauseMutation.isPending ||
        resumeMutation.isPending ||
        abortMutation.isPending ||
        clearMutation.isPending ||
        approveDefinitionMutation.isPending ||
        runtimeEditMutation.isPending ||
        configEditMutation.isPending ||
        resetContextMutation.isPending ||
        resetAssignmentMutation.isPending
      }
      pendingAction={pendingAction}
      isMobile={isMobile}
      mobilePanel={mobilePanel}
      autoSwitchPanel={autoSwitchPanel}
    />
  );
}
