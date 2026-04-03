"use client";

import { useCallback } from "react";
import { useSessionQuery, useWorkflowDefinitionQuery } from "@/lib/queries";
import {
  useAbortGraphWorkflowMutation,
  useClearGraphWorkflowMutation,
  usePauseGraphWorkflowMutation,
  useResumeGraphWorkflowMutation,
  useRuntimeEditGraphWorkflowMutation,
} from "@/lib/mutations";
import type { ExecutionMobilePanel } from "./page";
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
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const session = sessionQuery.data ?? null;
  const seedDefinitionId =
    session?.graphWorkflowExecution?.seedDefinitionId ?? null;
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

  return (
    <GraphWorkflowPanel
      projectName={projectName}
      sessionName={sessionName}
      execution={session?.graphWorkflowExecution ?? null}
      archivedExecutions={session?.graphWorkflowExecutionHistory ?? []}
      layout={seedDefinitionQuery.data?.layout ?? null}
      onPause={() => pauseMutation.mutate()}
      onResume={() => resumeMutation.mutate()}
      onAbort={() => abortMutation.mutate()}
      onClear={() => clearMutation.mutate()}
      onAddTask={handleAddTask}
      onUpdateTask={handleUpdateTask}
      onRemoveTask={handleRemoveTask}
      onMoveTask={handleMoveTask}
      onReorderTask={handleReorderTask}
      isMutating={
        pauseMutation.isPending ||
        resumeMutation.isPending ||
        abortMutation.isPending ||
        clearMutation.isPending ||
        runtimeEditMutation.isPending
      }
      isMobile={isMobile}
      mobilePanel={mobilePanel}
      autoSwitchPanel={autoSwitchPanel}
    />
  );
}
