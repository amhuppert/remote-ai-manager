/**
 * Context-limit gate for the workflow primitive layer.
 *
 * Decides whether a lane should rotate before the next turn based on the
 * workflow's context-limit policy and the metrics that the lane's backend
 * actually exposes. The shared lane vocabulary already keeps Claude vs Codex
 * metrics in discriminated branches, so the gate trusts those branches and
 * never invents context-window numbers a backend cannot supply.
 *
 * Outcomes route through the shared `GateResult` vocabulary:
 *  - `pass` with `evaluation: "disabled"` when no `contextLimitTokens` policy
 *    is configured for the lane.
 *  - `pass` with `evaluation: "unsupported"` when a policy is configured but
 *    the backend does not expose context metrics (Codex today).
 *  - `pass` with `evaluation: "metrics_unavailable"` when the backend
 *    supports metrics but has not yet recorded a `contextTokens` value (e.g.
 *    before the first turn, or for an outcome the backend skipped).
 *  - `pass` with `evaluation: "no_rotation"` when context tokens are at or
 *    below the configured limit.
 *  - `fail` with `evaluation: "rotation_required"` when context tokens exceed
 *    the limit, OR when the lane already carries `rotateBeforeNextTurn:
 *    true` (a previous turn flagged rotation that has not yet been honored).
 */

import {
  gateFail,
  gatePass,
  type GateFailResult,
  type GatePassResult,
} from "./gate-vocabulary";
import type { LanePolicy, LaneMetrics } from "./lane-vocabulary";

export interface RunContextLimitGateInput {
  metrics: LaneMetrics;
  policy: Pick<LanePolicy, "contextLimitTokens"> | LanePolicy;
}

export type ContextLimitGateResult = GatePassResult | GateFailResult;

export function runContextLimitGate(
  input: RunContextLimitGateInput,
): ContextLimitGateResult {
  const { metrics, policy } = input;
  const limit = policy.contextLimitTokens;

  if (metrics.rotateBeforeNextTurn) {
    return gateFail({
      kind: "context_limit",
      reason: "rotation required by lane state",
      details: { evaluation: "rotation_required" },
    });
  }

  if (limit === undefined) {
    return gatePass({
      kind: "context_limit",
      details: { evaluation: "disabled" },
    });
  }

  if (metrics.backend === "codex") {
    return gatePass({
      kind: "context_limit",
      details: { evaluation: "unsupported" },
    });
  }

  const contextTokens = metrics.contextTokens;
  if (contextTokens === undefined) {
    return gatePass({
      kind: "context_limit",
      details: { evaluation: "metrics_unavailable", limit },
    });
  }

  if (contextTokens > limit) {
    return gateFail({
      kind: "context_limit",
      reason: `context-limit rotation required: ${contextTokens} > ${limit}`,
      details: {
        evaluation: "rotation_required",
        contextTokens,
        limit,
      },
    });
  }

  return gatePass({
    kind: "context_limit",
    details: {
      evaluation: "no_rotation",
      contextTokens,
      limit,
    },
  });
}
