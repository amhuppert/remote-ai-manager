-- The slowest individual HTTP requests. `request.complete` (tracing module)
-- carries method/path/status/durationMs for every non-streaming request (SSE
-- responses log durationMs=NULL, so they fall out naturally). Each row is one
-- real request — pivot into it with:  run.sh trace <trace_id>
-- Params: --since/--until (window), --limit (default 30).

SELECT
    ts,
    method,
    path,
    status,
    round(duration_ms) AS ms,
    trace_id
FROM logs
WHERE message = 'request.complete'
  AND duration_ms IS NOT NULL
  AND since_ok(ts) AND until_ok(ts)
ORDER BY duration_ms DESC
LIMIT row_limit();
