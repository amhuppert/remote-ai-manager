# Logging & Diagnostics

CC produces four kinds of persistent data. All live under the platform config directory (`~/.config/cc` on Linux, `~/Library/Application Support/cc` on macOS).

## File Layout

```
<config-dir>/
├── cc-debug.log                               # Structured debug log (NDJSON)
├── state.json                                  # Manager state (projects/sessions/conversations)
├── config.json                                 # Global configuration
└── transcripts/
    ├── {conversationId}.jsonl                  # Per-conversation transcript
    └── images/{conversationId}/{idx}-{hash}.{ext}  # Externalized images
```

## Debug Log (`cc-debug.log`)

NDJSON — one JSON object per line. Every API request gets a trace context that auto-enriches log entries.

### Entry Schema

```json
{
  "timestamp": "ISO 8601",
  "level": "debug|info|warn|error",
  "module": "prompt|sessions|state|tracing|...",
  "message": "event.name",
  "traceId": "uuid",
  "action": "send-prompt|create-session|...",
  "projectName": "string",
  "sessionName": "string"
}
```

### Key Events by Module

| Module | Event | When |
|--------|-------|------|
| `tracing` | `request.start` | Every API request begins |
| `tracing` | `request.complete` | API request finishes (includes `status`, `durationMs`) |
| `tracing` | `request.error` | API request throws (includes `error`, `stack`) |
| `prompt` | `prompt.submit` | Prompt sent to SDK (`promptLength`, `model`, `resume`) |
| `prompt` | `prompt.complete` | SDK query finished (`durationMs`) |
| `prompt` | `prompt.timeout` | Execution exceeded `claudeTimeoutMs` |
| `prompt` | `prompt.aborted` | User-initiated abort |
| `prompt` | `prompt.sdk_error` | SDK returned an error |
| `state` | `state.recover_stale_conversation` | Stale "running" status reset on startup |
| `sessions` | `session.create` | New session created (`worktreePath`, `branchName`, `mode`) |

### Query Patterns (jq)

```bash
# Errors only
jq 'select(.level == "error")' cc-debug.log

# All logs for one request
jq 'select(.traceId == "UUID")' cc-debug.log

# Prompt lifecycle for a session
jq 'select(.sessionName == "NAME" and (.message | startswith("prompt.")))' cc-debug.log

# Slow API requests (>1s)
jq 'select(.message == "request.complete" and .durationMs > 1000)' cc-debug.log
```

### Configuration

- **CC_LOG_LEVEL** env var: `debug`, `info` (default), `warn`, `error`
- **CC_LOG_FILE** env var: override log file path
- `warn`/`error` entries also go to stderr

## Transcript Files (`transcripts/{id}.jsonl`)

Per-conversation JSONL recording all SDK messages. Each line is a `TranscriptEntry`.

### Entry Types

| `type` | `role` | Purpose |
|--------|--------|---------|
| `user` | `user` | User prompt (text + image refs) |
| `assistant` | `assistant` | Claude response (text, tool_use blocks) |
| `system` | — | SDK init, session ID assignment |
| `tool_result` | — | Tool execution results (raw SDK data) |
| `result` | — | Conversation completion (`is_error`, `duration_ms`, `total_cost_usd`, `num_turns`) |
| `rate_limit_event` | — | API rate limit info |

### Content Block Types

User and assistant entries contain `content: MessageContentBlock[]`:

- `text` — plain text
- `tool_use` — tool invocation (`name`, `input`)
- `tool_result` — tool output (`tool_use_id`, `content`)
- `command` — parsed slash command (`name`, `args`)
- `image` — inline base64 (legacy, backward compat)
- `image_ref` — externalized to disk (`imagePath`) — current format

### Reading Transcripts

`readConversationMessages()` in `transcript.ts` filters for visible messages (user/assistant with content), merges consecutive same-role entries, resolves `image_ref` blocks back to inline `image`, and detects slash commands.

## State File (`state.json`)

Single JSON file, atomically written (temp + rename). Hierarchy:

```
ManagerState
  └─ projects: { [projectPath]: ProjectState }
       └─ sessions: { [sessionName]: SessionState }
            └─ conversations: ConversationState[]
```

### Key ConversationState Fields

- `id` — UUID, matches transcript filename
- `status` — `new` | `awaiting` | `running` | `waiting_for_input`
- `claudeSessionId` — SDK session ID (for resume)
- `transcriptPath` — absolute path to JSONL file
- `totalCostUsd`, `totalDurationMs`, `totalTurns` — accumulated from `result` entries
- `promptCount` — number of prompts sent

### Startup Recovery

`recoverStaleConversations()` resets any conversation stuck in `running` or `waiting_for_input` back to `awaiting` on server start.

## SSE Events

Real-time broadcasts to connected UI clients via `sse-broadcaster.ts`. All events are Zod-validated on the client.

| Event Type | Domain | Trigger |
|-----------|--------|---------|
| `conversation-status` | Core | Conversation status transitions (`running`/`awaiting`/`waiting_for_input`) |
| `ask-question` | Core | SDK asks user a question (permission, input) |
| `session-finished` | Core | Session reaches terminal state |
| `message-queued` | Core | Message queued into running conversation via `streamInput()` |
| `job-status` | Jobs | Background job state change (merge, commit, resolve-conflicts) |
| `notification-created` | Notifications | New persistent notification created |
| `notification-updated` | Notifications | Notification marked as read/dismissed |
| `graph-workflow-status` | Graph Workflow | Workflow started/completed/failed/halted |
| `graph-workflow-context-status` | Graph Workflow | Execution context status change |
| `graph-workflow-task-status` | Graph Workflow | Task status change |
| `graph-workflow-validation-result` | Graph Workflow | Validation result received |
| `graph-workflow-retry` | Graph Workflow | Retry attempt for a context |
| `graph-workflow-circuit-breaker` | Graph Workflow | Circuit breaker triggered |
| `graph-workflow-shared-documents-updated` | Graph Workflow | Shared documents updated |
| `dev-server-status` | Dev Server | Dev server started/stopped/health change |

## Tracing Architecture

```
HTTP Request (X-Trace-Id header)
    → withTracing() middleware
        → AsyncLocalStorage trace context (traceId, action, projectName, sessionName)
            → All createLogger() calls auto-enriched
            → cc-debug.log (NDJSON)
    → prompt.ts
        → transcript.ts → {conversationId}.jsonl
        → transcript-images.ts → images/{conversationId}/
        → broadcast() → SSE clients
    → state.ts → state.json (atomic write)
```

Every API route is wrapped with `withTracing()`. The trace ID links debug log entries for a single request. Transcript entries are separate — they record the conversation content, not the request lifecycle.

---

_Document query patterns, not exhaustive field lists_
