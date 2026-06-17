# Logging & Diagnostics

Persistent data lives under config dir (`~/.config/cc` Linux, `~/Library/Application Support/cc` macOS).

```
<config-dir>/
├── logs/
│   ├── global.log                              # NDJSON debug log (default sink)
│   └── sessions/<projectSlug>__<sessionSlug>/
│       ├── session.log                          # Session-scoped NDJSON
│       └── conversations/<conversationSlug>.log # Conversation-scoped NDJSON
├── config.json                                  # Global config
├── command-center.db                             # SQLite (WAL) — sessions/projects/conversations/jobs/notifications
├── transcripts/{conversationId}.jsonl           # Per-conversation
├── transcripts/images/{conversationId}/...      # Externalized images
└── workflow-logs/{executionId}/                 # Graph workflow execution logs
```

State lives in `command-center.db` (SQLite); the legacy `state.json` is removed.

## Debug Log — NDJSON

Every API request gets a trace context that auto-enriches log entries.

### Scoped routing

`logger.ts` resolves the destination at write time from the active `TraceContext`:

- Conversation-scoped (`projectName + sessionName + conversationId`) → `logs/sessions/<projectSlug>__<sessionSlug>/conversations/<conversationSlug>.log`
- Session-scoped (`projectName + sessionName`) → `logs/sessions/<projectSlug>__<sessionSlug>/session.log`
- Otherwise → `logs/global.log`

Path components are sanitized (non-`[A-Za-z0-9._-]` → `_`, leading dots stripped, truncated to 80 chars with a SHA-256 suffix). On sanitization failure the logger falls back to the next-priority scope and emits a `logger.path.sanitize_failure` diagnostic.

**Dual-write exception:** `request.start` / `request.complete` from the `tracing` module are written to BOTH the scoped destination AND `logs/global.log` so operators retain a chronological cross-session timeline.

Setting `CC_LOG_FILE` or `CC_LOG_SCOPED=0` collapses all writes to a single file (the override path or `logs/global.log` respectively).

```json
{ "timestamp": "ISO 8601", "level": "debug|info|warn|error",
  "module": "prompt|sessions|state-store|tracing|...", "message": "event.name",
  "traceId": "uuid", "action": "...", "projectName": "...",
  "sessionName": "...", "conversationId": "..." }
```

### Key events

| Module | Event | Notes |
|---|---|---|
| `tracing` | `request.start` / `request.complete` / `request.error` | `complete` includes `status`, `durationMs` (non-SSE) |
| `prompt` | `prompt.submit` | `sessionName`, `promptLength`, `model`, `backend`, `conversationId` |
| `prompt` | `prompt.complete` / `prompt.timeout` / `prompt.aborted` / `prompt.sdk_error` | Emitted from the conversation actor; SDK-driven |
| `sessions` | `session.create` / `session.create_failure` / `session.delete` / `session.worktree_remove_failure` | `worktreePath`, `branchName`, `mode` on create |
| `lock` | `lock.acquired` / `lock.released` / `lock.rejected` | Conversation-level single-flight lock |
| `lock` | `project-lock.*` / `conversation-lock.*` | Project- and conversation-scoped variants |

### Config

- `CC_LOG_LEVEL` — `debug` / `info` (default) / `warn` / `error`
- `CC_LOG_FILE` — explicit single-file destination (overrides scoped routing)
- `CC_LOG_SCOPED` — set to `0` to disable scoped routing (everything → `global.log`)
- `CC_LOG_SILENT` — set to `1` to suppress stderr emission entirely
- `warn`/`error` also go to stderr unless `CC_LOG_SILENT=1`

### Timing & performance config

- `CC_TIMING_INFO_MS` (default `50`) — `timed()` `.complete` logs at `info` when `durationMs >=` this
- `CC_TIMING_WARN_MS` (default `1000`) — `timed()` `.complete` logs at `warn` when `durationMs >=` this
- `CC_TIMING_START` (default `0`) — set to `1` to emit `<event>.start` debug logs for every `timed()` call
- `CC_REQUEST_SLOW_MS` (default `500`) — `request.complete` logs at `warn` when `durationMs >=` this (non-streaming responses only)

