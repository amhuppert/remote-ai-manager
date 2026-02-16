# Logging & Debugging Infrastructure

CSM includes structured end-to-end logging that traces user interactions from the web UI through API routes to Claude CLI execution. Logs are designed to answer the question: *"What happened, and why did it fail?"* — without needing to reproduce the problem.

## How It Works

Every user action in the UI (creating a session, sending a prompt, deleting a session) generates a **trace ID** — a UUID that flows through every layer of the system. All log entries produced during that action share the same trace ID, making it possible to reconstruct the full chain of events with a single search.

```text
Browser                    Server
┌─────────────┐           ┌──────────────────────────────────────────┐
│ UI Component │           │                                          │
│      │       │           │  API Route (withTracing wrapper)         │
│  tracedFetch │──────────>│      │                                   │
│  generates   │ X-Trace-Id│  Sets up AsyncLocalStorage context       │
│  traceId     │ X-Action  │      │                                   │
│              │  headers  │  ┌───┴────┐  ┌────────┐  ┌─────┐        │
│              │           │  │sessions│  │ prompt │  │hooks│  ...    │
│              │           │  │        │  │        │  │     │        │
│              │           │  │ logger │  │ logger │  │logger│       │
│              │           │  └───┬────┘  └───┬────┘  └──┬──┘        │
│              │           │      └───────────┴──────────┘           │
│              │           │              │                           │
└─────────────┘           └──────────────┼───────────────────────────┘
                                         │
                                         ▼
                                   csm-debug.log
                                   (NDJSON, one JSON object per line)
```

### Key Concepts

- **Trace ID**: A UUID that links all log entries from a single user action. Generated in the browser by `tracedFetch`, sent as `X-Trace-Id` header, extracted by `withTracing` on the server.
- **Action**: A human-readable label for what the user did (e.g., `send-prompt`, `create-session`). Sent as `X-Action` header.
- **AsyncLocalStorage**: Node.js mechanism that automatically propagates the trace context through the async call chain without passing it as a parameter to every function.
- **NDJSON**: Newline-delimited JSON. Each line in the log file is a self-contained JSON object that can be parsed independently.

## Log File Location

| Platform | Default Path |
|----------|-------------|
| Linux | `~/.config/csm/csm-debug.log` |
| macOS | `~/Library/Application Support/csm/csm-debug.log` |

Override with the `CSM_LOG_FILE` environment variable (absolute path).

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CSM_LOG_LEVEL` | `info` | Minimum level to log. Options: `debug`, `info`, `warn`, `error` |
| `CSM_LOG_FILE` | *(see above)* | Absolute path to the log file |

- Setting `CSM_LOG_LEVEL=debug` enables verbose output including state file writes and lock acquisition/release events.
- `warn` and `error` entries are also written to **stderr** for immediate visibility in the terminal.
- Invalid `CSM_LOG_LEVEL` values fall back to `info` with a warning on stderr.

## Log Entry Format

Every log entry is a JSON object on its own line. Example:

```json
{
  "timestamp": "2026-02-16T14:23:01.456Z",
  "level": "info",
  "module": "prompt",
  "message": "prompt.complete",
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "action": "send-prompt",
  "projectName": "/home/user/projects/my-app",
  "sessionName": "feature-auth",
  "exitCode": 0,
  "durationMs": 12450,
  "stdoutSize": 3842,
  "stderrSize": 0
}
```

### Standard fields (always present)

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 timestamp |
| `level` | string | `debug`, `info`, `warn`, or `error` |
| `module` | string | Source module (e.g., `prompt`, `sessions`, `hooks`, `state`, `lock`, `tracing`) |
| `message` | string | Event identifier (e.g., `prompt.complete`, `session.create`) |

### Context fields (present when inside a traced request)

| Field | Type | Description |
|-------|------|-------------|
| `traceId` | string | UUID linking all entries from one user action |
| `action` | string | UI action name (e.g., `send-prompt`, `create-session`) |
| `projectName` | string | Project path |
| `sessionName` | string | Session name |

These fields are automatically attached by the logger when code runs inside a traced request context. They may be absent for operations that happen outside a request (e.g., background cleanup).

### Additional fields

Each log message may include extra fields specific to the event. See the [message reference](#message-reference) below for details.

## Common Debugging Tasks

### Reading the log file

Since the log is NDJSON, pipe it through `jq` for readable output:

```bash
# Readable view of the last 10 entries
tail -10 ~/.config/csm/csm-debug.log | jq .

# Compact summary view
tail -20 ~/.config/csm/csm-debug.log | jq '{timestamp, level, module, message, sessionName}'
```

### Finding errors

```bash
# All errors
grep '"level":"error"' ~/.config/csm/csm-debug.log | jq .

# Count errors by type
grep '"level":"error"' ~/.config/csm/csm-debug.log | jq -r .message | sort | uniq -c | sort -rn
```

### Tracing a request end-to-end

If you have a trace ID (from an error log entry, API response header, or browser dev tools):

```bash
grep 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' ~/.config/csm/csm-debug.log | jq .
```

This shows every log entry produced during that request, in chronological order. A typical sequence looks like:

1. `tracing` / `request.start` — Request received
2. `prompt` / `prompt.submit` — Prompt sent to Claude CLI
3. `lock` / `lock.acquired` — Session lock acquired (debug level)
4. `state` / `state.write` — State file updated (debug level)
5. `prompt` / `prompt.complete` — Claude CLI finished
6. `tracing` / `request.complete` — Response sent

### Investigating a specific session

```bash
grep '"sessionName":"feature-auth"' ~/.config/csm/csm-debug.log | jq .
```

### Finding slow operations

```bash
# Prompts that took longer than 30 seconds
grep '"message":"prompt.complete"' ~/.config/csm/csm-debug.log | \
  jq 'select(.durationMs > 30000) | {sessionName, durationMs}'

