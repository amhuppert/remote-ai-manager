"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  orderGraphWorkflowEventPages,
  useGraphWorkflowEventPagesQuery,
  useGraphWorkflowEventsQuery,
  useGraphWorkflowExecutionByIdQuery,
  useGraphWorkflowExecutionQuery,
  useGraphWorkflowLatestExecutionResultQuery,
  useWorkflowDefinitionQuery,
} from "@/lib/workflows/queries";
import {
  useAbortGraphWorkflowMutation,
  useAbandonGraphWorkflowMutation,
  useApproveGraphWorkflowDefinitionMutation,
  usePauseGraphWorkflowMutation,
  useResetExecutionContextAssignmentMutation,
  useResetExecutionContextMutation,
  useResumeGraphWorkflowMutation,
  useRejectGraphWorkflowDefinitionMutation,
  useResolveApprovalMutation,
  useRuntimeEditGraphWorkflowMutation,
} from "@/lib/workflows/mutations";
import { ApiCallError } from "@/lib/api/errors";
import { createClientLogger } from "@/lib/logging/client-logger";
import { pushToast } from "@/stores/toast.store";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { ExecutionMobilePanel } from "../SessionWorkflowPage";
import type { ExecutionControlAction } from "./ExecutionStatusBar";
import GraphWorkflowPanel from "./GraphWorkflowPanel";
import ApprovalGatePanel from "@/components/ApprovalGatePanel";
import { useApprovalScopedChanges } from "@/hooks/use-approval-scoped-changes";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";

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

function configEditErrorMessage(error: Error | null): string | null {
  if (!error) return null;
  if (error instanceof ApiCallError && error.code === "revision_conflict") {
    return null;
  }

  if (!(error instanceof ApiCallError)) return error.message;

  const issueMessages = (error.issues ?? []).map((issue) => issue.message);
  const instruction = error.details?.instruction;
  const messages = [
    ...(issueMessages.length > 0 ? issueMessages : [error.message]),
    ...(typeof instruction === "string" ? [instruction] : []),
  ];
  return [...new Set(messages)].join(" ");
}

interface ConnectedGraphWorkflowPanelProps {
  projectName: string;
  sessionName: string;
  selectedExecutionId?: string | null;
  isMobile: boolean;
  mobilePanel: ExecutionMobilePanel;
  autoSwitchPanel: (panel: ExecutionMobilePanel) => void;
}

interface CurrentContextApproval {
  contextId: string;
  contextTitle: string | null;
  requestedAt: string;
  enveloped: boolean;
}

function CurrentContextApprovalPanel({
  projectName,
  sessionName,
  execution,
  approval,
}: {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  approval: CurrentContextApproval;
}) {
  const resolveMutation = useResolveApprovalMutation(projectName, sessionName);
  const scopedChanges = useApprovalScopedChanges(
    projectName,
    sessionName,
    approval,
  );

  return (
    <ApprovalGatePanel
      contextTitle={approval.contextTitle}
      workflowName={
        execution.launchDocument?.name ??
        (execution.origin.kind === "one_off"
          ? execution.origin.planName
          : execution.origin.definitionId)
      }
      requestedAt={approval.requestedAt}
      isSubmitting={resolveMutation.isPending}
      conversationBusy={false}
      executionSuspended={
        execution.status === "paused" || execution.status === "halted"
      }
      scopedChanges={scopedChanges}
      voiceProjectName={projectName}
      onApprove={() =>
        resolveMutation.mutate({
          executionId: execution.id,
          contextId: approval.contextId,
          decision: "approve",
        })
      }
      onReject={(message) =>
        resolveMutation.mutate({
          executionId: execution.id,
          contextId: approval.contextId,
          decision: "reject",
          message,
        })
      }
    />
  );
}

