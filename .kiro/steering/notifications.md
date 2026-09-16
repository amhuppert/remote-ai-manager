# Notifications & Background Jobs

Dual-layer: in-memory job tracking (transient) + SQLite (durable history) + SSE (cross-tab sync).

## Architecture

```
dispatchMergeJob() / dispatchCommitJob() / dispatchResolveConflictsJob() / dispatchRebaseJob()
  → dispatchMachineJob() → Job Registry (Map) → SSE "job-status" → Zustand running jobs
      └─ XState actor runs unawaited → terminal state
          ├─ SQLite: updateJobRecord + createNotification
          ├─ SSE "notification-created" → toast + query invalidation
          └─ Remove from Job Registry
```

The four `dispatch*Job` functions in `src/lib/jobs/queue.ts` are the entry
points. Each builds a `JobDispatchHost` (whose `prepare` is `prepareDispatch`)
and hands it to `dispatchMachineJob` in `src/lib/jobs/machine-host.ts`, which
runs the dispatch under a `job:<type>` trace inheriting the caller's trace
context and hosts the job on an XState machine. `runRegisteredMergeJob` is the
one further caller of `dispatchMachineJob`: a graph join that already owns the
outer git locks registers its merge through the same host, awaiting the outcome
with a no-op session lock. There is no generic `dispatchJob`; a design that
names one is describing an API that does not exist.

**This is not a general-purpose background queue.** Three properties make it a
git-operations mechanism specifically, and each one has to hold for a caller to
belong here:

- `jobTypeSchema` is a **closed** enum — `commit`, `merge`, `resolve-conflicts`,
  `rebase`. A new kind of background work means widening that enum plus
  `deriveNotificationType` / `deriveNotificationTitle`, not registering a
  handler.
- The registry is keyed `projectPath::sessionName` and admits **exactly one job
  per session**; a second dispatch is refused with `JOB_ALREADY_RUNNING` (unless
  the incumbent is stale and gets force-failed first).
- Dispatch takes the **single-flight session lock** from
  `prompt/single-flight.ts` — the same lock graph-workflow git operations take —
  so anything else holding it makes the dispatch fail with `SESSION_BUSY`.

Work that does not want per-session exclusivity, or that has no session at all,
needs a different owner.

Three stores, three concerns:
- **In-memory `Map`** (`globalThis`) — running jobs only; removed on terminal
- **SQLite** (`command-center.db`, WAL) — persistent notifications/jobs; UI source of truth
- **Zustand store** — client running jobs + FIFO toast queue

## Job Lifecycle

```
prepareDispatch()
  → recoverStaleJob() (>10min → force fail)
  → acquireSessionLock() (key: projectPath::sessionName)
  → register in Map + createJobRecord()
  → publish "job-status" (running)
// Unawaited:
  → git ops (merge/commit/resolve-conflicts/rebase)
  → publish "job-status" (completed|failed|conflicts)
  → persistTerminalState() → updateJobRecord + createNotification
  → release locks
```

### Job types

`jobTypeSchema` (`src/lib/jobs/schemas.ts`) is the closed set; `jobStatusSchema`
is `running`, `completed`, `failed`, `conflicts`, `ready-to-land`, `discarded`.

| Type | Outcomes | Notification types |
|---|---|---|
| `merge` | completed, failed, conflicts, ready-to-land, discarded | `merge-completed`/`-failed`/`-conflicts`/`-ready-to-land`/`-discarded` |
| `commit` | completed, failed | `commit-completed`/`-failed` |
| `resolve-conflicts` | completed, failed | `resolve-completed`/`-failed` |
| `rebase` | completed, failed | `rebase-completed`/`-failed` |

### Locking

- **Session lock** — the single-flight session lock in `prompt/single-flight.ts`, keyed `projectPath::sessionName`. Graph-workflow git operations take the same lock through `createSessionGitLock`, so they and jobs are mutually exclusive per session
- **Project lock** — required for Phase 2 squash-merge (retried up to 30s, 100ms polling)
- **Stale recovery** — jobs running >10min auto-failed on next dispatch or startup

## SQLite

Location: `<config-dir>/command-center.db` (WAL).

Tables: `notifications` (indexed on `read`, `created_at`, `project+session`) + `job_records`.

Pattern: `globalThis` singleton DB connection, HMR-safe. Initialized in `instrumentation.node.ts`.

Startup: `recoverStaleJobs()` → mark running as failed + create failure notifications. `cleanupOldNotifications()` purges >7 days.

Type derivation: `deriveNotificationType(jobType, status)` and `deriveNotificationTitle(type)` keep jobs/notifications consistent.

## SSE

Jobs and notification services publish through `events/publication.ts` or an injected `PublishFn`. Repositories persist data only; they never emit SSE or push notifications.

| Event | Trigger | Client action |
|---|---|---|
| `job-status` | Job state change | Update Zustand jobs Map; on terminal, invalidate session queries |
| `notification-created` | `createNotification()` | Invalidate notification cache + enqueue toast |
| `notification-updated` | `markAsRead()` / `markAllAsRead()` | Invalidate cache |

`NotificationListener` registers `registerJobsReconnectReconciliation` from `src/lib/jobs/sse-reactions.ts`. After a connection error it invokes the shared `reconnectReconcile`, which invalidates notification queries and reconciles running jobs.

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
- `mergeDonePromptQueue: MergeDoneTicketPrompt[]` — FIFO, deduped by `jobId`; drives the global "Move ticket to Done?" dialog (`MergeDoneTicketPromptHost`)
- `addOrUpdateJob()` — running upserts, terminal deletes
- `enqueueToast()` / `dismissToast()`
- `enqueueMergeDonePrompt()` / `dismissMergeDonePrompt()`

React Query: `notificationKeys.list()` server-backed list for Activities panel; invalidated by SSE; enabled only when panel open.

`NotificationsPanelContainer` merges three sources: active conversations + running jobs (Zustand) + persisted notifications (API), sorted by timestamp.

`MergeToastContainer` maps notification type → variant (`success`/`conflicts`/`error`), auto-dismisses after 8s.

## Conventions

- **Non-throwing persistence** — `persistJobRecord()` / `persistTerminalState()` swallow errors; DB failures must not block job execution
- **Zod-validate on SSE** — all event handlers validate before processing
- **Toasts on `notification-created`**, not `job-status` terminal
- **Decisions on `job-status` terminal**, not `notification-created` — the merge→ticket-Done suggestion (`resolveMergeDoneTicketPrompt`) hangs off the authoritative job transition, because notification persistence is deliberately non-throwing and a swallowed write would silently lose the prompt
- **Service-owned publication** — notification service mutations publish their own typed events through an injected `PublishFn`; callers and repositories do not duplicate that side effect
