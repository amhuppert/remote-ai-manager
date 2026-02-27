---
description: This skill should be used when diagnosing CC issues, analyzing failures, tracing user actions through logs, investigating hook problems, state corruption, prompt execution errors, or understanding what happened in recent runs. Use when asked to "check logs", "debug", "what went wrong", "trace request", "find errors", or "analyze recent activity".
name: debug-logs
---

# CC Debug Log Analysis

Structured NDJSON logs trace every user action from UI through API routes to Claude CLI execution. Each log line is a self-contained JSON object. All entries from one user action share a `traceId` UUID.

## Log File Location

```bash
# Linux (default)
LOG="${CC_LOG_FILE:-$HOME/.config/cc/cc-debug.log}"
# macOS (default)
LOG="${CC_LOG_FILE:-$HOME/Library/Application Support/cc/cc-debug.log}"
```

Verify: `wc -l "$LOG"` to confirm file exists and check size before querying.

## Log Entry Structure

Every line: `{"timestamp":"ISO8601","level":"info","module":"prompt","message":"prompt.complete","traceId":"uuid",...}`

Auto-enriched context fields (from AsyncLocalStorage): `traceId`, `action`, `projectName`, `sessionName`.

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
# All prompt failures with key context
grep '"message":"prompt.failure"' "$LOG" | jq '{sessionName,error,cliArgs,cwd,stderr}'

# Slow prompts (>30s)
grep '"message":"prompt.complete"' "$LOG" | jq 'select(.durationMs > 30000) | {sessionName,durationMs}'

# All prompt activity for a session
grep '"sessionName":"SESSION_NAME"' "$LOG" | grep '"module":"prompt"' | jq '{message,durationMs,error,exitCode}'
```

Key fields in `prompt.failure`: `sessionName`, `cliArgs` (sans prompt text), `cwd`, `error`, `stderr`, `stack`.

### Session Lifecycle Issues

```bash
# Creation failures (worktree/branch errors)
grep '"message":"session.create_failure"' "$LOG" | jq '{projectName,sessionName,error}'

# Worktree removal failures
grep '"message":"session.worktree_remove_failure"' "$LOG" | jq '{sessionName,worktreePath,error}'

# Full session lifecycle
grep -E '"message":"session\.(create|delete)"' "$LOG" | jq '{message,sessionName,branchName,worktreeCleanup}'
```

### Hook Problems

```bash
# Events from sessions CC doesn't know about
grep '"message":"hook.unknown_session"' "$LOG" | jq '{cwd,eventType}'

# Malformed hook payloads
grep '"message":"hook.validation_failure"' "$LOG" | jq .

# All received hook events
grep '"message":"hook.event_received"' "$LOG" | jq '{eventType,sessionId,timestamp}'
```

Hook events get their own traceId (originating from Claude CLI, not UI). Correlate to the originating prompt via `sessionName` + timestamp proximity.

### State File Corruption

```bash
# Read/parse failures
grep '"message":"state.read_failure"' "$LOG" | jq '{errorType,filePath,error}'

# Atomic rename failures (indicates filesystem issues)
grep '"message":"state.rename_failure"' "$LOG" | jq '{tmpPath,finalPath,error}'
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

| Variable        | Default                      | Effect                           |
| --------------- | ---------------------------- | -------------------------------- |
| `CC_LOG_LEVEL` | `info`                       | Filter: debug, info, warn, error |
| `CC_LOG_FILE`  | `<config-dir>/cc-debug.log` | Log file path                    |

Set `CC_LOG_LEVEL=debug` to include state writes (`state.write`, `state.atomic_write`) and lock events (`lock.acquired`, `lock.released`).

Warn/error entries also go to stderr for immediate visibility.

## Complete Log Message Catalog

### Request Lifecycle (module: tracing)

| Message            | Level | Key Fields                             | Meaning               |
| ------------------ | ----- | -------------------------------------- | --------------------- |
| `request.start`    | info  | method, path                           | API request received  |
| `request.complete` | info  | method, path, status, durationMs       | API request finished  |
| `request.error`    | error | method, path, error, stack, durationMs | Unhandled route error |

### Prompt Execution (module: prompt)

| Message           | Level | Key Fields                                                | Meaning                   |
| ----------------- | ----- | --------------------------------------------------------- | ------------------------- |
| `prompt.submit`   | info  | sessionName, promptLength, cliArgs                        | Prompt sent to Claude CLI |
| `prompt.complete` | info  | sessionName, exitCode, durationMs, stdoutSize, stderrSize | Prompt succeeded          |
| `prompt.failure`  | error | sessionName, cliArgs, cwd, error, stderr, stack           | Prompt failed             |

### Session Lifecycle (module: sessions)

| Message                           | Level | Key Fields                                         | Meaning                  |
| --------------------------------- | ----- | -------------------------------------------------- | ------------------------ |
| `session.create`                  | info  | projectName, sessionName, worktreePath, branchName | Session creation started |
| `session.create_failure`          | error | projectName, sessionName, error, stack             | Session creation failed  |
| `session.delete`                  | info  | sessionName, worktreeCleanup                       | Session deleted          |
| `session.worktree_remove_failure` | error | sessionName, worktreePath, error                   | Worktree removal failed  |

### Hook Events (module: hooks / hooks.route)

| Message                   | Level | Key Fields                      | Meaning                    |
| ------------------------- | ----- | ------------------------------- | -------------------------- |
| `hook.event_received`     | info  | eventType, sessionId, timestamp | Hook event from Claude CLI |
| `hook.unknown_session`    | warn  | cwd, eventType                  | Unrecognized session cwd   |
| `hook.validation_failure` | warn  | rawPayload                      | Malformed hook payload     |

### State File (module: state)

| Message                | Level | Key Fields                           | Meaning                 |
| ---------------------- | ----- | ------------------------------------ | ----------------------- |
| `state.write`          | debug | projectCount, sessionCount, fileSize | State persisted         |
| `state.atomic_write`   | debug | tmpPath, finalPath                   | Atomic write paths      |
| `state.read_failure`   | error | errorType, filePath, error, stack    | State read/parse failed |
| `state.rename_failure` | error | tmpPath, finalPath, error, stack     | Atomic rename failed    |

### Lock (module: lock)

| Message         | Level | Key Fields               | Meaning                   |
| --------------- | ----- | ------------------------ | ------------------------- |
| `lock.acquired` | debug | projectPath, sessionName | Session lock acquired     |
| `lock.released` | debug | projectPath, sessionName | Session lock released     |
| `lock.rejected` | warn  | projectPath, sessionName | Concurrent prompt blocked |
