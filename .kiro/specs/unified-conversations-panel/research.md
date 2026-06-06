# Research & Design Decisions

## Summary
- **Feature**: `unified-conversations-panel`
- **Discovery Scope**: Extension — modifying existing status system and adding a new cross-project UI panel
- **Key Findings**:
  - Status values are hardcoded as a Zod enum (`idle`, `ready`, `running`) in `src/lib/conversations/schemas.ts`. Every status reference (schema, derivation, UI display, CSS classes) needs updating.
  - SSE infrastructure already broadcasts `session-ready` events with project/session/conversation context. Extending to broadcast on `running` transitions and adding a new event type is straightforward.
  - A new API endpoint is needed to aggregate conversations across all projects — no existing endpoint returns cross-project conversation data.

## Research Log

### Current Status Value Usage Map

- **Context**: Need to understand every location that references status values to plan the rename scope.
- **Sources Consulted**: Full codebase grep for `idle`, `ready`, `running` in status contexts
- **Findings**:
  - **Schema**: `src/lib/conversations/schemas.ts` — `z.enum(["idle", "ready", "running"])`
  - **Derivation**: `src/lib/session-derived.ts:13-25` — checks `"running"` then `"ready"`, defaults to `"idle"`
  - **Creation**: `src/lib/conversations/service.ts` — new conversations start as `"ready"`
  - **Import**: `src/lib/conversations/service.ts` — imported conversations start as `"idle"`
  - **Prompt start**: `src/lib/prompt/route-handlers.ts` — sets `"running"`
  - **Prompt end**: `src/lib/prompt/route-handlers.ts` — sets `"ready"`
  - **Hook Stop**: `src/lib/hooks.ts` — sets `"ready"` on Stop event
  - **UI display**: ProjectCard, SessionsList, ConversationList, ConversationSidebar, SessionDetailPage — all reference `"running"`, `"ready"`, `"idle"` for CSS class selection and text display
  - **CSS**: `globals.css` — `.session-status.running`, `.session-status.ready`, `.session-status.idle`, `.sidebar-dot.running`, `.sidebar-dot.ready`
  - **Zustand store**: `projects.store.ts` — filter type includes `"active"` | `"idle"` | `"all"`
  - **Discovery**: `src/lib/discovery.ts:47` — checks `deriveSessionStatus(s) === "running"` for `hasRunningSession`
- **Implications**: Status rename is a sweeping change across schema, lib, UI, CSS, and stores. Migration layer needed for persisted state.

### SSE Infrastructure Analysis

- **Context**: Unified panel needs real-time updates. Evaluate existing SSE infrastructure for extension.
- **Sources Consulted**: `src/lib/events/broadcaster.ts`, `src/app/api/events/route.ts`, `src/components/NotificationListener.tsx`
- **Findings**:
  - Broadcaster uses `globalThis` for HMR safety — solid pattern
  - Currently only emits `session-ready` event type with `SessionReadyEvent` payload
  - `NotificationListener` invalidates `sessionKeys.all` on any event — triggers TanStack Query refetch
  - The broadcaster's `broadcast()` function is typed to `SessionReadyEvent` only
  - No event is broadcast when a conversation transitions to `running` (only on completion)
- **Implications**:
  - Need to generalize `broadcast()` to accept multiple event types
  - Add `conversation-status-change` event type with status field
  - Broadcast on both `running` and `awaiting` transitions

### Cross-Project Data Access Pattern

- **Context**: Unified panel needs to aggregate conversations across all projects. No existing endpoint provides this.
- **Sources Consulted**: API route structure, `src/lib/state-store/`, `src/lib/discovery.ts`
- **Findings**:
  - `readState()` returns the entire `ManagerState` with all projects/sessions/conversations
  - Current session APIs are scoped to a single project: `GET /api/projects/[name]/sessions`
  - `discoverProjects()` returns `DiscoveredProject[]` but without conversation details
  - State file is flat: `state.projects[path].sessions[name].conversations[]`
- **Implications**: A new API endpoint (`GET /api/conversations/active` or similar) can read the full state and filter/flatten across all projects. Since state is a single JSON file, this is a simple read + transform.

### Project Badge & Filter Analysis

