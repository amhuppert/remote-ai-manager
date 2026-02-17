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
  - `executePrompt()` in `prompt.ts` orchestrates the full lifecycle: lock acquisition → status transition → CLI spawn → prompt count increment → status reset → lock release
  - `acquireSessionLock()` and `isSessionBusy()` in `lock.ts` provide the single-flight mechanism
  - `mutateSession()` is a private helper that reads session state, applies a mutation callback, updates `lastActivityAt`, and persists via `updateSession()`
  - The API route at `prompt/route.ts` handles HTTP concerns: request validation, project/session resolution, lock check, and error-to-HTTP-status mapping
  - CLI args are dynamically built: `-c` flag added only when `promptCount > 0`
- **Implications**: Design documents an existing, stable architecture. No new components needed.

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
  - Uses `execFile` (not `exec`) for safer subprocess spawning (no shell injection risk)
  - First prompt: `claude -p "<prompt>"` — starts new conversation
  - Subsequent: `claude -c -p "<prompt>"` — continues most recent conversation in CWD
  - `--dangerously-skip-permissions` prevents interactive permission prompts in headless mode
  - `--output-format json` returns structured `{ result, session_id }` output
  - `--max-turns 50` limits runaway execution
  - `CLAUDE`-prefixed environment variables filtered to avoid inheriting parent session context
  - Timeout from `config.claudeTimeoutMs` (default 300,000 ms = 5 minutes)
  - Max buffer 10 MB for stdout capture
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

- **Claude CLI not installed** — If `claude` binary is not in PATH, `execFile` throws immediately. Error propagated with descriptive message.
- **Timeout kills process but lock persists** — The `finally` block guarantees lock release even on timeout.
- **Status stuck at "running"** — Best-effort recovery in `finally` block handles this; errors during status reset are suppressed to avoid masking the original error.

## References

- Node.js `child_process.execFile` — subprocess spawning without shell (security benefit)
- Claude Code CLI `-p` and `-c` flags — prompt and conversation continuation
