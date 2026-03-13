import { assertNever } from "@/lib/assert-never";
import type {
  FixPlanTask,
  RalphLoopIterationMeta,
  CircuitBreakerStateEnum,
  RalphLoopConfig,
  HaltReason,
} from "@/types";

export type ExitDecision =
  | { action: "continue" }
  | { action: "halt"; reason: HaltReason };

export interface ExitEvaluationParams {
  fixPlan: FixPlanTask[];
  iterations: RalphLoopIterationMeta[];
  currentIteration: RalphLoopIterationMeta;
  circuitBreakerState: CircuitBreakerStateEnum;
  config: RalphLoopConfig;
}

/**
 * Evaluate exit conditions in strict priority order.
 * Pure function: takes iteration history and current state, returns exit decision.
 */
export function evaluate(params: ExitEvaluationParams): ExitDecision {
  const { fixPlan, iterations, currentIteration, circuitBreakerState, config } =
    params;

  // 1. Plan complete — all tasks resolved (completed or skipped)
  if (isAllTasksResolved(fixPlan)) {
    return { action: "halt", reason: { type: "plan_complete" } };
  }

  // 2. Iteration cap reached
  if (currentIteration.iterationNumber >= config.maxIterations) {
    return {
      action: "halt",
      reason: { type: "iteration_cap", maxIterations: config.maxIterations },
    };
  }

  // 3. Circuit breaker open
  if (circuitBreakerState === "open") {
    return {
      action: "halt",
      reason: { type: "circuit_breaker", reason: "no_progress" },
    };
  }

  // 4. Permission denied (2+ consecutive)
  if (hasConsecutivePermissionDenials(iterations, 2)) {
    return { action: "halt", reason: { type: "permission_denied" } };
  }

  // 5. Test saturation (3+ of last 5 test-only)
  if (hasTestSaturation(iterations)) {
    return { action: "halt", reason: { type: "test_saturation" } };
  }

  // 6. Stalled exit signal (2+ of last 3 signal exit but tasks remain)
  const stalledResult = checkStalledExitSignal(iterations, fixPlan);
  if (stalledResult) {
    return { action: "halt", reason: stalledResult };
  }

  return { action: "continue" };
}

/** Check if all tasks in the plan are resolved (completed or skipped). */
export function isAllTasksResolved(fixPlan: FixPlanTask[]): boolean {
  if (fixPlan.length === 0) return false;
  return fixPlan.every(
    (task) => task.status === "completed" || task.status === "skipped",
  );
}

/** Check for 2+ consecutive permission denial iterations (from the end). */
function hasConsecutivePermissionDenials(
  iterations: RalphLoopIterationMeta[],
  threshold: number,
): boolean {
  if (iterations.length < threshold) return false;

  let consecutive = 0;
  for (let i = iterations.length - 1; i >= 0; i--) {
    const iter = iterations[i];
    if (!iter) break;
    const report = iter.statusReport;
    if (
      report?.status === "blocked" &&
      report.work_summary.toLowerCase().includes("permission")
    ) {
      consecutive++;
      if (consecutive >= threshold) return true;
    } else {
      break;
    }
  }
  return false;
}

/** Check if 3+ of the last 5 iterations are test-only (work_type: testing with no implementation). */
function hasTestSaturation(iterations: RalphLoopIterationMeta[]): boolean {
  const last5 = iterations.slice(-5);
  if (last5.length < 3) return false;

  const testOnlyCount = last5.filter(
    (iter) => iter.statusReport?.work_type === "testing",
  ).length;

  return testOnlyCount >= 3;
}

/** Check for stalled exit signal: 2+ of last 3 iterations report exit_signal: true but tasks remain. */
function checkStalledExitSignal(
  iterations: RalphLoopIterationMeta[],
  fixPlan: FixPlanTask[],
): HaltReason | null {
  const last3 = iterations.slice(-3);
  if (last3.length < 2) return null;

  const exitSignalCount = last3.filter(
    (iter) => iter.statusReport?.exit_signal === true,
  ).length;

  if (exitSignalCount < 2) return null;

  const unresolvedCount = fixPlan.filter(
    (task) => task.status !== "completed" && task.status !== "skipped",
  ).length;

  if (unresolvedCount === 0) return null;

  return { type: "stalled_exit_signal", remainingTasks: unresolvedCount };
}

/** Classify a halt reason as successful or problematic. */
export function isSuccessfulHalt(reason: HaltReason): boolean {
  switch (reason.type) {
    case "plan_complete":
      return true;
    case "iteration_cap":
    case "circuit_breaker":
    case "permission_denied":
    case "test_saturation":
    case "stalled_exit_signal":
    case "stopped":
    case "context_limit":
      return false;
    default:
      return assertNever(reason);
  }
}

/** Map a HaltReason to its terminal workflow output status. */
export function haltReasonToTerminalStatus(
  reason: HaltReason,
): "completed" | "halted" | "stopped" {
  switch (reason.type) {
    case "plan_complete":
      return "completed";
    case "stopped":
      return "stopped";
    case "iteration_cap":
    case "circuit_breaker":
    case "permission_denied":
    case "test_saturation":
    case "stalled_exit_signal":
    case "context_limit":
      return "halted";
    default:
      return assertNever(reason);
  }
}
