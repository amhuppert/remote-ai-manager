-- Duplicate work within a single request. If one trace runs the same operation
-- (same message + label/accessor) many times, that's an N+1 / repeated-read smell
-- — exactly the class of regression PERFORMANCE.md's focused accessors target.
-- Ranked by wasted time = (repeats - 1) * avg op time, so a hot loop of cheap
-- reads and a handful of expensive ones both surface.
-- Params: --since/--until (window), --limit (default 30).

WITH per_trace_op AS (
    SELECT
        trace_id,
        message,
        coalesce(label, accessor, path, '') AS op_key,
        count(*)             AS calls,
        round(sum(op_ms), 1) AS total_ms,
        round(avg(op_ms), 2) AS avg_ms
    FROM logs
    WHERE trace_id IS NOT NULL
      AND op_ms IS NOT NULL
      AND since_ok(ts) AND until_ok(ts)
    GROUP BY trace_id, message, op_key
    HAVING count(*) > 1
)
SELECT
    message,
    op_key,
    count(*)                 AS traces_affected,
    sum(calls)               AS total_calls,
    round(avg(calls), 1)     AS avg_calls_per_trace,
    max(calls)               AS worst_calls_in_one_trace,
    round(sum(total_ms - avg_ms))  AS wasted_ms   -- time beyond the first call
FROM per_trace_op
GROUP BY message, op_key
ORDER BY wasted_ms DESC
LIMIT row_limit();
