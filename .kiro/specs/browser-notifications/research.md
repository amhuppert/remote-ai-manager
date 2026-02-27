# Research & Design Decisions

## Summary
- **Feature**: `browser-notifications`
- **Discovery Scope**: Extension (adding real-time notifications to existing hook-based system)
- **Key Findings**:
  - The hook API route is the natural broadcast trigger point; `processHookEvent` needs to return richer data (project/session names) instead of a boolean
  - No existing persistent SSE channel exists; prompt SSE is per-request only. A new in-memory broadcaster registry pattern is needed
  - The root layout is a pure Server Component with no client wrappers — a new `"use client"` component must be added as a `<body>` child

## Research Log

### Existing Hook Event Flow
- **Context**: How does Claude Code's `Stop` event reach CC, and what data is available?
- **Sources Consulted**: `src/app/api/hooks/route.ts`, `src/lib/hooks.ts`
- **Findings**:
  - Claude CLI POSTs `{ session_id, transcript_path, cwd, hook_event_name }` to `/api/hooks`
  - `processHookEvent` reads full state, finds session by matching `cwd` to `worktreePath`, updates metadata, writes state
  - Currently returns `boolean` — discards project name and session name after lookup
  - The `Stop` event does NOT update `conversation.status` (that's managed by `executePromptStream`)
- **Implications**: `processHookEvent` return type must be enriched to include `projectName`, `sessionName`, `conversationId` so the hook route can broadcast without a second state read

### Existing SSE Pattern
- **Context**: How does this codebase already implement SSE?
- **Sources Consulted**: `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/prompt/route.ts`
- **Findings**:
  - Uses `ReadableStream` with `TextEncoder`, manual `controller.enqueue` for SSE frames
  - Format: `event: <name>\ndata: <json>\n\n`
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
  - Each SSE connection is per-request (starts, streams, closes)
- **Implications**: The global events endpoint follows a different pattern — long-lived open connection. But the SSE framing format and headers should match the existing pattern for consistency.

### Root Layout Structure
- **Context**: Where to place the global notification client?
- **Sources Consulted**: `src/app/layout.tsx`
- **Findings**:
  - Pure Server Component, no `"use client"` directive
  - `<body>` renders only `{children}` — no context providers or global wrappers
- **Implications**: A new `"use client"` component added as a sibling to `{children}` inside `<body>`. No layout refactoring needed.

### Session Page URL Pattern
- **Context**: What URL does the notification click handler navigate to?
- **Sources Consulted**: `src/app/projects/[name]/[session]/[conversationId]/page.tsx`, `SessionDetailPage.tsx`
- **Findings**:
  - Pattern: `/projects/{projectName}/{sessionName}/{conversationId}`
  - All segments are URL-encoded with `encodeURIComponent`
- **Implications**: The SSE event payload must include all three identifiers for notification click navigation.

### Browser Notification API
- **Context**: Standard web API; no external dependencies needed
- **Sources Consulted**: MDN Web Docs (standard knowledge)
- **Findings**:
  - `Notification.requestPermission()` returns a promise resolving to `"granted"`, `"denied"`, or `"default"`
  - `new Notification(title, { body, icon, tag })` creates an OS-level notification
  - `notification.onclick` handler for click-to-navigate
  - Permission state is persisted by the browser per origin — no CC-side storage needed
  - Not all browsers support Notification API (notably iOS Safari requires PWA mode)
- **Implications**: Check `"Notification" in window` before any API calls. Permission request should happen on user interaction or first load.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| In-memory broadcaster | Module-level `Set` of SSE stream controllers | Zero dependencies, simple, fits single-process model | Lost on server restart; no cross-process support | Matches CC's existing in-memory patterns (single-flight lock map) |
| Redis pub/sub | External message broker for broadcasting | Supports multi-process, persistent | Adds external dependency; CC has no database | Violates CC's "no external services" philosophy |
| Polling from client | Client polls a status endpoint | Simplest server-side implementation | Wastes bandwidth, delayed notifications, constant load | Rejected per user requirement |

**Selected**: In-memory broadcaster. CC runs as a single Node.js process; the in-memory pattern is consistent with existing patterns (e.g., the `promptLocks` map in `prompt.ts`).

## Design Decisions

### Decision: In-Memory SSE Broadcaster Registry
- **Context**: Need a mechanism for the hook route to push events to connected browser clients
- **Alternatives Considered**:
  1. Redis pub/sub — adds external dependency
  2. File-based event queue — complex, disk I/O
  3. In-memory `Set<ReadableStreamDefaultController>` — zero dependencies
- **Selected Approach**: Module-level `Set` storing active SSE stream controllers. `broadcast()` iterates the set and enqueues events. `addClient()` / `removeClient()` manage the set.
- **Rationale**: CC is a single-process app with no database. In-memory state is the established pattern (see `promptLocks`). Broadcaster state is ephemeral — losing it on restart is acceptable since clients auto-reconnect.
- **Trade-offs**: No cross-process support. Acceptable since CC is single-process.
- **Follow-up**: Ensure `removeClient` is called in the stream's `cancel` callback to prevent memory leaks.

### Decision: Enrich processHookEvent Return Type
- **Context**: The hook route needs project name, session name, and conversation ID to broadcast meaningful events
- **Alternatives Considered**:
  1. Second state read in the hook route — wasteful, races with write
  2. Enrich `processHookEvent` return to include context
- **Selected Approach**: Change return type from `boolean` to `{ matched: boolean; projectName?: string; sessionName?: string; conversationId?: string }`
- **Rationale**: The data is already available inside `processHookEvent` during the state lookup. Returning it avoids a redundant read.
- **Trade-offs**: Minor breaking change to the function signature, but it's internal-only.

### Decision: Notification Click Navigation
- **Context**: Clicking a notification should take the user to the relevant session page
- **Selected Approach**: Use `notification.onclick` to call `window.focus()` and set `window.location.href` to the session URL
- **Rationale**: `window.location.href` works reliably from any context. Using `router.push()` would require the notification handler to have access to the Next.js router, which is complex to wire from a global component.

## Risks & Mitigations
- **Risk**: SSE connection interrupted by network issues — **Mitigation**: `EventSource` has built-in auto-reconnect; add exponential backoff for manual fallback
- **Risk**: Memory leak from zombie SSE controllers — **Mitigation**: Remove controller in stream `cancel` callback; add periodic cleanup sweep
- **Risk**: Notification permission denied permanently — **Mitigation**: Graceful degradation; no retry after denial
- **Risk**: Multiple browser tabs open duplicate notifications — **Mitigation**: Use `Notification.tag` to deduplicate (same tag replaces previous notification)

## References
- Browser Notification API — MDN Web Docs (standard web platform)
- Server-Sent Events — W3C specification (standard web platform)
- EventSource auto-reconnect — built-in browser behavior per SSE spec
