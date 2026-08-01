export const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3;

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
