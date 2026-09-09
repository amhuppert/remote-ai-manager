import { describe, expect, it } from "vitest";

import type {
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";

import {
  getTaskRunner,
  listBackends,
} from "@/lib/agent-backends/registry-core";
import { bootstrapBackends } from "@/lib/agent-backends/registry";

import { createProbeCallLedger, ProbeBudgetExceededError } from "./budget";
import {
  guardTaskRunner,
  instrumentTaskRunnersForProbe,
} from "./instrumentation";

function result(costUsd: number | null): AgentTaskResult {
  return {
    text: "ok",
    usage: { costUsd },
    error: null,
    timedOut: false,
    failure: null,
    continuationDisposition: "retain",
  };
}

const request = {} as AgentTaskRequest;

describe("guardTaskRunner", () => {
  it("admits the call before the runner is reached", async () => {
    const ledger = createProbeCallLedger({
      budget: { ordinary: 1, compaction: 1 },
    });
    let reached = 0;
    const guarded = guardTaskRunner(
      {
        backend: "claude",
        run: async () => {
          reached += 1;
          return result(0.25);
        },
      },
      ledger,
    );

    await guarded.run(request);
    // The second call is over the cap, so the runner must never see it: the
    // point of the guard is that the money is not spent, not that it is
    // noticed afterwards.
    await expect(guarded.run(request)).rejects.toThrow(
      ProbeBudgetExceededError,
    );

    expect(reached).toBe(1);
    expect(ledger.totals().compaction).toBe(1);
  });

  it("records what the call actually cost, per generation pass", async () => {
    const ledger = createProbeCallLedger();
    const costs = [0.1, null, 0.3];
    let call = 0;
    const guarded = guardTaskRunner(
      {
        backend: "claude",
        run: async () => result(costs[call++] ?? null),
      },
      ledger,
    );

    await guarded.run(request);
    await guarded.run(request);
    await guarded.run(request);

    expect(ledger.calls().map((entry) => entry.costUsd)).toEqual([
      0.1,
      null,
      0.3,
    ]);
    const totals = ledger.totals();
    expect(totals.providerReportedCostUsd).toBeCloseTo(0.4);
    expect(totals.callsWithUnavailableCost).toBe(1);
  });

  it("counts a failed pass, because the provider was still reached", async () => {
    const ledger = createProbeCallLedger();
    const guarded = guardTaskRunner(
      {
        backend: "claude",
        run: async () => {
          throw new Error("provider refused");
        },
      },
      ledger,
    );

    await expect(guarded.run(request)).rejects.toThrow("provider refused");
    expect(ledger.totals().compaction).toBe(1);
    expect(ledger.calls()[0]).toMatchObject({ settled: false });
  });

  it("attributes the call to the backend that ran it", async () => {
    const ledger = createProbeCallLedger();
    const guarded = guardTaskRunner(
      { backend: "codex", run: async () => result(0.5) },
      ledger,
    );

    await guarded.run(request);

    expect(ledger.calls()[0]).toMatchObject({
      backend: "codex",
      costSource: { kind: "estimated", estimator: "cc:estimateCodexCostUsd" },
    });
  });
});

describe("instrumentTaskRunnersForProbe", () => {
  it("puts the guard in front of the backends the registry already holds", async () => {
    bootstrapBackends();
    const before = listBackends().map((descriptor) => descriptor.id);
    const ledger = createProbeCallLedger();

    // The registry refuses a duplicate registration, so instrumenting has to
    // replace the existing entries rather than add to them. This is the step
    // that fails loudly at probe startup when it is done wrongly.
    instrumentTaskRunnersForProbe(ledger);

    expect(listBackends().map((descriptor) => descriptor.id)).toEqual(before);
    const runner = getTaskRunner("claude");
    await expect(
      // Reaching the real adapter is not the point: admission is, and it
      // happens before the runner is called.
      runner.run({} as never).catch(() => undefined),
    ).resolves.toBeUndefined();
    expect(ledger.totals().compaction).toBe(1);
  });
});
