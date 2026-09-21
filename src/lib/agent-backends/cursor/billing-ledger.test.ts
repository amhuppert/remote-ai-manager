import { describe, expect, it } from "vitest";
import {
  CURSOR_BILLING_MAX_ATTRIBUTION_ATTEMPTS,
  applyBillingSnapshot,
  applyBillingUnavailable,
  billingRunsAwaitingSettlement,
  billingTurn,
  centsToUsd,
  cursorBillingLedgerSchema,
  emptyCursorBillingLedger,
  recordBillingTurnEnd,
  recordBillingTurnStart,
  turnBilledCost,
  type CursorBillingLedger,
  type CursorBillingSnapshotInput,
} from "./billing-ledger";

/**
 * The attribution and settlement rules, as pure state transitions. Every
 * scenario here is one the runtime must survive without double-counting or
 * erasing: repeated snapshots, late cost, ambiguous entries, exhausted
 * attribution, and a provider that refuses the feature outright.
 */

const AGENT = "agent-1";
const T0 = "2026-09-20T10:00:00.000Z";
const T1 = "2026-09-20T10:00:05.000Z";
const T2 = "2026-09-20T10:00:30.000Z";

const tokens = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: input + output,
});

function snapshot(
  runs: CursorBillingSnapshotInput["runs"],
  cost: CursorBillingSnapshotInput["cost"] = null,
): CursorBillingSnapshotInput {
  const usage = runs.reduce(
    (sum, run) => ({
      inputTokens: sum.inputTokens + run.usage.inputTokens,
      outputTokens: sum.outputTokens + run.usage.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: sum.totalTokens + run.usage.totalTokens,
    }),
    tokens(0, 0),
  );
  return { usage, cost, runs };
}

function dispatchedTurn(
  ledger: CursorBillingLedger,
  runId: string,
  turnTokens: ReturnType<typeof tokens> | null,
  startedAt = T0,
): CursorBillingLedger {
  const started = recordBillingTurnStart(ledger, {
    runId,
    agentId: AGENT,
    startedAt,
  });
  return recordBillingTurnEnd(started, {
    runId,
    agentId: AGENT,
    tokens: turnTokens,
    outcome: "completed",
    at: startedAt,
  });
}

