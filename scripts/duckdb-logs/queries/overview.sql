-- Overview: what is in this window? Time span, level mix, and the busiest event
-- types ranked by total time spent. Good first call to orient before drilling in.

SELECT 'time span' AS section;
SELECT min(ts) AS first_event, max(ts) AS last_event,
       round(date_diff('second', min(ts), max(ts)) / 3600.0, 1) AS span_hours,
       count(*) AS rows
FROM logs WHERE since_ok(ts) AND until_ok(ts);

SELECT 'rows by level' AS section;
SELECT level, count(*) AS n
FROM logs WHERE since_ok(ts) AND until_ok(ts)
GROUP BY level ORDER BY n DESC;

SELECT 'top event types by total time (op_ms = canonical durationMs)' AS section;
SELECT message,
       count(*)                              AS n,
       round(sum(op_ms))                     AS total_ms,
       round(avg(op_ms), 2)                  AS avg_ms,
       round(quantile_cont(op_ms, 0.95), 1)  AS p95_ms,
       round(max(op_ms), 1)                  AS max_ms
FROM logs
WHERE op_ms IS NOT NULL AND since_ok(ts) AND until_ok(ts)
GROUP BY message
ORDER BY total_ms DESC
LIMIT row_limit();
