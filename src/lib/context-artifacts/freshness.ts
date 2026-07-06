/**
 * Read-time freshness derivation for context artifacts
 * (docs/design/conversation-compaction/README.md §6.2). Freshness is never
 * stored: `stale` and `outdated` are orthogonal flags computed against the
 * live transcript position and the current build's generator versions.
 */

/** Version stamps shared by artifact rows and the current build. */
export interface FreshnessVersionStamp {
  promptVersion: string;
  normalizerVersion: string;
  schemaVersion: number;
}

/** The freshness-relevant columns of a `context_artifacts` row. */
export interface FreshnessRowInput extends FreshnessVersionStamp {
  coveredEndSeq: number;
}

/**
 * Current build/transcript state. `maxSeq` is the seq of the last visible
 * transcript entry from the entry reader (-1 when the transcript is empty) —
 * never `getNextAppendSeq()`.
 */
export interface FreshnessCurrentInput extends FreshnessVersionStamp {
  maxSeq: number;
}

export interface ArtifactFreshness {
  /** The transcript advanced past the artifact's covered range. */
  stale: boolean;
  /**
   * How far behind the artifact is, as a count of merged logical messages
   * (transcript units) whose last entry `seq > coveredEndSeq` — the same
   * merged-message coordinate the UI displays. Callers group entries (e.g.
   * via `groupTranscriptEntries`) and pass the count in; a coverage boundary
   * inside a merged unit counts that unit once. 0 when not stale or when the
   * caller supplies no count.
   */
  staleBehindMessages: number;
  /** The generator improved since this artifact was made (version drift). */
  outdated: boolean;
}

export function deriveFreshness(
  row: FreshnessRowInput,
  current: FreshnessCurrentInput,
  staleBehindUnitCount?: number,
): ArtifactFreshness {
  const stale = current.maxSeq > row.coveredEndSeq;
  const outdated =
    row.promptVersion !== current.promptVersion ||
    row.normalizerVersion !== current.normalizerVersion ||
    row.schemaVersion !== current.schemaVersion;
  return {
    stale,
    staleBehindMessages: stale ? (staleBehindUnitCount ?? 0) : 0,
    outdated,
  };
}
