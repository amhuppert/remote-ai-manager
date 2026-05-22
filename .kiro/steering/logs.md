# Logging & Diagnostics

Persistent data lives under config dir (`~/.config/cc` Linux, `~/Library/Application Support/cc` macOS).

```
<config-dir>/
├── cc-debug.log                              # NDJSON debug log
├── state.json                                 # Manager state
├── config.json                                # Global config
├── notifications.db                           # SQLite (jobs/notifications, WAL mode)
├── transcripts/{conversationId}.jsonl         # Per-conversation
├── transcripts/images/{conversationId}/...    # Externalized images
└── workflow-logs/{executionId}/               # Graph workflow execution logs
```

## Debug Log (`cc-debug.log`) — NDJSON

Every API request gets a trace context that auto-enriches log entries.

```json
{ "timestamp": "ISO 8601", "level": "debug|info|warn|error",
  "module": "prompt|sessions|state|tracing|...", "message": "event.name",
  "traceId": "uuid", "action": "...", "projectName": "...", "sessionName": "..." }
```

### Key events

| Module | Event | Notes |
|---|---|---|
| `tracing` | `request.start` / `request.complete` / `request.error` | `complete` includes `status`, `durationMs` |
| `prompt` | `prompt.submit` | `promptLength`, `model`, `resume` |
| `prompt` | `prompt.complete` / `prompt.timeout` / `prompt.aborted` / `prompt.sdk_error` | |
| `state` | `state.recover_stale_conversation` | Stale "running" reset on startup |
| `sessions` | `session.create` | `worktreePath`, `branchName`, `mode` |

### Config

- `CC_LOG_LEVEL` — `debug` / `info` (default) / `warn` / `error`
- `CC_LOG_FILE` — override path
- `CC_LOG_SILENT` — suppress stderr emission
- `warn`/`error` also go to stderr

### Timing & performance config

- `CC_TIMING_INFO_MS` (default `50`) — `timed()` `.complete` logs at `info` when `durationMs >=` this
- `CC_TIMING_WARN_MS` (default `1000`) — `timed()` `.complete` logs at `warn` when `durationMs >=` this
- `CC_TIMING_START` (default `0`) — set to `1` to emit `<event>.start` debug logs for every `timed()` call
- `CC_REQUEST_SLOW_MS` (default `500`) — `request.complete` logs at `warn` when `durationMs >=` this (non-streaming responses only)

Below `CC_TIMING_INFO_MS`, `timed()` complete logs land at `debug` and only surface when `CC_LOG_LEVEL=debug`.

### jq queries

