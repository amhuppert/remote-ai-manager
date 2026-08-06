import {
  IllegalContextStatusTransitionError,
  resetContextStateToInitial,
} from "@/lib/workflow-graph/context-transitions";
import { buildInitialTaskState } from "@/lib/workflow-graph/execution-state";
import { recomputeLanePlanForSubgraph } from "@/lib/workflow-graph/lane-plan";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
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

  const contextExists = execution.workingDefinition.executionContexts.some(
    (entry) => entry.id === contextId,
  );
  if (!contextExists) {
    throw new ResetExecutionContextError(
      `Execution context "${contextId}" not found.`,
    );
  }

  // The transition owner holds the legality decision (completed is terminal).
  // It is pure (runs inside a write-queue reducer, so it does no logging); its
  // rejection is translated back into the reset API's error contract:
  // workflow-manager and respondToManagerError key off ResetExecutionContextError
  // and this message.
  let nextContextStates: Record<string, GraphWorkflowExecutionContextState>;
  try {
    nextContextStates = resetContextStateToInitial(execution, contextId, {
      reason: "reset_context.operator_reset",
    });
  } catch (error) {
    if (error instanceof IllegalContextStatusTransitionError) {
      throw new ResetExecutionContextError(
        `Execution context "${contextId}" is completed and cannot be reset.`,
      );
    }
    throw error;
  }

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

  // Keyed by lane key (`implementer` | `context_validator:<assignmentId>`), so
  // dropping a context drops every cohort member's lane with it.
  const nextLaneStates: Record<
    string,
    Record<string, GraphWorkflowAgentSessionState>
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
