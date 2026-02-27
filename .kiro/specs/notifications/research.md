# Research & Design Decisions

## Summary
- **Feature**: `notifications`
- **Discovery Scope**: Extension (adding persistence layer to existing notification system)
- **Key Findings**:
  - Bun's built-in `bun:sqlite` is the optimal SQLite driver — zero dependencies, 3-6x faster than better-sqlite3, synchronous API
  - Current system architecture is sound (SSE broadcasting, Zustand stores, fire-and-forget dispatch) but all state is ephemeral (globalThis Maps + client memory)
  - Resolve-conflicts jobs have a display bug in NotificationsPanelContainer (missing else-if branch)

## Research Log

### SQLite Driver Selection for Bun Runtime
- **Context**: Requirements mandate SQLite persistence. CC runs on Bun runtime (see tech.md: `bun run dev`).
- **Sources Consulted**:
  - [bun:sqlite docs](https://bun.com/docs/runtime/sqlite)
  - [bun:sqlite API reference](https://bun.com/reference/bun/sqlite)
  - [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3)
  - [better-sqlite3 Node.js 25 build failure](https://github.com/WiseLibs/better-sqlite3/issues/1411)
- **Findings**:
  - `bun:sqlite` is built-in, zero-dependency, synchronous API
  - 3-6x faster than better-sqlite3 for read queries
  - Supports WAL mode, transactions (deferred/immediate/exclusive), prepared statements
  - `Database` constructor: `new Database(filepath, options?)` for persistent files
  - `.run()` returns `{ lastInsertRowid, changes }` for writes
  - `.all()` returns array of objects, `.get()` returns single row
  - Transactions auto-rollback on exception, nested transactions become savepoints
  - better-sqlite3 has build failures on newer Node.js versions and requires native compilation
- **Implications**: Use `bun:sqlite` exclusively. No npm dependency needed. Database file location follows existing config directory pattern (`getConfigDir()`).

### Existing System Architecture Analysis
- **Context**: Need to understand current architecture to design minimal, non-breaking extension.
- **Sources Consulted**: Direct codebase analysis of 10+ source files
- **Findings**:
  - **Server-side**: `background-jobs.ts` uses `globalThis` Maps for job state, broadcasts `JobStatusEvent` via `sse-broadcaster.ts`
  - **Client-side**: `notification.store.ts` (Zustand+Immer) accumulates jobs and manages toast queue
  - **SSE pipeline**: `api/events/route.ts` → `sse-broadcaster.ts` → `NotificationListener.tsx` → store
  - **Config**: `config.ts` provides `getConfigDir()` for platform-aware paths
  - **Schemas**: `schemas.ts` defines all event types with Zod, types derived via `z.infer`
  - **Bug**: `NotificationsPanelContainer.tsx` has no mapping branch for `resolve-conflicts` jobs
  - **Panel data source**: Currently combines React Query (active conversations API) + Zustand store (jobs) — both ephemeral
- **Implications**: The persistence layer slots in between dispatch and broadcast — write to DB, then broadcast. Client shifts from store-only to API-backed with SSE for real-time updates.

### Cross-Tab/Cross-Device Synchronization Strategy
- **Context**: Requirements 5 and 6 require notification state consistency across tabs and devices.
- **Sources Consulted**: Existing SSE architecture, BroadcastChannel API
- **Findings**:
  - SSE already broadcasts to all connected clients (tabs and devices)
  - Missing: read/unread state changes are not broadcast
  - Missing: no server-side notification records (only job-status events)
  - BroadcastChannel API could optimize same-browser tab sync but adds complexity for marginal gain
  - Server-authoritative approach (DB as source of truth + SSE for push) covers both cross-tab and cross-device
- **Implications**: Extend SSE with `notification-created` and `notification-updated` events. Client fetches from API on panel open and on SSE reconnection. No need for BroadcastChannel.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Server-authoritative with SSE push | DB is source of truth; SSE pushes changes; client fetches on open/reconnect | Consistent across tabs/devices; survives restarts; simple mental model | Adds DB read latency to panel open | Selected approach |
| Client-first with background sync | Zustand store as primary; sync to server periodically | Fast UI; offline support | Complex conflict resolution; data loss window | Over-engineered for single-user local app |
| Hybrid (optimistic client + server confirm) | Write to store immediately; confirm via server | Best perceived performance | Dual source of truth; complex rollback | Unnecessary complexity |

## Design Decisions

### Decision: `bun:sqlite` as persistence layer
- **Context**: Need embedded database for notification/job persistence
- **Alternatives Considered**:
  1. better-sqlite3 — native addon, requires compilation, build issues on newer Node.js
  2. bun:sqlite — built-in, zero-dependency, faster
  3. JSON file (existing pattern) — no query capability, no concurrent access safety
- **Selected Approach**: `bun:sqlite` with WAL mode enabled
- **Rationale**: Zero dependencies, fastest option, synchronous API matches existing patterns, WAL mode provides concurrent read safety
- **Trade-offs**: Ties runtime to Bun (already the case for this project)
- **Follow-up**: Verify WAL mode works correctly in Next.js server-side context

### Decision: Single `notifications` table (no separate `jobs` table)
- **Context**: Jobs and notifications are closely related — every terminal job creates a notification
- **Alternatives Considered**:
  1. Separate `jobs` and `notifications` tables — normalized but requires joins
  2. Single `notifications` table with job metadata columns — denormalized but simpler
- **Selected Approach**: Single `notifications` table with nullable job-specific columns
- **Rationale**: Running jobs are still tracked in-memory (globalThis) for the fire-and-forget pattern. The DB stores notification records created at terminal states. Simplifies queries and API.
- **Trade-offs**: Some nullable columns; running job state still ephemeral (recovered on startup)
- **Follow-up**: Ensure stale job recovery writes a "failed" notification to DB

### Decision: Server-authoritative notification state
- **Context**: Cross-tab and cross-device consistency requires a single source of truth
- **Selected Approach**: SQLite DB is authoritative. Client fetches via API, receives updates via SSE.
- **Rationale**: Eliminates dual-source-of-truth bugs. SSE already exists for real-time push.
- **Trade-offs**: Panel open requires API call (minor latency)

## Risks & Mitigations
- **Risk**: SQLite file locking under concurrent Next.js API routes — **Mitigation**: WAL mode + single Database instance via globalThis singleton
- **Risk**: Stale jobs after server crash — **Mitigation**: Startup recovery marks running jobs as failed and creates failure notifications
- **Risk**: SSE reconnection gap causes missed events — **Mitigation**: Client fetches full state on reconnection
- **Risk**: DB file grows unbounded — **Mitigation**: Retention-based cleanup on server startup (default 7 days)

## References
- [bun:sqlite Documentation](https://bun.com/docs/runtime/sqlite) — Full API reference for built-in SQLite
- [bun:sqlite API Reference](https://bun.com/reference/bun/sqlite) — Detailed method signatures
- [better-sqlite3 Node.js 25 issue](https://github.com/WiseLibs/better-sqlite3/issues/1411) — Build failures on newer Node
- [Bun 1.2 SQLite overview](https://dev.to/pockit_tools/bun-12-deep-dive-built-in-sqlite-s3-and-why-it-might-actually-replace-nodejs-4738) — Performance benchmarks
