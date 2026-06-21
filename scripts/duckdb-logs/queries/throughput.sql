-- Request volume and latency over time, bucketed by hour. Surfaces load patterns
-- and *when* the app got slow — a p95 spike in one bucket points you at a window
-- to drill into (re-run other queries with --since/--until around it). Change the
-- bucket via date_trunc('minute' | 'hour' | 'day').
-- Params: --since/--until (window).

SELECT
    date_trunc('hour', ts)                     AS hour,
    count(*)                                   AS requests,
    round(avg(duration_ms), 1)                 AS avg_ms,
    round(quantile_cont(duration_ms, 0.95), 1) AS p95_ms,
    round(max(duration_ms), 1)                 AS max_ms,
    sum(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS server_errors
FROM logs
WHERE message = 'request.complete'
  AND duration_ms IS NOT NULL
  AND since_ok(ts) AND until_ok(ts)
GROUP BY hour
ORDER BY hour;
