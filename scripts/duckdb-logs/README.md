# DuckDB log analysis

Ad-hoc SQL over Command Center's NDJSON logs, via the [DuckDB](https://duckdb.org)
CLI. A companion to `bun run logs:analyze` (the bespoke analyzer): use **that** for
the curated, ranked report; use **this** when you have a question the report
doesn't answer and want to slice the raw log freely.

```bash
bun run logs:duckdb endpoints --since 2026-06-20      # per-route p50/p95/p99
bun run logs:duckdb trace <traceId>                   # one request, step by step
bun run logs:duckdb sql "SELECT module, count(*) FROM logs GROUP BY 1 ORDER BY 2 DESC"
```

(or call `scripts/duckdb-logs/run.sh <cmd>` directly.)

## How it works (the pattern)

Every command runs a **fresh, stateless** DuckDB process: `prelude.sql` is read
first, then the question SQL. There is no database to build and nothing is cached,
so results are always current.

`prelude.sql` defines a typed `logs` **view** over the live log glob plus a few
macros. DuckDB scans the NDJSON on each query, but projection pushdown keeps it
fast (sub-second to a few seconds over ~1M lines) because fields a query doesn't
reference — including the catch-all `raw` column — are never parsed. The 300 MB+
log is read directly; no ETL, no flattening, no load step.

Parameters are passed through the **environment** and read in SQL via `getenv()`,
so queries stay injection-safe and the same `.sql` file works windowed or whole-
history:

```sql
-- prelude.sql defines these:
since_ok(ts)   -- (getenv('SINCE')='' OR ts >= SINCE)  — unset bound = no filter
until_ok(ts)   -- upper bound, same idea
row_limit()    -- $LIMIT, default 30
route(path)    -- normalize /sessions/<x>/… → /sessions/:name/…  for grouping
jget(j, p)     -- json_extract_string(j, p): reach un-projected fields safely
```

A query is then just `SELECT … FROM logs WHERE since_ok(ts) AND until_ok(ts) …`.
This is the pattern to copy when you write a new one: filter on the macros, rank
on `op_ms` (the canonical duration), reach rare fields with `jget(raw, '$.field')`.

Do NOT use the `->>` operator when the expression contains more than one extract:
DuckDB v1.5.4 parses the arrow operators at the wrong precedence, so
`raw->>'$.a'='x' AND raw->>'$.b'='y'` swallows the rest of the predicate as the
path argument and fails with a conversion error naming an arbitrary log record
(the error's "value" is just whichever row was in flight — it is not a bad log
line). Parenthesized `(raw->>'$.a')` also parses correctly, but `jget()` cannot
be misparsed; `run.sh selftest` pins the `jget` pattern.

## Commands

```
run.sh <question> [--since T] [--until T] [--limit N] [--format F]
run.sh trace <traceId>             one request's full timeline
run.sh slow-requests [N]           shortcut for --limit N
run.sh sql "SELECT … FROM logs"    ad-hoc query against the typed view
run.sh repl                        interactive shell with `logs` loaded
run.sh list                        list the built-in questions
run.sh selftest                    run every question against fixtures/sample.log
```

Flags: `--since` / `--until` (ISO, e.g. `2026-06-20` or `2026-06-20T12:00:00Z`),
`--limit N` (default 30), `--format box|markdown|csv|json|line` (default `box` —
`markdown` is handy for pasting results, `json`/`csv` for machine parsing),
`--glob <path>` to point at a different log. The `# source/window` header prints
to **stderr**, so piping stdout gives clean data.

### Built-in questions

| Question | Answers |
|---|---|
| `overview` | Time span, level mix, top event types by total time. Start here. |
| `slow-requests` | The N slowest individual HTTP requests, with `trace_id` to drill in. |
| `endpoints` | Per-route p50/p95/p99/max latency (paths normalized via `route()`). |
| `state-store` | `state.read.timing` + per-repo `*.timing` ranked by cumulative cost. |
| `trace <id>` | Every timed event in one request, in order — "where did the time go?" |
| `duplicate-work` | Same op repeated within a trace (N+1 / repeated-read smell). |
| `external-commands` | git / dev-server / pre-merge / tailscale subprocess latency. |
| `throughput` | Requests + p95 + 5xx bucketed by hour — *when* did it get slow. |
| `write-queue` | Mutation wait (queued) vs hold (executing) — serialized-queue contention. |
| `errors` | warn/error rows by module+message, with an example trace to pivot on. |

The `queries/*.sql` files are readable, copy-pasteable exemplars — open one to see
the pattern, or adapt it via `run.sh sql`.

## Log source

`$CC_LOG_FILE` if set, else the OS-default CC log glob — `global.log*`, which spans
the active file **and** rotated backups (`global.log.1`, `.2`, …), so by default you
analyze the full retained history, not just the most recent window. macOS:
`~/Library/Application Support/cc/logs/global.log*`. Override with `--glob`:

```bash
# one session's scoped log:
run.sh state-store --glob "$HOME/Library/Application Support/cc/logs/sessions/cc__perf/session.log"
```

When unioning the active file with session logs, note that `request.start` /
`request.complete` are dual-written to both `global.log` and the scoped file —
filter to one source to avoid double-counting.

## The `logs` schema

Typed columns projected from each NDJSON line (absent keys → `NULL`):

`ts, level, module, message, trace_id, action, project, session, conversation_id,
method, path, status, streaming, duration_ms, total_ms (legacy), wait_ms, hold_ms,
accessor, label, command, args_preview, cwd, exit_code, event_type,
subscriber_count, delivered, payload_bytes, op_ms` — plus `raw` (the full JSON
line) for anything not projected.

`op_ms` is the canonical operation duration (`durationMs`, falling back to the
legacy `totalMs` for pre-canonicalization log lines), so cross-event hotspot
queries can rank everything on one axis.

## Prerequisites

`duckdb` on `PATH` (developed against v1.5.4; `brew install duckdb`). No other
dependency — DuckDB is a dev/analysis tool here, not part of the app runtime.

## When to use this vs `logs:analyze`

- **`logs:analyze`** — known questions, ranked severity, concise Markdown by
  default, opt-in JSON for code, trace reconstruction with inclusive/exclusive
  time, and before/after `compare`. The default for "is CC slow and why?".
- **this** — a novel question, a percentile *distribution*, a cross-cutting join
  (e.g. join request timing to state-store timing by `trace_id`), or exploration
  where you don't yet know what you're looking for.
