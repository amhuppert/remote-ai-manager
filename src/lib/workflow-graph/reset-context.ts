import {
  buildInitialContextState,
  buildInitialTaskState,
} from "@/lib/workflow-graph/execution-state";
import { recomputeLanePlanForSubgraph } from "@/lib/workflow-graph/lane-plan";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowLaneKind,
  GraphWorkflowAgentSessionState,
  GraphWorkflowTaskState,
} from "@/lib/workflows/schemas";
export class ResetExecutionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetExecutionContextError";
  }
}

const RESET_ELIGIBLE_STATUSES: ReadonlySet<GraphWorkflowExecution["status"]> =
  new Set(["paused", "halted"]);

export function resetExecutionContext(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowExecution {
  if (!RESET_ELIGIBLE_STATUSES.has(execution.status)) {
    throw new ResetExecutionContextError(
      `Reset only allowed when the workflow is paused or halted (current status: ${execution.status}).`,
    );
  }

  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new ResetExecutionContextError(
      `Execution context "${contextId}" not found.`,
    );
  }

  const contextState = execution.contextStates[contextId];
  if (contextState?.status === "completed") {
    throw new ResetExecutionContextError(
      `Execution context "${contextId}" is completed and cannot be reset.`,
    );
  }

  const nextContextState: GraphWorkflowExecutionContextState =
    buildInitialContextState(context, execution.workingDefinition.tasks);

  const nextContextStates = {
    ...execution.contextStates,
    [contextId]: nextContextState,
  };

  const nextTaskStates: Record<string, GraphWorkflowTaskState> = {};
  for (const [taskId, taskState] of Object.entries(execution.taskStates)) {
    if (taskState.contextId !== contextId) {
      nextTaskStates[taskId] = taskState;
      continue;
    }
    const taskDefinition = execution.workingDefinition.tasks.find(
      (task) => task.id === taskId,
    );
    if (!taskDefinition) {
      nextTaskStates[taskId] = taskState;
      continue;
    }
    nextTaskStates[taskId] = buildInitialTaskState(taskDefinition);
  }

  const nextLaneStates: Record<
    string,
    Partial<Record<GraphWorkflowLaneKind, GraphWorkflowAgentSessionState>>
  > = {};
  for (const [ctxKey, contextLanes] of Object.entries(execution.laneStates)) {
    if (ctxKey === contextId) continue;
    nextLaneStates[ctxKey] = contextLanes;
  }

  const nextLanePlan = recomputeLanePlanForSubgraph({
    definition: execution.workingDefinition,
    previousPlan: execution.lanePlan,
    contextIds: [contextId],
  });

  return {
    ...execution,
    status: "paused",
    activeContextIds: [],
    contextStates: nextContextStates,
    taskStates: nextTaskStates,
    laneStates: nextLaneStates,
    haltReason: null,
    completedAt: null,
    machineSnapshot: null,
    lanePlan: nextLanePlan,
  };
}
