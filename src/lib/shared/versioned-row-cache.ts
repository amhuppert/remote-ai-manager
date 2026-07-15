/**
 * Parsed-row cache with monotonic-version invalidation — PERFORMANCE.md
 * Pattern 3, extracted so the state-store repos that enumerate rows share one
 * implementation instead of each hand-rolling it.
 *
 * The problem it solves: Zod-parsing dominates the cost of enumerating a repo
 * with non-trivial row counts, and the focused-first read migration guarantees
 * traffic pours onto these enumerators. Re-parsing every row on every call is
 * the read-amplification floor.
 *
 * The mechanism:
 *   1. A per-key cache `Map<key, { rawRow, parsed }>`.
 *   2. A monotonic `version` counter. Every repo mutator MUST call `bump()`
 *      (a missed bump silently serves stale data).
 *   3. `readAll(loadRows)` short-circuits when `version` has not changed since
 *      the last `readAll`: it returns the cached array by REFERENCE (same array)
 *      WITHOUT invoking `loadRows`, so a warm-version hit never enumerates the
 *      underlying store (PERFORMANCE.md's "short-circuit before raw fetch").
 *   4. On a version miss, each row's raw column object is compared against the
 *      cached one (`rowsEqual`); an unchanged row reuses its parsed result,
 *      a changed/new row is re-parsed and the cache updated.
 *   5. Cache entries whose keys are absent from the new row set are pruned.
 *
 * `getParsedByKey` exposes the per-key entry so a repo can layer a
 * secondary memo (e.g. a per-session id list) on top of the same parsed cache
 * without duplicating the parse — the conversations repo does this. Because
 * that secondary memo is version-gated identically, every id it resolves is
 * guaranteed still present in the cache.
 *
 * Reference-identity contract: `readAll` returns the same array reference on a
 * version hit, and the same parsed element for an unchanged row across calls.
 * Callers that sort/mutate the result in place must copy the container first
 * (the repos return a fresh array around the shared parsed elements for that
 * reason). This is the exact behavior the repo contract tests pin with
 * `expect(second).toBe(first)`.
 */

export interface VersionedRowCacheDeps<TKey, TRaw, TParsed> {
  /** Stable key for a raw row (e.g. its `id`, or a composite project::name). */
  keyOf(row: TRaw): TKey;
  /**
   * True when two raw rows for the same key are column-for-column equal, so
   * the cached parse can be reused. Compares only the persisted columns, not
   * incidental raw-object keys.
   */
  rowsEqual(a: TRaw, b: TRaw): boolean;
  /** Parse a raw row into its domain projection (the expensive step). */
  parse(row: TRaw): TParsed;
}

export interface VersionedRowCache<TKey, TRaw, TParsed> {
  /**
   * Return the parsed projection of every row, reusing cached parses for
   * unchanged rows. On a version hit `loadRows` is NOT called and the same
   * array reference is returned; on a miss `loadRows` is invoked to fetch the
   * raw rows, which keeps the underlying enumeration (e.g. the SQL fetch)
   * behind the version gate.
   */
  readAll(loadRows: () => TRaw[]): TParsed[];
  /**
   * Parse one raw row, reusing (and populating) the per-key cache entry — the
   * same reuse-or-parse step `readAll` runs per row, without the version gate
   * or prune. For a focused enumerator (e.g. one session's rows) that shares
   * the per-key cache with `readAll` but fetches only a subset. Does NOT bump
   * or prune; the caller layers its own version-gated memo.
   */
  resolveRow(row: TRaw): TParsed;
  /** The cached `{ rawRow, parsed }` entry for a key, or undefined. */
  getParsedByKey(key: TKey): { rawRow: TRaw; parsed: TParsed } | undefined;
  /** Increment the version — call from every mutator that changes a row. */
  bump(): void;
  /** Drop a single key's cache entry (call from a row delete). */
  evict(key: TKey): void;
  /** Current monotonic version (diagnostics/secondary-memo gating). */
  readonly version: number;
}

export function createVersionedRowCache<TKey, TRaw, TParsed>(
  deps: VersionedRowCacheDeps<TKey, TRaw, TParsed>,
): VersionedRowCache<TKey, TRaw, TParsed> {
  const entries = new Map<TKey, { rawRow: TRaw; parsed: TParsed }>();
  let version = 0;
  let lastReadAllVersion = -1;
  let lastReadAllResult: TParsed[] = [];

  function resolveRow(row: TRaw): TParsed {
    const key = deps.keyOf(row);
    const cached = entries.get(key);
    if (cached !== undefined && deps.rowsEqual(cached.rawRow, row)) {
      return cached.parsed;
    }
    const parsed = deps.parse(row);
    entries.set(key, { rawRow: row, parsed });
    return parsed;
  }

  return {
    get version() {
      return version;
    },
    readAll(loadRows) {
      if (version === lastReadAllVersion) {
        return lastReadAllResult;
      }
      const rows = loadRows();
      const out: TParsed[] = new Array(rows.length);
      const seen = new Set<TKey>();
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        seen.add(deps.keyOf(row));
        out[i] = resolveRow(row);
      }
      if (entries.size > seen.size) {
        for (const key of entries.keys()) {
          if (!seen.has(key)) entries.delete(key);
        }
      }
      lastReadAllVersion = version;
      lastReadAllResult = out;
      return out;
    },
    resolveRow,
    getParsedByKey(key) {
      return entries.get(key);
    },
    bump() {
      version += 1;
    },
    evict(key) {
      entries.delete(key);
    },
  };
}
