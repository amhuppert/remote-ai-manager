"use client";

import type { GraphWorkflowLifecycleSnapshot } from "@/lib/workflows/graph-workflow/workflow-manager";
import type { GraphWorkflowExecution } from "@/types";

function getMachineSnapshot(
  execution: GraphWorkflowExecution,
): GraphWorkflowLifecycleSnapshot | null {
  return (
    (execution.machineSnapshot as GraphWorkflowLifecycleSnapshot | null) ?? null
  );
}

export function isTaskConversationLive(
  execution: GraphWorkflowExecution,
  taskId: string,
): boolean {
  const taskState = execution.taskStates[taskId];
  if (!taskState?.lastConversationId) {
    return false;
  }

  const machineSnapshot = getMachineSnapshot(execution);
  if (machineSnapshot?.hasLiveIteration !== true) {
    return false;
  }

  const activeContextId =
    machineSnapshot?.activeContextId ?? execution.activeContextIds[0] ?? null;
  if (!activeContextId || activeContextId !== taskState.contextId) {
    return false;
  }

  return taskState.status !== "completed";
}

export function isTaskEditable(
  execution: GraphWorkflowExecution,
  taskId: string,
): boolean {
  const taskState = execution.taskStates[taskId];
  if (execution.status === "completed") {
    return false;
  }

  if (taskState?.status === "completed" || taskState?.status === "running") {
    return false;
  }

  return !isTaskConversationLive(execution, taskId);
}
