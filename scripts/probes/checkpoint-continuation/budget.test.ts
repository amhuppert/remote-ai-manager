import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_PROBE_BUDGET,
  ProbeBudgetExceededError,
  createProbeCallLedger,
} from "./budget";

describe("probe call ledger", () => {
  it("refuses the call that would exceed the cap before it is made", () => {
    const ledger = createProbeCallLedger({
      budget: { ordinary: 1, compaction: 1 },
    });
    ledger.admit("compaction", "fold", "claude");

    // The refusal arrives from admit(), which runs before the provider call —
    // not from a post-hoc record of money already spent.
    expect(() => ledger.admit("compaction", "repair", "claude")).toThrow(
      ProbeBudgetExceededError,
    );
    expect(ledger.remaining("compaction")).toBe(0);
  });

  it("counts an admitted call that then fails, because the spend happened", () => {
    const ledger = createProbeCallLedger({
      budget: { ordinary: 2, compaction: 2 },
    });
    ledger.admit("ordinary", "turn", "codex");

    // No settle(): the call threw. The slot must not come back.
    expect(ledger.remaining("ordinary")).toBe(1);
  });

  it("prices each call by the backend that actually ran it", () => {
    const ledger = createProbeCallLedger();
    // A Codex conversation still folds its checkpoint on the configured
    // compaction backend, so one run mixes both pricing provenances.
    ledger.settle(ledger.admit("ordinary", "turn", "codex"), {
      costUsd: 0.5,
    });
    ledger.settle(ledger.admit("compaction", "fold", "claude"), {
      costUsd: 0.25,
    });

    const totals = ledger.totals();
    expect(totals.estimatedCostUsd).toBeCloseTo(0.5);
    expect(totals.callsWithEstimatedCost).toBe(1);
    expect(totals.costEstimators).toEqual(["cc:estimateCodexCostUsd"]);
    expect(totals.providerReportedCostUsd).toBeCloseTo(0.25);
    expect(totals.callsWithProviderReportedCost).toBe(1);
  });

  it("reports an unavailable price as unavailable rather than zero", () => {
    const ledger = createProbeCallLedger();
    ledger.settle(ledger.admit("ordinary", "drained", "claude"), {
      costUsd: null,
    });

    const totals = ledger.totals();
    expect(totals.callsWithUnavailableCost).toBe(1);
    expect(totals.callsWithProviderReportedCost).toBe(0);
    expect(totals.providerReportedCostUsd).toBe(0);
  });

  it("keeps every per-call measurement for the report", () => {
    const ledger = createProbeCallLedger();
    ledger.settle(ledger.admit("ordinary", "warm-up", "claude"), {
      costUsd: 0.1,
    });
    ledger.settle(ledger.admit("compaction", "seed pass", "claude"), {
      costUsd: null,
    });

    expect(ledger.calls()).toEqual([
      {
        kind: "ordinary",
        label: "warm-up",
        backend: "claude",
        costUsd: 0.1,
        costSource: { kind: "provider_reported" },
        settled: true,
      },
      {
        kind: "compaction",
        label: "seed pass",
        backend: "claude",
        costUsd: null,
        costSource: null,
        settled: true,
      },
    ]);
  });

  it("marks an admitted-but-unsettled call so a lost measurement is visible", () => {
    const ledger = createProbeCallLedger();
    ledger.admit("ordinary", "abandoned", "claude");

    expect(ledger.calls()[0]).toMatchObject({ settled: false, costUsd: null });
    expect(ledger.totals().callsWithUnavailableCost).toBe(1);
  });

  it("keeps the delivery contract's ceiling as the default", () => {
    expect(CHECKPOINT_PROBE_BUDGET).toEqual({ ordinary: 12, compaction: 6 });
  });
});
