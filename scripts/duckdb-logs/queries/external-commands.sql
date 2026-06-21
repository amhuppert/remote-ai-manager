-- External command latency. git / dev-server / tailscale / init-script / pre-merge
-- all run through `exec` and log `<prefix>.complete` with command + argsPreview +
-- durationMs. Subprocess spawns are often the real wall-clock cost behind a slow
-- session-create or merge, invisible to in-process timing. Grouped by the leading
-- args (the git subcommand / verb) so e.g. all `worktree add …` aggregate together.
-- Params: --since/--until (window), --limit (default 30).

SELECT
    coalesce(command, '?')                                       AS cmd,
    regexp_extract(coalesce(args_preview, ''), '^(\S+\s?\S*)', 1) AS verb,
    count(*)                                   AS n,
    round(avg(duration_ms), 1)                 AS avg_ms,
    round(quantile_cont(duration_ms, 0.95), 1) AS p95_ms,
    round(max(duration_ms), 1)                 AS max_ms,
    round(sum(duration_ms))                    AS total_ms,
    sum(CASE WHEN exit_code <> 0 THEN 1 ELSE 0 END) AS nonzero_exits
FROM logs
WHERE message LIKE '%.complete'
  AND module = 'exec'
  AND duration_ms IS NOT NULL
  AND since_ok(ts) AND until_ok(ts)
GROUP BY cmd, verb
ORDER BY total_ms DESC
LIMIT row_limit();
