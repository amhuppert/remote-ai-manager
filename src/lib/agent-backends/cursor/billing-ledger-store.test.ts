import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyBillingSnapshot,
  emptyCursorBillingLedger,
  recordBillingTurnEnd,
  recordBillingTurnStart,
} from "./billing-ledger";
import { createCursorBillingStore } from "./billing-ledger-store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cc-cursor-billing-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const tokens = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 12,
};

describe("cursor billing ledger store", () => {
  it("reads an empty ledger when nothing has been written yet", async () => {
    const store = createCursorBillingStore(path.join(root, "missing"));
    expect(await store.load()).toEqual(emptyCursorBillingLedger());
  });

  it("round-trips a settled ledger through the file, including applied amounts", async () => {
    const store = createCursorBillingStore(root);
    let ledger = recordBillingTurnStart(emptyCursorBillingLedger(), {
      runId: "run-1",
      agentId: "agent-1",
      startedAt: "2026-09-20T10:00:00.000Z",
    });
    ledger = recordBillingTurnEnd(ledger, {
      runId: "run-1",
      agentId: "agent-1",
      tokens,
      outcome: "completed",
      at: "2026-09-20T10:00:04.000Z",
    });
    ledger = applyBillingSnapshot(ledger, {
      agentId: "agent-1",
      forRunId: "run-1",
      snapshot: {
        usage: tokens,
        cost: { rawCostCents: 2.5, chargedCents: 2.5 },
        runs: [
          {
            runId: "uuid-1",
            usage: tokens,
            cost: { rawCostCents: 2.5, chargedCents: 2.5 },
          },
        ],
      },
      at: "2026-09-20T10:00:05.000Z",
    }).ledger;

    await store.save(ledger);
    const reloaded = await createCursorBillingStore(root).load();
    expect(reloaded).toEqual(ledger);
    expect(reloaded.agents["agent-1"]?.appliedCents).toBe(2.5);
  });

  it("refuses a corrupt ledger rather than starting a fresh zero history", async () => {
    const store = createCursorBillingStore(root);
    await writeFile(path.join(root, "cc-billing-ledger.json"), '{"version":9}');
    await expect(store.load()).rejects.toThrow(/billing ledger/i);
  });

  it("writes owner-only, readable JSON next to the provider task ledger", async () => {
    const store = createCursorBillingStore(root);
    await store.save(emptyCursorBillingLedger());
    const raw = await readFile(
      path.join(root, "cc-billing-ledger.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual(emptyCursorBillingLedger());
  });
});
