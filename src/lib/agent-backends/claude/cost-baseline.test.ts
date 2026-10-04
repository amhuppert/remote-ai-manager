import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { costSettlementFrame } from "@/lib/conversations/cost-settlement";
import { appendTranscriptEntry } from "@/lib/prompt/transcript";
import { readClaudePersistedCostBaseline } from "./cost-baseline";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function transcriptWith(frames: Record<string, unknown>[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-claude-cost-"));
  dirs.push(dir);
  for (const raw of frames) {
    await appendTranscriptEntry("conversation", { timestamp: new Date().toISOString(), type: "result", raw }, dir);
  }
  return dir;
}

describe("Claude persisted cost baseline", () => {
  it("is the total the session's latest result saved", async () => {
    const dir = await transcriptWith([
      { session_id: "sess-a", total_cost_usd: 0.12, num_turns: 1 },
      { session_id: "sess-b", total_cost_usd: 5, num_turns: 1 },
      { session_id: "sess-a", total_cost_usd: 0.26, num_turns: 3 },
    ]);
    expect(await readClaudePersistedCostBaseline("conversation", "sess-a", dir)).toEqual({
      sessionId: "sess-a",
      cumulativeCostUsd: 0.26,
    });
  });

  it("is absent for a session the transcript never recorded, or a transcript that does not exist", async () => {
    const dir = await transcriptWith([{ session_id: "sess-b", total_cost_usd: 5, num_turns: 1 }]);
    expect(await readClaudePersistedCostBaseline("conversation", "sess-a", dir)).toBeNull();
    expect(await readClaudePersistedCostBaseline("missing", "sess-a", dir)).toBeNull();
  });

  it("passes over a zeroed crash frame, which says nothing about what was spent", async () => {
    const dir = await transcriptWith([
      { session_id: "sess-a", total_cost_usd: 10, num_turns: 2 },
      { session_id: "sess-a", total_cost_usd: 0, num_turns: 0, is_error: true },
    ]);
    expect(await readClaudePersistedCostBaseline("conversation", "sess-a", dir)).toEqual({
      sessionId: "sess-a",
      cumulativeCostUsd: 10,
    });
  });

  it("includes what a task that resumed the session spent, which its settlement frame records on the session", async () => {
    const dir = await transcriptWith([{ session_id: "sess-a", total_cost_usd: 0.178, num_turns: 4 }]);
    await appendTranscriptEntry(
      "conversation",
      costSettlementFrame("conversation", { lineageId: "sess-a", cumulativeCostUsd: 0.193, costUsdDelta: 0.015 }),
      dir,
    );
    await appendTranscriptEntry(
      "conversation",
      costSettlementFrame("conversation", { lineageId: "task_run:other", cumulativeCostUsd: 2, costUsdDelta: 2 }),
      dir,
    );
    expect(await readClaudePersistedCostBaseline("conversation", "sess-a", dir)).toEqual({
      sessionId: "sess-a",
      cumulativeCostUsd: 0.193,
    });
  });
});
