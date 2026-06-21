-- State-store write-queue contention. `state-store.write_queue.timing` splits each
-- mutation into waitMs (queued behind other writers) + holdMs (actually executing);
-- durationMs = wait + hold. When wait dominates hold, the serialized write queue is
-- the bottleneck, not the write itself — a different fix (shorter critical sections
-- / fewer writes) than a slow individual mutation.
-- Params: --since/--until (window), --limit (default 30).

SELECT
    regexp_replace(label, '\[.*\]', '')   AS mutation,   -- strip the [path/key] suffix
    count(*)                              AS n,
    round(sum(wait_ms))                   AS total_wait_ms,
    round(sum(hold_ms))                   AS total_hold_ms,
    round(avg(wait_ms), 2)                AS avg_wait_ms,
    round(avg(hold_ms), 2)                AS avg_hold_ms,
    round(max(wait_ms), 1)                AS max_wait_ms,
    round(100.0 * sum(wait_ms) / nullif(sum(wait_ms) + sum(hold_ms), 0), 1) AS wait_pct
FROM logs
WHERE message = 'state-store.write_queue.timing'
  AND since_ok(ts) AND until_ok(ts)
GROUP BY mutation
ORDER BY total_wait_ms DESC
LIMIT row_limit();
