/**
 * The plan-repair trigger predicate (docs/design/cc-cli/08 §Trigger policy).
 * Pure — the supervisor evaluates it against a FRESH read of the active
 * execution after a loop settles (never the loop's possibly-fenced snapshot).
 */

import type { GraphWorkflowPlanRepairPolicy } from "../config-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "../schemas";

/**
 * Hard per-execution backstop across all contexts — a runaway
 * repair→resume→trip cycle stops here even if per-context caps were raised.
 */
export const PLAN_REPAIR_MAX_ROUNDS_PER_EXECUTION = 5;

export type PlanRepairHaltType =
  | "circuit_breaker"
  | "max_iterations"
  // A loop that exhausted a pass budget (D4 R12). Its remedies are the three
  // loop-control ops rather than a context edit: the halt names a pass instance
  // that will never run again.
  | "loop_limit_reached"
  // Drift on a shared lane (lightweight parallelism R8). Repairable for the
  // same reason it is resumable: the fix is an ownership widening on a context
  // through `update-context`, which is already in the repair agent's vocabulary.
  | "ownership_violation";

export type PlanRepairTriggerVerdict =
  | {
      eligible: true;
      contextId: string;
      haltType: PlanRepairHaltType;
      /** The loop this round repairs; null for a context halt. */
      loopGroupId: string | null;
      /** Which loop budget refused; null for a context halt. */
      loopScope: "loop" | "execution" | null;
      /** 1-based attempt number this round would be for the repair subject. */
      attempt: number;
      policy: GraphWorkflowPlanRepairPolicy;
    }
  | {
      eligible: false;
      reason:
        | "not_halted"
        | "halt_kind"
        | "unknown_context"
        | "unknown_loop_group"
        | "disabled"
        | "context_attempts_exhausted"
        | "execution_rounds_exhausted";
    };

/**
 * What a round is accounted against, and under whose policy.
 *
 * A context halt keys on the tripped context. A loop halt keys on the LOOP
 * GROUP (decision D10): every pass instance is a fresh context, so per-context
 * accounting would hand each new pass an untouched budget of repairs, and the
 * policy has to come from the group — the pass instance's own copy is a clone
 * of the body template's, not the loop's.
 */
interface PlanRepairSubject {
  contextId: string;
  loopGroupId: string | null;
  loopScope: "loop" | "execution" | null;
  policy: GraphWorkflowPlanRepairPolicy;
  /** Rounds already spent on this subject. */
  priorAttempts: number;
}

type RepairableHaltReason = Extract<
  GraphWorkflowHaltReason,
  { type: PlanRepairHaltType }
>;

type SubjectResolution =
  | { ok: true; subject: PlanRepairSubject }
  | { ok: false; reason: "unknown_context" | "unknown_loop_group" };

function resolveSubject(
  execution: GraphWorkflowExecution,
  haltReason: RepairableHaltReason,
): SubjectResolution {
  if (haltReason.type === "loop_limit_reached") {
    const group = execution.workingDefinition.loopGroups?.find(
      (candidate) => candidate.id === haltReason.loopGroupId,
    );
    // Only a RESOLVED group carries the seed-resolved policy; an authored one
    // means this execution never seeded its loops, so there is nothing to
    // repair against.
    if (!group || !("planRepair" in group)) {
      return { ok: false, reason: "unknown_loop_group" };
    }
    return {
      ok: true,
      subject: {
        contextId: haltReason.contextId,
        loopGroupId: group.id,
        loopScope: haltReason.scope,
        policy: group.planRepair,
        priorAttempts: execution.planRepairRounds.filter(
          (round) => round.loopGroupId === group.id,
        ).length,
      },
    };
  }

  const contextId = haltReason.contextId;
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) return { ok: false, reason: "unknown_context" };
  return {
    ok: true,
    subject: {
      contextId,
      loopGroupId: null,
      loopScope: null,
      policy: context.planRepair,
      priorAttempts: execution.planRepairRounds.filter(
        (round) => round.loopGroupId === null && round.contextId === contextId,
      ).length,
    },
  };
}

export function evaluatePlanRepairTrigger(
  execution: GraphWorkflowExecution,
): PlanRepairTriggerVerdict {
  if (execution.status !== "halted" || execution.haltReason === null) {
    return { eligible: false, reason: "not_halted" };
  }

  const haltReason = execution.haltReason;
  if (
    haltReason.type !== "circuit_breaker" &&
    haltReason.type !== "max_iterations" &&
    haltReason.type !== "loop_limit_reached" &&
    haltReason.type !== "ownership_violation"
  ) {
    return { eligible: false, reason: "halt_kind" };
  }

  const resolved = resolveSubject(execution, haltReason);
  if (!resolved.ok) return { eligible: false, reason: resolved.reason };
  const { subject } = resolved;

  if (!subject.policy.enabled) {
    return { eligible: false, reason: "disabled" };
  }

  // Rounds are appended BEFORE the agent runs, so crashed rounds count too —
  // exhaustion is deliberately conservative.
  const totalRounds = execution.planRepairRounds.length;
  if (totalRounds >= PLAN_REPAIR_MAX_ROUNDS_PER_EXECUTION) {
    return { eligible: false, reason: "execution_rounds_exhausted" };
  }
  if (subject.priorAttempts >= subject.policy.maxAttemptsPerContext) {
    return { eligible: false, reason: "context_attempts_exhausted" };
  }

  return {
    eligible: true,
    contextId: subject.contextId,
    haltType: haltReason.type,
    loopGroupId: subject.loopGroupId,
    loopScope: subject.loopScope,
    attempt: subject.priorAttempts + 1,
    policy: subject.policy,
  };
}
