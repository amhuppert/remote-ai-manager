/**
 * Durable cost baseline for Claude per-turn cost attribution.
 *
 * A resumed Claude session continues from the cumulative total its transcript
 * saved, so the first result of a new subprocess already carries every earlier
 * turn's spend. The conversation transcript's result frames record that
 * cumulative per session, so a runtime resuming a session recovers the
 * baseline from its own transcript rather than charging the whole history to
 * its first turn. The frame shape is the one this adapter writes.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { COST_SETTLEMENT_FRAME_TYPE } from "@/lib/conversations/cost-settlement";
import { getTranscriptPath } from "@/lib/prompt/transcript";
import { projectClaudeUsageFrame } from "./transcript-projections";

export interface ClaudePersistedCostBaseline {
  sessionId: string;
  cumulativeCostUsd: number;
}

/**
 * Latest saved cumulative cost of `sessionId` in the conversation's
 * transcript, or null when no result frame records one. Never throws: an
 * unreadable transcript leaves the session's earlier spend unknown.
 */
export async function readClaudePersistedCostBaseline(
  conversationId: string,
  sessionId: string,
  configDir?: string,
): Promise<ClaudePersistedCostBaseline | null> {
  try {
    const transcriptPath = await getTranscriptPath(conversationId, configDir);
    const lines = createInterface({
      input: createReadStream(transcriptPath),
      crlfDelay: Infinity,
    });
    let latest: ClaudePersistedCostBaseline | null = null;
    for await (const line of lines) {
      if (
        !line.includes('"result"') &&
        !line.includes(COST_SETTLEMENT_FRAME_TYPE)
      )
        continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null || !("type" in entry))
        continue;
      const raw = "raw" in entry ? entry.raw : null;
      // A task that resumed the session in its own process records the session's new total
      // as a settlement on the session's lineage.
      const cumulativeCostUsd =
        entry.type === "result"
          ? sessionResultTotal(raw, sessionId)
          : entry.type === COST_SETTLEMENT_FRAME_TYPE
            ? sessionSettlementTotal(raw, sessionId)
            : null;
      // A zeroed crash or startup frame says nothing about what was spent.
      if (cumulativeCostUsd !== null && cumulativeCostUsd > 0)
        latest = { sessionId, cumulativeCostUsd };
    }
    return latest;
  } catch {
    return null;
  }
}

/** The session total a result frame of `sessionId` saved, or null. */
function sessionResultTotal(raw: unknown, sessionId: string): number | null {
  const usage = projectClaudeUsageFrame(raw);
  return usage?.lineageId === sessionId ? usage.cumulativeCostUsd : null;
}

/** The session total a cost settlement frame records on `sessionId`'s lineage, or null. */
function sessionSettlementTotal(
  raw: unknown,
  sessionId: string,
): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const lineageId = "lineageId" in raw ? raw.lineageId : null;
  const total = "cumulativeCostUsd" in raw ? raw.cumulativeCostUsd : null;
  return lineageId === sessionId && typeof total === "number" ? total : null;
}
