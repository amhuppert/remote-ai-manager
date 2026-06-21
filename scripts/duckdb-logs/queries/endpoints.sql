-- Per-endpoint latency distribution. The route() macro (see prelude.sql) collapses
-- dynamic path segments to a template so requests aggregate by endpoint instead of
-- by concrete id/name. This is the view for "which routes are slow, how often hit".
-- Params: --since/--until (window), --limit (default 30).

SELECT
    method,
    route(path)                                AS route,
    count(*)                                   AS n,
    round(avg(duration_ms), 1)                 AS avg_ms,
    round(quantile_cont(duration_ms, 0.50), 1) AS p50_ms,
    round(quantile_cont(duration_ms, 0.95), 1) AS p95_ms,
    round(quantile_cont(duration_ms, 0.99), 1) AS p99_ms,
    round(max(duration_ms), 1)                 AS max_ms,
    round(sum(duration_ms))                    AS total_ms
FROM logs
WHERE message = 'request.complete'
  AND duration_ms IS NOT NULL
  AND since_ok(ts) AND until_ok(ts)
GROUP BY method, route
HAVING count(*) >= 5
ORDER BY p95_ms DESC
LIMIT row_limit();
