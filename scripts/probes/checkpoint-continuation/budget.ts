/**
 * Deterministic call accounting for the checkpoint continuation probe.
 *
 * A live probe spends real provider credit, so the bound has to be structural
 * rather than a habit. `admit` is the only way to reach a provider call, it
 * runs immediately before that call, and it consumes the slot at that moment —
 * so a call that is refused was never made, and a call that was made is
 * counted even if it then throws. An earlier version reserved an estimated
 * number of calls up front and reconciled afterwards, which audited the cap
 * instead of enforcing it: a repair pass could spend past the ceiling and only
 * be noticed once the money was gone.
 *
 * Cost is reported as priced-or-unavailable and never as zero — a provider
 * that declines to report a price has not told us the call was free — and a
 * price is never reported without saying who produced it, because the two
 * adapters this probe certifies do not price a call the same way.
 */

import type { AgentBackendId } from "@/lib/shared/schemas";

export type ProbeCallKind = "ordinary" | "compaction";

/**
 * What produced a cost number.
 *
 * An estimate names its estimator, so nothing downstream can read a
 * pricing-table product as a figure the provider billed (R9.3).
 */
export type ProbeCostSource =
  | { readonly kind: "provider_reported" }
  | { readonly kind: "estimated"; readonly estimator: string };

/**
 * Where a call's price comes from, as the adapters actually compute it:
 * Claude passes through the SDK's own `total_cost_usd`, while Codex has no
 * provider price at all and applies CC's pricing table to reported tokens.
 *
 * This is a property of the backend that ran the individual call, not of the
 * run: a Codex conversation still folds its checkpoint on the configured
 * compaction backend, so one run legitimately mixes both provenances.
 */
export function costSourceForBackend(backend: AgentBackendId): ProbeCostSource {
  return backend === "codex"
    ? { kind: "estimated", estimator: "cc:estimateCodexCostUsd" }
    : { kind: "provider_reported" };
}

export interface ProbeCallBudget {
  ordinary: number;
  compaction: number;
}

/** The delivery contract's per-run ceiling. */
export const CHECKPOINT_PROBE_BUDGET: ProbeCallBudget = {
  ordinary: 12,
  compaction: 6,
};

export class ProbeBudgetExceededError extends Error {
  constructor(
    readonly kind: ProbeCallKind,
    readonly used: number,
    readonly limit: number,
  ) {
    super(
      `${kind} call budget exhausted: ${used} of ${limit} already spent, and this call would exceed it`,
    );
    this.name = "ProbeBudgetExceededError";
  }
}

/** What `settle` reports about a call that has now returned. */
export interface ProbeCallMeasurement {
  /** Null when the backend reported no cost for this call. */
  costUsd: number | null;
}

export interface ProbeCall {
  kind: ProbeCallKind;
  label: string;
  backend: AgentBackendId;
  costUsd: number | null;
  /** Null exactly when there is no number to attribute. */
  costSource: ProbeCostSource | null;
  /** False when the call was admitted but never reported a measurement. */
  settled: boolean;
}

/** Opaque handle for the admitted call a measurement belongs to. */
export interface ProbeCallToken {
  readonly index: number;
}

export interface ProbeCallTotals {
  ordinary: number;
  compaction: number;
  /** Sum over the calls the provider itself priced. */
  providerReportedCostUsd: number;
  callsWithProviderReportedCost: number;
  /** Sum over the calls a CC-side estimator priced. Never added to the above. */
  estimatedCostUsd: number;
  callsWithEstimatedCost: number;
  /** Every estimator that contributed to `estimatedCostUsd`. */
  costEstimators: readonly string[];
  /** Calls whose cost is unavailable — not zero. */
  callsWithUnavailableCost: number;
}

export interface ProbeCallLedger {
  /**
   * Claim the slot for a call about to be made. Throws
   * `ProbeBudgetExceededError` instead of returning, so a caller cannot reach
   * the provider by ignoring a result.
   */
  admit(
    kind: ProbeCallKind,
    label: string,
    backend: AgentBackendId,
  ): ProbeCallToken;
  settle(token: ProbeCallToken, measurement: ProbeCallMeasurement): void;
  calls(): readonly ProbeCall[];
  remaining(kind: ProbeCallKind): number;
  totals(): ProbeCallTotals;
}

export interface ProbeCallLedgerOptions {
  budget?: ProbeCallBudget;
}

export function createProbeCallLedger(
  options: ProbeCallLedgerOptions = {},
): ProbeCallLedger {
  const budget = options.budget ?? CHECKPOINT_PROBE_BUDGET;
  const used: Record<ProbeCallKind, number> = { ordinary: 0, compaction: 0 };
  const calls: ProbeCall[] = [];
  return {
    admit(kind, label, backend) {
      if (used[kind] + 1 > budget[kind]) {
        throw new ProbeBudgetExceededError(kind, used[kind], budget[kind]);
      }
      used[kind] += 1;
      const index =
        calls.push({
          kind,
          label,
          backend,
          costUsd: null,
          costSource: null,
          settled: false,
        }) - 1;
      return { index };
    },
    settle(token, measurement) {
      const call = calls[token.index];
      if (!call) throw new Error(`no admitted call at index ${token.index}`);
      call.costUsd = measurement.costUsd;
      call.costSource =
        measurement.costUsd === null
          ? null
          : costSourceForBackend(call.backend);
      call.settled = true;
    },
    calls() {
      return calls;
    },
    remaining(kind) {
      return budget[kind] - used[kind];
    },
    totals() {
      const priced = calls.filter(
        (call): call is ProbeCall & { costUsd: number } =>
          call.costUsd !== null,
      );
      const reported = priced.filter(
        (call) => call.costSource?.kind === "provider_reported",
      );
      const estimated = priced.filter(
        (call) => call.costSource?.kind === "estimated",
      );
      const sum = (subset: readonly (ProbeCall & { costUsd: number })[]) =>
        subset.reduce((total, call) => total + call.costUsd, 0);
      return {
        ordinary: used.ordinary,
        compaction: used.compaction,
        providerReportedCostUsd: sum(reported),
        callsWithProviderReportedCost: reported.length,
        estimatedCostUsd: sum(estimated),
        callsWithEstimatedCost: estimated.length,
        costEstimators: [
          ...new Set(
            estimated.flatMap((call) =>
              call.costSource?.kind === "estimated"
                ? [call.costSource.estimator]
                : [],
            ),
          ),
        ],
        callsWithUnavailableCost: calls.length - priced.length,
      };
    },
  };
}