export default function ConnectedGraphWorkflowPanel({
  projectName,
  sessionName,
  selectedExecutionId,
  isMobile,
  mobilePanel,
  autoSwitchPanel,
}: ConnectedGraphWorkflowPanelProps) {
  const executionQuery = useGraphWorkflowExecutionQuery(
    projectName,
    sessionName,
  );
  const currentExecution = executionQuery.data ?? null;
  const resolvedSelectionId =
    selectedExecutionId === undefined
      ? (currentExecution?.id ?? null)
      : selectedExecutionId;
  const selectedIsCurrent =
    resolvedSelectionId !== null &&
    resolvedSelectionId === currentExecution?.id;
  const selectedExecutionQuery = useGraphWorkflowExecutionByIdQuery(
    projectName,
    sessionName,
    resolvedSelectionId,
    { enabled: resolvedSelectionId !== null && !selectedIsCurrent },
  );
  const execution = selectedIsCurrent
    ? currentExecution
    : (selectedExecutionQuery.data ?? null);
  const executionId = execution?.id ?? null;
  const isHistoricalSelection = executionId !== null && !selectedIsCurrent;
  // History is self-contained. Passing null here is deliberate: even a
  // template-origin run must never rejoin mutable definition storage after it
  // releases the session lease.
  const seedDefinitionId =
    selectedIsCurrent &&
    execution?.launchDocument === null &&
    execution.origin.kind === "template"
      ? execution.seedDefinitionId
      : null;
  const seedDefinitionQuery = useWorkflowDefinitionQuery(
    projectName,
    seedDefinitionId,
  );
  const pauseMutation = usePauseGraphWorkflowMutation(projectName, sessionName);
  const resumeMutation = useResumeGraphWorkflowMutation(
    projectName,
    sessionName,
  );
  const abortMutation = useAbortGraphWorkflowMutation(projectName, sessionName);
  const abandonMutation = useAbandonGraphWorkflowMutation(
    projectName,
    sessionName,
  );
  const approveDefinitionMutation = useApproveGraphWorkflowDefinitionMutation(
    projectName,
    sessionName,
  );
  const rejectDefinitionMutation = useRejectGraphWorkflowDefinitionMutation(
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
      const contextIds = operations.flatMap((operation) =>
        "contextId" in operation ? [operation.contextId] : [],
      );
      const input = {
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations,
      };
      logger.info("session_workflow.context_config_save.requested", {
        projectName,
        sessionName,
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operationCount: operations.length,
        contextIds,
      });
      configEditMutation.mutate(input, {
        onSuccess: () => {
          logger.info("session_workflow.context_config_save.completed", {
            projectName,
            sessionName,
            executionId: execution.id,
            baseLiveRevision: execution.liveRevision,
            operationCount: operations.length,
            contextIds,
          });
        },
        onError: (error) => {
          logger.warn("session_workflow.context_config_save.failed", {
            projectName,
            sessionName,
            executionId: execution.id,
            baseLiveRevision: execution.liveRevision,
            operationCount: operations.length,
            contextIds,
            error: error.message,
            errorCode: error instanceof ApiCallError ? error.code : undefined,
            status: error instanceof ApiCallError ? error.status : undefined,
            issueCount:
              error instanceof ApiCallError ? (error.issues?.length ?? 0) : 0,
          });
        },
      });
    },
    [configEditMutation, execution, projectName, sessionName],
  );

  const configEditConflict =
    configEditMutation.error instanceof ApiCallError &&
    configEditMutation.error.code === "revision_conflict";

  const eventsQuery = useGraphWorkflowEventsQuery(
    projectName,
    sessionName,
    selectedIsCurrent ? executionId : null,
  );
  const eventPagesQuery = useGraphWorkflowEventPagesQuery(
    projectName,
    sessionName,
    executionId,
    { enabled: isHistoricalSelection },
  );
  useEffect(() => {
    if (
      !isHistoricalSelection ||
      !eventPagesQuery.hasNextPage ||
      eventPagesQuery.isFetchingNextPage
    ) {
      return;
    }
    void eventPagesQuery.fetchNextPage();
  }, [
    eventPagesQuery.fetchNextPage,
    eventPagesQuery.hasNextPage,
    eventPagesQuery.isFetchingNextPage,
    isHistoricalSelection,
  ]);
  const events = useMemo(
    () =>
      isHistoricalSelection
        ? orderGraphWorkflowEventPages(eventPagesQuery.data?.pages)
        : (eventsQuery.data ?? []),
    [eventPagesQuery.data?.pages, eventsQuery.data, isHistoricalSelection],
  );
  const resultQuery = useGraphWorkflowLatestExecutionResultQuery(
    projectName,
    sessionName,
    executionId,
    { enabled: isHistoricalSelection },
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
  // Execution-addressed: gating on a seed definition id would dead-end the
  // button for a one-off park, which has none (D7 R14.2).
  const handleApproveDefinition = useCallback(() => {
    if (!executionId) return;

    logger.info("session_workflow.definition_approval.requested", {
      projectName,
      sessionName,
      executionId,
    });
    approveDefinitionMutation.mutate(
      { executionId },
      {
        onSuccess: () => {
          logger.info("session_workflow.definition_approval.completed", {
            projectName,
            sessionName,
            executionId,
          });
        },
        onError: (error) => {
          logger.warn("session_workflow.definition_approval.failed", {
            projectName,
            sessionName,
            executionId,
            error: error.message,
          });
        },
      },
    );
  }, [approveDefinitionMutation, executionId, projectName, sessionName]);

  const pendingAction: ExecutionControlAction | null = pauseMutation.isPending
    ? "pause"
    : resumeMutation.isPending
      ? "resume"
      : abortMutation.isPending
        ? "abort"
        : abandonMutation.isPending
          ? "abandon"
          : null;

  const contextApprovals = useMemo(() => {
    if (
      !selectedIsCurrent ||
      execution === null ||
      !holdsExecutionLease(
        execution.status,
        execution.haltReason,
        execution.abandonment,
      )
    ) {
      return [];
    }
    const approvals: CurrentContextApproval[] = [];
    for (const state of Object.values(execution.contextStates)) {
      if (
        state.status !== "awaiting_approval" ||
        state.pendingApproval === null ||
        state.pendingApproval.decision !== null
      ) {
        continue;
      }
      const context = execution.workingDefinition.executionContexts.find(
        (candidate) => candidate.id === state.contextId,
      );
      approvals.push({
        contextId: state.contextId,
        contextTitle: context?.title ?? null,
        requestedAt: state.pendingApproval.requestedAt,
        enveloped: state.pendingApproval.approvalScope.kind !== "whole_tree",
      });
    }
    return approvals;
  }, [execution, selectedIsCurrent]);

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
      events={events}
      layout={
        execution?.launchDocument?.layout ??
        seedDefinitionQuery.data?.item.layout ??
        null
      }
      actionCapability={selectedIsCurrent ? "current" : "read-only"}
      result={resultQuery.data ?? null}
      onPause={handlePause}
      onResume={(conflictGuidance) =>
        resumeMutation.mutate(
          conflictGuidance && conflictGuidance.length > 0
            ? { conflictGuidance }
            : undefined,
        )
      }
      onAbort={() => abortMutation.mutate()}
      onAbandon={() => {
        if (executionId === null) return;
        abandonMutation.mutate({
          executionId,
          reason:
            "Operator abandoned the resumably halted execution from Current detail.",
        });
      }}
      onApproveDefinition={handleApproveDefinition}
      onRejectDefinition={() => {
        if (executionId === null) return;
        rejectDefinitionMutation.mutate({ executionId });
      }}
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
      isRejectingDefinition={rejectDefinitionMutation.isPending}
      definitionApprovalError={definitionApprovalErrorMessage(
        approveDefinitionMutation.error ?? rejectDefinitionMutation.error,
      )}
      configEditConflict={configEditConflict}
      configEditError={configEditErrorMessage(configEditMutation.error)}
      configSaveSucceeded={configEditMutation.isSuccess}
      isMutating={
        pauseMutation.isPending ||
        resumeMutation.isPending ||
        abortMutation.isPending ||
        approveDefinitionMutation.isPending ||
        rejectDefinitionMutation.isPending ||
        abandonMutation.isPending ||
        runtimeEditMutation.isPending ||
        configEditMutation.isPending ||
        resetContextMutation.isPending ||
        resetAssignmentMutation.isPending
      }
      pendingAction={pendingAction}
      isMobile={isMobile}
      mobilePanel={mobilePanel}
      autoSwitchPanel={autoSwitchPanel}
      humanApprovalPanel={
        execution === null || contextApprovals.length === 0 ? null : (
          <>
            {contextApprovals.map((approval) => (
              <CurrentContextApprovalPanel
                key={`${approval.contextId}:${approval.requestedAt}`}
                projectName={projectName}
                sessionName={sessionName}
                execution={execution}
                approval={approval}
              />
            ))}
          </>
        )
      }
    />
  );
}
