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

import { readFile } from "node:fs/promises";
import { getTranscriptPath } from "@/lib/prompt/transcript";
import { parseJsonl } from "@/lib/shared/read-jsonl";

export interface CodexPersistedCostBaseline {
  /** Thread the cumulative belongs to (`backendRef.ref` of the result frame). */
  threadRef: string;
  /** Thread-cumulative cost recorded by the latest result frame for it. */
  cumulativeCostUsd: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Latest persisted cumulative cost for `threadRef` in the conversation's
 * transcript, or null when no frame records one. Never throws — an unreadable
 * transcript degrades to full re-attribution, not a failed turn.
 */
export async function readCodexPersistedCostBaseline(
  conversationId: string,
  threadRef: string,
): Promise<CodexPersistedCostBaseline | null> {
  try {
    const transcriptPath = await getTranscriptPath(conversationId);
    const jsonlText = await readFile(transcriptPath, "utf-8");
    let latest: CodexPersistedCostBaseline | null = null;
    for (const parsed of parseJsonl(jsonlText)) {
      const entry = asRecord(parsed);
      if (!entry || entry.type !== "result") continue;
      const raw = asRecord(entry.raw);
      if (!raw || raw.backend !== "codex") continue;
      if (asRecord(raw.backendRef)?.ref !== threadRef) continue;
      if (typeof raw.costUsd !== "number") continue;
      latest = { threadRef, cumulativeCostUsd: raw.costUsd };
    }
    return latest;
  } catch {
    return null;
  }
}
