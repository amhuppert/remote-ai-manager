import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { costSettlementFrame } from "@/lib/conversations/cost-settlement";
import { appendTranscriptEntry } from "@/lib/prompt/transcript";
import { attributeTaskRunCost, readLineageCumulativeCost } from "./task-run-cost";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("a task run's cost on its conversation", () => {
  const session = { backend: "claude" as const, ref: "sess-a" };

  it("charges a task that resumed the session only what it added, on the session's lineage", () => {
    expect(
      attributeTaskRunCost({
        usage: { costUsd: 0.193, cumulativeCostUsd: 0.193 },
        sessionRef: session,
        runLineageId: "task_run:att-1",
        previousCumulativeUsd: 0.178,
      }),
    ).toEqual({
      costUsd: expect.closeTo(0.015, 9),
      settlement: { lineageId: "sess-a", cumulativeCostUsd: 0.193, costUsdDelta: expect.closeTo(0.015, 9) },
    });
  });

  it("charges a fresh session's whole total, and a restarted lineage from zero", () => {
    expect(
      attributeTaskRunCost({
        usage: { costUsd: 0.02, cumulativeCostUsd: 0.02 },
        sessionRef: { backend: "claude", ref: "sess-new" },
        runLineageId: "task_run:att-2",
        previousCumulativeUsd: null,
      })?.costUsd,
    ).toBe(0.02);
    expect(
      attributeTaskRunCost({
        usage: { costUsd: 0.05, cumulativeCostUsd: 0.05 },
        sessionRef: session,
        runLineageId: "task_run:att-3",
        previousCumulativeUsd: 0.4,
      })?.costUsd,
    ).toBe(0.05);
  });

  it("keeps a backend without a session total on the run's own lineage, and records nothing for a free run", () => {
    expect(
      attributeTaskRunCost({
        usage: { costUsd: 0.3 },
        sessionRef: session,
        runLineageId: "task_run:att-4",
        previousCumulativeUsd: 0.2,
      }),
    ).toEqual({ costUsd: 0.3, settlement: { lineageId: "task_run:att-4", cumulativeCostUsd: 0.3, costUsdDelta: 0.3 } });
    expect(
      attributeTaskRunCost({ usage: {}, sessionRef: null, runLineageId: "task_run:att-5", previousCumulativeUsd: null }),
    ).toBeNull();
  });

  it("reads a lineage's latest recorded total from the conversation's transcript", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cc-task-cost-"));
    dirs.push(dir);
    const at = new Date().toISOString();
    await appendTranscriptEntry("conv", { timestamp: at, type: "result", raw: { session_id: "sess-a", total_cost_usd: 0.1, num_turns: 1 } }, dir);
    await appendTranscriptEntry("conv", costSettlementFrame("conv", { lineageId: "sess-a", cumulativeCostUsd: 0.13, costUsdDelta: 0.03 }), dir);
    await appendTranscriptEntry("conv", { timestamp: at, type: "result", raw: { session_id: "sess-b", total_cost_usd: 9, num_turns: 1 } }, dir);
    expect(await readLineageCumulativeCost("conv", "sess-a", dir)).toBe(0.13);
    expect(await readLineageCumulativeCost("conv", "sess-x", dir)).toBeNull();
  });
});