describe("cursor billing ledger attribution", () => {
  it("attributes the one new entry of a post-turn snapshot to that turn and settles its cost", () => {
    const ledger = dispatchedTurn(
      emptyCursorBillingLedger(),
      "run-1",
      tokens(100, 20),
    );
    const applied = applyBillingSnapshot(ledger, {
      agentId: AGENT,
      forRunId: "run-1",
      snapshot: snapshot(
        [
          {
            runId: "uuid-a",
            usage: tokens(100, 20),
            cost: { rawCostCents: 4.25, chargedCents: 4.25 },
          },
        ],
        { rawCostCents: 4.25, chargedCents: 4.25 },
      ),
      at: T1,
    });

    expect(billingTurn(applied.ledger, "run-1")).toMatchObject({
      status: "settled",
      usageIds: ["uuid-a"],
    });
    expect(applied.deltaCents).toBe(4.25);
    expect(applied.deltaCentsByRun).toEqual({ "run-1": 4.25 });
    expect(applied.remainderDeltaCents).toBe(0);
    expect(applied.cumulativeAppliedCents).toBe(4.25);
    expect(turnBilledCost(applied.ledger, "run-1")).toEqual({
      rawCostCents: 4.25,
      chargedCents: 4.25,
    });
    expect(applied.ledger.availability.state).toBe("available");
    expect(centsToUsd(applied.deltaCents)).toBeCloseTo(0.0425);
  });

  it("keeps a costless entry attributed but unsettled, then applies the late cost exactly once", () => {
    const ledger = dispatchedTurn(
      emptyCursorBillingLedger(),
      "run-1",
      tokens(100, 20),
    );
    const first = applyBillingSnapshot(ledger, {
      agentId: AGENT,
      forRunId: "run-1",
      snapshot: snapshot([
        { runId: "uuid-a", usage: tokens(100, 20), cost: null },
      ]),
      at: T1,
    });
    expect(billingTurn(first.ledger, "run-1")?.status).toBe("attributed");
    expect(first.deltaCents).toBe(0);
    expect(turnBilledCost(first.ledger, "run-1")).toBeNull();
    expect(billingRunsAwaitingSettlement(first.ledger, AGENT)).toEqual([
      "run-1",
    ]);

    const late = snapshot(
      [
        {
          runId: "uuid-a",
          usage: tokens(100, 20),
          cost: { rawCostCents: 4, chargedCents: 4 },
        },
      ],
      { rawCostCents: 4, chargedCents: 4 },
    );
    const second = applyBillingSnapshot(first.ledger, {
      agentId: AGENT,
      forRunId: null,
      snapshot: late,
      at: T2,
    });
    expect(billingTurn(second.ledger, "run-1")?.status).toBe("settled");
    expect(second.deltaCents).toBe(4);
    expect(second.deltaCentsByRun).toEqual({ "run-1": 4 });
    expect(billingRunsAwaitingSettlement(second.ledger, AGENT)).toEqual([]);

    // Repeated polling of an unchanged provider state applies nothing.
    const third = applyBillingSnapshot(second.ledger, {
      agentId: AGENT,
      forRunId: null,
      snapshot: late,
      at: T2,
    });
    expect(third.deltaCents).toBe(0);
    expect(third.deltaCentsByRun).toEqual({});
    expect(third.cumulativeAppliedCents).toBe(4);
  });

  it("distinguishes a zero charge (plan-included usage) from an unknown cost", () => {
    const ledger = dispatchedTurn(
      emptyCursorBillingLedger(),
      "run-1",
      tokens(100, 20),
    );
    const applied = applyBillingSnapshot(ledger, {
      agentId: AGENT,
      forRunId: "run-1",
      snapshot: snapshot(
        [
          {
            runId: "uuid-a",
            usage: tokens(100, 20),
            cost: { rawCostCents: 3.5, chargedCents: 0 },
          },
        ],
        { rawCostCents: 3.5, chargedCents: 0 },
      ),
      at: T1,
    });
    expect(billingTurn(applied.ledger, "run-1")?.status).toBe("settled");
    expect(turnBilledCost(applied.ledger, "run-1")).toEqual({
      rawCostCents: 3.5,
      chargedCents: 0,
    });
    expect(applied.deltaCents).toBe(0);
  });

  it("leaves a turn pending while no entry has landed and bounds the attempts", () => {
    let ledger = dispatchedTurn(
      emptyCursorBillingLedger(),
      "run-1",
      tokens(100, 20),
    );
    for (
      let attempt = 1;
      attempt <= CURSOR_BILLING_MAX_ATTRIBUTION_ATTEMPTS;
      attempt += 1
    ) {
      const applied = applyBillingSnapshot(ledger, {
        agentId: AGENT,
        forRunId: attempt === 1 ? "run-1" : null,
        snapshot: snapshot([]),
        at: T1,
      });
      ledger = applied.ledger;
      expect(applied.deltaCents).toBe(0);
      if (attempt < CURSOR_BILLING_MAX_ATTRIBUTION_ATTEMPTS) {
        expect(billingTurn(ledger, "run-1")).toMatchObject({
          status: "pending",
          attempts: attempt,
        });
        expect(billingRunsAwaitingSettlement(ledger, AGENT)).toEqual(["run-1"]);
      }
    }
    expect(billingTurn(ledger, "run-1")?.status).toBe("unresolved");
    expect(billingRunsAwaitingSettlement(ledger, AGENT)).toEqual([]);
    expect(turnBilledCost(ledger, "run-1")).toBeNull();
  });

  it("matches late entries to earlier pending turns by their token counts", () => {
    let ledger = dispatchedTurn(
      emptyCursorBillingLedger(),
      "run-1",
      tokens(100, 20),
      T0,
    );
    // The first turn's post-turn fetch found nothing (billing lagged).
    ledger = applyBillingSnapshot(ledger, {
      agentId: AGENT,
      forRunId: "run-1",
      snapshot: snapshot([]),
      at: T0,
    }).ledger;
    ledger = dispatchedTurn(ledger, "run-2", tokens(300, 7), T1);
    const applied = applyBillingSnapshot(ledger, {
      agentId: AGENT,
      forRunId: "run-2",
      snapshot: snapshot(
        [
          {
            runId: "uuid-b",
            usage: tokens(300, 7),
            cost: { rawCostCents: 9, chargedCents: 9 },
          },
          {
            runId: "uuid-a",
            usage: tokens(100, 20),
            cost: { rawCostCents: 4, chargedCents: 4 },
          },
        ],
        { rawCostCents: 13, chargedCents: 13 },
      ),
      at: T2,
    });

    expect(billingTurn(applied.ledger, "run-1")).toMatchObject({
      status: "settled",
      usageIds: ["uuid-a"],
    });
    expect(billingTurn(applied.ledger, "run-2")).toMatchObject({
      status: "settled",
      usageIds: ["uuid-b"],
    });
    expect(applied.deltaCentsByRun).toEqual({ "run-1": 4, "run-2": 9 });
    expect(applied.deltaCents).toBe(13);
  });

  it("never assigns an ambiguous entry to a turn, yet still counts its cost for the conversation", () => {
    let ledger = dispatchedTurn(emptyCursorBillingLedger(), "run-1", null, T0);
    ledger = applyBillingSnapshot(ledger, {
      agentId: AGENT,
      forRunId: "run-1",
      snapshot: snapshot([]),
      at: T0,
    }).ledger;
    ledger = dispatchedTurn(ledger, "run-2", null, T1);
    const applied = applyBillingSnapshot(ledger, {
      agentId: AGENT,
      forRunId: "run-2",
      snapshot: snapshot(
        [
          {
            runId: "uuid-x",
            usage: tokens(50, 5),
            cost: { rawCostCents: 2, chargedCents: 2 },
          },
        ],
        { rawCostCents: 2, chargedCents: 2 },
      ),
      at: T2,
    });

    // Two turns could own the one entry and nothing tells them apart.
    expect(billingTurn(applied.ledger, "run-1")?.usageIds).toEqual([]);
    expect(billingTurn(applied.ledger, "run-2")?.usageIds).toEqual([]);
    expect(applied.deltaCentsByRun).toEqual({});
    expect(applied.deltaCents).toBe(2);
    expect(applied.cumulativeAppliedCents).toBe(2);
  });

  it("applies the agent-level remainder beyond per-entry cost once, never twice", () => {
    const ledger = dispatchedTurn(
      emptyCursorBillingLedger(),
      "run-1",
      tokens(100, 20),
    );
    const withRemainder = snapshot(
      [
        {
          runId: "uuid-a",
          usage: tokens(100, 20),
          cost: { rawCostCents: 6, chargedCents: 6 },
        },
      ],
      { rawCostCents: 10, chargedCents: 10 },
    );
    const first = applyBillingSnapshot(ledger, {
      agentId: AGENT,
      forRunId: "run-1",
      snapshot: withRemainder,
      at: T1,
    });
    expect(first.deltaCentsByRun).toEqual({ "run-1": 6 });
    expect(first.remainderDeltaCents).toBe(4);
    expect(first.deltaCents).toBe(10);

    const second = applyBillingSnapshot(first.ledger, {
      agentId: AGENT,
      forRunId: null,
      snapshot: withRemainder,
      at: T2,
    });
    expect(second.deltaCents).toBe(0);
    expect(second.remainderDeltaCents).toBe(0);
    expect(second.cumulativeAppliedCents).toBe(10);
  });

  it("never applies a negative delta when the provider's figure moves down", () => {
    const ledger = dispatchedTurn(
      emptyCursorBillingLedger(),
      "run-1",
      tokens(100, 20),
    );
    const first = applyBillingSnapshot(ledger, {
      agentId: AGENT,
      forRunId: "run-1",
      snapshot: snapshot(
        [
          {
            runId: "uuid-a",
            usage: tokens(100, 20),
            cost: { rawCostCents: 10, chargedCents: 10 },
          },
        ],
        { rawCostCents: 10, chargedCents: 10 },
      ),
      at: T1,
    });
    const second = applyBillingSnapshot(first.ledger, {
      agentId: AGENT,
      forRunId: null,
      snapshot: snapshot(
        [
          {
            runId: "uuid-a",
            usage: tokens(100, 20),
            cost: { rawCostCents: 8, chargedCents: 8 },
          },
        ],
        { rawCostCents: 8, chargedCents: 8 },
      ),
      at: T2,
    });
    expect(second.deltaCents).toBe(0);
    expect(second.cumulativeAppliedCents).toBe(10);
  });

  it("records a provider refusal as a durable unavailable state and stops asking", () => {
    const ledger = dispatchedTurn(
      emptyCursorBillingLedger(),
      "run-1",
      tokens(100, 20),
    );
    const refused = applyBillingUnavailable(ledger, {
      agentId: AGENT,
      code: "feature_unavailable",
      at: T1,
    });
    expect(refused.availability).toEqual({
      state: "unavailable",
      code: "feature_unavailable",
      observedAt: T1,
      disclosedAt: null,
    });
    expect(billingTurn(refused, "run-1")?.status).toBe("unavailable");
    expect(billingRunsAwaitingSettlement(refused, AGENT)).toEqual([]);
    expect(turnBilledCost(refused, "run-1")).toBeNull();

    // The feature later appears: the turn is attributable again.
    const applied = applyBillingSnapshot(refused, {
      agentId: AGENT,
      forRunId: null,
      snapshot: snapshot(
        [
          {
            runId: "uuid-a",
            usage: tokens(100, 20),
            cost: { rawCostCents: 1, chargedCents: 1 },
          },
        ],
        { rawCostCents: 1, chargedCents: 1 },
      ),
      at: T2,
    });
    expect(applied.ledger.availability.state).toBe("available");
    expect(billingTurn(applied.ledger, "run-1")).toMatchObject({
      status: "settled",
      usageIds: ["uuid-a"],
    });
    expect(applied.deltaCentsByRun).toEqual({ "run-1": 1 });
  });

  it("survives a JSON round trip and bounds the turn history", () => {
    let ledger = emptyCursorBillingLedger();
    for (let index = 0; index < 505; index += 1) {
      ledger = dispatchedTurn(ledger, `run-${index}`, tokens(1, 1));
      ledger = applyBillingSnapshot(ledger, {
        agentId: AGENT,
        forRunId: `run-${index}`,
        snapshot: snapshot(
          [
            {
              runId: `uuid-${index}`,
              usage: tokens(1, 1),
              cost: { rawCostCents: 1, chargedCents: 1 },
            },
          ],
          { rawCostCents: index + 1, chargedCents: index + 1 },
        ),
        at: T1,
      }).ledger;
    }
    expect(ledger.turns.length).toBeLessThanOrEqual(500);
    expect(billingTurn(ledger, "run-504")?.status).toBe("settled");
    expect(billingTurn(ledger, "run-0")).toBeUndefined();
    const reloaded = cursorBillingLedgerSchema.parse(
      JSON.parse(JSON.stringify(ledger)),
    );
    expect(reloaded).toEqual(ledger);
  });
});
