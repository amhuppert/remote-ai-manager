/**
 * Circuit-breaker gate for the workflow primitive layer.
 *
 * Surfaces the canonical "give up after N consecutive failures" decision as
 * a shared `GateResult`. The owning workflow records each consecutive
 * failure on its own state (e.g. `consecutiveFailureCount` per context in
 * the existing graph workflow execution) and consults this gate before the
 * next attempt.
 *
 * Behavior:
 *  - `failureCount < threshold` → `pass`. The workflow may continue.
 *  - `failureCount >= threshold` → `fail`. The breaker has tripped; the
 *    workflow should halt the affected lane / context rather than retry.
 *
 * Inputs are validated:
 *  - `threshold` must be positive (≥ 1). A zero or negative threshold would
 *    trip on the first attempt and almost certainly indicates a config bug
 *    upstream, so it is rejected at the boundary instead of being silently
 *    treated as "always tripped".
 *  - `failureCount` must be non-negative.
 */

import {
  gateFail,
  gatePass,
  type GateFailResult,
  type GatePassResult,
} from "./gate-vocabulary";

export interface RunCircuitBreakerGateInput {
  failureCount: number;
  threshold: number;
}

export type CircuitBreakerGateResult = GatePassResult | GateFailResult;

export function runCircuitBreakerGate(
  input: RunCircuitBreakerGateInput,
): CircuitBreakerGateResult {
  const { failureCount, threshold } = input;

  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(
      `runCircuitBreakerGate: threshold must be a positive integer, received ${threshold}`,
    );
  }
  if (!Number.isInteger(failureCount) || failureCount < 0) {
    throw new Error(
      `runCircuitBreakerGate: failureCount must be a non-negative integer, received ${failureCount}`,
    );
  }

  if (failureCount >= threshold) {
    return gateFail({
      kind: "circuit_breaker",
      reason: `circuit breaker tripped: ${failureCount} consecutive failures >= threshold ${threshold}`,
      details: { failureCount, threshold, tripped: true },
    });
  }

  return gatePass({
    kind: "circuit_breaker",
    details: { failureCount, threshold, tripped: false },
  });
}
