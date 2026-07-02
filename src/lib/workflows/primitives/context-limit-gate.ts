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
 *  - `fail` with `evaluation: "rotation_required"` when the turn auto-compacted
 *    (`compactedThisTurn`) under a configured limit — compaction deflates the
 *    occupancy metric, so the reading can no longer be trusted below the limit.
 *  - `pass` with `evaluation: "metrics_unavailable"` when the backend
 *    supports metrics but has not yet recorded a `contextTokens` value (e.g.
 *    before the first turn, or for an outcome the backend skipped).
 *  - `pass` with `evaluation: "no_rotation"` when context tokens are at or
 *    below the configured limit.
 *  - `fail` with `evaluation: "rotation_required"` when context tokens exceed
 *    the limit, OR when the lane already carries `rotateBeforeNextTurn:
 *    true` (a previous turn flagged rotation that has not yet been honored).
 */

import { z } from "zod";
import {
  gateFail,
  gatePass,
  type GateFailResult,
  type GatePassResult,
} from "./gate-vocabulary";
import type { LanePolicy, LaneMetrics } from "./lane-vocabulary";

/**
 * The full taxonomy of context-limit decisions. Ordered by capability rather
 * than by the branch precedence used inside `evaluateContextLimit`:
 *
 *  - `disabled` — no `contextLimitTokens` policy configured.
 *  - `unsupported` — a policy is set but the backend cannot report context
 *    occupancy (Codex today).
 *  - `rotation_required` (compaction) — the optional `compactedThisTurn` input
 *    is true under a configured limit; the occupancy metric is masked by the
 *    auto-compaction, so the branch fires before `metrics_unavailable` and the
 *    numeric comparison, but after `disabled`/`unsupported` so a disabled
 *    feature never rotates and Codex stays honestly unsupported.
 *  - `metrics_unavailable` — the backend supports occupancy metrics but has
 *    not yet recorded a `contextTokens` value.
 *  - `no_rotation` — occupancy is at or below the configured limit.
 *  - `rotation_required` — occupancy exceeds the limit, or the lane already
 *    carries `rotateBeforeNextTurn: true`.
 */
export const contextLimitEvaluationSchema = z.enum([
  "disabled",
  "unsupported",
  "metrics_unavailable",
  "no_rotation",
  "rotation_required",
]);
export type ContextLimitEvaluation = z.infer<
  typeof contextLimitEvaluationSchema
>;

export interface RunContextLimitGateInput {
  metrics: LaneMetrics;
  policy: Pick<LanePolicy, "contextLimitTokens"> | LanePolicy;
}

export type ContextLimitGateResult = GatePassResult | GateFailResult;

/**
 * Pure decision function: given a lane's metrics and its context-limit policy,
 * classify whether the lane must rotate. The branch order is significant — an
 * already-flagged `rotateBeforeNextTurn` sticks regardless of occupancy, and a
 * missing policy short-circuits before any backend/occupancy inspection. The
 * optional, outcome-scoped `compactedThisTurn` forces rotation when a turn
 * auto-compacted under a configured limit — after `disabled`/`unsupported` so
 * those short-circuits win, but before the occupancy checks the compaction
 * would otherwise mask.
 */
export function evaluateContextLimit(input: {
  metrics: LaneMetrics;
  policy: Pick<LanePolicy, "contextLimitTokens">;
  compactedThisTurn?: boolean;
}): ContextLimitEvaluation {
  const { metrics, policy, compactedThisTurn } = input;

  if (metrics.rotateBeforeNextTurn) {
    return "rotation_required";
  }

  const limit = policy.contextLimitTokens;
  if (limit === undefined) {
    return "disabled";
  }

  if (metrics.backend === "codex") {
    return "unsupported";
  }

  if (compactedThisTurn === true) {
    return "rotation_required";
  }

  if (metrics.contextTokens === undefined) {
    return "metrics_unavailable";
  }

  if (metrics.contextTokens > limit) {
    return "rotation_required";
  }

  return "no_rotation";
}

export function runContextLimitGate(
  input: RunContextLimitGateInput,
): ContextLimitGateResult {
  const { metrics, policy } = input;
  const limit = policy.contextLimitTokens;
  const contextTokens =
    metrics.backend === "claude" ? metrics.contextTokens : undefined;
  const evaluation = evaluateContextLimit({ metrics, policy });

  switch (evaluation) {
    case "disabled":
      return gatePass({
        kind: "context_limit",
        details: { evaluation },
      });

    case "unsupported":
      return gatePass({
        kind: "context_limit",
        details: { evaluation },
      });

    case "metrics_unavailable":
      return gatePass({
        kind: "context_limit",
        details: { evaluation, limit },
      });

    case "no_rotation":
      return gatePass({
        kind: "context_limit",
        details: { evaluation, contextTokens, limit },
      });

    case "rotation_required": {
      if (metrics.rotateBeforeNextTurn) {
        return gateFail({
          kind: "context_limit",
          reason: "rotation required by lane state",
          details: { evaluation },
        });
      }
      return gateFail({
        kind: "context_limit",
        reason: `context-limit rotation required: ${contextTokens} > ${limit}`,
        details: { evaluation, contextTokens, limit },
      });
    }
  }
}