Below `CC_TIMING_INFO_MS`, `timed()` complete logs land at `debug` and only surface when `CC_LOG_LEVEL=debug`.

### jq queries

The default sink is `logs/global.log`. Cross-session timelines (`request.start` / `request.complete`) live there; deeper drill-downs may need the per-session or per-conversation file under `logs/sessions/`.

```bash
LOG="$CC_CONFIG_DIR/logs/global.log"     # or "$HOME/.config/cc/logs/global.log"
jq 'select(.level == "error")' "$LOG"
jq 'select(.traceId == "UUID")' "$LOG"
jq 'select(.sessionName == "NAME" and (.message | startswith("prompt.")))' "$LOG"
jq 'select(.message == "request.complete" and .durationMs > 1000)' "$LOG"
jq 'select(.message | startswith("git.")) | {action, args: .argsPreview, durationMs}' "$LOG"
jq 'select(.message == "sse.broadcast.complete" and .durationMs > 10)' "$LOG"
```

## Timing & Performance Events

All `timed()`-emitted logs inherit `traceId`/`action`/`projectName`/`sessionName`/`conversationId` from AsyncLocalStorage. Each event emits `<event>.complete` on success (level by duration threshold) and `<event>.error` at `warn` on throw; optional `<event>.start` at `debug` when `CC_TIMING_START=1`.

| Module | Event | Fields |
|---|---|---|
| `exec` | `exec.complete` / `exec.error` | `command`, `argsPreview`, `cwd`, `durationMs`, `stdoutBytes`, `stderrBytes`, `exitCode` |
| `exec` | `spawn.start` / `spawn.exit` / `spawn.spawn_error` | `command`, `argsPreview`, `cwd`, `pid`, `durationMs`, `exitCode`, `signal` |
| `git-client` (via exec, `eventPrefix: "git"`) | `git.complete` / `git.error` | All git ops via `GitClient`; `command="git"`, `argsPreview`, `durationMs` |
| `repo-config` (via exec, `eventPrefix: "pre-merge.script"`) | `pre-merge.script.complete` / `.error` | Pre-merge validation script invocations |
| `tailscale` (via exec, `eventPrefix: "tailscale"`) | `tailscale.complete` / `.error` | All `tailscale` CLI calls |
| `dev-server` (via exec, `eventPrefix: "dev-server"`) | `dev-server.start` / `dev-server.exit` | Per-session dev server process lifecycle |
| `init-script` (via exec, `eventPrefix: "init-script"`) | `init-script.complete` / `.error` | Worktree init scripts |
| `sse` | `sse.broadcast.complete` | `eventType`, `seq`, `subscriberCount`, `delivered`, `payloadBytes`, `durationMs` |
| `sse` | `broadcast.no_clients` | Zero subscribers (warn) |
| `transcript` | `transcript.read.complete` | `messageCount`, `durationMs` |
| `state-db` (via `notification-db`) | `state-db.createNotification` / `.createJobRecord` / `.updateJobRecord` / `.recoverStaleJobs` / `.cleanupOldNotifications` `.complete` | Per-write fields (`notificationId`, `jobId`, `status`, `deleted`, `recoveredCount`) |
| `state-store` | `state.mutate.complete` | `label`, `sessionName`, `durationMs` |
| `state-store` | `state.read.timing` | `accessor`, `totalMs` (and optionally `projectPath`, `sessionName`, `conversationId`); only emitted when `totalMs >= STATE_READ_TIMING_LOG_THRESHOLD_MS` |
| `state-store` | `state-store.write_queue.timing` | `label`, `waitMs`, `holdMs` — feeds the log-analysis `state-store` finding |
| `file-scanner` | `file-scanner.scan.complete` | `rootPath`, `fileCount`, `truncated`, `durationMs` |
| `worktree` | `worktree.create.complete` / `worktree.remove.complete` | `laneId`, `worktreePath`, `branchName`, `status`, `durationMs` |
| `diff` | `diff.compute.complete` | `worktreePath`, `fileCount`, `durationMs` |
| `workflow-storage` | `workflow-storage.list` / `.get` / `.create` / `.update` / `.delete` `.complete` | `workflowId` (where applicable), `workflowCount`/`found`/`revision`/`deleted`, `durationMs` |