- **Context**: Project cards show "active" badge when `hasRunningSession` is true. Filters are "all" | "active" | "idle".
- **Sources Consulted**: `ProjectCard.tsx:26-35`, `ProjectsGrid.tsx:233-244`, `projects.store.ts`
- **Findings**:
  - `ProjectCard` badge logic: `hasRunningSession` → "active" (cyan), `activeSessions > 0` → session count (green), else → "idle" (gray)
  - Filter logic: "active" = `activeSessions > 0`, "idle" = `activeSessions === 0`
  - Need to rename badge text "active" → "running" and add new "active" filter (has non-archived sessions)
  - Store type needs to change from `"all" | "active" | "idle"` to `"all" | "active" | "running" | "idle"`
  - `DiscoveredProject` already has `hasRunningSession` and `activeSessions` — sufficient for new filter logic
- **Implications**: Badge rename + filter rework are localized to `ProjectCard.tsx`, `ProjectsGrid.tsx`, and `projects.store.ts`. No backend changes needed.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Polling-based panel | Unified panel polls a new API endpoint on interval | Simple, no SSE changes needed | Higher latency, unnecessary network traffic | Doesn't meet real-time requirement |
| SSE-driven panel with query invalidation | Extend existing SSE to broadcast status changes, use TanStack Query invalidation to refetch | Reuses existing patterns, real-time, consistent with current architecture | Slight complexity in extending broadcaster | **Selected** — aligns with current patterns |
| WebSocket channel | Dedicated WebSocket for panel updates | Full-duplex, lower overhead per message | New infrastructure, doesn't align with existing SSE pattern | Over-engineered for this use case |

## Design Decisions

### Decision: Extend SSE broadcaster with discriminated event types

- **Context**: Unified panel needs real-time status updates; current broadcaster only supports `SessionReadyEvent`
- **Alternatives Considered**:
  1. Add separate broadcaster for new event types
  2. Generalize existing broadcaster to accept discriminated union of events
- **Selected Approach**: Generalize the broadcaster with a discriminated union type. Add `ConversationStatusEvent` with `type: "conversation-status"` alongside existing `SessionReadyEvent`.
- **Rationale**: Single SSE connection per client is simpler. Discriminated union is type-safe and extensible.
- **Trade-offs**: Slightly more complex type signature vs. cleaner single-channel architecture.

### Decision: New API endpoint for cross-project active conversations

- **Context**: No existing endpoint returns conversations across projects. Panel needs aggregated data.
- **Alternatives Considered**:
  1. Client-side: fetch all projects, then fetch sessions for each → N+1 requests
  2. Server-side: single endpoint reads state file and returns filtered/flattened conversations
- **Selected Approach**: New `GET /api/conversations/active` endpoint that reads state, filters for `running`/`awaiting` conversations, and returns a flat list with project/session context.
- **Rationale**: Single request, simple server-side transform, state file is already in-memory.
- **Trade-offs**: New endpoint to maintain, but avoids client-side N+1 problem.

### Decision: Status value migration via Zod transform

- **Context**: Persisted state file may contain old values (`idle`, `ready`). Need backward-compatible read.
- **Alternatives Considered**:
  1. One-time migration script that rewrites the state file
  2. Read-time transform via Zod `.transform()` on the schema
- **Selected Approach**: Zod transform that maps old values to new ones during `safeParse`. Old values are transparently converted; new writes always use new values.
- **Rationale**: Zero-downtime migration, no separate migration step, handles the case where users may downgrade.
- **Trade-offs**: Transform runs on every read, but cost is negligible for a small state file.

### Decision: Unified panel as global right-side panel

- **Context**: Panel needs to be accessible from any page. Must not conflict with existing ConversationSidebar (left) or DiffPanel (right).
- **Alternatives Considered**:
  1. Right-side overlay panel (slides over content, z-indexed above)
  2. Right-side inline panel (pushes content left, like DiffPanel)
  3. Left-side panel (conflicts with ConversationSidebar)
- **Selected Approach**: Right-side overlay panel with backdrop. Slides in from the right edge, overlays current content without pushing layout. Higher z-index than page content but lower than modals.
- **Rationale**: Works on every page without conflicting with existing panel layouts. No need to adjust grid/flex layout per page. Consistent behavior regardless of which page is active.
- **Trade-offs**: Covers content when open, but this is acceptable for a toggleable panel. Can be dismissed easily.

### Decision: Consolidate unified panel into sidebar tabs on session detail pages

- **Context**: After Phase 1 implementation, two separate panels showed active conversations: the overlay UnifiedPanel (right side) and the ConversationSidebar (left side, session-only). Users wanted a single consolidated view.
- **Alternatives Considered**:
  1. Keep overlay panel as the only active conversations view
  2. Replace overlay panel entirely with sidebar tabs
  3. Add tabs to sidebar while keeping overlay for non-session pages
