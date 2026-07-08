"use client";

import { useCallback } from "react";
import {
  useGraphWorkflowEventsQuery,
  useGraphWorkflowExecutionQuery,
  useWorkflowDefinitionQuery,
} from "@/lib/workflows/queries";
import {
  useAbortGraphWorkflowMutation,
  useClearGraphWorkflowMutation,
  usePauseGraphWorkflowMutation,
  useResetExecutionContextMutation,
  useResumeGraphWorkflowMutation,
  useRuntimeEditGraphWorkflowMutation,
} from "@/lib/workflows/mutations";
import { ApiCallError } from "@/lib/api/errors";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/schemas";
import type { ExecutionMobilePanel } from "../SessionWorkflowPage";
import type { ExecutionControlAction } from "./ExecutionStatusBar";
import GraphWorkflowPanel from "./GraphWorkflowPanel";

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
  const seedDefinitionId = execution?.seedDefinitionId ?? null;
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
  const clearMutation = useClearGraphWorkflowMutation(projectName, sessionName);
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

  const executionId = execution?.id ?? null;
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

  const pendingAction: ExecutionControlAction | null = pauseMutation.isPending
    ? "pause"
    : resumeMutation.isPending
      ? "resume"
      : abortMutation.isPending
        ? "abort"
        : clearMutation.isPending
          ? "clear"
          : null;

  return (
    <GraphWorkflowPanel
      projectName={projectName}
      sessionName={sessionName}
      execution={execution}
      events={eventsQuery.data ?? []}
      archivedExecutions={[]}
      layout={seedDefinitionQuery.data?.item.layout ?? null}
      onPause={() => pauseMutation.mutate()}
      onResume={(conflictGuidance) =>
        resumeMutation.mutate(
          conflictGuidance && conflictGuidance.length > 0
            ? { conflictGuidance }
            : undefined,
        )
      }
      onAbort={() => abortMutation.mutate()}
      onClear={() => clearMutation.mutate()}
      onAddTask={handleAddTask}
      onUpdateTask={handleUpdateTask}
      onRemoveTask={handleRemoveTask}
      onMoveTask={handleMoveTask}
      onReorderTask={handleReorderTask}
      onResetContext={handleResetContext}
      onSaveContextConfig={handleSaveContextConfig}
      isSavingConfig={configEditMutation.isPending}
      isPausingExecution={pauseMutation.isPending}
      isResumingExecution={resumeMutation.isPending}
      configEditConflict={configEditConflict}
      configSaveSucceeded={configEditMutation.isSuccess}
      isMutating={
        pauseMutation.isPending ||
        resumeMutation.isPending ||
        abortMutation.isPending ||
        clearMutation.isPending ||
        runtimeEditMutation.isPending ||
        configEditMutation.isPending ||
        resetContextMutation.isPending
      }
      pendingAction={pendingAction}
      isMobile={isMobile}
      mobilePanel={mobilePanel}
      autoSwitchPanel={autoSwitchPanel}
    />
  );
}
