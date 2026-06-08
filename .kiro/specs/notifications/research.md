# Research & Design Decisions

## Summary
- **Feature**: `notifications`
- **Discovery Scope**: Extension (notification persistence plus PLC notification/live-refresh extension)
- **Key Findings**:
  - The implemented notification system now uses the shared SQLite state DB through `src/lib/notifications/repo.ts` and `src/lib/jobs/repo.ts`; the PLC extension must reuse that path rather than introduce a second persistence mechanism.
  - Project-conversation foundation events are already `scope`-discriminated and omit `sessionName`; notification records must therefore gain a real project-conversation variant instead of using sentinel or fake session names.
  - `NotificationListener.tsx` currently returns early for non-session conversation events, while the cockpit spec expects this global listener to invalidate `projectConversationKeys` for `scope:"project"` events.
  - Browser/push notification parity can reuse the existing Browser Notification API handling and push dispatcher triggers, but their context contracts must no longer require `sessionName` for PLC notifications.

## Research Log

### Current SQLite Persistence Baseline
- **Context**: Notification persistence has already been implemented. The PLC extension must fit the current code rather than revisit driver selection.
- **Sources Consulted**:
  - `src/lib/state-store/state-db.ts`
  - `src/lib/notifications/repo.ts`
  - `src/lib/jobs/repo.ts`
- **Findings**:
  - Notification records live in the shared CC state database and are accessed through the notifications repository.
  - `job_records` remains the job lifecycle table; terminal jobs create rows in `notifications`.
  - The repository validates raw SQLite rows and domain objects through Zod before returning API/SSE payloads.
  - Startup initialization already handles notification DB initialization, stale job recovery, and retention cleanup.
- **Implications**: Extend the existing repository, schemas, and migration path. Do not introduce a second DB, a second notification table, or a PLC-only persistence path.

### Existing System Architecture Analysis
- **Context**: Need to understand current architecture to design minimal, non-breaking extension.
- **Sources Consulted**: Direct codebase analysis of 10+ source files
- **Findings**:
  - **Server-side**: `src/lib/jobs/queue.ts` tracks running jobs and creates persisted terminal job notifications through `src/lib/notifications/repo.ts`.
  - **Client-side**: `notification.store.ts` tracks running jobs and per-tab toast queues; notification history comes from React Query and the API.
  - **SSE pipeline**: `/api/events` uses `src/lib/events/broadcaster.ts`; `NotificationListener.tsx` owns the single global EventSource.
  - **Schemas**: notification and conversation event types are Zod-derived; conversation events now carry a `scope` discriminator.
  - **PLC gap**: `NotificationListener.tsx` currently ignores project-scoped conversation events; notification rows still assume job/session context.
- **Implications**: PLC work is an additive extension to notification row shape, server-side transition handling, and global listener invalidation.

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

### PLC Notification and Live-Refresh Extension
- **Context**: Requirements 9-12 extend the notifications spec for project-level conversations. The foundation spec owns project-conversation persistence/execution and emits `scope:"project"` conversation events; the cockpit spec owns tab UI and focus handling.
- **Sources Consulted**:
  - `.kiro/specs/project-level-conversations/brief.md`
  - `.kiro/specs/project-level-conversations/design.md`
  - `.kiro/specs/project-conversation-cockpit/design.md`
  - `src/lib/conversations/schemas.ts`
  - `src/lib/project-conversations/route-handlers.ts`
  - `src/lib/project-conversations-client/query-keys.ts`
  - `src/components/NotificationListener.tsx`
  - `src/lib/notifications/schemas.ts`
  - `src/lib/notifications/repo.ts`
  - `src/lib/push-notification/dispatcher.ts`
- **Findings**:
  - Conversation event schemas are already discriminated by `scope`; the project variant carries `projectName` and `conversationId` but not `sessionName`.
  - `projectConversationKeys.list`, `projectConversationKeys.messages`, and the derived open-count query are the cockpit cache boundaries that need invalidation on project-scoped status, message, lifecycle, and open events.
  - Current notification records require job/session fields (`sessionName`, `branchName`, `jobId`, `jobType`), which conflicts with PLC requirement 9.4.
  - The active-conversations source already returns project variants, and `activeConversationHref()` already maps project rows to `/projects/{projectName}?focus={conversationId}`.
  - Push notification formatting currently requires `sessionName`, so PLC parity needs a context union or equivalent formatting path that can label the main project context without synthesizing a session.
- **Implications**:
  - Add a `source` discriminator to notification records: `job` and `project-conversation`.
  - Add a server-side PLC notification service that creates persisted project-conversation notifications from server-side project status/error transitions, with idempotency per transition.
  - Extend the global listener with project branches for `conversation-status`, `message-appended`, `message-updated`, `conversation-created`, `conversation-renamed`, `conversation-archived`, `conversation-open`, `conversation-unread`, and `ask-question`.
  - Keep rail grouping, cockpit rendering, and project-conversation persistence/execution out of this spec.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Server-authoritative with SSE push | DB is source of truth; SSE pushes changes; client fetches on open/reconnect | Consistent across tabs/devices; survives restarts; simple mental model | Adds DB read latency to panel open | Selected approach |
