import {
  IllegalContextStatusTransitionError,
  resetContextStateToInitial,
} from "@/lib/workflow-graph/context-transitions";
import { buildInitialTaskState } from "@/lib/workflow-graph/execution-state";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
export class ResetExecutionContextError extends Error {
  constructor(
    readonly code:
      | "invalid_execution_status"
      | "context_missing"
      | "terminal_context",
    message: string,
  ) {
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
      "invalid_execution_status",
      `Reset only allowed when the workflow is paused or halted (current status: ${execution.status}).`,
    );
  }

  const contextExists = execution.workingDefinition.executionContexts.some(
    (entry) => entry.id === contextId,
  );
  if (!contextExists) {
    throw new ResetExecutionContextError(
      "context_missing",
      `Execution context "${contextId}" not found.`,
    );
  }

  // The transition owner holds the legality decision (completed and skipped are
  // terminal). It is pure (runs inside a write-queue reducer, so it does no
  // logging); its rejection is translated back into the reset API's error
  // contract: workflow-manager and the HTTP adapter use the typed reset code. The refusing status is named
  // rather than assumed — a skipped context was never run, and reporting it as
  // completed would misdescribe the branch to the operator.
  let nextContextStates: Record<string, GraphWorkflowExecutionContextState>;
  try {
    nextContextStates = resetContextStateToInitial(execution, contextId, {
      reason: "reset_context.operator_reset",
    });
  } catch (error) {
    if (error instanceof IllegalContextStatusTransitionError) {
      throw new ResetExecutionContextError(
        "terminal_context",
        `Execution context "${contextId}" is ${error.from} and cannot be reset.`,
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

  return {
    ...execution,
    status: "paused",
    activeContextIds: [],
    contextStates: nextContextStates,
    taskStates: nextTaskStates,
    haltReason: null,
    completedAt: null,
    machineSnapshot: null,
  };
}