- **Selected Approach**: Add Session/Active tabs to the ConversationSidebar. The overlay UnifiedPanel is retained for non-session pages (projects list, sessions list) where no sidebar exists.
- **Rationale**: On session detail pages (where users spend most time), inline tabs reduce context switching vs. opening/closing an overlay. The sidebar is always visible, so users can glance at active conversations without any toggle. Non-session pages still need the overlay since they lack a sidebar.
- **Trade-offs**: Sidebar width is limited (~260px), so active conversation items are more compact than in the overlay. Generic mutation hooks were needed since active tab conversations span multiple projects.

### Decision: Generic mutation hooks for cross-project operations

- **Context**: Active tab shows conversations from any project/session. The existing `useArchiveConversationMutation(projectName, sessionName)` and `useRenameConversationMutation(projectName, sessionName)` take project/session at hook creation time, not at call time.
- **Alternatives Considered**:
  1. Create one mutation instance per unique project/session pair in the active list
  2. Use `fetch` directly without TanStack Query mutations
  3. Create new hooks that accept project/session as part of mutation variables
- **Selected Approach**: New generic hooks (`useGenericArchiveConversationMutation`, `useGenericRenameConversationMutation`) that accept `{ projectName, sessionName, ... }` in the mutation variables.
- **Rationale**: Clean API, proper query invalidation (both the specific conversation list and the active list), follows existing mutation patterns.
- **Trade-offs**: Two mutation hooks per operation (session-scoped and generic). The generic hooks could replace the session-scoped ones, but keeping both avoids unnecessary changes to existing call sites.

### Decision: Consistent button icons and tooltip attributes

- **Context**: Archive buttons used different icons across views (`\u2912` upward arrow in sidebar, different characters in cards). Tooltip attributes were inconsistent (`title` in sidebar, `data-tooltip` in cards).
- **Selected Approach**: Standardize on `\u2913` (downward arrow to bar) for archive, `\u21A9` (leftward arrow with hook) for unarchive, `&#9998;` (pencil) for rename. Use `data-tooltip` everywhere for CSS-based tooltips.
- **Rationale**: Downward arrow to bar is a more intuitive "archive" metaphor than upward arrow. `data-tooltip` provides consistent CSS tooltip styling; `title` tooltips are browser-dependent and often clipped.

## Risks & Mitigations

- **Risk**: Status rename breaks tests or hardcoded values in templates → **Mitigation**: Grep for all `"idle"`, `"ready"` string literals; update tests alongside schema changes.
- **Risk**: SSE event ordering issues during rapid status changes → **Mitigation**: Panel uses TanStack Query refetch on any event; stale data is overwritten by next fetch.
- **Risk**: Large number of active conversations degrades panel performance → **Mitigation**: Panel only shows `running` + `awaiting`; in practice this is a small number (typically <20 across all projects).

## References
- Existing SSE pattern: `src/lib/events/broadcaster.ts`
- TanStack Query invalidation: `src/components/NotificationListener.tsx`
- Design system: `.claude/skills/cc-design-system/SKILL.md`
- Zustand store pattern: `src/stores/session-detail.store.ts`

## PLC Additive Extension Research Update (2026-06-06)

### Active Conversation Scope Integration

- **Context**: PLC requirements 9-13 extend the existing Active Conversations surfaces to project conversations without creating a separate rail or data source.
- **Sources Consulted**: `src/lib/active-conversations/schemas.ts`, `src/lib/active-conversations/route-handlers.ts`, `src/features/session/sidebar/ConversationSidebar.tsx`, `src/features/session/sidebar/ConversationSidebarRow.tsx`, `src/features/session/sidebar/ConversationSidebar.helpers.ts`, `src/components/Topbar.tsx`, `src/features/project-detail/ProjectDetailView.tsx`, `src/lib/project-conversations-client/{query-keys,queries,mutations}.ts`.
- **Findings**:
  - `activeConversationSchema` is already a `scope`-discriminated union with `SessionActiveConversation` and `ProjectActiveConversation`; the project variant has no `sessionName` or `branchName` and uses `worktreePath` as the project root.
  - `GET /api/conversations/active` already has a project-conversation pass that emits `scope: "project"` rows from `listProjectConversations()`, excluding archived projects/conversations and preserving active status sorting.
  - `ConversationSidebar` currently filters active data to `scope === "session"`, so PLC presentation is blocked in the UI rather than the data source.
  - `NotificationsPanelContainer` is the current global panel container and also filters active conversation items to `scope === "session"`.
  - `ConversationSidebarRow` and helper types currently require `SessionActiveConversation` and display `sessionName` in breadcrumbs; they need a scope-aware context descriptor for `project / main`.
  - `Topbar` also filters the "needs you" pinned target to session rows and must use the same route helper as the sidebar.
  - `ProjectDetailView` mounts `ConversationSidebar` as the cockpit rail and already consumes a `focus` query param to reopen/focus a PLC tab, which is the correct rail-to-cockpit handoff.
  - Project-conversation client mutations exist for rename, archive, and open/reopen; generic active-row mutations need a scope-aware wrapper rather than forcing project rows through session routes.