Existing `tracing.request.complete` augmented:
- Non-SSE responses: includes `durationMs`, response headers include `Server-Timing: total;dur=<ms>`; logs at `warn` when `durationMs >= CC_REQUEST_SLOW_MS`, else `info`.
- SSE responses (content-type `text/event-stream`): `streaming: true`, `durationMs: null`, logged at `debug`; no `Server-Timing` header.

## Client-Side Timing

`tracedFetch` and the `NotificationListener` SSE handler emit `console.debug` logs in the browser. They are not shipped to the server in this pass; correlate via `traceId` with `logs/global.log`.

| Console event | Source | Fields |
|---|---|---|
| `api.fetch` | `traced-fetch.ts` | `traceId`, `action`, `method`, `url` (pathname only), `status`, `totalMs`, `serverMs`, `networkMs` |
| `api.fetch.error` | `traced-fetch.ts` | `traceId`, `action`, `method`, `url`, `totalMs`, `error` |
| `sse.message` | `NotificationListener.tsx` | `eventType`, `transportMs`, `handlerMs` |

`serverMs` parsed from response `Server-Timing: total;dur=<ms>` (null if absent). `networkMs = totalMs - serverMs` when `serverMs` is known. `sse.message` only logs when `handlerMs >= 1` or `transportMs >= 50`.

## SSE Timing Model

Three timing surfaces, not connection lifetime:

1. **Server broadcast time** — `sse.broadcast.complete` measures the fan-out enqueue across all subscribers (server-side only). Sub-millisecond fan-outs stay at `debug`.
2. **Transport time** — server injects `_sentAt: Date.now()` into the SSE data envelope; the browser computes `transportMs = Date.now() - _sentAt`. **Clock-skew sensitive** between server/client; use for relative comparisons, not absolute SLAs.
3. **Client handler time** — `handlerMs = performance.now()` delta around the message dispatch in the browser.

`request.complete` for SSE GETs logs `streaming: true` / `durationMs: null` — connection lifetime is not the metric we care about.

## Agent Log Analysis CLI

Use `logs:analyze` as the first tool for performance diagnosis. It emits bounded JSON by default so agents can rank evidence without reading the entire log.

```bash
bun run logs:analyze -- report
bun run logs:analyze -- report --in path/to/log --format markdown
bun run logs:analyze -- report --since 2026-05-21T12:00:00Z --top 20
bun run logs:analyze -- report --projectName NAME --sessionName SESSION
bun run logs:analyze -- trace <traceId> --format markdown
bun run logs:analyze -- compare --before before.log --after after.log
```

`report` runs slow request ranking, operation hotspot aggregation, duplicate-work detection, state-store diagnostics, external command diagnostics, SSE broadcast diagnostics, client timing analysis when `--client-log` is provided, error correlation, and instrumentation-gap detection.

`trace <traceId>` reconstructs timed operation intervals for one trace and reports inclusive time, exclusive time, duplicate work, warnings/errors, and unexplained request time. If unexplained time dominates, add `timed()` coverage before optimizing code.

`compare` reports before/after endpoint p95 deltas, operation p95 deltas, new duplicate-work signatures, and new warnings/errors.

Options shared across commands:

```bash
--in <path> --format json|markdown --out <path> --markdown-out <path>
--speedscope-out <path> --since <iso> --until <iso>
--projectName <name> --sessionName <name> --conversationId <id>
--path <api-path> --action <action> --top <n>
--slow-ms <n> --hotspot-ms <n> --include-self --pretty
```

Default log path resolution (analysis CLI only) checks `CC_LOG_FILE`, `<config-dir>/logs/global.log`, `<config-dir>/cc-debug.log` (legacy), `./.config/logs/global.log`, and `./.config/cc-debug.log` (legacy). Scoped per-session/per-conversation files under `logs/sessions/` are not auto-discovered — pass them explicitly with `--in`.

