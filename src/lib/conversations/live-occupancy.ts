/**
 * In-memory live-occupancy registry for the in-flight agent turn.
 *
 * Tracks, per CC `conversationId`, the most recent context-window occupancy the
 * publisher has observed this turn plus whether an SDK auto-compaction has been
 * seen. Consumers (the mid-turn `complete_task` gate) read this to decide
 * rotation against a live reading rather than the deflated last-wins value that
 * a compaction masks.
 *
 * Process-local and transient by design: a module-level `Map`, no persistence,
 * no logging, no injected deps. Entries are created lazily by the first
 * `record`/`mark` of a turn and deleted when the turn settles, so the map stays
 * bounded by in-flight turns and `compactedThisTurn` is per-turn by
 * construction. CC runs as a single server process; if that ever changes, this
 * module is the seam.
 */

export interface LiveOccupancySnapshot {
  /** null when only a compaction has been seen so far this turn. */
  contextTokens: number | null;
  compactedThisTurn: boolean;
}

const registry = new Map<string, LiveOccupancySnapshot>();

/**
 * Record the latest observed occupancy for a conversation's in-flight turn.
 * Last write wins for `contextTokens`; an existing `compactedThisTurn` is
 * preserved so a compaction seen earlier in the turn survives later readings.
 */
export function recordLiveOccupancy(
  conversationId: string,
  contextTokens: number,
): void {
  const existing = registry.get(conversationId);
  registry.set(conversationId, {
    contextTokens,
    compactedThisTurn: existing?.compactedThisTurn ?? false,
  });
}

/**
 * Mark that an SDK auto-compaction occurred this turn. Creates the entry with
 * `contextTokens: null` when none exists yet; otherwise preserves the recorded
 * occupancy.
 */
export function markLiveCompaction(conversationId: string): void {
  const existing = registry.get(conversationId);
  registry.set(conversationId, {
    contextTokens: existing?.contextTokens ?? null,
    compactedThisTurn: true,
  });
}

/**
 * Read the current snapshot for a conversation, or null when none exists
 * (callers fall back to persisted lane state).
 */
export function readLiveOccupancy(
  conversationId: string,
): LiveOccupancySnapshot | null {
  return registry.get(conversationId) ?? null;
}

/** Delete the entry — called by the publisher when a turn settles. */
export function clearLiveOccupancy(conversationId: string): void {
  registry.delete(conversationId);
}

export function _resetLiveOccupancyForTesting(): void {
  registry.clear();
}
