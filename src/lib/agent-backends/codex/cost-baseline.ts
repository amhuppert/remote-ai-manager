/**
 * Durable cost baseline for Codex per-turn cost attribution.
 *
 * Codex reports thread-CUMULATIVE usage on every turn, so the runtime
 * attributes each turn the delta against the last cumulative it saw. That
 * baseline lives in runtime memory and dies with the server process — but the
 * conversation transcript's codex result frames record the cumulative cost as
 * of each turn, so a runtime resuming a persisted thread after a restart can
 * recover the baseline from its own transcript instead of re-attributing the
 * thread's whole history to the first post-restart turn.
 *
 * The frame shape parsed here is the one `codexConversationTranscriptProjection`
 * writes — adapter-owned on both ends.
 */

import { getTranscriptPath } from "@/lib/prompt/transcript";
import { readCodexTranscriptRecords } from "./transcript-records";

export interface CodexPersistedCostBaseline {
  /** Thread the cumulative belongs to (`backendRef.ref` of the result frame). */
  threadRef: string;
  /** Thread-cumulative cost recorded by the latest result frame for it. */
  cumulativeCostUsd: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Latest persisted cumulative cost for `threadRef` in the conversation's
 * transcript, or null when no frame records one. Never throws — an unreadable
 * transcript leaves cumulative accounting unknown, not a fresh zero lineage.
 */
export async function readCodexPersistedCostBaseline(
  conversationId: string,
  threadRef: string,
  configDir?: string,
): Promise<CodexPersistedCostBaseline | null> {
  try {
    const transcriptPath = await getTranscriptPath(conversationId, configDir);
    let latest: CodexPersistedCostBaseline | null = null;
    for await (const parsed of readCodexTranscriptRecords(transcriptPath)) {
      const entry = asRecord(parsed);
      if (!entry || entry.type !== "result") continue;
      const raw = asRecord(entry.raw);
      if (!raw || raw.backend !== "codex") continue;
      if (asRecord(raw.backendRef)?.ref !== threadRef) continue;
      latest = {
        threadRef,
        cumulativeCostUsd:
          typeof raw.costUsd === "number" &&
          Number.isFinite(raw.costUsd) &&
          raw.costUsd >= 0
            ? raw.costUsd
            : null,
      };
    }
    return latest;
  } catch {
    return null;
  }
}
