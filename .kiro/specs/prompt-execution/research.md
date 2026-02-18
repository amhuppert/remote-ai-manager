# Research & Design Decisions

## Summary

- **Feature**: `prompt-execution`
- **Discovery Scope**: Extension (existing system — fully implemented)
- **Key Findings**:
  - Prompt execution is fully implemented across `src/lib/prompt.ts` and `src/lib/lock.ts`
  - Single-flight locking uses an in-memory `Map<string, Promise<void>>` pattern
  - Session state mutations use a helper function that reads, mutates, and persists atomically

## Research Log

### Existing Architecture Analysis

- **Context**: Prompt execution is already implemented; mapping implementation against requirements.
- **Sources Consulted**: `src/lib/prompt.ts`, `src/lib/lock.ts`, `src/app/api/projects/[name]/sessions/[session]/prompt/route.ts`, `src/lib/schemas.ts`
- **Findings**:
  - `executePromptStream()` in `prompt.ts` orchestrates the full streaming lifecycle: lock acquisition → status transition → CLI spawn via `spawn` → stream stdout line-by-line → accumulate `MessageContentBlock[]` → persist → status reset → lock release
  - `parseStreamLine()` and `formatToolUse()` in `stream-events.ts` handle stream-json event parsing and tool display formatting
  - `acquireSessionLock()` and `isSessionBusy()` in `lock.ts` provide the single-flight mechanism
  - `mutateSession()` is a private helper that reads session state, applies a mutation callback, updates `lastActivityAt`, and persists via `updateSession()`
  - The API route at `prompt/route.ts` returns an SSE `text/event-stream` response, wiring the `emit` callback to the ReadableStream controller
  - CLI args are dynamically built: `-c` flag added only when `promptCount > 0`
- **Implications**: Design documents an existing, stable architecture. `stream-events.ts` and `MessageContent.tsx` added for streaming support.

### Single-Flight Lock Pattern

- **Context**: Understanding the concurrency control mechanism.
- **Findings**:
  - Uses `Map<string, Promise<void>>` keyed by `${projectPath}::${sessionName}`
  - Lock acquisition is synchronous (throws immediately if busy)
  - Lock release is via a returned closure that deletes the map entry and resolves the promise
  - `isSessionBusy()` provides a non-blocking check used by the API route before attempting execution
- **Implications**: Simple, effective pattern for local single-user tool. No persistence needed — locks are lost on server restart (acceptable since processes also terminate).

### Claude CLI Integration

- **Context**: Understanding how the CLI subprocess is managed.
- **Findings**:
  - Uses `spawn` (not `exec`) for streaming subprocess output (no shell injection risk)
  - stdout is read line-by-line via `readline.createInterface` — each line is a stream-json event
  - First prompt: `claude -p "<prompt>"` — starts new conversation
  - Subsequent: `claude -c -p "<prompt>"` — continues most recent conversation in CWD
  - `--dangerously-skip-permissions` prevents interactive permission prompts in headless mode
  - `--output-format stream-json` returns streaming events (system init, assistant messages, user tool_results, result)
  - `--max-turns 50` limits runaway execution
  - `CLAUDE`-prefixed environment variables filtered to avoid inheriting parent session context
  - Manual timeout via `setTimeout` + `child.kill("SIGTERM")` (spawn does not support `timeout` option)
  - Content blocks accumulated into `MessageContentBlock[]` during streaming, stored on process close
- **Implications**: Worktree-per-session design makes `-c` flag unambiguous — each worktree has its own conversation history.

## Design Decisions

### Decision: In-Memory Lock Map vs Database Lock

- **Context**: How to prevent concurrent prompt execution per session
- **Alternatives Considered**:
  1. In-memory `Map` with promise tracking
  2. File-based lock (e.g., lockfile)
  3. Database advisory lock
- **Selected Approach**: In-memory `Map` with promise tracking
- **Rationale**: Simplest approach for a local single-user tool. No external dependencies. Lock state doesn't need to survive restarts.
- **Trade-offs**: Lost on server restart, but acceptable since subprocess also terminates.

### Decision: Status Mutation via Helper Function

- **Context**: How to update session status during prompt lifecycle
- **Selected Approach**: `mutateSession()` helper that reads → mutates → writes with automatic `lastActivityAt` update
- **Rationale**: DRY pattern for the three status mutations (start, success, error recovery). Ensures timestamp is always updated.

## Risks & Mitigations

- **Claude CLI not installed** — If `claude` binary is not in PATH, `spawn` fails immediately. Error propagated with descriptive message.
- **Timeout kills process but lock persists** — The `finally` block guarantees lock release even on timeout.
- **Status stuck at "running"** — Best-effort recovery in `finally` block handles this; errors during status reset are suppressed to avoid masking the original error.
- **Client disconnect mid-stream** — Process continues to completion; state is still persisted. `controller.enqueue` wrapped in try/catch to handle disconnected clients.

## References

- Node.js `child_process.spawn` — subprocess spawning with streaming stdout (security benefit: no shell)
- Node.js `readline.createInterface` — line-by-line reading of spawn stdout
- Claude Code CLI `-p` and `-c` flags — prompt and conversation continuation
- Claude Code CLI `--output-format stream-json` — streaming structured event output
