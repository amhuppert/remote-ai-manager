# Logging & Diagnostics

Persistent data lives under config dir (`~/.config/cc` Linux, `~/Library/Application Support/cc` macOS).

```
<config-dir>/
├── logs/
│   ├── global.log                              # NDJSON debug log (default sink)
│   ├── sessions/<projectSlug>__<sessionSlug>/
│   │   ├── session.log                          # Session-scoped NDJSON
│   │   └── conversations/<conversationSlug>.log # Conversation-scoped NDJSON
│   └── projects/<projectSlug>/                  # Project conversations (no session)
│       ├── project.log
│       └── conversations/<conversationSlug>.log
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
- Project conversation (`sessionName` is the internal sentinel) → `logs/projects/<projectSlug>/conversations/<conversationSlug>.log`, or `logs/projects/<projectSlug>/project.log` without a conversation id
- Otherwise → `logs/global.log`

A file path is a diagnostic identity a reader sees, so a project conversation
does NOT route to `sessions/<projectSlug>__<sentinel>/…` (R1.3). Readers built on
`discoverScopedLogPaths` walk both trees.

Path components are sanitized (non-`[A-Za-z0-9._-]` → `_`, leading dots stripped, truncated to 80 chars with a SHA-256 suffix). On sanitization failure the logger falls back to the next-priority scope and emits a `logger.path.sanitize_failure` diagnostic.

**Dual-write exception:** `request.start` / `request.complete` from the `tracing` module are written to BOTH the scoped destination AND `logs/global.log` so operators retain a chronological cross-session timeline.

Setting `CC_LOG_FILE` or `CC_LOG_SCOPED=0` collapses all writes to a single file (the override path or `logs/global.log` respectively).

```json
{ "timestamp": "ISO 8601", "level": "debug|info|warn|error",
  "module": "prompt|sessions|state-store|tracing|...", "message": "event.name",
  "traceId": "uuid", "action": "...", "projectName": "...",
  "sessionName": "...", "conversationId": "..." }
