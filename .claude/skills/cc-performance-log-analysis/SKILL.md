---
name: cc-performance-log-analysis
description: Use when diagnosing Command Center performance issues from structured server logs, slow API requests, operation timing, state-store latency, duplicate work, SSE broadcast cost, external command latency, or before/after performance regressions. Triggers include "analyze performance logs", "find slow requests", "why is CC slow", "trace this request", "compare log performance", "identify bottlenecks", and ad-hoc SQL questions over the logs (DuckDB / `logs:duckdb`).
---

# CC Performance Log Analysis

Use `bun run logs:analyze` as the first tool for Command Center performance log diagnosis. It produces concise Markdown by default for an agent's own reading. Select JSON only when output feeds code, and use manual `jq` only for ad hoc checks after the CLI narrows the problem.

**Two tools.** `logs:analyze` answers the known questions with ranked, severity-tagged findings and trace reconstruction — start there. When you have a question its report does not surface (a custom grouping, a percentile distribution, a cross-cutting join, "is X correlated with Y"), use `bun run logs:duckdb` to query the raw log with SQL — see [Ad-hoc SQL with DuckDB](#ad-hoc-sql-with-duckdb-logsduckdb) below.

> **Rotation awareness.** `global.log` rotates by size (`CC_LOG_MAX_BYTES`, default 100 MiB) into `global.log.1`, `global.log.2`, …. The default `logs:analyze` discovery reads **only the active file**, so a regression older than the current window — or a `--since` range that predates it — is silently absent. `--in` takes a single path and does **not** glob, so analyzing the full retained history means merging the rotated set first (see "Analyze across rotated logs"). The active file may also open with a `logger.rotate` marker line, indicating earlier history is in the backups.

## Workflow

1. Start with a report:

   ```bash
   bun run logs:analyze -- report
   ```

2. Read `findings` first. Pick the highest-severity finding with concrete trace IDs or operation keys.

3. Deep-dive one or two traces:

   ```bash
   bun run logs:analyze -- trace <traceId>
   ```

4. Use compare mode for before/after validation:

   ```bash
   bun run logs:analyze -- compare --before before.log --after after.log
   ```

5. Use Speedscope only after the report identifies a trace or hotspot worth visual inspection:

   ```bash
   bun run logs:analyze -- trace <traceId> --speedscope-out /tmp/trace.json
   ```

## Command Recipes

Recent full report:

```bash
bun run logs:analyze -- report
```

Filter by project/session:

```bash
bun run logs:analyze -- report --projectName NAME --sessionName SESSION
```

Analyze a time window:

```bash
bun run logs:analyze -- report --since 2026-05-21T12:00:00Z --top 20
```

Analyze across rotated logs (full retained history, not just the active window):

```bash
# --in reads ONE file and does not glob, so merge the rotated set first.
# Order is irrelevant — every record is timestamped; --since/--until still apply.
cat "<config-dir>"/logs/global.log* > /tmp/cc-global-merged.log
bun run logs:analyze -- report --in /tmp/cc-global-merged.log
```

Deep-dive a trace:

```bash
bun run logs:analyze -- trace TRACE_ID
```

Compare before/after logs:

```bash
bun run logs:analyze -- compare --before /tmp/before.log --after /tmp/after.log
```

Include browser timing captured separately:

```bash
bun run logs:analyze -- report --client-log /tmp/client-console.jsonl
```

Create a human-readable handoff:

```bash
bun run logs:analyze -- report --markdown-out /tmp/cc-log-analysis.md
```

Assert performance budgets (CI gating):

```bash
# Advisory by default — the report always includes a `budgets` section, exit 0.
bun run logs:analyze -- report
# With --assert-budgets, any exceeded ceiling makes the command exit non-zero
# (the report is still emitted so CI can see what violated).
bun run logs:analyze -- report --assert-budgets
```

## Performance budgets (`--assert-budgets`)

`logs:analyze report` evaluates the log against a checked-in budget config and
reports any breach in the report's `budgets` field (and a `## Budgets` markdown
section). This is **advisory by default** — a breach does not fail the command.
Pass `--assert-budgets` to make any breach exit non-zero, which is what wires the
budgets into a CI or perf-sensitive-change gate. Point at a different config with
`--budgets <path>`.

The config lives at **`scripts/log-budgets.json`** (beside the CLI entry). Its
schema (all values required; numbers are calibration starting points, tune as
telemetry accrues):

