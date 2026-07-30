/**
 * The plan-repair trigger predicate (docs/design/cc-cli/08 §Trigger policy).
 * Pure — the supervisor evaluates it against a FRESH read of the active
 * execution after a loop settles (never the loop's possibly-fenced snapshot).
 */

import type { GraphWorkflowPlanRepairPolicy } from "../config-schemas";
import type { GraphWorkflowExecution } from "../schemas";

/**
 * Hard per-execution backstop across all contexts — a runaway
 * repair→resume→trip cycle stops here even if per-context caps were raised.
 */
export const PLAN_REPAIR_MAX_ROUNDS_PER_EXECUTION = 5;

export type PlanRepairHaltType = "circuit_breaker" | "max_iterations";

export type PlanRepairTriggerVerdict =
  | {
      eligible: true;
      contextId: string;
      haltType: PlanRepairHaltType;
      /** 1-based attempt number this round would be for the context. */
      attempt: number;
      policy: GraphWorkflowPlanRepairPolicy;
    }
  | {
      eligible: false;
      reason:
        | "not_halted"
        | "halt_kind"
        | "unknown_context"
        | "disabled"
        | "context_attempts_exhausted"
        | "execution_rounds_exhausted";
    };

export function evaluatePlanRepairTrigger(
  execution: GraphWorkflowExecution,
): PlanRepairTriggerVerdict {
  if (execution.status !== "halted" || execution.haltReason === null) {
    return { eligible: false, reason: "not_halted" };
  }

  const haltReason = execution.haltReason;
  if (
    haltReason.type !== "circuit_breaker" &&
    haltReason.type !== "max_iterations"
  ) {
    return { eligible: false, reason: "halt_kind" };
  }

  const contextId = haltReason.contextId;
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    return { eligible: false, reason: "unknown_context" };
  }

  const policy = context.planRepair;
  if (!policy.enabled) {
    return { eligible: false, reason: "disabled" };
  }

  // Rounds are appended BEFORE the agent runs, so crashed rounds count too —
  // exhaustion is deliberately conservative.
  const totalRounds = execution.planRepairRounds.length;
  if (totalRounds >= PLAN_REPAIR_MAX_ROUNDS_PER_EXECUTION) {
    return { eligible: false, reason: "execution_rounds_exhausted" };
  }
  const contextRounds = execution.planRepairRounds.filter(
    (round) => round.contextId === contextId,
  ).length;
  if (contextRounds >= policy.maxAttemptsPerContext) {
    return { eligible: false, reason: "context_attempts_exhausted" };
  }

  return {
    eligible: true,
    contextId,
    haltType: haltReason.type,
    attempt: contextRounds + 1,
    policy,
  };
}
