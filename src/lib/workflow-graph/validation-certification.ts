import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationRound,
} from "./schemas";
import { landGatedPublishSettlement } from "./lane-readiness";

type ValidationRoundSnapshot = Pick<
  GraphWorkflowValidationRound,
  "seq" | "phase" | "outcome"
>;

export type ValidationCertification =
  | { status: "not_required" }
  | { status: "passed"; roundSeq: number }
  | {
      status: "owed";
      reason: "round_absent" | "round_open" | "round_concluded_without_pass";
      round: ValidationRoundSnapshot | null;
    };

export interface ValidationCertificationDebt {
  contextId: string;
  certification: Extract<ValidationCertification, { status: "owed" }>;
}

export function validationCertification(
  execution: GraphWorkflowExecution,
  contextId: string,
): ValidationCertification {
  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === contextId,
  );
  const validationRequired =
    (context?.scriptValidator?.commands.length ?? 0) > 0 ||
    context?.contextValidator?.enabled === true;
  if (!validationRequired) return { status: "not_required" };

  const round = execution.contextStates[contextId]?.validationRound;
  if (round === null || round === undefined) {
    return { status: "owed", reason: "round_absent", round: null };
  }

  const roundSnapshot: ValidationRoundSnapshot = {
    seq: round.seq,
    phase: round.phase,
    outcome: round.outcome,
  };
  if (round.phase !== "concluded") {
    return {
      status: "owed",
      reason: "round_open",
      round: roundSnapshot,
    };
  }
  if (round.outcome === "passed") {
    return { status: "passed", roundSeq: round.seq };
  }
  return {
    status: "owed",
    reason: "round_concluded_without_pass",
    round: roundSnapshot,
  };
}

export function findValidationCertificationDebt(
  execution: GraphWorkflowExecution,
): ValidationCertificationDebt[] {
  const skippedContextIds = new Set(
    landGatedPublishSettlement(execution).skippedContextIds,
  );
  const debt: ValidationCertificationDebt[] = [];

  for (const context of execution.workingDefinition.executionContexts) {
    if (skippedContextIds.has(context.id)) continue;
    const certification = validationCertification(execution, context.id);
    if (certification.status !== "owed") continue;
    debt.push({ contextId: context.id, certification });
  }

  return debt;
}

export function describeValidationCertificationDebt(
  debt: ValidationCertificationDebt,
): string {
  const { round } = debt.certification;
  if (round === null) return `${debt.contextId} (no validation round)`;
  return `${debt.contextId} (round ${round.seq}, phase ${round.phase}, outcome ${round.outcome ?? "null"})`;
}