# Slow API requests (over 5 seconds)
grep '"message":"request.complete"' ~/.config/csm/csm-debug.log | \
  jq 'select(.durationMs > 5000) | {method, path, status, durationMs}'
```

### Checking hook integration

```bash
# See all hook events received
grep '"message":"hook.event_received"' ~/.config/csm/csm-debug.log | jq .

# Find events from sessions CSM doesn't recognize
grep '"message":"hook.unknown_session"' ~/.config/csm/csm-debug.log | jq .
```

## Understanding Hook Correlation

Hook events (from Claude CLI) arrive at `/api/hooks` as separate HTTP requests with their own trace IDs — they don't share the trace ID of the prompt that triggered them, since hooks originate from the Claude CLI process, not from the UI.

To correlate a hook event with its originating prompt:

1. Find the hook event and note the `sessionName` and `timestamp`
2. Search for prompt events on the same session around the same time:
   ```bash
   grep '"sessionName":"feature-auth"' ~/.config/csm/csm-debug.log | \
     grep -E '"module":"(prompt|hooks)"' | jq '{timestamp, module, message}'
   ```

## Architecture

The logging infrastructure consists of four components in `src/lib/logging/`:

| File | Purpose |
|------|---------|
| `context.ts` | `AsyncLocalStorage`-based trace context. Provides `runWithTrace()` and `getTraceContext()`. |
| `logger.ts` | Logger factory. `createLogger("module-name")` returns a logger that auto-enriches entries with trace context. |
| `tracing.ts` | `withTracing()` higher-order function that wraps API route handlers with trace setup and request lifecycle logging. |
| `index.ts` | Re-exports for convenience. |

Plus `src/lib/traced-fetch.ts` on the frontend — a `fetch()` wrapper that generates trace IDs and attaches `X-Trace-Id` / `X-Action` headers.

### Design principles

- **Non-invasive**: Logging is added via wrapper functions and logger calls. No existing function signatures were changed.
- **Never throws**: The logger silently drops entries if writes fail. Logging should never break the application.
- **Zero dependencies**: Uses only Node.js built-ins (`node:fs`, `node:async_hooks`, `node:crypto`).

## Message Reference

### Request Lifecycle

| Message | Level | Additional Fields | When |
|---------|-------|-------------------|------|
| `request.start` | info | `method`, `path` | Every API request received |
| `request.complete` | info | `method`, `path`, `status`, `durationMs` | Every API request completed |
| `request.error` | error | `method`, `path`, `error`, `stack`, `durationMs` | Unhandled error in a route handler |

### Prompt Execution

| Message | Level | Additional Fields | When |
|---------|-------|-------------------|------|
| `prompt.submit` | info | `sessionName`, `promptLength`, `cliArgs` | Prompt sent to Claude CLI. `cliArgs` excludes the prompt text. |
| `prompt.complete` | info | `sessionName`, `exitCode`, `durationMs`, `stdoutSize`, `stderrSize` | Claude CLI finished successfully |
| `prompt.failure` | error | `sessionName`, `cliArgs`, `cwd`, `error`, `stderr`, `stack` | Claude CLI failed (non-zero exit, timeout, etc.) |

### Session Lifecycle

| Message | Level | Additional Fields | When |
|---------|-------|-------------------|------|
| `session.create` | info | `projectName`, `sessionName`, `worktreePath`, `branchName` | Session creation initiated |
| `session.create_failure` | error | `projectName`, `sessionName`, `error`, `stack` | Session creation failed (worktree or branch error) |
| `session.delete` | info | `sessionName`, `worktreeCleanup` | Session deleted. `worktreeCleanup` is `success`, `fallback`, or `skipped`. |
| `session.worktree_remove_failure` | error | `sessionName`, `worktreePath`, `error` | Git worktree removal failed (fallback to `rm -rf`) |

### Hook Events

| Message | Level | Additional Fields | When |
|---------|-------|-------------------|------|
| `hook.event_received` | info | `eventType`, `sessionId`, `timestamp` | Hook event received from Claude CLI |
| `hook.unknown_session` | warn | `cwd`, `eventType` | Hook event's `cwd` doesn't match any managed session |
| `hook.validation_failure` | warn | `rawPayload` | Hook payload failed JSON parsing or schema validation |

### State File Operations

| Message | Level | Additional Fields | When |
|---------|-------|-------------------|------|
| `state.write` | debug | `projectCount`, `sessionCount`, `fileSize` | State file written to disk |
| `state.atomic_write` | debug | `tmpPath`, `finalPath` | Atomic write (temp file before rename) |
| `state.read_failure` | error | `errorType`, `filePath`, `error`, `stack` | State file couldn't be read or parsed |
| `state.rename_failure` | error | `tmpPath`, `finalPath`, `error`, `stack` | Atomic rename failed (potential filesystem issue) |

### Lock (Concurrency Control)

| Message | Level | Additional Fields | When |
|---------|-------|-------------------|------|
| `lock.acquired` | debug | `projectPath`, `sessionName` | Session lock acquired for prompt execution |
| `lock.released` | debug | `projectPath`, `sessionName` | Session lock released |
| `lock.rejected` | warn | `projectPath`, `sessionName` | Concurrent prompt attempt blocked |
