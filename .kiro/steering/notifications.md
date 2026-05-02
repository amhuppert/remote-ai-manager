# Notifications & Background Jobs

Dual-layer: in-memory job tracking (transient) + SQLite (durable history) + SSE (cross-tab sync).

## Architecture

```
dispatchJob() → Job Registry (Map) → SSE "job-status" → Zustand running jobs
  └─ async exec → terminal state
      ├─ SQLite: updateJobRecord + createNotification
      ├─ SSE "notification-created" → toast + query invalidation
      └─ Remove from Job Registry
```

Three stores, three concerns:
- **In-memory `Map`** (`globalThis`) — running jobs only; removed on terminal
- **SQLite** (`notifications.db`, WAL) — persistent notifications/jobs; UI source of truth
- **Zustand store** — client running jobs + FIFO toast queue

## Job Lifecycle

```
prepareDispatch()
  → recoverStaleJob() (>10min → force fail)
  → acquireSessionLock() (key: projectPath::sessionName)
  → register in Map + createJobRecord()
  → broadcast "job-status" (running)
// Unawaited:
  → git ops (merge/commit/resolve)
  → broadcast "job-status" (completed|failed|conflicts)
  → persistTerminalState() → updateJobRecord + createNotification
  → release locks
```

### Job types

| Type | Outcomes | Notification types |
|---|---|---|
| `merge` | completed, failed, conflicts | `merge-completed`/`-failed`/`-conflicts` |
| `commit` | completed, failed | `commit-completed`/`-failed` |
| `resolve-conflicts` | completed, failed | `resolve-completed`/`-failed` |

### Locking

- **Session lock** — same-session concurrency guard (`projectPath::sessionName`)
- **Project lock** — required for Phase 2 squash-merge (retried up to 30s, 100ms polling)
- **Stale recovery** — jobs running >10min auto-failed on next dispatch or startup

## SQLite

Location: `<config-dir>/notifications.db` (WAL).

Tables: `notifications` (indexed on `read`, `created_at`, `project+session`) + `job_records`.

Pattern: `globalThis` singleton DB connection, HMR-safe. Initialized in `instrumentation.node.ts`.

Startup: `recoverStaleJobs()` → mark running as failed + create failure notifications. `cleanupOldNotifications()` purges >7 days.

Type derivation: `deriveNotificationType(jobType, status)` and `deriveNotificationTitle(type)` keep jobs/notifications consistent.

## SSE

| Event | Trigger | Client action |
|---|---|---|
| `job-status` | Job state change | Update Zustand jobs Map; on terminal, invalidate session queries |
| `notification-created` | `createNotification()` | Invalidate notification cache + enqueue toast |
| `notification-updated` | `markAsRead()` / `markAllAsRead()` | Invalidate cache |

`NotificationListener` tracks `hadErrorRef` — on EventSource reconnect, refetches all notifications to recover missed events.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/notifications` | List (`unread`, `limit`, `offset`) |
| PATCH | `/api/notifications/[id]` | Mark read |
| DELETE | `/api/notifications/[id]` | Dismiss |
| POST | `/api/notifications/mark-all-read` | Mark all read |

## Client

`notification.store.ts`:
- `jobs: Map<string, BackgroundJob>` — running only; terminal deletes
- `toastQueue: Notification[]` — FIFO; populated by `notification-created` SSE
- `addOrUpdateJob()` — running upserts, terminal deletes
- `enqueueToast()` / `dismissToast()`

React Query: `notificationKeys.list()` server-backed list for Activities panel; invalidated by SSE; enabled only when panel open.

`NotificationsPanelContainer` merges three sources: active conversations + running jobs (Zustand) + persisted notifications (API), sorted by timestamp.

`MergeToastContainer` maps notification type → variant (`success`/`conflicts`/`error`), auto-dismisses after 8s.

## Conventions

- **Non-throwing persistence** — `persistJobRecord()` / `persistTerminalState()` swallow errors; DB failures must not block job execution
- **Zod-validate on SSE** — all event handlers validate before processing
- **Toasts on `notification-created`**, not `job-status` terminal
- **Internal SSE broadcasts** — `createNotification()` and `markAsRead()` broadcast themselves; callers don't
