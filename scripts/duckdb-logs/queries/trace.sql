-- Drill into a single request by trace_id: every timed event that shares the id,
-- in order, with its own duration. Answers "where did this slow request spend its
-- time?" — the SQL analogue of `logs:analyze trace <id>`.
--
--   run.sh trace <trace_id>
--
-- With no id (TRACE_ID unset) it defaults to the slowest request whose trace has
-- real sub-operations (>= 8 timed events), so the timeline is illustrative.

SET VARIABLE tid = coalesce(
    nullif(getenv('TRACE_ID'), ''),
    (
        WITH rich AS (
            SELECT trace_id FROM logs
            WHERE trace_id IS NOT NULL
            GROUP BY trace_id HAVING count(*) >= 8
        )
        SELECT l.trace_id
        FROM logs l JOIN rich USING (trace_id)
        WHERE l.message = 'request.complete' AND l.duration_ms IS NOT NULL
        ORDER BY l.duration_ms DESC LIMIT 1
    )
);

SELECT 'request being traced' AS section;
SELECT trace_id, method, path, status, round(duration_ms) AS ms
FROM logs
WHERE trace_id = getvariable('tid') AND message = 'request.complete';

SELECT 'timeline (all events in this trace)' AS section;
SELECT
    ts,
    round(date_diff('microsecond',
        (SELECT min(ts) FROM logs WHERE trace_id = getvariable('tid')), ts) / 1000.0, 1) AS t_plus_ms,
    module,
    message,
    coalesce(label, accessor, path, args_preview) AS detail,
    round(op_ms, 1) AS op_ms
FROM logs
WHERE trace_id = getvariable('tid')
ORDER BY ts;