## Speedscope Export (hotspot aggregation)

Aggregate `timed()` durations across the whole app and view them in https://speedscope.app. Designed for answering "where does most execution time go?" via Speedscope's **Left Heavy** and **Sandwich** views.

```bash
bun run trace:speedscope                                  # global.log → trace.json
bun run trace:speedscope -- --trace <traceId>             # filter to one HTTP request
bun run trace:speedscope -- --since 2026-05-21T12:00:00Z  # drop older entries
bun run trace:speedscope -- --in path/to/log --out my-trace.json
```

The exporter serializes every trace end-to-end onto a single `aggregated` thread (tid=1). Within each group, parent/child nesting is reconstructed from time containment; events that overlap as siblings (e.g. `Promise.all`) are promoted to additional roots. Entries without a `traceId` each become their own single-event group.

**Tradeoff:** wall-clock fidelity is intentionally lost so Speedscope's aggregating views show trustworthy per-frame totals. The Time Order view will display a synthetic serialized timeline rather than real wall clock — use `--trace <id>` if you need to inspect a single request in time order.

The output is valid Chrome Trace Event Format, so Perfetto / chrome://tracing will load it, but only Speedscope's aggregating views answer the question this tool is built for.

Implementation: pure converter in `src/lib/logging/speedscope-export.ts`; CLI entry in `scripts/speedscope-export.ts`.

## Transcripts (`transcripts/{id}.jsonl`)

Per-conversation JSONL. Each line is a `TranscriptEntry`.

| `type` | Purpose |
|---|---|
| `user` | User prompt (text + image refs) |
| `assistant` | Claude response (text, tool_use blocks) |
| `system` | SDK init, session ID assignment |
| `tool_result` | Tool execution results |
| `result` | Conversation completion (`is_error`, `duration_ms`, `total_cost_usd`, `num_turns`) |
| `rate_limit_event` | API rate limit info |

Content blocks: `text`, `tool_use`, `tool_result`, `command` (parsed slash command), `image` (legacy inline base64), `image_ref` (externalized to disk — current format).

`readConversationMessages()` in `transcript.ts` filters visible messages, merges consecutive same-role entries, resolves `image_ref` → inline `image`, detects slash commands.

## State Store (SQLite)

State lives in `command-center.db` (WAL mode) and is accessed through a write queue (`src/lib/state-store/`). The aggregate exposes the legacy `ManagerState → projects → sessions → conversations[]` hierarchy to callers.

Key `ConversationState` fields: `id` (matches transcript filename), `status` (`new`/`awaiting`/`running`/`waiting_for_input`), `claudeSessionId` (SDK resume), `transcriptPath`, `totalCostUsd`, `totalDurationMs`, `totalTurns`, `promptCount`.

Startup: stale `running`/`waiting_for_input` conversations are reset to `awaiting` during recovery.

## SSE Events

Broadcast via `events/broadcaster.ts`; client-side Zod-validated.

| Event | Trigger |
|---|---|
| `conversation-status` | `running` / `awaiting` / `waiting_for_input` transitions |
| `ask-question` | SDK requests permission/input |
| `message-queued` | Queued via `streamInput()` into running conversation |
| `job-status` | Background job state change |
| `notification-created` / `notification-updated` | Notification lifecycle |
| `graph-workflow-status` / `-context-status` / `-task-status` / `-validation-result` / `-circuit-breaker` / `-shared-documents-updated` / `-pending-halt-reason` / `-merge-status` / `-batch-scheduled` / `-lane-status` / `-join-status` | Graph workflow events |
| `dev-server-status` | Dev server lifecycle/health |

## Tracing

```
HTTP request (X-Trace-Id) → withTracing() middleware
  → AsyncLocalStorage trace context
    (traceId, action, projectName, sessionName, conversationId)
    → all createLogger() calls auto-enriched
      → logs/global.log  +  logs/sessions/<proj>__<sess>/[conversations/<conv>.]log
  → prompt.ts → conversation actor → transcript.ts (jsonl) + transcript-images.ts + broadcast()
  → state-store (SQLite via write queue)
```

