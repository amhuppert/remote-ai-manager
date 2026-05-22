---
description: This skill should be used when diagnosing CC issues, analyzing failures, tracing user actions through logs, investigating state corruption, prompt execution errors, lock contention, or understanding what happened in recent runs. Use when asked to "check logs", "debug", "what went wrong", "trace request", "find errors", or "analyze recent activity".
name: debug-logs
---

# CC Debug Log Analysis

Structured NDJSON logs trace every user action from UI through API routes to the Claude Agent SDK. Each log line is a self-contained JSON object. All entries from one user action share a `traceId` UUID.

## Log File Location

Default routing is scoped: writes land in `<config-dir>/logs/global.log`, `<config-dir>/logs/sessions/<projectSlug>__<sessionSlug>/session.log`, or `<config-dir>/logs/sessions/<projectSlug>__<sessionSlug>/conversations/<conversationSlug>.log` depending on the active trace context. `request.start` / `request.complete` from the `tracing` module are dual-written to BOTH the scoped destination and `global.log`, so `global.log` retains a full cross-session timeline.

```bash
# Linux (default)
CONFIG_DIR="${CC_CONFIG_DIR:-$HOME/.config/cc}"
# macOS (default)
CONFIG_DIR="${CC_CONFIG_DIR:-$HOME/Library/Application Support/cc}"

LOG="${CC_LOG_FILE:-$CONFIG_DIR/logs/global.log}"
# Per-session / per-conversation files:
ls "$CONFIG_DIR/logs/sessions/"
ls "$CONFIG_DIR/logs/sessions/<projectSlug>__<sessionSlug>/conversations/"
```

`CC_LOG_FILE` collapses everything to one file. `CC_LOG_SCOPED=0` disables scoped routing (everything → `global.log`).

Verify: `wc -l "$LOG"` to confirm file exists and check size before querying. Start with `global.log` for cross-session triage; switch to the scoped file once narrowed to one session/conversation for deep drill-downs.

## Log Entry Structure

Every line: `{"timestamp":"ISO8601","level":"info","module":"prompt","message":"prompt.complete","traceId":"uuid",...}`

Auto-enriched context fields (from AsyncLocalStorage): `traceId`, `action`, `projectName`, `sessionName`, `conversationId`.

## Quick Diagnosis (Start Here)

Always start with error/warning summary to orient before diving deeper:

```bash
# Error summary by type (most common first)
grep '"level":"error"' "$LOG" | jq -r .message | sort | uniq -c | sort -rn

# Warning summary by type
grep '"level":"warn"' "$LOG" | jq -r .message | sort | uniq -c | sort -rn

# Last 5 errors with context
grep '"level":"error"' "$LOG" | tail -5 | jq '{message,module,error,sessionName,traceId}'

# Last 5 warnings
grep '"level":"warn"' "$LOG" | tail -5 | jq '{message,module,sessionName,traceId}'

# Recent activity (last 20 entries)
tail -20 "$LOG" | jq '{timestamp,level,module,message,sessionName}'
```

## End-to-End Request Tracing

The trace flow for every request: `request.start` → module operations → `request.complete` (or `request.error`).

### Step 1: Find the traceId

```bash
# From most recent error
grep '"level":"error"' "$LOG" | tail -1 | jq -r .traceId

# From a specific action type
grep '"action":"send-prompt"' "$LOG" | tail -1 | jq -r .traceId

# From a specific session's recent activity
grep '"sessionName":"SESSION_NAME"' "$LOG" | tail -1 | jq -r .traceId
```

### Step 2: Reconstruct the full chain

```bash
grep 'TRACE_ID' "$LOG" | jq '{timestamp,module,message,level,error,durationMs}'
```

This shows the complete request lifecycle and every operation that happened within it.

## Debugging by Scenario

### Prompt Execution Failures

```bash
# All SDK errors with key context
grep '"message":"prompt.sdk_error"' "$LOG" | jq '{sessionName,conversationId,error,backend}'

# Timeouts and aborts
grep -E '"message":"prompt\.(timeout|aborted)"' "$LOG" | jq '{message,sessionName,conversationId,durationMs,reason}'

# Facade-level failures (validation, dispatch, backend selection)
grep -E '"message":"prompt\.(facade_error|backend_mismatch|collab_dispatch_failed|model_effort_validation_failed)"' "$LOG" | jq .

# Slow prompts (>30s)
grep '"message":"prompt.complete"' "$LOG" | jq 'select(.durationMs > 30000) | {sessionName,conversationId,durationMs}'

# All prompt activity for a session
grep '"sessionName":"SESSION_NAME"' "$LOG" | grep '"module":"prompt"' | jq '{message,durationMs,error,backend}'
```

