import type {
  GraphWorkflowExecutionContextState,
  GraphWorkflowTaskState,
  ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
type ResolvedContext =
  ResolvedWorkflowSemanticDefinition["executionContexts"][number];
type ResolvedTask = ResolvedWorkflowSemanticDefinition["tasks"][number];

export function buildInitialTaskState(
  task: ResolvedTask,
): GraphWorkflowTaskState {
  return {
    taskId: task.id,
    contextId: task.contextId,
    order: task.order,
    status: "pending",
    summary: null,
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
  };
}

export function buildInitialContextState(
  context: ResolvedContext,
  tasks: readonly ResolvedTask[],
): GraphWorkflowExecutionContextState {
  const totalTaskCount = tasks.filter(
    (task) => task.contextId === context.id,
  ).length;

  return {
    contextId: context.id,
    status: "pending",
    totalTaskCount,
    completedTaskCount: 0,
    iterationCount: 0,
    consecutiveFailureCount: 0,
    worktreePath: null,
    branchName: null,
    isolation: "session",
    batchId: null,
    laneId: null,
    joinId: null,
    mergeStatus: "not-applicable",
    cleanupStatus: "not-applicable",
    lastMergeError: null,
    pendingApproval: null,
    pendingUserInput: null,
  };
}

export function buildInitialContextStates(
  definition: ResolvedWorkflowSemanticDefinition,
): Record<string, GraphWorkflowExecutionContextState> {
  const contextStates: Record<string, GraphWorkflowExecutionContextState> = {};
  for (const context of definition.executionContexts) {
    contextStates[context.id] = buildInitialContextState(
      context,
      definition.tasks,
    );
  }
  return contextStates;
}

export function buildInitialTaskStates(
  definition: ResolvedWorkflowSemanticDefinition,
): Record<string, GraphWorkflowTaskState> {
  const taskStates: Record<string, GraphWorkflowTaskState> = {};
  for (const task of definition.tasks) {
    taskStates[task.id] = buildInitialTaskState(task);
  }
  return taskStates;
}
