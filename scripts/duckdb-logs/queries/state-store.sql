-- State-store hotspots. Two timing families, both ranked on op_ms (canonical
-- durationMs, with the legacy totalMs coalesced for old log lines):
--   * accessor read path -> `state.read.timing` (durationMs + accessor)
--   * per-repo accessors  -> `state-store.<repo>.<op>.timing` (durationMs)
-- This is where SQLite read cost lives and where the parsed-row caches in
-- PERFORMANCE.md pay off (or regress).
-- Params: --since/--until (window), --limit (default 30).

SELECT
    message,
    accessor,                              -- only set on state.read.timing rows
    count(*)                               AS n,
    round(sum(op_ms))                      AS total_ms,
    round(avg(op_ms), 2)                   AS avg_ms,
    round(quantile_cont(op_ms, 0.95), 1)   AS p95_ms,
    round(max(op_ms), 1)                   AS max_ms
FROM logs
WHERE (message LIKE 'state-store.%timing' OR message = 'state.read.timing')
  AND op_ms IS NOT NULL
  AND since_ok(ts) AND until_ok(ts)
GROUP BY message, accessor
ORDER BY total_ms DESC
LIMIT row_limit();