Prompts run inside an XState conversation actor that drives the Claude Agent SDK; there is no Claude CLI subprocess. Errors surface as `prompt.sdk_error`, `prompt.timeout`, or `prompt.aborted` from the actor, plus `prompt.facade_error` / dispatcher events from the HTTP route layer.

### Session Lifecycle Issues

```bash
# Creation failures (worktree/branch errors)
grep '"message":"session.create_failure"' "$LOG" | jq '{projectName,sessionName,error}'

# Worktree removal failures
grep '"message":"session.worktree_remove_failure"' "$LOG" | jq '{sessionName,worktreePath,error}'

# Full session lifecycle
grep -E '"message":"session\.(create|delete)"' "$LOG" | jq '{message,sessionName,branchName,worktreeCleanup}'
```

### State Store Issues

State persistence lives in SQLite (`notifications.db`, WAL mode) accessed through a write queue.

```bash
# Schema validation failures (state on disk no longer matches Zod schemas)
grep -E '"message":"state-store\..*\.schema_validation_failure"' "$LOG" | jq '{module,message,error}'

# Aggregate merge failures
grep '"message":"state-store.aggregate.merge_failure"' "$LOG" | jq '{error,stack}'

# Fatal state-store errors
grep '"message":"state-store.fatal"' "$LOG" | jq '{error,stack}'

# Read accessor timing (only emitted when totalMs >= threshold)
grep '"message":"state.read.timing"' "$LOG" | jq '{accessor,totalMs,sessionName,conversationId}'

# Write-queue hold/wait timing (feeds cc-performance-log-analysis state-store finding)
grep '"message":"state-store.write_queue.timing"' "$LOG" | jq 'select(.holdMs > 100) | {label,waitMs,holdMs}'
```

### Lock Contention (Concurrent Prompts)

```bash
# Rejected concurrent execution attempts
grep '"message":"lock.rejected"' "$LOG" | jq '{projectPath,sessionName,traceId}'
```

### Slow or Failed API Requests

```bash
# Failed requests
grep '"message":"request.error"' "$LOG" | jq '{method,path,error,durationMs}'

# Slow requests (>5s)
grep '"message":"request.complete"' "$LOG" | jq 'select(.durationMs > 5000) | {method,path,status,durationMs}'
```

## Filtering

```bash
# By session
grep '"sessionName":"NAME"' "$LOG" | jq .

# By project
grep '"projectName":"PATH"' "$LOG" | jq .

# Errors for a specific session
grep '"sessionName":"NAME"' "$LOG" | grep '"level":"error"' | jq .

# By today's date
grep "\"timestamp\":\"$(date +%Y-%m-%d)" "$LOG" | jq .

# By current hour (UTC)
grep "\"timestamp\":\"$(date -u +%Y-%m-%dT%H)" "$LOG" | jq .
```

## Configuration

| Variable        | Default                         | Effect                                                                  |
| --------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `CC_LOG_LEVEL`  | `info`                          | Filter: `debug` / `info` / `warn` / `error`                             |
| `CC_LOG_FILE`   | (scoped routing)                | Collapse all writes to a single file at this path                       |
| `CC_LOG_SCOPED` | `1`                             | Set to `0` to disable scoped routing (everything → `global.log`)         |
| `CC_LOG_SILENT` | `0`                             | Set to `1` to suppress stderr emission entirely                          |

Set `CC_LOG_LEVEL=debug` to include lock events (`lock.acquired`, `lock.released`) and verbose internals.

Warn/error entries also go to stderr (unless `CC_LOG_SILENT=1`) for immediate visibility.

## Complete Log Message Catalog

### Request Lifecycle (module: tracing)

| Message            | Level | Key Fields                             | Meaning                                       |
| ------------------ | ----- | -------------------------------------- | --------------------------------------------- |
| `request.start`    | info  | method, path                           | API request received                          |
| `request.complete` | info  | method, path, status, durationMs       | API request finished (non-SSE; dual-written)  |
| `request.error`    | error | method, path, error, stack, durationMs | Unhandled route error                         |

