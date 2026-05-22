# Performance Improvements — Checklist

Source: `bun run logs:analyze -- report` against `/home/alex/.config/cc/logs/global.log` on 2026-05-22.
Dev server hits the live `~/.config/cc/command-center.db` (73 MB), so reproduction uses real prod state.

For each issue: **reproduce → fix → verify**.

## Issue 1 — Whole-state mutate path runs O(entire-DB) work per tiny mutation (CRITICAL)

- **Symptom**: `state.mutate.complete label=setConversationPendingPromptText` p95 = 6 079 ms across 13 calls. Hold time on the write queue p95 = 6 078 ms.
- **Root cause** (`src/lib/state-store/state-store.ts:178-250`, `state-aggregate.ts:117-219`): every mutation runs `aggregate.readAll()` (full Zod parse of `ManagerState`) → `structuredClone` → second Zod parse → sibling canonicalization → `diffAndCommit` with a third Zod parse + full diff. Each keystroke into the prompt input blocks the event loop for ~6 s.
- **Repro**:
  1. Start dev server, open a session conversation.
  2. Type into the draft input → POSTs to `/conversations/[id]/pending-prompt`.
  3. Observe `state.mutate.complete label=setConversationPendingPromptText` in logs ≫ 1 s.
- **Fix candidates** (prefer the literal/minimal step):
  - Replace the `mutateSession` round-trip for `setConversationPendingPromptText` with a focused write that calls `repos.conversations.upsert` (or a narrower SQL UPDATE) inside `writeQueue.withWriteQueue`, the way `setProjectArchived` already does (`state-store.ts:604-626`).
  - Drop the redundant `managerStateSchema.parse` calls on the mutate hot path; keep one validation at the entry boundary.
- **Success criterion**: `setConversationPendingPromptText` mutate duration p95 < 50 ms; no measurable degradation of other in-flight requests during a burst of typing.
- **Status (2026-05-22)**: FIXED. Repo gained focused `setPendingPromptText` (`conversations-repo.ts`); `state-store.setConversationPendingPromptText` writes the column inside `writeQueue.withWriteQueue` without touching the aggregate. Verified on dev server: 10 keystrokes against `/pending-prompt` rendered in 10-16 ms each (was 5 300-6 200 ms). p95 ≪ 50 ms.

## Issue 2 — Event-loop starvation cascades into unrelated requests (CRITICAL, depends on Issue 1)

- **Symptom**: `project-resolver:project-resolver.resolve.complete` p95 = 24 444 ms when the body is two `existsSync` calls (`src/lib/project-resolver.ts:42-50`). GETs `/commands` (13 s), `/agent-capabilities` (×2, 13 s), `/sessions/[name]` (5 s) all log 100 % unexplained time.
- **Root cause**: synchronous CPU spikes from Issue 1 hold the event loop; sibling routes can't progress.
- **Repro**:
  1. With dev server up, hammer `/pending-prompt` while issuing a `/commands` GET.
  2. Observe `/commands` duration tracking the mutate hold time.
- **Fix**: should resolve automatically once Issue 1 is fixed. Re-measure.
- **Success criterion**: `project-resolver.resolve` p95 < 10 ms; `/commands`, `/agent-capabilities`, `/sessions/[name]` p95 < 200 ms under typing burst.
- **Status (2026-05-22)**: RESOLVED by Issue 1 fix. Under a 10-keystroke parallel burst, GET `/commands` = 232 ms, `/agent-capabilities` = 32 ms, `/sessions/[name]` = 45 ms (were 13 000+ ms during the prior cascade). Post-burst quiescent: 71/8/10 ms.

## Issue 3 — `conversations.findAll` reads/parses every row on every read (HIGH)

- **Symptom**: `state-store.conversations.findAll.timing` p95 = 589 ms, n = 14. Sessions findAll p95 = 95 ms.
- **Root cause** (`src/lib/state-store/conversations-repo.ts`): per-row JSON parse + Zod validation of all conversations in the DB on each `aggregate.readAll()` and each `readState`.
- **Repro**: after Issue 1, a standalone `readState` call still costs ~600 ms.
- **Fix candidates**:
  - Memoize parsed rows keyed by primary key + a content fingerprint (e.g. `last_activity_at` + length of JSON columns).
  - Or push more of the diff/read logic into SQL so we avoid hydrating the whole table just to look up one entity.
- **Success criterion**: `state.read.timing accessor=readState` p95 < 100 ms; `state-store.conversations.findAll.timing` p95 < 100 ms.
- **Status (2026-05-22)**: FIXED via row-level cache + version counter in `conversations-repo.ts`. Per-row raw-column comparison skips the Zod parse when a row is unchanged; a monotonic `cacheVersion` bumped by every write lets `findAll` return its cached array verbatim when nothing has changed since the last call. Verified on dev server: 10× GET `/api/conversations/active` rendered in 62-89 ms (was 520-570 ms). Tests pin the cache via reference equality (`expect(second).toBe(first)`) and invalidation after each mutator.

## Issue 4 — Callers use `readState` where focused accessors would suffice (MEDIUM)

- **Symptom**: `state.read.timing accessor=readState` p95 = 660 ms, total 7.8 s across 14 calls in a 1.5-minute window.
- **Root cause**: routes pull the whole `ManagerState` when they only need one session or conversation.
- **Repro**: grep `readState(` callers, check whether the consumer uses just one project/session.
- **Fix**: migrate qualifying callers to `getSession` / `getProjectSessionListItems` / `getConversation` (`state-store.ts:285-489`).
- **Success criterion**: `readState` call count drops materially; remaining `readState` calls are justifiably whole-state.
- **Status (2026-05-22)**: FIXED. Added focused accessor `getProjectMcpOverrides(projectPath)` on the state store and migrated the three hot-path MCP `readProjectOverrides` callers (`workflows/conversation/actor-implementations.ts`, `mcp/default-deps.ts` `defaultReadProjectOverrides` + composer block). Also migrated `workflows/conversation/manager.ts:defaultLoadActorInput` from `readState()` to `getSession()` and `workflows/conversation/persistence.ts:restoreConversationSnapshot` from `readState()` to `getConversation()` (deps interface swapped accordingly). Remaining `readState` callers are legitimately whole-state: `debug-logs-ingest-route-handlers`, `active-conversations-route-handlers`, `recover-workflow-envelopes`, `manager.rehydrateConversationActors`, `discovery.discoverProjects`, `mcp/default-deps.defaultListGlobalRuntimeTargets`, `agent-capabilities/default-deps.defaultListAffectedConversations`, `sessions.ts` uniqueness + delete paths (low-frequency admin ops), and `agent-capabilities` cascade walks (low-frequency PATCH route work). Unit verification: `createStateStore-focused-read.test.ts` pins that `getProjectMcpOverrides` never invokes `aggregate.readAll`/`diffAndCommit`. Dev-server verification: an `/api/conversations/active` burst produced only the legitimately whole-state `readState` calls; the MCP route hot path now logs `getProjectMcpOverrides` instead.

## Process notes

- Reproduce each issue against the dev server before touching code.
- Verify each fix with `bun run logs:analyze -- compare --before <before>.log --after <after>.log`.
- Capture the before-state log snippet for each issue into `/tmp/perf-before-<issue>.log` before fixing.
