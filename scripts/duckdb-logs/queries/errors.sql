-- Error / warning correlation. warn+error rows grouped by module+message, with the
-- time window they span and an example trace_id to pivot into `trace`. Slow-request
-- warnings (request.complete >= CC_REQUEST_SLOW_MS) and timing warnings (>=
-- CC_TIMING_WARN_MS) land here too, so it doubles as a "what crossed a latency
-- threshold" view.
-- Params: --since/--until (window), --limit (default 30).

SELECT
    level,
    module,
    message,
    count(*)                AS n,
    min(ts)                 AS first_seen,
    max(ts)                 AS last_seen,
    round(max(op_ms), 1)    AS max_ms,
    any_value(trace_id)     AS example_trace
FROM logs
WHERE level IN ('warn', 'error')
  AND since_ok(ts) AND until_ok(ts)
GROUP BY level, module, message
ORDER BY level DESC, n DESC
LIMIT row_limit();