Every API route wrapped with `withTracing()`. TraceId links debug entries for one request; `request.start`/`request.complete` from the `tracing` module are dual-written to both the scoped destination and `global.log`. Transcripts are separate (conversation content, not request lifecycle).

Background entrypoints (jobs, workflow execution, SDK turns, SSE broadcasts) call `runAsTrace(action, fn, inherit?)` so all `timed()` calls during the unit of work share a `traceId` for hotspot aggregation.

## Workflow Execution Logs (`workflow-logs/{executionId}/`)

Per-execution structured logs for graph workflow forensics. Separate from `logs/global.log` — captures full decision trail for AI agent post-hoc investigation.

```
workflow-logs/<executionId>/
├── _manifest.json                       # Entry point: metadata, definition, context summaries
├── lifecycle.jsonl                       # Execution events (start/pause/resume/halt/complete)
├── decisions.jsonl                       # Cross-cutting decisions (rotation, retry, circuit breaker)
└── contexts/<contextId>/
    ├── iterations.jsonl                  # Iteration lifecycle
    ├── tasks.jsonl                       # Task events (completion, reopening, agent-added, validation)
    ├── validation.jsonl                  # Validator invocations, results, remediation
    ├── validation-transcript.jsonl       # Full validator agent transcripts (reasoning, tool/command items, messages)
    └── prompts/                          # iteration-<n>.md, *.md / *.json validator prompts/responses
```

### Investigation order

1. `_manifest.json` — status, halt reason, summaries, full definition
2. `lifecycle.jsonl` — when started/paused/resumed/halted
3. `decisions.jsonl` — rotation, scheduling, retry, circuit-breaker triggers
4. `contexts/<id>/` — drill-down into iterations / tasks / validation / prompts

### Key events by file

| File | Events |
|---|---|
| `lifecycle.jsonl` | `execution.started`/`resumed`/`paused`/`aborted`/`completed`/`halted`; `shared_document.created`/`updated` |
| `decisions.jsonl` | `context.scheduled`, `implementer.rotation`, `rotation.scheduled` (token utilization), `max_iterations.reached` |
| `iterations.jsonl` | `iteration.started`/`prompt_sent`/`agent_turn_completed`/`follow_up_sent`/`follow_up_skipped`/`completed` |
| `tasks.jsonl` | `task.completion_attempted`/`validation_passed`/`validation_failed`/`added_by_agent`/`reopened` |
| `validation.jsonl` | `task_validator.started`, `context_validator.started`, `validator.invoked`/`result_parsed`/`remediation_applied` |
| `validation-transcript.jsonl` | `validator.transcript_begin` (lane, engine, attempt, entryCount) + one `validator.transcript_item` (seq, backend, itemType, raw) per backend-native item/message; appended per validator invocation |

Shared schema: `{ timestamp, event, executionId, ...data }`.

### jq queries

```bash
jq 'select(.event == "validator.result_parsed" and .pass == false)' workflow-logs/<id>/contexts/<ctx>/validation.jsonl
jq 'select(.itemType == "reasoning") | .raw' workflow-logs/<id>/contexts/<ctx>/validation-transcript.jsonl
jq 'select(.event | test("circuit_breaker|retry"))' workflow-logs/<id>/decisions.jsonl
jq 'select(.event == "task.reopened")' workflow-logs/<id>/contexts/<ctx>/tasks.jsonl
jq 'select(.event | test("rotation|implementer"))' workflow-logs/<id>/decisions.jsonl
```

### Design

- **Fire-and-forget** — log write failures never affect execution
- **AI-optimized split** — separate files per concern; agents load only what's relevant
- **Full prompt capture** — every prompt + validator response stored verbatim
- **Parse-path tracking** — validator responses record which parse path succeeded (`structured_output`/`raw_json`/`fenced_json_block`/`fenced_json_block_fallback`)

### Implementation

- `createExecutionLogger()` in `src/lib/workflow-graph/execution-logger.ts` — factory
- `registerExecutionLogger()` / `getExecutionLogger()` — global registry (Map keyed by executionId)
