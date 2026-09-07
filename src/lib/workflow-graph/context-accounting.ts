import { type GraphWorkflowTaskValidationFailure } from "@/lib/workflow-graph/schemas";
import type { ValidationRoundOutcome } from "./validation-round";

/**
 * Cap for a task's append-only `failureHistory`. The sole consumer renders the
 * full array into the retry prompt (`iteration-prompt.ts`), where only the most
 * recent failures matter; the cap is a guardrail against a pathological
 * validation loop growing the persisted execution blob without bound.
 */
const MAX_FAILURE_HISTORY = 10;

/**
 * Append one validation failure to a task's history, keeping only the most
 * recent {@link MAX_FAILURE_HISTORY} entries. Pure.
 */
export function appendFailureHistory(
  existing: GraphWorkflowTaskValidationFailure[] | undefined,
  entry: GraphWorkflowTaskValidationFailure,
): GraphWorkflowTaskValidationFailure[] {
  return [...(existing ?? []), entry].slice(-MAX_FAILURE_HISTORY);
}

type ContextCounters = Pick<
  import("./schemas").GraphWorkflowExecutionContextState,
  | "iterationCount"
  | "consecutiveFailureCount"
  | "consecutiveCandidateMismatchCount"
>;

export type ContextAccountingAction =
  | { kind: "iteration_started" }
  | { kind: "semantic_rejection" }
  | { kind: "ordinary_terminal_error" }
  | { kind: "output_rejection" }
  | { kind: "certified" }
  | {
      kind: "round_concluded";
      outcome: ValidationRoundOutcome | null;
    }
  | { kind: "manual_resume" }
  | { kind: "question_parked"; restoreIterationCount: number };

export function initialContextAccounting(): ContextCounters {
  return {
    iterationCount: 0,
    consecutiveFailureCount: 0,
    consecutiveCandidateMismatchCount: 0,
  };
}

export function accountContextAction(
  state: ContextCounters,
  action: ContextAccountingAction,
): ContextCounters {
  const counters: ContextCounters = {
    iterationCount: state.iterationCount,
    consecutiveFailureCount: state.consecutiveFailureCount,
    consecutiveCandidateMismatchCount: state.consecutiveCandidateMismatchCount,
  };
  switch (action.kind) {
    case "iteration_started":
      return { ...counters, iterationCount: counters.iterationCount + 1 };
    case "semantic_rejection":
    case "ordinary_terminal_error":
      return {
        ...counters,
        consecutiveFailureCount: counters.consecutiveFailureCount + 1,
      };
    case "output_rejection":
      return {
        ...counters,
        iterationCount: counters.iterationCount + 1,
        consecutiveFailureCount: counters.consecutiveFailureCount + 1,
      };
    case "certified":
      return { ...counters, consecutiveFailureCount: 0 };
    case "round_concluded":
      return {
        ...counters,
        consecutiveCandidateMismatchCount:
          action.outcome === "candidate_mismatch"
            ? counters.consecutiveCandidateMismatchCount + 1
            : 0,
      };
    case "manual_resume":
      return {
        ...counters,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
      };
    case "question_parked":
      return { ...counters, iterationCount: action.restoreIterationCount };
  }
}
