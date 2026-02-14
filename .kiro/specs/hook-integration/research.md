# Research & Design Decisions

## Summary

- **Feature**: `hook-integration`
- **Discovery Scope**: Extension (existing system — fully implemented with tests)
- **Key Findings**:
  - Hook processing is implemented in `src/lib/hooks.ts` with `processHookEvent()` and `detectHooksStatus()`
  - `hooks.test.ts` provides tests covering session matching and metadata update scenarios
  - Two API routes handle event reception (`/api/hooks`) and status detection (`/api/hooks/status`)
  - UI warning banners are integrated into both project list and session list pages

## Research Log

### Existing Architecture Analysis

- **Context**: Hook integration is already implemented; mapping implementation against requirements.
- **Sources Consulted**: `src/lib/hooks.ts`, `src/lib/hooks.test.ts`, `src/app/api/hooks/route.ts`, `src/app/api/hooks/status/route.ts`, `src/app/projects/page.tsx`, `src/app/projects/[name]/page.tsx`, `src/lib/schemas.ts`
- **Findings**:
  - `processHookEvent()` takes `HookEventData`, finds the session by matching `cwd` to `worktreePath`, updates `claudeSessionId` / `transcriptPath` / `lastActivityAt`, and persists state
  - `findSessionByCwd()` helper iterates all projects/sessions to find a match
  - `detectHooksStatus()` reads `~/.claude/settings.json`, parses it permissively, checks for `UserPromptSubmit` and `Stop` events with `csm` in the command string
  - `hookEventDataSchema` validates incoming events with all fields optional (graceful handling of partial data)
  - POST `/api/hooks` validates body and forwards to `processHookEvent()`
  - GET `/api/hooks/status` calls `detectHooksStatus()` and returns the result
  - Both `projects/page.tsx` and `projects/[name]/page.tsx` call `detectHooksStatus()` server-side and display warning banners when hooks are missing
- **Implications**: Feature is complete. Tests cover core processing logic; API route and UI tests are lower priority.

### Claude Code Hook System

- **Context**: Understanding how Claude Code's hook system works.
- **Findings**:
  - Hooks configured in `~/.claude/settings.json` under `hooks` key
  - Two event types used by CSM: `UserPromptSubmit` (fires on prompt submission) and `Stop` (fires when Claude finishes)
  - Hook commands receive JSON on stdin; CSM hook pipes it via `cat | curl -s -X POST http://localhost:3000/api/hooks -H "Content-Type: application/json" -d @-`
  - Hooks are snapshotted at Claude Code startup — changes require restart
  - Must use absolute paths in hook commands to avoid cwd issues
  - JSON payload includes `session_id`, `transcript_path`, `cwd`, and `hook_event_name`
- **Implications**: CSM's hook design is event-driven and non-invasive — it only observes Claude Code events without modifying behavior.

## Design Decisions

### Decision: CWD-Based Session Matching

- **Context**: How to match incoming hook events to managed sessions.
- **Alternatives Considered**:
  1. Match by `session_id` — requires knowing the ID before hooks fire
  2. Match by `cwd` — worktree paths are unique and known at session creation
  3. Match by PID — fragile, requires process tracking
- **Selected Approach**: Match by `cwd` (working directory)
- **Rationale**: Each session has a unique worktree path set at creation time. The `cwd` field in hook events reflects where Claude Code is running. This provides reliable, deterministic matching without requiring prior knowledge of the Claude session ID.

### Decision: Partial Update Semantics

- **Context**: How to handle events with incomplete metadata.
- **Selected Approach**: Only update fields that are present in the event payload
- **Rationale**: Different hook events provide different metadata. `UserPromptSubmit` may provide `session_id` early, while `Stop` provides the final `transcript_path`. Partial updates ensure no data is lost by overwriting with null/undefined.

### Decision: Global Hook Configuration

- **Context**: Whether hooks should be configured per-project or globally.
- **Selected Approach**: Global configuration in `~/.claude/settings.json`
- **Rationale**: Claude Code hooks are global by design. A single hook configuration forwards all events to CSM, which then matches by cwd. This avoids per-project hook setup and works for any managed session.

## Risks & Mitigations

- **Hooks not installed** — UI warning banners guide users to configure hooks. Detection runs server-side on page load.
- **Hooks snapshotted at startup** — Claude Code must be restarted after hook configuration changes. This is a Claude Code limitation, not a CSM issue.
- **Race conditions on state update** — State module uses atomic write (temp file + rename). Hook events are infrequent (two per prompt cycle), so contention is minimal.
- **Unknown cwd** — If Claude Code runs outside a managed worktree, the event is silently ignored (returns false).

## References

- Claude Code hooks documentation — `UserPromptSubmit` and `Stop` event types
- Claude Code settings path: `~/.claude/settings.json`
- State management: atomic read-mutate-write pattern in `state.ts`