```

### Conversation scope in log fields

Log fields are a PUBLIC identity surface (`project-conversation-parity` R1.3):
the project sentinel `__project__` must never appear in one. A project
conversation is session-less, so it emits `scope: "project"` and **no
`sessionName` key at all** — an absent key rather than a placeholder, because
there is no correct session value to report.

**The sink enforces this, not the discipline below.** `buildEntry` in
`logging/logger.ts` drops a sentinel-valued `sessionName` and substitutes
`scope: "project"` (`refuseSentinelSessionIdentity`). It has to live there
because the trace context stamps `sessionName` onto EVERY entry emitted inside a
request — a project request leaks from log sites whose own call sites never
mention a session, so no per-call-site audit can be complete. It is the logging
analogue of the throw in `conversationTargetApiBase`; the logger never throws by
contract, so it substitutes.

Log-file ROUTING is resolved from the raw trace context, not from the sanitized
entry, so the field guard cannot reach it. It has its own rule: a project
conversation routes to the `logs/projects/` tree above, so the sentinel never
occupies a path component either.

The rest of this section is still how you WRITE a log site on a project path.
The sink guarantees the output; deriving the scope at the call site is what makes
the code say what it means, and it is what the R1.3 tests assert.

Never log a session name taken from a session-keyed storage API: that value IS
the sentinel for a project conversation. Carry a `ConversationScopeRef` (or
`ConversationTarget`) through scope-invariant code, spread it into the log
fields, and materialize the store key only at the storage call site via
`storeSessionNameFromScopeRef` / `conversationTargetStoreSessionName`. If no
sentinel-valued variable is ever bound, the leak cannot be written.

This is not enforceable by the sentinel architecture test, which reads imports
rather than emitted fields — a handler classified `internal-adapter` there leaked
the sentinel through four log sites. Handlers under R1.3 therefore take their
`Logger` through deps so a test can read what they actually emitted; use
`createCapturingLogger()` from `@/lib/shared/testing/capturing-logger`. Assert
both directions: no sentinel at project scope, and the real session name still
present at session scope (the fix must remove the sentinel, not the diagnostic).

**The whole turn path is the largest instance**, and it is a chain, not one
module: the project entry synthesizes a sentinel `SessionState`, and that store
key is then handed to every stage. Each stage derives one `scopeRef` at its top
and spreads it:

| Stage | Module | Events |
| --- | --- | --- |
| Prompt facade | `prompt/sdk-driver.ts` | `prompt.submit`, `prompt.complete`, `prompt.command_*`, `prompt.collab_*` |
| Actor lifecycle | `workflows/conversation/manager.ts` | `conversation-manager.actor_started`, `.turn_rejected`, `.turn_failed`, `.ensure_and_drain` |
| Resource acquisition | `prompt/single-flight.ts`, `shared/query-semaphore.ts` | `conversation-lock.{acquired,released,rejected}`, `semaphore.*` |
| Turn runtime | `workflows/conversation/actor-implementations.ts` | `prompt.runtime_create`, `prompt.mcp_seeded`, `prompt.sdk_error`, `task_run.*` |
| Retry policy | `workflows/conversation/with-runtime-replacement-retry.ts` | `prompt.runtime_retry`, `prompt.continuation_pair_contradiction` |
| Transcript | `prompt/transcript.ts` | `documents-index.index_failed`, `notice_appended` |
| Message queue | `prompt/queue.ts`, `conversations/message-queue-drain.ts` | `queue.accepted`, `queue.drain_*` |

Four further project-reachable stages sit outside the turn and follow the same
rule:

| Stage | Module | Events |
| --- | --- | --- |
| Startup rehydration | `workflows/conversation/rehydration.ts` | `conversation-manager.rehydrated`, `queue.recover_failed` |
| Workflow task run (project compaction, ticket generation) | `workflows/conversation/execute-workflow-task-run.ts` | `conversation.execute_workflow_task_run.{dispatch,finalized}` |
| State-store reads | `state-store/accessors.ts` | `state.read.timing` |
| Conversation draft | `prompt/route-handlers.ts` (`persistPendingPromptText`) | `pending_prompt.{update_completed,compare_and_clear_completed,update_failed}` |

Three traps this chain teaches:

- **Fixing a module's own log statements is not enough.** A stage also hands
  identity to helpers that log from their own module. `withRuntimeReplacementRetry`
  is the example: it took a `sessionName` in its `meta` and emitted it from a
  module-scoped logger no test could read. It now takes a `ConversationScopeRef`
  and its `Logger` through deps, and the actor passes its own — so one capturing
  logger covers the turn and everything it dispatches through.
- **Name the carrier for what it is.** `TranscriptBroadcastMeta` calls its field
  `storeSessionName`, not `sessionName`, because every consumer spreads that meta
  into a payload or a log line. A field named `sessionName` holding the sentinel
  will eventually be spread onto a public surface; a field named
  `storeSessionName` has to be deliberately renamed to get there. `AppendNoticeInput`
  follows the same rule; so does `acquireConversationLock`, whose store key legitimately
  keys the lock Map but never reaches its `conversation-lock.*` fields.
- **A free-form label is a log field.** The query semaphore emits only the label
  it is handed — into every `semaphore.*` event and into the text of its
  queue-timeout `Error`, which reaches a client. Build such labels from the scope
  ref (`prompt:<session>` / `prompt:project:<conversationId>`), never by
  interpolating a storage name.
- **A threshold hides a sink.** `state.read.timing` only fires above 5ms, so an
  in-memory read never emitted it in a test and the leak went unobserved for six
  review rounds. When a diagnostic is conditional, its test has to make the
  condition true (`read-timing-scope.test.ts` wraps the repository read), not
  assume the sink is unreachable.

Scope of the rule: a log site is only a leak if the sentinel can REACH it. Most
`sessionName` log fields in the codebase sit on session-only paths where a real
session name is the correct value and must stay. When adding a log field on a
path a project conversation can reach, derive the scope ref instead.

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
- `CC_LOG_MAX_BYTES` — rotate a log file once an append would exceed this size (default `104857600` = 100 MiB; `0` disables rotation → unbounded growth)
- `CC_LOG_MAX_FILES` — rotated backups retained per file (default `5`; total disk per file ≈ `CC_LOG_MAX_BYTES × (CC_LOG_MAX_FILES + 1)`)
- `warn`/`error` also go to stderr unless `CC_LOG_SILENT=1`

### Rotation & retention

Size-based, applied in `appendLine` so it covers `global.log` and the scoped
session/conversation logs uniformly. When an append would push a file past
`CC_LOG_MAX_BYTES`, it rotates: `<file>.<N>` is dropped, `<file>.i` → `<file>.(i+1)`,
`<file>` → `<file>.1`, and the fresh file opens with a `logger.rotate` marker line.
Per-file size is tracked in memory (seeded by one `stat` per path) so the
synchronous-append hot path does not stat on every line; a restart re-seeds from
the existing file and rotates it on the next write. Only `global.log` realistically
reaches the threshold — scoped logs are bounded by session lifetime.

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

Every timed event records its primary duration under a canonical **`durationMs`** field. A few events additionally emit a sub-phase breakdown alongside `durationMs`: the write queue's `waitMs`/`holdMs` (`durationMs = waitMs + holdMs`) and `diff.timing`'s `paramsMs`/`resolveMs`/`sessionMs`/`diffMs`/`serializeMs`. Legacy logs (pre-canonicalization) recorded `state.read.timing` / `diff.timing` durations under `totalMs`; the analysis parser still reads it as a fallback.

| Module | Event | Fields |
|---|---|---|
| `exec` | `exec.complete` / `exec.error` | `command`, `argsPreview`, `cwd`, `durationMs`, `stdoutBytes`, `stderrBytes`, `exitCode` |
| `exec` | `spawn.start` / `spawn.exit` / `spawn.spawn_error` | `command`, `argsPreview`, `cwd`, `pid`, `durationMs`, `exitCode`, `signal` |
| `git-client` (via exec, `eventPrefix: "git"`) | `git.complete` / `git.error` | All git ops via `GitClient`; `command="git"`, `argsPreview`, `durationMs` |
| `validation` | `validation.run_requested` / `.queued` / `.started` / `.completed` / `.rejected` / `.spawn_failed` | Server-owned validation admission, queueing, execution, and terminal accounting |
| `validation` | `validation.runner.spawned` / `.start_confirmed` / `.timeout` / `.cancel_requested` / `.group_kill_escalated` / `.group_dead` / `.spawn_error` | Validation process-group lifecycle |
| `tailscale` (via exec, `eventPrefix: "tailscale"`) | `tailscale.complete` / `.error` | All `tailscale` CLI calls |
| `dev-server` (via exec, `eventPrefix: "dev-server"`) | `dev-server.start` / `dev-server.exit` | Per-session dev server process lifecycle |
| `init-script` (via exec, `eventPrefix: "init-script"`) | `init-script.complete` / `.error` | Worktree init scripts |
| `sse` | `sse.broadcast.complete` | `eventType`, `seq`, `subscriberCount`, `delivered`, `payloadBytes`, `durationMs` |
| `sse` | `broadcast.no_clients` | Zero subscribers (warn) |
| `transcript` | `transcript.read.complete` | `messageCount`, `durationMs` |
| `state-db` (via `notification-db`) | `state-db.createNotification` / `.createJobRecord` / `.updateJobRecord` / `.recoverStaleJobs` / `.cleanupOldNotifications` `.complete` | Per-write fields (`notificationId`, `jobId`, `status`, `deleted`, `recoveredCount`) |
| `state-store` | `state.mutate.complete` | `label`, `sessionName`, `durationMs` |
| `state-store` | `state.read.timing` | `accessor`, `durationMs` (and optionally `projectPath`, `sessionName`, `conversationId`); only emitted when `durationMs >= STATE_READ_TIMING_LOG_THRESHOLD_MS` |
| `state-store` | `state-store.write_queue.timing` | `label`, `durationMs`, `waitMs`, `holdMs` (`durationMs = waitMs + holdMs`); plus `blockedByLabel` / `blockedByTraceId` when the wait was caused by another mutation holding the queue (the waiter's own `traceId` is the ambient auto-stamp) — feeds the log-analysis `state-store` finding |
| `state-store` | `state-store.write_queue.hold_budget_exceeded` | **error**-level: a callback held the queue past the budget (default 500ms). Fields: `label`, `holdMs`, `budgetMs`, `stack` (captured where the write was enqueued). Telemetry only — the write is never aborted |
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

Use `logs:analyze` as the first tool for performance diagnosis. It emits concise Markdown by default for an agent's own reading; select `--format json` only when the result feeds code.

```bash
bun run logs:analyze -- report
bun run logs:analyze -- report --in path/to/log
bun run logs:analyze -- report --since 2026-05-21T12:00:00Z --top 20
bun run logs:analyze -- report --projectName NAME --sessionName SESSION
bun run logs:analyze -- trace <traceId>
bun run logs:analyze -- compare --before before.log --after after.log
```

`report` runs slow request ranking, operation hotspot aggregation, duplicate-work detection, state-store diagnostics (including `write_queue.hold_budget_exceeded` findings keyed by the holding mutation label), external command diagnostics, SSE broadcast diagnostics, client timing analysis when `--client-log` is provided, error correlation, convention checks (a `202` response with `durationMs > 1000` is a violation), instrumentation-gap detection, and performance-budget evaluation against `scripts/log-budgets.json` (advisory by default; `--assert-budgets` exits non-zero on breach). See `.claude/skills/cc-performance-log-analysis/SKILL.md` for the budget schema.

`trace <traceId>` reconstructs timed operation intervals for one trace and reports inclusive time, exclusive time, duplicate work, warnings/errors, and unexplained request time. If unexplained time dominates, add `timed()` coverage before optimizing code.

`compare` reports before/after endpoint p95 deltas, operation p95 deltas, new duplicate-work signatures, and new warnings/errors.

Options shared across commands:

```bash
--in <path> --format json|markdown --out <path> --markdown-out <path>
--speedscope-out <path> --since <iso> --until <iso>
--projectName <name> --sessionName <name> --conversationId <id>
--path <api-path> --action <action> --top <n>
--slow-ms <n> --hotspot-ms <n> --include-self --pretty
--budgets <path> --assert-budgets   # report only; budget config + CI gate
```

Default log path resolution (analysis CLI only) checks `CC_LOG_FILE`, `<config-dir>/logs/global.log`, `<config-dir>/cc-debug.log` (legacy), `./.config/logs/global.log`, and `./.config/cc-debug.log` (legacy). Scoped files under `logs/sessions/` and `logs/projects/` ARE auto-discovered (`discoverScopedLogPaths` walks both trees). Rotated backups (`global.log.1`, `global.log.2`, …) are likewise not auto-discovered, so default discovery sees only the active file; pass the backups explicitly (or a glob) with `--in` to analyze across rotations.

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
| `assistant` | Agent response (text, thinking, and tool blocks as supported) |
| `system` | Adapter-projected backend initialization/metadata |
| `tool_result` | Tool execution results |
| `result` | Adapter-projected completion (`duration_ms`, `total_cost_usd`, `num_turns`, and failure fields when available) |
| provider-native type | Lossless native entry wrapped with `backend`, `seq`, `type`, and uninterpreted `raw` payload |

Content blocks: `text`, `thinking`, `tool_use`, `tool_result`, `command` (parsed slash command), `image` (legacy inline base64), `image_ref` (externalized to disk), `image_marker`, `debug_structured`, and `document_feedback`.

`readConversationMessages()` in `transcript.ts` filters visible messages, merges consecutive same-role entries, resolves `image_ref` → inline `image`, detects slash commands.

## State Store (SQLite)

State lives in `command-center.db` (WAL mode) and is accessed through a write queue (`src/lib/state-store/`). The aggregate exposes the legacy `ManagerState → projects → sessions → conversations[]` hierarchy to callers.

Key `ConversationState` fields: `id` (matches transcript filename), `status` (`new`/`awaiting`/`running`/`waiting_for_input`), `backendRef` (opaque `{ backend, ref }` continuity handle), `transcriptPath`, `totalCostUsd`, `totalDurationMs`, `totalTurns`, `promptCount`.

Startup: stale `running`/`waiting_for_input` conversations are reset to `awaiting` during recovery.

## SSE Events

Publish through `events/publication.ts` (`publishEvent`, an injected `PublishFn`, `publishEventBestEffort`, or `publishScopedStatus`); the raw broadcaster is private transport. Clients validate frames with Zod.

| Event | Trigger |
|---|---|
| `conversation-status` | `running` / `awaiting` / `waiting_for_input` transitions |
| `ask-question` | Backend or workflow requests permission/input |
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
  → prompt route → conversation lifecycle → backend adapter
      → transcript.ts (jsonl) + transcript-images.ts + publication.publishEvent()
  → state-store (SQLite via write queue)
```

Every API route wrapped with `withTracing()`. TraceId links debug entries for one request; `request.start`/`request.complete` from the `tracing` module are dual-written to both the scoped destination and `global.log`. Transcripts are separate (conversation content, not request lifecycle).

Background entrypoints (jobs, workflow execution, backend turns, SSE publication) call `runAsTrace(action, fn, inherit?)` so all `timed()` calls during the unit of work share a `traceId` for hotspot aggregation.

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