| Field | Meaning | Default |
|---|---|---|
| `routeClassP95Ms` | per-route-class (method+path) p95 ceiling, ms | `1000` |
| `writeQueueHoldMs` | write-queue hold ceiling, ms (matches the runtime hold budget) | `500` |
| `stateReadMs` | `state.read` accessor p95 ceiling, ms | `100` |
| `rowSizeBytes` | serialized row-size ceiling, bytes (from `state-store.row_size.exceeded`) | `262144` |

Two convention/violation **finding rules** also surface in every report's
`findings` (independent of `--assert-budgets`):

- `state-store.write_queue.hold_budget_exceeded` events → ranked `state-store`
  findings, keyed by the mutation **label** that held the queue (the culprit).
- `request.complete` with **status 202 and `durationMs > 1000`** → a
  `convention-violation` finding: a 202 must accept work, not perform it (Design
  5) — work over ~1s belongs behind a job with SSE progress.

## Ad-hoc SQL with DuckDB (`logs:duckdb`)

When the answer isn't one of the report's findings, query the NDJSON directly with
`bun run logs:duckdb` (DuckDB CLI; requires `duckdb` on PATH). It is stateless and
always current, and — unlike `logs:analyze` — reads `global.log*` (active **plus**
rotated backups) by default, so the full retained history is in scope with no merge
step.

Built-in questions (all take `--since` / `--until <ISO>`, `--limit N`, and
`--format box|markdown|csv|json`; the `# source/window` header prints to stderr so
piped stdout stays clean):

```bash
bun run logs:duckdb overview                        # span, levels, top events by total time
bun run logs:duckdb slow-requests --since 2026-06-20 # slowest requests (trace_id to drill in)
bun run logs:duckdb endpoints                       # per-route p50/p95/p99/max
bun run logs:duckdb state-store                     # SQLite read hotspots by cumulative time
bun run logs:duckdb write-queue                     # mutation wait (contention) vs hold
bun run logs:duckdb trace <traceId>                 # one request's full timeline
bun run logs:duckdb list                            # every question
```

Ad-hoc — query the typed `logs` view directly (filter on the `since_ok`/`until_ok`
macros, normalize routes with `route(path)`, reach un-projected fields via
`jget(raw, '$.field')` — never the `->>` operator with more than one extract per
expression: DuckDB v1.5.4 misparses arrow-operator precedence and the query dies
with a conversion error naming an arbitrary log record):

```bash
bun run logs:duckdb sql "SELECT route(path) AS route,
  count(*) n, round(quantile_cont(duration_ms,0.95),1) p95
  FROM logs WHERE message='request.complete' AND since_ok(ts)
  GROUP BY route ORDER BY p95 DESC LIMIT 20" --since 2026-06-20 --format markdown
```

Use `--format markdown` for pasteable tables and `--format json`/`csv` for machine
parsing. The full schema, macros, and the query library live in
`scripts/duckdb-logs/README.md` (the `queries/*.sql` files are copy-pasteable
exemplars). The interpretation rules below apply to DuckDB output too.

## Interpretation Rules

- Treat `instrumentation-gap` as a signal to add `timed()` coverage before optimizing. Do not claim root cause when unexplained time dominates.
- Treat `duplicate-work` findings as likely code-path issues: repeated state reads, transcript reads, diffs, or git commands inside one request trace.
- Treat high `state-store.write_queue` `waitMs` as contention. Treat high `holdMs` as slow mutation work.
- Treat slow external commands separately from application CPU work. A slow `git` or `tailscale` command is not evidence that React, Next.js, or SQLite is slow.
- Do not infer browser network or handler cost without `--client-log`; server logs alone cannot prove client-side latency.
- Do not analyze SSE connection lifetime as request latency. Use `sse.broadcast.complete`, `transportMs`, and `handlerMs`.
- Prefer p95/count-backed findings over single max-duration outliers.
- Use trace IDs as evidence anchors in final answers.

## Reporting Template

When reporting findings, use this shape:

```markdown
Findings:
- Severity: <critical|high|medium|low>
  Evidence: <metric values and trace IDs>
  Likely area: <route/module/operation>
  Next step: <specific file or command>

Residual uncertainty:
- <what the logs cannot prove yet>
```

## Pitfalls

- Do not optimize code when the strongest finding is missing instrumentation.
- Do not ignore high malformed-line counts; the report may be incomplete.
- Do not merge client timing conclusions into server timing conclusions unless `traceId` or event type connects them.
- Do not treat Speedscope's aggregated time order as real wall-clock order; use trace mode for a single request timeline.
- Do not conclude "no such trace" or "no regression in range" from a default report alone — the active `global.log` is only the most recent window. Merge the rotated `global.log*` set (above) before ruling out anything historical.