```bash
jq 'select(.level == "error")' cc-debug.log
jq 'select(.traceId == "UUID")' cc-debug.log
jq 'select(.sessionName == "NAME" and (.message | startswith("prompt.")))' cc-debug.log
jq 'select(.message == "request.complete" and .durationMs > 1000)' cc-debug.log
jq 'select(.message | startswith("git.")) | {action, args: .argsPreview, durationMs}' cc-debug.log
jq 'select(.message == "sse.broadcast.complete" and .durationMs > 10)' cc-debug.log
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
| `sse-broadcaster` | `sse.broadcast.complete` | `eventType`, `seq`, `subscriberCount`, `delivered`, `payloadBytes`, `durationMs` |
| `sse-broadcaster` | `broadcast.no_clients` | Zero subscribers (warn) |
| `transcript` | `transcript.read.complete` | `messageCount`, `durationMs` |
| `state-store/state-db` (via `notification-db`) | `state-db.createNotification` / `.createJobRecord` / `.updateJobRecord` / `.recoverStaleJobs` / `.cleanupOldNotifications` `.complete` | Per-write fields (`notificationId`, `jobId`, `status`, `deleted`, `recoveredCount`) |
| `state-store` | `state.mutate.complete` | `label`, `sessionName`, `durationMs` |
| `file-scanner` | `file-scanner.scan.complete` | `rootPath`, `fileCount`, `truncated`, `durationMs` |
| `worktree` | `worktree.create.complete` / `worktree.remove.complete` | `laneId`, `worktreePath`, `branchName`, `status`, `durationMs` |
| `diff` | `diff.compute.complete` | `worktreePath`, `fileCount`, `durationMs` |
| `workflow-storage` | `workflow-storage.list` / `.get` / `.create` / `.update` / `.delete` `.complete` | `workflowId` (where applicable), `workflowCount`/`found`/`revision`/`deleted`, `durationMs` |

Existing `tracing.request.complete` augmented:
- Non-SSE responses: includes `durationMs`, response headers include `Server-Timing: total;dur=<ms>`; logs at `warn` when `durationMs >= CC_REQUEST_SLOW_MS`, else `info`.
- SSE responses (content-type `text/event-stream`): `streaming: true`, `durationMs: null`, logged at `debug`; no `Server-Timing` header.

## Client-Side Timing

`tracedFetch` and the `NotificationListener` SSE handler emit `console.debug` logs in the browser. They are not shipped to the server in this pass; correlate via `traceId` with `cc-debug.log`.

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

## Perfetto / Chrome Trace Export

Visualize `timed()` durations as a flamegraph by converting the NDJSON log into Chrome Trace Event Format and dropping the result into https://ui.perfetto.dev/.

```bash
bun run trace:perfetto                                  # global.log → trace.json
bun run trace:perfetto -- --trace <traceId>             # filter to one HTTP request
bun run trace:perfetto -- --since 2026-05-21T12:00:00Z  # drop older entries
bun run trace:perfetto -- --in path/to/log --out my-trace.json
```

Each unique `traceId` becomes its own track (thread row) labeled by `action`; entries without a `traceId` land on a shared `background` track. Within a track, nested spans render as stacked bars based on overlapping intervals — no explicit parent-child wiring is required because every `timed()` call propagates `traceId` via AsyncLocalStorage.

Implementation: pure converter in `src/lib/logging/perfetto-export.ts`; CLI entry in `scripts/perfetto-export.ts`.

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

## State File (`state.json`)

Atomic writes (temp + rename). Hierarchy:

```
ManagerState → projects → sessions → conversations[]
```

Key `ConversationState` fields: `id` (matches transcript filename), `status` (`new`/`awaiting`/`running`/`waiting_for_input`), `claudeSessionId` (SDK resume), `transcriptPath`, `totalCostUsd`, `totalDurationMs`, `totalTurns`, `promptCount`.

Startup: `recoverStaleConversations()` resets stuck `running`/`waiting_for_input` → `awaiting`.

## SSE Events

Broadcast via `sse-broadcaster.ts`; client-side Zod-validated.

| Event | Trigger |
|---|---|
| `conversation-status` | `running` / `awaiting` / `waiting_for_input` transitions |
| `ask-question` | SDK requests permission/input |
| `session-finished` | Terminal session state |
| `message-queued` | Queued via `streamInput()` into running conversation |
| `job-status` | Background job state change |
| `notification-created` / `notification-updated` | Notification lifecycle |
| `graph-workflow-status` / `-context-status` / `-task-status` / `-validation-result` / `-retry` / `-circuit-breaker` / `-shared-documents-updated` | Graph workflow events |
| `dev-server-status` | Dev server lifecycle/health |

## Tracing

```
HTTP request (X-Trace-Id) → withTracing() middleware
  → AsyncLocalStorage trace context (traceId, action, projectName, sessionName)
    → all createLogger() calls auto-enriched → cc-debug.log
  → prompt.ts → transcript.ts (jsonl) + transcript-images.ts + broadcast()
  → state.ts (atomic write)
```

Every API route wrapped with `withTracing()`. TraceId links debug entries for one request; transcripts are separate (conversation content, not request lifecycle).

## Workflow Execution Logs (`workflow-logs/{executionId}/`)

Per-execution structured logs for graph workflow forensics. Separate from `cc-debug.log` — captures full decision trail for AI agent post-hoc investigation.

```
workflow-logs/<executionId>/
├── _manifest.json                       # Entry point: metadata, definition, context summaries
├── lifecycle.jsonl                       # Execution events (start/pause/resume/halt/complete)
├── decisions.jsonl                       # Cross-cutting decisions (rotation, retry, circuit breaker)
└── contexts/<contextId>/
    ├── iterations.jsonl                  # Iteration lifecycle
    ├── tasks.jsonl                       # Task events (completion, reopening, agent-added, validation)
    ├── validation.jsonl                  # Validator invocations, results, remediation
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

Shared schema: `{ timestamp, event, executionId, ...data }`.

### jq queries

```bash
jq 'select(.event == "validator.result_parsed" and .pass == false)' workflow-logs/<id>/contexts/<ctx>/validation.jsonl
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
