---
name: cc-performance-log-analysis
description: Use when diagnosing Command Center performance issues from structured server logs, slow API requests, operation timing, state-store latency, duplicate work, SSE broadcast cost, external command latency, or before/after performance regressions. Triggers include "analyze performance logs", "find slow requests", "why is CC slow", "trace this request", "compare log performance", and "identify bottlenecks".
---

# CC Performance Log Analysis

Use `bun run logs:analyze` as the first tool for Command Center performance log diagnosis. It produces concise Markdown by default for an agent's own reading. Select JSON only when output feeds code, and use manual `jq` only for ad hoc checks after the CLI narrows the problem.

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
