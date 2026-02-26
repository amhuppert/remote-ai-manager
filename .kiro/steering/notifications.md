# Notifications & Background Jobs

CSM uses a dual-layer architecture for async operations: in-memory job tracking for transient state, SQLite persistence for durable notification history, and SSE for real-time cross-tab/device sync.

## Architecture

```
dispatchJob() → Job Registry (Map) → SSE "job-status" → Zustand store (running jobs)
    └─ async execution → terminal state
        ├─ SQLite: updateJobRecord + createNotification
        ├─ SSE "notification-created" → toast + query invalidation
        └─ Remove from Job Registry
```

**Three data stores, three concerns**:
- **In-memory Map** (`globalThis`): Transient running jobs only — removed on terminal state
- **SQLite** (`better-sqlite3`, WAL mode): Persistent notification/job history — source of truth for UI
- **Zustand store**: Client-side running job tracking + toast queue (FIFO)

## Job Lifecycle

### Dispatch Pattern (fire-and-forget)

```typescript
prepareDispatch()
  → recoverStaleJob() (>10min → force fail)
  → acquireSessionLock() (key: projectPath::sessionName)
  → register in Map + persist createJobRecord()
  → broadcast "job-status" (running)

// Unawaited async execution:
  → git operations (merge/commit/resolve)
  → broadcast "job-status" (completed|failed|conflicts)
  → persistTerminalState() → updateJobRecord + createNotification
  → release locks
```

### Job Types & Terminal States

| Job Type | Possible Outcomes | Notification Type |
|----------|-------------------|-------------------|
| `merge` | completed, failed, conflicts | `merge-completed`, `merge-failed`, `merge-conflicts` |
| `commit` | completed, failed | `commit-completed`, `commit-failed` |
| `resolve-conflicts` | completed, failed | `resolve-completed`, `resolve-failed` |

### Locking

- **Session lock**: Prevents concurrent operations on same session (`projectPath::sessionName`)
- **Project lock**: Required for Phase 2 squash-merge (retried up to 30s with 100ms polling)
- **Stale recovery**: Jobs running >10min auto-failed on next dispatch or startup

## SQLite Persistence

**Location**: `<config-dir>/notifications.db` (WAL journal mode)

**Tables**: `notifications` (with indexes on `read`, `created_at`, `project+session`) and `job_records`

**Key pattern**: `globalThis` singleton DB connection, HMR-safe. Initialize on server startup via `instrumentation.node.ts`.

**Startup recovery**: `recoverStaleJobs()` marks running jobs as failed + creates failure notifications. `cleanupOldNotifications()` purges >7 days.

**Type derivation**: `deriveNotificationType(jobType, status)` and `deriveNotificationTitle(type)` ensure consistency between jobs and notifications.

## SSE Event Flow

| Event | Trigger | Client Action |
|-------|---------|---------------|
| `job-status` | Any job state change | Update Zustand jobs Map; invalidate session queries on terminal |
| `notification-created` | `createNotification()` | Invalidate notification cache + enqueue toast |
| `notification-updated` | `markAsRead()` / `markAllAsRead()` | Invalidate notification cache |

**Reconnection**: `NotificationListener` tracks `hadErrorRef` — on EventSource reconnect, refetches all notifications to recover missed events.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/notifications` | List notifications (params: `unread`, `limit`, `offset`) |
| PATCH | `/api/notifications/[id]` | Mark as read |
| DELETE | `/api/notifications/[id]` | Dismiss notification |
| POST | `/api/notifications/mark-all-read` | Mark all as read |

## Client Architecture

**Zustand store** (`notification.store.ts`):
- `jobs: Map<string, BackgroundJob>` — running only; terminal states delete from map
- `toastQueue: Notification[]` — FIFO; populated by `notification-created` SSE events
- `addOrUpdateJob()`: Running → upsert; terminal → delete
- `enqueueToast()`: Push notification for display
- `dismissToast()`: Pop first toast

**React Query** (`notificationKeys.list()`):
- Server-backed notification list for Activities panel
- Invalidated by SSE events (created/updated)
- Enabled only when panel is open (optimization)

**NotificationsPanelContainer**: Merges three sources — active conversations + running jobs (Zustand) + persisted notifications (API) — sorted by timestamp.

**MergeToastContainer**: Maps notification type → toast variant (`success`/`conflicts`/`error`), auto-dismisses after 8s.

## Key Conventions

- **Non-throwing persistence**: `persistJobRecord()` and `persistTerminalState()` catch errors silently — DB failures must not block job execution
- **Schema validation on SSE**: All event handlers validate with Zod schemas before processing
- **Toast responsibility**: Toasts triggered by `notification-created` SSE events, not by `job-status` terminal events
- **Notification broadcasting**: `createNotification()` and `markAsRead()` broadcast SSE events internally — callers don't need to broadcast separately

---

_Document patterns, not every field. Schemas in `schemas.ts` are the source of truth for data shapes._
