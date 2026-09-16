import type { TranscriptUsageProjection } from "../transcript-projections";

/**
 * Backend-owned decoders for the transcript frames the Codex adapter
 * persists (via `codexConversationTranscriptProjection`). Registered with the
 * neutral projections in `../transcript-projections`; consumers never read
 * `raw` themselves.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Project a persisted Codex result frame into neutral usage counters. The
 * frame's `costUsd` is the THREAD-cumulative estimate as of that turn, so the
 * thread ref is the lineage id and aggregation (final-cumulative-per-lineage)
 * stays with the caller. Unknown cost must survive replay as an unknown ledger.
 */
export function projectCodexUsageFrame(
  raw: unknown,
): TranscriptUsageProjection | null {
  const record = asRecord(raw);
  if (record === null || record.backend !== "codex") return null;
  const ref = asRecord(record.backendRef)?.ref;
  if (typeof ref !== "string" || ref.length === 0) return null;
  if (record.costUsd !== null && typeof record.costUsd !== "number")
    return null;
  return {
    lineageId: ref,
    cumulativeCostUsd:
      typeof record.costUsd === "number" &&
      Number.isFinite(record.costUsd) &&
      record.costUsd >= 0
        ? record.costUsd
        : null,
    numTurns: typeof record.numTurns === "number" ? record.numTurns : null,
  };
}