- **Implications**: The extension is mostly a client/UI integration over existing scope-aware data. The design should avoid changing the active-conversations API unless tests expose a contract mismatch.

### Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Separate PLC rail | Add a distinct project-conversation rail next to the active session rail | Avoids touching existing session row code | Duplicates UI, creates separate sorting/grouping logic, violates cockpit mount requirement | Rejected |
| Scope-aware ActiveConversation row model | Widen sidebar/topbar helpers from session-only rows to the existing `ActiveConversation` union | Reuses data source, one grouping/sorting path, preserves session behavior | Requires careful type narrowing for session-only actions like peek/fork | Selected |
| API-level synthetic session name | Add `sessionName: "main"` to project rows | Simplifies current UI assumptions | Violates PLC requirements and foundation schema; risks treating PLCs as sessions | Rejected |

### Decision: Scope-aware row descriptor

- **Context**: Session rows need `project / session` breadcrumbs and project rows need `project / main` context without a synthetic session.
- **Selected Approach**: Add pure helper functions that derive a row descriptor from `ActiveConversation`: route href, context key, display project label, display scope label (`sessionName` for session, `main` for project), and action scope. Sidebar grouping/search/section helpers consume this descriptor instead of reading `sessionName` directly.
- **Rationale**: Keeps presentation logic deterministic and testable; avoids pushing UI assumptions into the API payload.
- **Trade-offs**: A few session-only flows (peek, answer, fork, copy session context) must remain narrowed to session rows until separate PLC equivalents exist.

### Decision: Route PLC focus via project `focus` query param

- **Context**: Selecting a closed PLC from the Active Conversations surface must navigate to the project cockpit and reopen/focus the tab.
- **Selected Approach**: Project row hrefs use `/projects/{projectName}?focus={conversationId}`. The existing project page focus reconciliation reopens and focuses closed PLCs.
- **Rationale**: Uses the cockpit's documented consumer contract and avoids having the rail own tab state.
- **Trade-offs**: The route is a focus intent, not a permanent deep-link shape. If cockpit route semantics change, this extension must be revalidated.

### Decision: Scope-aware generic row mutations

- **Context**: Existing generic rename/archive hooks accept `projectName` + `sessionName`, so they cannot handle project rows without violating the no-synthetic-session boundary.
- **Selected Approach**: Add scope-aware active-conversation mutation wrappers that route session rows through session conversation endpoints and project rows through project-conversation endpoints, then invalidate `conversationKeys.active()` and the relevant list/open-count keys.
- **Rationale**: The UI sees one row action surface, while route choice remains explicit and type-safe.
- **Trade-offs**: Adds a thin abstraction around existing mutations/endpoints; design must keep it narrow to rename/archive only.

## PLC Extension Risks & Mitigations

- **Risk**: Session-only actions accidentally appear for PLC rows — **Mitigation**: Type helpers expose session-only capabilities only after `scope === "session"` narrowing; tests cover project rows lacking `sessionName`.
- **Risk**: Topbar or sidebar navigate PLC rows to invalid session routes — **Mitigation**: Centralize route derivation in a pure helper and test both scopes.
- **Risk**: Project rows lose Needs-you grouping or unread semantics — **Mitigation**: `splitNeedsYou` operates on shared status/unread fields and tests include `waiting_for_input` plus unread PLC rows.
- **Risk**: Global panel and cockpit rail coverage diverge — **Mitigation**: cover `NotificationsPanelContainer` explicitly and rely on the same `ConversationSidebar` component for the cockpit rail.
- **Risk**: UI duplicates cockpit tab management — **Mitigation**: Rail emits only the project focus URL; `ProjectDetailView` remains the tab owner.
