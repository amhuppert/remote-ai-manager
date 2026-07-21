-- Shared prelude for the DuckDB log-analysis tool.
--
-- Every query runs in a fresh, stateless DuckDB process: this file is `.read`
-- first, then the question SQL. It defines a typed `logs` VIEW over the live
-- NDJSON glob plus a couple of helper macros. Nothing is materialized — DuckDB
-- scans the log on each query (projection pushdown keeps it sub-second to a few
-- seconds because unreferenced JSON fields, including `raw`, are never parsed),
-- so results are always fresh and there is no database file to build or keep up
-- to date.
--
-- Inputs come from the environment so queries stay injection-safe and reusable:
--   CC_LOG_GLOB : path/glob of the NDJSON log(s) to read (set by run.sh)
--   SINCE       : optional ISO lower time bound; '' (unset) = no bound
--   UNTIL       : optional ISO upper time bound; '' (unset) = no bound
--   LIMIT       : row cap for the ranked queries (run.sh defaults it to 30)
--   TRACE_ID    : the trace to drill into (trace.sql)

-- since_ok(ts) / until_ok(ts): fold the optional SINCE/UNTIL window into a WHERE
-- clause. Unset bound => always true, so the same query file works windowed or
-- whole-history. This is the canonical way to parameterize a query here.
CREATE OR REPLACE TEMP MACRO since_ok(ts) AS
  (getenv('SINCE') = '' OR ts >= TRY_CAST(getenv('SINCE') AS TIMESTAMP));
CREATE OR REPLACE TEMP MACRO until_ok(ts) AS
  (getenv('UNTIL') = '' OR ts <  TRY_CAST(getenv('UNTIL') AS TIMESTAMP));

-- row_limit(): the LIMIT for ranked queries, from $LIMIT (run.sh defaults 30).
CREATE OR REPLACE TEMP MACRO row_limit() AS
  coalesce(TRY_CAST(nullif(getenv('LIMIT'), '') AS BIGINT), 30);

-- route(path): collapse dynamic path segments to a route template so requests
-- aggregate by endpoint instead of by concrete id/name. UUID -> :id, long hex ->
-- :id, /{projects,sessions,conversations}/<x> -> /…/:name.
CREATE OR REPLACE TEMP MACRO route(p) AS
  regexp_replace(
    regexp_replace(
      regexp_replace(p,
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', ':id', 'g'),
      '/(projects|sessions|conversations)/[^/]+', '/\1/:name', 'g'),
    '/[0-9a-f]{16,}', '/:id', 'g');

-- jget(j, p): extract a string field from a JSON value — the canonical way to
-- reach un-projected fields (`jget(raw, '$.someField')`). Do NOT use the `->>`
-- operator with more than one extract per expression: DuckDB v1.5.4 parses the
-- arrow operators at the wrong precedence, so
--   raw->>'$.a'='x' AND raw->>'$.b'='y'
-- swallows the rest of the predicate as the path argument and fails with a
-- conversion error on arbitrary rows. Parenthesizing `(raw->>'$.a')` also
-- works, but jget() cannot be misparsed. The selftest pins this.
CREATE OR REPLACE TEMP MACRO jget(j, p) AS json_extract_string(j, p);

-- The typed view. Hot fields are projected to columns; the full line stays in
-- `raw` (a JSON value) so any rarely-used field is reachable ad hoc via
--   jget(raw, '$.someField')
-- without changing this file. read_json_objects tolerates the log's
-- union-of-many-event-shapes schema: absent keys are simply NULL.
CREATE OR REPLACE TEMP VIEW logs AS
SELECT
    -- TRY_CAST: a valid-JSON line whose `timestamp` is not a timestamp must
    -- yield a NULL ts, not abort every whole-history query over the glob.
    TRY_CAST(json ->> '$.timestamp' AS TIMESTAMP)     AS ts,
    json ->> '$.level'                                AS level,
    json ->> '$.module'                               AS module,
    json ->> '$.message'                              AS message,
    json ->> '$.traceId'                              AS trace_id,
    json ->> '$.action'                               AS action,
    json ->> '$.projectName'                          AS project,
    json ->> '$.sessionName'                          AS session,
    json ->> '$.conversationId'                       AS conversation_id,

    -- HTTP request lifecycle (tracing module)
    json ->> '$.method'                               AS method,
    json ->> '$.path'                                 AS path,
    TRY_CAST(json ->> '$.status' AS INTEGER)          AS status,
    TRY_CAST(json ->> '$.streaming' AS BOOLEAN)       AS streaming,

    -- Duration surfaces. Every timed event records a canonical durationMs; the
    -- write queue additionally splits it into waitMs (queued) + holdMs
    -- (executing). totalMs is the LEGACY key (pre-canonicalization lines put
    -- state.read / diff timings there) — kept so historical logs still read.
    TRY_CAST(json ->> '$.durationMs' AS DOUBLE)       AS duration_ms,
    TRY_CAST(json ->> '$.totalMs' AS DOUBLE)          AS total_ms,  -- legacy
    TRY_CAST(json ->> '$.waitMs' AS DOUBLE)           AS wait_ms,
    TRY_CAST(json ->> '$.holdMs' AS DOUBLE)           AS hold_ms,

    -- state-store timing context
    json ->> '$.accessor'                             AS accessor,
    json ->> '$.label'                                AS label,

    -- external command timing (exec / git / dev-server / tailscale / init-script)
    json ->> '$.command'                              AS command,
    json ->> '$.argsPreview'                          AS args_preview,
    json ->> '$.cwd'                                  AS cwd,
    TRY_CAST(json ->> '$.exitCode' AS INTEGER)        AS exit_code,

    -- SSE broadcast timing
    json ->> '$.eventType'                            AS event_type,
    TRY_CAST(json ->> '$.subscriberCount' AS INTEGER) AS subscriber_count,
    TRY_CAST(json ->> '$.delivered' AS INTEGER)       AS delivered,
    TRY_CAST(json ->> '$.payloadBytes' AS BIGINT)     AS payload_bytes,

    -- One "operation duration" axis: canonical durationMs, falling back to the
    -- legacy totalMs, so cross-event hotspot queries can rank everything.
    coalesce(
        TRY_CAST(json ->> '$.durationMs' AS DOUBLE),
        TRY_CAST(json ->> '$.totalMs' AS DOUBLE)
    )                                                 AS op_ms,

    json                                              AS raw
FROM read_json_objects(
    getenv('CC_LOG_GLOB'),
    format = 'newline_delimited',
    maximum_object_size = 20000000,
    -- The log is appended to live; ignore a torn final line (mid-write) instead
    -- of aborting the whole query on it.
    ignore_errors = true
);
