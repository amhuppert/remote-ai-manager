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
  const resetContextMutation = useResetExecutionContextMutation(
    projectName,
    sessionName,
  );

  const handleAddTask = useCallback(
    (contextId: string, title: string, instructions: string) => {
      runtimeEditMutation.mutate({
        operations: [
          {
            type: "add",
            contextId,
            title,
            instructions,
          },
        ],
      });
    },
    [runtimeEditMutation],
  );

  const handleUpdateTask = useCallback(
    (taskId: string, updates: { title?: string; instructions?: string }) => {
      runtimeEditMutation.mutate({
        operations: [
          {
            type: "update",
            taskId,
            ...(updates.title ? { title: updates.title } : {}),
            ...(updates.instructions
              ? { instructions: updates.instructions }
              : {}),
          },
        ],
      });
    },
    [runtimeEditMutation],
  );

  const handleRemoveTask = useCallback(
    (taskId: string) => {
      runtimeEditMutation.mutate({
        operations: [{ type: "remove", taskId }],
      });
    },
    [runtimeEditMutation],
  );

  const handleMoveTask = useCallback(
    (taskId: string, targetContextId: string, targetOrder: number) => {
      runtimeEditMutation.mutate({
        operations: [
          {
            type: "move",
            taskId,
            targetContextId,
            targetOrder,
          },
        ],
      });
    },
    [runtimeEditMutation],
  );

  const handleReorderTask = useCallback(
    (contextId: string, orderedTaskIds: string[]) => {
      runtimeEditMutation.mutate({
        operations: [
          {
            type: "reorder",
            contextId,
            orderedTaskIds,
          },
        ],
      });
    },
    [runtimeEditMutation],
  );

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
      isMutating={
        pauseMutation.isPending ||
        resumeMutation.isPending ||
        abortMutation.isPending ||
        clearMutation.isPending ||
        runtimeEditMutation.isPending ||
        resetContextMutation.isPending
      }
      pendingAction={pendingAction}
      isMobile={isMobile}
      mobilePanel={mobilePanel}
      autoSwitchPanel={autoSwitchPanel}
    />
  );
}