| Client-first with background sync | Zustand store as primary; sync to server periodically | Fast UI; offline support | Complex conflict resolution; data loss window | Over-engineered for single-user local app |
| Hybrid (optimistic client + server confirm) | Write to store immediately; confirm via server | Best perceived performance | Dual source of truth; complex rollback | Unnecessary complexity |

## Design Decisions

### Decision: Reuse the shared SQLite state DB
- **Context**: Notification/job persistence has already landed in the shared state DB with `better-sqlite3`, WAL mode, and HMR-safe singleton access.
- **Alternatives Considered**:
  1. Introduce a separate PLC notification store — splits retention/read-state logic and duplicates APIs.
  2. Reuse notification persistence — one notification history and one read/dismiss lifecycle.
- **Selected Approach**: Keep using `src/lib/notifications/repo.ts` and the shared SQLite state DB. Add PLC notification columns and schemas through the existing repository.
- **Rationale**: Preserves the current API/SSE/read-state model and avoids a second source of truth.
- **Trade-offs**: Requires an additive migration on the existing `notifications` table and careful row parsing for old job rows.

### Decision: Retain `job_records` plus generalized `notifications`
- **Context**: Jobs and notifications have different lifecycles. Running jobs need recovery; terminal jobs create notifications. PLC notifications do not need job recovery rows.
- **Alternatives Considered**:
  1. Put PLC notifications into `job_records` — invalid because PLC statuses are not jobs.
  2. Create a separate `project_conversation_notifications` table — duplicates notification read/dismiss/retention APIs.
  3. Generalize `notifications` with a source discriminator — one notification lifecycle, type-safe variants.
- **Selected Approach**: Keep `job_records` for background job lifecycle and generalize `notifications` with `source:"job" | "project-conversation"`.
- **Rationale**: Separates job recovery from notification history while preserving one Activities/read-state API.
- **Trade-offs**: The notifications table contains nullable fields guarded by source-specific schema validation and SQL checks.

### Decision: Server-authoritative notification state
- **Context**: Cross-tab and cross-device consistency requires a single source of truth
- **Selected Approach**: SQLite DB is authoritative. Client fetches via API, receives updates via SSE.
- **Rationale**: Eliminates dual-source-of-truth bugs. SSE already exists for real-time push.
- **Trade-offs**: Panel open requires API call (minor latency)

### Decision: Project-conversation notifications use a notification variant, not fake session fields
- **Context**: PLC notifications must identify project and project conversation without requiring `sessionName`.
- **Alternatives Considered**:
  1. Store `sessionName: "__project__"` in notification rows — easy but leaks the foundation sentinel into user-facing data and violates the no-session requirement.
  2. Make all job/session fields optional on a single loose object — simple but pushes unsafe optional-field checks into every consumer.
  3. Add a discriminated notification union — explicit and type-safe.
- **Selected Approach**: Use `source:"job"` and `source:"project-conversation"` variants. Job notifications retain existing job/session fields; PLC notifications carry `conversationId`, optional name, status, and optional error.
- **Rationale**: The variant matches the foundation's `scope` discriminator pattern and prevents project notifications from depending on a session route.
- **Trade-offs**: Requires an additive schema/database migration and consumer narrowing on `source`.

### Decision: Global listener owns project-conversation cache invalidation
- **Context**: The cockpit spec exposes `projectConversationKeys` but does not own the global `/api/events` listener.
- **Selected Approach**: Extend `NotificationListener.tsx` to branch on `scope:"project"` and invalidate project list/messages/open-count caches, active conversations, and notification caches as appropriate.
- **Rationale**: Keeps one EventSource owner and avoids per-feature duplicate SSE connections.
- **Trade-offs**: The listener grows more central; tests must pin session branches so PLC wiring does not regress session behavior.

## Risks & Mitigations
- **Risk**: SQLite file locking under concurrent Next.js API routes — **Mitigation**: WAL mode + single Database instance via globalThis singleton
- **Risk**: Stale jobs after server crash — **Mitigation**: Startup recovery marks running jobs as failed and creates failure notifications
- **Risk**: SSE reconnection gap causes missed events — **Mitigation**: Client fetches full state on reconnection
- **Risk**: DB file grows unbounded — **Mitigation**: Retention-based cleanup on server startup (default 7 days)
- **Risk**: Project-conversation notifications accidentally navigate to session routes — **Mitigation**: use the project notification variant and cockpit focus URL only.
- **Risk**: Project-scoped SSE handling regresses session invalidations — **Mitigation**: add listener tests for both session and project branches.
- **Risk**: Duplicate status broadcasts create duplicate PLC notifications — **Mitigation**: persist with a deterministic `dedupe_key`.

## References
- [better-sqlite3 Node.js 25 issue](https://github.com/WiseLibs/better-sqlite3/issues/1411) — Build failures on newer Node
- `src/lib/notifications/repo.ts` — Current notification persistence implementation
- `src/lib/project-conversations-client/query-keys.ts` — Project-conversation React Query keys invalidated by the global listener