### Prompt Execution (module: prompt)

| Message                                  | Level | Key Fields                                                    | Meaning                                       |
| ---------------------------------------- | ----- | ------------------------------------------------------------- | --------------------------------------------- |
| `prompt.submit`                          | info  | sessionName, promptLength, model, backend, conversationId      | Prompt accepted by HTTP facade                |
| `prompt.complete`                        | info  | sessionName, conversationId, durationMs, model                 | SDK turn finished cleanly                     |
| `prompt.sdk_error`                       | error | sessionName, conversationId, error, backend                    | SDK / backend reported an error               |
| `prompt.timeout`                         | warn  | sessionName, conversationId, durationMs, timeoutMs             | Turn exceeded configured timeout              |
| `prompt.aborted`                         | warn  | sessionName, conversationId, reason                            | Turn aborted (cancel / superseded)            |
| `prompt.facade_error`                    | error | sessionName, error                                             | Pre-actor validation/dispatch failure         |
| `prompt.backend_adopted` / `_mismatch`    | info/warn | sessionName, backend, requestedBackend                     | Backend selection decision                    |
| `prompt.collab_dispatch[_failed]`         | info/error | targetSession, conversationId                              | Collaboration handoff to another session      |
| `prompt.model_effort_validation_failed[_actor]` | warn | model, requestedEffort                                  | Invalid model/effort combination              |

### Session Lifecycle (module: sessions)

| Message                           | Level | Key Fields                                          | Meaning                  |
| --------------------------------- | ----- | --------------------------------------------------- | ------------------------ |
| `session.create`                  | info  | projectName, sessionName, worktreePath, branchName, mode | Session creation succeeded |
| `session.create_failure`          | error | projectName, sessionName, error, stack              | Session creation failed  |
| `session.delete`                  | info  | sessionName, worktreeCleanup                        | Session deleted          |
| `session.worktree_remove_failure` | error | sessionName, worktreePath, error                    | Worktree removal failed  |

### State Store (module: state-store)

State persistence runs through a write queue over SQLite (`notifications.db`, WAL mode). Tracked events:

| Message                                            | Level | Key Fields                                  | Meaning                                                  |
| -------------------------------------------------- | ----- | ------------------------------------------- | -------------------------------------------------------- |
| `state.read.timing`                                | info  | accessor, totalMs, sessionName, conversationId | Slow read accessor (only above threshold)            |
| `state-store.write_queue.timing`                   | info  | label, waitMs, holdMs                       | Per-write queue cost; feeds the perf log-analysis tool   |
| `state-store.aggregate.diff.timing`                | info  | label, durationMs                           | Diff/commit cost during a mutation                       |
| `state-store.aggregate.merge_failure`              | error | error, stack                                | Aggregate merge produced an invalid snapshot             |
| `state-store.*.schema_validation_failure`          | error | module, error                               | Stored row failed Zod schema validation                  |
| `state-store.workflow_envelopes_parse_failed`      | error | error                                       | Persisted workflow envelope JSON failed parse            |
| `state-store.fatal`                                | error | error, stack                                | Unrecoverable store error                                |
| `state-db.{createNotification,createJobRecord,updateJobRecord,recoverStaleJobs,cleanupOldNotifications}.complete` | info | per-write fields | Notification/job DB write completed |

### Lock (module: lock)

| Message                                     | Level | Key Fields                            | Meaning                                  |
| ------------------------------------------- | ----- | ------------------------------------- | ---------------------------------------- |
| `lock.acquired` / `lock.released`           | debug | projectPath, sessionName              | Session-level single-flight lock         |
| `lock.rejected`                             | warn  | projectPath, sessionName              | Concurrent prompt blocked                |
| `project-lock.acquired` / `.released`        | debug | projectPath                           | Project-level lock                       |
| `conversation-lock.acquired` / `.released`   | debug | projectPath, sessionName, conversationId | Conversation-level lock              |

## Related Skills

- `cc-performance-log-analysis` — wraps `bun run logs:analyze` to produce structured findings (slow requests, state-store contention, SSE backpressure). Prefer it when the question is "is anything slow?"; this skill is the manual-`jq` reference for arbitrary forensic queries.
