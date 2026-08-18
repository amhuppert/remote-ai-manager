export const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3;

/**
 * The per-execution total-pass backstop (D4 R10): every pass admitted by every
 * loop group in one execution counts against this single ceiling.
 *
 * It is a HARD CONSTANT, not a policy. There is deliberately no config field,
 * no live-edit operation and no plan-repair operation that can raise it — a
 * loop's own `maxPasses` is the raisable budget, and an audited repair may amend
 * that; this one bounds every loop together so a repaired cap can never turn a
 * runaway graph into an unbounded one. It lives here, beside the other engine
 * budget constants, because both the accept-time cap ceiling (`loop-resolver`)
 * and the runtime slot admission (`loop-budgets`) have to read the same number.
 */
export const EXECUTION_TOTAL_PASS_BACKSTOP = 25;

/**
 * How many rounds in a row may conclude `candidate_mismatch` before the context
 * halts as unstable.
 *
 * A mismatch charges nothing and returns the context to `ready`, so the engine
 * re-opens a round at once — the right response to drift that settles (a write
 * landing while the tree freezes) and an unbounded loop when it cannot. The
 * number is deliberately generous: legitimate transient drift clears in a round
 * or two, so a run of this length is only ever a defect.
 *
 * A HARD CONSTANT rather than a policy field, for the same reason as the pass
 * backstop above: it exists to bound a loop no other budget can see, and a
 * raisable ceiling would restore the loop it removes.
 */
export const CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET = 5;

/**
 * The threshold the breaker actually enforces for a context.
 *
 * The policy field is optional, so "no threshold declared" is a valid and
 * common state that still trips at the default. Read surfaces resolve through
 * here rather than reading the field, so a chip cannot report a budget the
 * engine does not use — the structural parameter keeps this usable from both
 * the engine (a resolved context) and the UI (any policy-shaped object).
 */
export function resolveConsecutiveFailureThreshold(
  circuitBreaker: { consecutiveFailureThreshold?: number } | null | undefined,
): number {
  return (
    circuitBreaker?.consecutiveFailureThreshold ??
    DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD
  );
}
