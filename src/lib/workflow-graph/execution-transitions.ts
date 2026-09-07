import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "./schemas";
import type { GraphWorkflowStatus } from "./definition-schemas";
import {
  buildLifecycleSnapshot,
  transitionContextStatus,
} from "./context-transitions";

function markActiveContextReady(execution: GraphWorkflowExecution): void {
  if (execution.activeContextIds.length === 0) {
    return;
  }

  for (const activeContextId of execution.activeContextIds) {
    const activeContext = execution.contextStates[activeContextId];
    if (!activeContext) {
      continue;
    }

    if (activeContext.status === "running") {
      transitionContextStatus(execution, activeContextId, "ready", {
        reason: "manager.mark_active_context_ready",
      });
    }
  }
}

function interruptRunningTasks(execution: GraphWorkflowExecution): boolean {
  let foundRunning = false;
  for (const taskState of Object.values(execution.taskStates)) {
    if (taskState.status === "running") {
      taskState.status = "interrupted";
      foundRunning = true;
    }
  }
  return foundRunning;
}

/**
 * THE execution-level transition into a non-running state (D4: execution status
 * is hand-rolled here rather than in the context-status owner). Exported so
 * every path that ends or parks a run — including the repository's
 * materialization-failure halt — moves through this one rule set: running tasks
 * are interrupted, the active context is marked ready, a running run's
 * `loopEpoch` is retired, and the lifecycle snapshot is rebuilt.
 */
export function transitionToNonRunningState(
  execution: GraphWorkflowExecution,
  status: Extract<GraphWorkflowStatus, "paused" | "halted" | "aborted">,
  completedAt: string | null,
  haltReason: GraphWorkflowHaltReason | null,
): GraphWorkflowExecution {
  const nextExecution = structuredClone(execution);
  const hadRunningTasks = interruptRunningTasks(nextExecution);
  markActiveContextReady(nextExecution);
  if (execution.status === "running") {
    nextExecution.loopEpoch += 1;
  }
  nextExecution.status = status;
  nextExecution.completedAt = completedAt;
  nextExecution.haltReason = haltReason;
  // A run that has left the park has no decision left to make, so a reservation
  // on it is debt rather than state. Cutting off a live holder is the caller's
  // question, not this one's: the two acts that can transition a still-parked
  // run — abort and rejection — refuse while a decision is genuinely in flight.
  nextExecution.definitionApprovalClaim = null;
  nextExecution.machineSnapshot = buildLifecycleSnapshot(nextExecution, {
    lifecycleStatus: status,
    recoveryMode: hadRunningTasks ? "interrupted_task" : "none",
    hasLiveIteration: false,
  });
  return nextExecution;
}

export function requireRunningExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  if (execution.status !== "running") {
    throw new Error("Only running graph workflow executions can be updated");
  }

  return execution;
}
