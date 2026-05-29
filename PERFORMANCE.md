# Performance Log

Durable record of performance issues found in Command Center, their root causes, and the patterns we now follow to prevent regressions.

**Keep this file updated.** When you fix a performance issue, add an entry under [Resolved issues](#resolved-issues). When you add new code in an area covered by a pattern below, follow it. If you find yourself violating a pattern, stop and ask why — the pattern was written because the alternative bit us.

Reproduction and verification tooling:

- `bun run logs:analyze -- report` against `~/.config/cc/logs/global.log` produces a JSON report of slow requests, p95s, and accessor counts. Use this to spot regressions before merging server-side perf-sensitive changes.
- `bun run logs:analyze -- compare --before <before>.log --after <after>.log` quantifies a fix.

## Patterns to follow

### 1. Never call `readState()` on a hot path — use a focused accessor

`readState()` runs a full Zod parse of every project, session, conversation, and reference document in the DB, a `structuredClone`, a second parse, sibling canonicalization, and a third parse inside `diffAndCommit`. With ~200 conversations this is hundreds of milliseconds *per call*. Calling it from a per-keystroke or per-request handler is a foot-gun.

Use a focused accessor instead. The state store exposes:

- `getSession(projectPath, sessionName)`
- `getProjectSessions(projectPath)`
- `getProjectSessionListItems(projectPath)`
- `getConversation(projectPath, sessionName, conversationId)`
- `getSessionConversations(projectPath, sessionName)`
- `getReferenceDocuments(projectPath, sessionName)`
- `getProjectMcpOverrides(projectPath)`
- `getArchivedProjects()` / `getPinnedProjects()`

If your route needs one project/session/conversation slice, use the matching accessor. If no accessor exists for the slice you need, **add one** — model it after the existing accessors in `src/lib/state-store/state-store.ts`. Focused accessors hit the repos directly, bypassing the aggregate's read-everything-and-validate cycle, and they emit a distinct `accessor` label in `state.read.timing` so we can spot misuse in logs.

`readState()` is appropriate when the work is genuinely whole-state: rehydration on startup, project discovery, the "active conversations across all projects" route, etc. Those callers must accept the cost; everyone else should not.

A regression guard lives in `src/lib/state-store/createStateStore-focused-read.test.ts` — it injects a spy `StateAggregate` that throws if `readAll` or `diffAndCommit` is touched, then asserts each focused accessor still returns correct data. When you add a new focused accessor, extend this test.

### 2. Never run a whole-state mutate for a single-column update

`mutateState`, `mutateSession`, and `mutateConversation` are general-purpose: they hydrate the entire state, run the user-provided mutator on the in-memory copy, canonicalize siblings, and `diffAndCommit` the whole tree. For a single-column update (e.g. setting a draft prompt, toggling a flag) the cost is *the same* as a structural change — which means a per-keystroke endpoint blocks the event loop for seconds.

For frequent single-column updates, add a focused repo-level setter that runs a narrow SQL `UPDATE` inside `writeQueue.withWriteQueue`, and expose it on the state store. Examples already in the codebase:

- `repos.conversations.setPendingPromptText(...)` + `state-store.setConversationPendingPromptText(...)`
- `repos.projects.setArchived(...)` + `state-store.setProjectArchived(...)`
- `repos.projects.setPinned(...)` + `state-store.setProjectPinned(...)`
- `repos.sessions.setArchived(...)`, `setTddEnabled(...)`, `setFinished(...)`

Heuristic: if the only field you're touching is a single column on a single row, write a focused setter. If a focused setter doesn't exist yet, add one rather than reaching for `mutate*`.

### 3. Cache Zod-parsed rows; invalidate via a monotonic version counter

Zod parsing dominates the cost of `findAll` for any repo with non-trivial row counts. Even after a focused-accessor migration, anything that *does* enumerate rows (e.g. the aggregate's `readAll`, an `accessor=findAll` query) pays a per-row parse cost.

The conversations repo demonstrates the pattern (`src/lib/state-store/conversations-repo.ts`):

1. Keep a per-row cache `Map<id, { rawRow, parsed }>` and a `findAllCache.lastFindAllVersion` snapshot.
2. Maintain a monotonic `cacheVersion` counter; **every mutator (`upsert`, `delete`, `setPendingPromptText` when `info.changes > 0`, etc.) bumps it**.
3. In `findAll`, short-circuit when `cacheVersion === lastFindAllVersion` and return the cached array verbatim (same reference).
4. On a cache miss, fetch raw rows, and for each row compare the raw column object against the cached one; reuse the parsed result if unchanged, otherwise re-parse and update the cache.
5. Prune cache entries whose ids are no longer present.

If you add a new repo with a frequently-iterated `findAll`, replicate this structure. If you add a new mutator to an existing cached repo, **you MUST bump `cacheVersion`** in that mutator — a missed bump silently serves stale data. The conversations-repo contract test pins reference equality across calls to catch regressions (`expect(second).toBe(first)`).

### 4. Beware event-loop starvation cascades

CC runs on a single Node event loop. Any synchronous CPU spike — a big Zod parse, a structuredClone of a large state tree, a tight loop — blocks every other in-flight request. We've seen unrelated routes log multi-second durations during a typing burst because the keystroke handler was eating the loop.

Implications:

- Patterns 1–3 above are not micro-optimizations; they prevent cross-request starvation.
- When investigating "why is route X slow", check whether a different route was simultaneously holding the loop. The `state.mutate.complete` and `state.read.timing` log events with their `totalMs` and per-accessor labels are the primary diagnostic.
- Long-running work (>50 ms of CPU) should be split, batched, or pushed off the request path.

### 5. Don't add comments documenting the optimization

Per CLAUDE.md's comment rules, do not annotate fixes with comments like "now uses focused accessor" or "avoid full state read". The current state of the code is self-documenting; the historical context belongs here in this log.

### 6. Keep high-frequency React state local to the subtree that consumes it

When a hook owns state that updates at high frequency (scroll position, mouse coords, virtualized range, drag offset, etc.), the component that calls the hook re-renders on every update. Anything that component constructs in its render — inline object literals, freshly-bound callbacks, derived prop bundles — gets new identities and fans the re-render out to every child that takes those props, even if `React.memo` is in play (a fresh object literal defeats `Object.is`).

Place the hook call as low in the tree as possible — ideally inside a "container" component that wraps only the subtree that actually consumes the state. The parent never sees the update, so its sibling subtrees (top bars, dialogs, modal portals, mobile bottom bars) stay still.

Verification: `src/components/ReactScanInstrumentation.tsx` is mounted in dev via `src/app/layout.tsx` and exposes `window.__reactScanReport` / `window.__reactScanReset`. Use it with `?scan=1` and `playwright-cli --raw eval` to capture before/after render counts per component (see the `react-scan` skill).

Heuristic: if a hook returns state that changes on user interaction *within* a panel, put the hook call inside that panel's container — not above it.

## Resolved issues

Each entry: symptom → root cause → fix → lesson. Add new entries at the top.

### 2026-05-29 — `computeDiff` re-ran `git read-tree`/`add -A`/`diff` on every poll

- **Symptom**: `diff.compute.complete` for `GET /api/projects/[name]/sessions/[session]/diff` measured ~1655 ms exclusive p95 in the daily log report. The route is polled by every open session view; on a typical day three sessions polling at 5 s intervals burn ~2 s of event-loop time *per poll cycle* in pure git work, even when nothing in the worktree changed.
- **Root cause**: `computeDiffImpl` (`src/lib/git/diff.ts`) unconditionally runs `git read-tree HEAD` → `git add -A` → `git diff --cached HEAD --unified=3` against a fresh temp index every call. On a worktree with a large checkout (`node_modules`, `.next`) `git add -A` alone is hundreds of ms. The vast majority of polls land on an unchanged worktree, so the entire pipeline produces output identical to the previous call.
- **Fix**: added a parsed-diff cache keyed on `worktreePath`, invalidated by a cheap two-call token (`git rev-parse HEAD` + sha1 of `git status --porcelain=v1 -z`). On a cache hit, return the previously-parsed `SessionDiff` by reference (so React Query's referential equality short-circuits re-renders); on a miss, run the expensive sequence and store the new entry. Bounded eviction at `DIFF_CACHE_MAX = 100` worktrees. `_resetDiffCacheForTesting` exposes the cache for unit tests, which use the existing `ComputeDiffDeps` injection point — no `vi.mock` on internal modules.
- **Verification**: `bun run test src/lib/git/diff.test.ts` — 17/17 green. Four new behavioural assertions: (1) same reference returned when HEAD + porcelain are unchanged across two calls (only the two token probes hit `execFileAsync` on the second call); (2) new reference + new content when HEAD changes; (3) new reference when working-tree status changes; (4) per-worktree isolation.
- **Lesson**: Pattern 3 (parsed-row cache + cheap monotonic-ish invalidation token) applies just as well to *parsed git output* as it does to Zod-parsed DB rows. Where there's no natural counter, two thin git probes (`rev-parse HEAD` + porcelain hash) are several orders of magnitude cheaper than `read-tree` + `add -A` + `diff` and serve the same role as the conversations-repo `cacheVersion` snapshot. Returning by reference matters: it's not just CPU savings — it lets the client-side React Query layer drop a render.

### 2026-05-29 — `readConversationMessagesWithSeq` re-parsed the full transcript on every poll

- **Symptom**: `transcript.read.complete` for `GET /api/projects/[name]/sessions/[session]/conversations/[id]/messages` measured ~1619 ms p95 in the daily log report, with ~96 polls per active conversation session. The route streams the rendered transcript to the conversation page; with a single long conversation (~700 KB JSONL, ~1500 entries), each poll re-read the file from disk and ran the full JSONL → `TranscriptMessage` parser top-to-bottom.
- **Root cause**: `readConversationMessagesWithSeq` (`src/lib/prompt/transcript.ts`) called `readConversationMessagesWithSeqImpl(transcriptPath)` unconditionally. The impl `readFile`s the whole transcript and walks every line, allocating, parsing JSON, and threading `currentModel`/`currentEffort`. Conversation transcripts are append-only on disk, so the parsed array for an unchanged file is by definition identical to the previous call — but no cache exposed that fact.
- **Fix**: added a parsed-message cache keyed on `transcriptPath`, invalidated by `(stat.mtimeMs, stat.size)`. This mirrors the existing `lastAssistantCache` shape elsewhere in the same module. On a cache hit, return the cached array by reference; on a miss, run the existing impl and store. Bounded eviction at `TRANSCRIPT_READ_CACHE_MAX = 200` paths. `_resetTranscriptReadCacheForTesting` exposes the cache for unit tests. The `timed()` wrapper is unchanged, so `transcript.read.complete` will now show the post-cache duration — cache hits are stat-only (<1 ms).
- **Verification**: `bun run test src/lib/prompt/transcript.test.ts` — 70/70 green. Three new behavioural assertions written first (TDD): (1) same array reference returned for an unchanged file; (2) different reference + correct new content after append; (3) per-path isolation when two transcripts have different content.
- **Lesson**: Pattern 3 again. `mtime` + `size` is a perfectly serviceable monotonic-ish token for append-only files — no need to hash the contents. **Append-only invariant matters**: if any future code path truncates or rewrites a transcript in place, it MUST clear the cache entry for that path or readers will see stale data. Today, `copyTranscriptUpTo` writes to a *different* target, so the invariant holds without explicit invalidation. This is documented in the cache's source comment so the next writer doesn't unknowingly break it.

### 2026-05-28 — Scrolling the workflow event log was paint-bound, not React-bound

- **Symptom**: scrolling `.wb-inspector-body` on `/projects/[name]/[session]/workflow` felt sluggish. Under 4× CPU throttling, 90 programmatic 80px scroll steps measured median 40.8 ms/frame, p95 49.7 ms, max 53.1 ms — **88/90 frames dropped below 30 fps**. Unthrottled was already at the 16.4 ms limit with no headroom.
- **Root cause**: not React. react-scan captured **0 render events** across 7 200 px of scroll — the scroll handler architecture is fine. The cost was pure browser layout/paint: `WorkflowEventLog` (`src/components/workflow-graph/WorkflowEventLog.tsx`) flat-renders the entire `execution.history` (138 `wb-exec-event` rows × ~7 DOM nodes each), producing a 1 013-element, 8 045 px-tall scroll container with no virtualization or layout containment. Every composited frame had to consider all 138 rows.
- **Fix**: applied CSS containment to the row primitive in `src/components/workflow-graph/workflow-graph.css`:
  ```css
  .wb-exec-event {
    content-visibility: auto;
    contain-intrinsic-size: auto 32px;
  }
  ```
  `content-visibility: auto` lets the browser skip layout/paint for rows outside the viewport; `contain-intrinsic-size: auto 32px` provides a placeholder size that gets refined to the row's natural height after first render, preserving scrollbar accuracy. No component refactor, no new dependency.
- **Verification** (same 90-frame programmatic scroll over `.wb-inspector-body`):
  | | Median | p95 | Max | Frames > 33 ms |
  |---|---|---|---|---|
  | Before, 4× CPU | 40.8 ms | 49.7 ms | 53.1 ms | 88 / 90 |
  | After, 4× CPU | **16.8 ms** | **19.5 ms** | **20.9 ms** | **0 / 90** |
  | After, 1× CPU | 16.7 ms | 17.2 ms | 17.7 ms | 0 / 90 |
- **Lesson**: when react-scan shows **0 renders during the interaction**, stop hunting React perf and move to the trace/DOM side — the cost is style/layout/paint over a large undifferentiated tree. For long flat lists of cheap rows, `content-visibility: auto` + `contain-intrinsic-size` is the lowest-cost win: no virtualization library, no component rewrite, and the browser does the windowing. Reach for `react-virtual` only when rows are expensive enough that even off-screen layout work matters, or when DOM-node count itself (memory, accessibility tree, query-selector cost) is the bottleneck.

### 2026-05-27 — Pre-merge validation exhausted RAM (vitest fork fan-out + orphaned workers)

- **Symptom**: smart-merging a branch ran `scripts/pre-merge-validate.sh`; the machine hit the macOS "out of application memory" dialog (~30 GB shown against WezTerm, the terminal hosting CC) and froze. Reported as "the validation script's memory explodes, I suspect vitest."
- **Root cause**: two independent infrastructure issues, neither branch-specific (`vitest.config.ts` was identical to main).
  1. **Uncapped fork fan-out.** Vitest's default `forks` pool spawns one worker per CPU core with no `maxForks` cap and no per-fork heap limit. On a 16-core / 16 GB machine that is ~16 heavyweight Node processes loading the full app module graph + jsdom simultaneously. Measured in isolation each step is modest (eslint 1.3 GB, tsc 1.0 GB, vitest ~4 GB peak summed RSS across 16 forks); the danger is the startup thundering herd landing on top of the already-resident CC dev server + per-session dev servers, tipping a 16 GB box (only 2 GB swap) into swap death. The "30 GB" is the WezTerm process **coalition** (CC + spawned validation + all forks), inflated further by per-process virtual reservation.
  2. **Orphaned workers on timeout.** CC runs the script through `execFile` (`src/lib/projects/repo-config.ts`), whose timeout signals only the direct child (the bash script). The deep tree `bash → npx → node → vitest → N workers` is not in a killed process group, so on timeout the N workers are **orphaned** and keep running. Each retried merge ("keeps happening") stacked another live worker set, compounding pressure into the spiral.
- **Fix**:
  - `vitest.config.ts`: set `pool: "forks"` with `poolOptions.forks.maxForks` scaled to RAM (`floor(totalmem_GB * 0.6 / 2)`, clamped to `[2, cores]` → 4 on a 16 GB box) plus `execArgv: ["--max-old-space-size=2048"]` so a single runaway file OOM-kills its own fork instead of growing unbounded. Verified: peak worker forks dropped from 16–18 to 4; suite still green.
  - Added `execFileGroup` in `src/lib/shared/exec.ts` — spawns `detached` (own process group) and on timeout signals the whole group via `process.kill(-pid, "SIGTERM")` then escalates to `SIGKILL` after a grace period. Output is buffered to 10 MB and **truncated** (not killed) past that, fixing a latent secondary bug where the default 1 MB `execFile` `maxBuffer` would have silently failed a noisy validation. `repo-config.ts`'s validation runner now uses it.
- **Lesson**: test-runner parallelism that scales to core count rather than memory is a latent OOM on high-core/low-RAM machines, and it compounds when the run shares the box with the app under test. Cap worker count by *memory budget*, not cores, and cap per-worker heap. Separately: any timeout that kills a process which fans out into a tree must kill the **process group** (`detached` + `kill(-pid)`), or the descendants orphan and accumulate across retries.

### 2026-05-27 — Scrolling the message panel re-rendered top-bar/dialog components

- **Symptom**: react-scan captured 866 render events during a single scroll flow on the conversation page. `TddToggle`, `VoiceRecordButton`, `ConfirmDialog`, `AgentCapabilitiesModal`, and `ConversationAgentCapabilitiesConfig` each re-rendered 18× on scroll despite living in the top bar / dialog layer with no scroll-dependent state of their own. `BackendToggle` re-rendered 9×.
- **Root cause**: `useSessionPageConversation` (which calls `useConversationNav`, the owner of scroll position via Virtuoso's `rangeChanged`/`atBottom`/`atTop` callbacks) was invoked at the top of `SessionPage`. Every scroll tick → `setNavState` → `SessionPage` re-renders → a fresh inline `args` literal is passed to `SessionPageContent` → `useSessionPageViewProps` rebuilds `topbarProps`, `promptComposerProps`, `dialogsProps`, `mobileBottomBarProps` as new objects → the entire sibling tree (top bar, dialogs, modal portals, mobile bottom bar) re-renders, even though none of them care about scroll.
- **Fix**: extracted `src/features/session/conversation/ConversationPanelContainer.tsx` — a new container that owns the scroll-derived state locally by calling `useSessionPageConversation` itself. `SessionPage` no longer reads `conversation.*` or threads any scroll-derived field through `useSessionPageViewProps`. `use-session-page-view-props.tsx` now passes a `panelContainerProps` bundle through `contentProps`; `SessionContent` renders `<ConversationPanelContainer {...panelContainerProps} promptInputSlot={promptInputSlot} />` instead of `<ConversationPanel ... />` directly. Scroll-triggered re-renders are now scoped to the panel subtree.
- **Verification**: same scroll flow with react-scan after the refactor — total render events dropped from 866 to 182 (-79 %). `TddToggle`, `VoiceRecordButton`, `ConfirmDialog`, `AgentCapabilitiesModal`, `ConversationAgentCapabilitiesConfig`, `BackendToggle` all drop to **0** renders on scroll. Components that legitimately re-render on scroll (virtualized `MessageRow`, `MarkdownCodeRenderer`, the panel itself, `ConversationNav`) still do — they're inside the panel subtree.
- **Lesson**: Pattern 6. A hook owning high-frequency state pulls its calling component into the same update loop. If the calling component sits above the subtree that actually consumes the state, every sibling above the consumer pays the cost — and props rebuilt as inline literals will fan the re-render out even past `React.memo` boundaries. The fix isn't memoization; it's moving the hook call down.

### 2026-05-26 — Bulk session delete: 2N whole-state mutations + serial git worktree removes

- **Symptom**: `POST /api/projects/[name]/sessions/bulk` with `op=delete` for 3 sessions took 27.9 s (trace `b326bd6c`). Breakdown: 3× `exec:git.complete` for `worktree remove --force` totalling ~25.3 s (91 %), plus 6× `state.mutate.complete` totalling ~2.5 s (`aggregate.diff` ~380 ms each).
- **Root cause**: two compounding issues.
  1. `deleteSession` ran the orphan-retarget and the row-removal as two separate `mutateState` calls. Each paid the full `readAll` → `structuredClone` → `diffAndCommit` cost (~430 ms with the diff alone ~380 ms), so every per-session delete doubled the whole-state mutate cost.
  2. The bulk route handler in `src/lib/sessions/route-handlers.ts` looped `for await { await deps.deleteSession(...) }`, so the bookkeeping cost was 2×N for N sessions — there was no batch-aware path.
- **Fix**:
  - Fused retarget + remove into a single `mutateState` labeled `deleteSession` (`src/lib/sessions/service.ts`). `retargetOrphanedChildren` stays as a standalone export because the merge actor still uses it independently.
  - Added `bulkDeleteSessions(projectPath, sessionNames)` that runs per-session side effects (worktree removal, transcript purge, notification/job-record cleanup) and then applies a single `mutateState` labeled `bulkDeleteSessions` that retargets all orphaned children and deletes all successfully-prepared sessions in one pass. The bulk route handler now delegates to it for `op=delete`. State mutations drop from `2N` → `1` per batch.
  - Wrapped `git worktree remove` and its `rm -rf` fallback in `timed(logger, "session.worktree_remove", { ..., cleanup })`. The pre-existing `exec:git.complete` event lumped every git op under one signature, hiding worktree-remove p95 in aggregate reports — the new labeled span is now discriminable in `bun run logs:analyze -- report`.
- **Not fixed (intentionally)**: serial `git worktree remove` calls within a bulk batch. Concurrent invocations against the same parent repository race on `.git/config.lock` (same root cause as claude-code #34645). The real bottleneck is the filesystem `rm` of `node_modules`/`.next` inside each worktree, not git's bookkeeping; if this is a hotspot, the right pattern is parallel `fs.rm(worktreePath, { recursive: true, force: true })` first, then a single serial `git worktree prune` — not parallel `git worktree remove`.
- **Lesson**: Pattern 2. Even when each individual `mutate*` call is justified, callers that loop over them at the route layer multiply the whole-state cost. Bulk routes need a single batched mutation; per-step side effects belong outside of `mutateState`. Pair this with the discipline of giving long-running externals (like `git worktree remove`) a labeled `timed()` span so the report can see them.

### 2026-05-22 — Callers using `readState` where focused accessors would suffice

- **Symptom**: `state.read.timing accessor=readState` p95 = 660 ms, total 7.8 s across 14 calls in 1.5 min. The hot MCP composer path (`src/lib/workflows/conversation/actor-implementations.ts` and `src/lib/mcp/default-deps.ts`) read whole state just to look up one project's `mcpOverrides`.
- **Root cause**: no focused accessor existed for the "project MCP overrides" slice, and rehydration / snapshot restore paths went through `readState` despite only needing one session/conversation.
- **Fix**: added `getProjectMcpOverrides(projectPath)` on the state store. Migrated three MCP `readProjectOverrides` callers, `manager.defaultLoadActorInput` (→ `getSession`), and `persistence.restoreConversationSnapshot` (→ `getConversation`). Remaining `readState` callers are genuinely whole-state (active-conversations, discovery, rehydration, listGlobalRuntimeTargets, etc.).
- **Lesson**: Pattern 1. Before reaching for `readState`, ask whether the slice you actually need has a focused accessor — and if not, add one.

### 2026-05-22 — `conversations.findAll` re-parsed every row on every read

- **Symptom**: `state-store.conversations.findAll.timing` p95 = 589 ms with ~200 rows. Each `readState`/`readAll` cycle paid this cost.
- **Root cause**: per-row JSON-column parse + Zod validation ran on every call with no caching.
- **Fix**: added a per-row cache keyed by raw column comparison plus a monotonic `cacheVersion` bumped by every mutator. `findAll` returns the cached array by reference when no writes have happened (`expect(second).toBe(first)`), and on cache miss reuses parsed rows whose raw columns are unchanged.
- **Lesson**: Pattern 3. Frequently-iterated repos need a parsed-row cache with explicit invalidation. Verified by `src/lib/state-store/conversations-repo.contract.test.ts` (`describe("conversations-repo findAll caching")`).

### 2026-05-22 — Event-loop starvation cascading to unrelated routes

- **Symptom**: `project-resolver.resolve.complete` p95 = 24 s for a function that does two `existsSync` calls. `/commands`, `/agent-capabilities`, `/sessions/[name]` GETs all logged ~13 s during typing bursts.
- **Root cause**: the whole-state mutate hotspot (next entry) held the event loop; every sibling request waited.
- **Fix**: resolved automatically once the mutate hotspot was fixed. Post-fix, the same burst produced `/commands` = 232 ms, `/agent-capabilities` = 32 ms, `/sessions/[name]` = 45 ms.
- **Lesson**: Pattern 4. When investigating slow request X, check whether a different long-running route was holding the loop in the same window. Single Node event loop = one slow handler poisons everything.

### 2026-05-22 — Whole-state mutate for `setConversationPendingPromptText` (CRITICAL)

- **Symptom**: `state.mutate.complete label=setConversationPendingPromptText` p95 = 6 079 ms across 13 calls. Each keystroke into the draft prompt input blocked the event loop ~6 s.
- **Root cause**: `setConversationPendingPromptText` went through `mutateSession`, which ran `aggregate.readAll()` (full Zod parse) → `structuredClone` → second Zod parse → sibling canonicalization → `diffAndCommit` with a third Zod parse and full diff — for a single-column update.
- **Fix**: added `repos.conversations.setPendingPromptText` (narrow SQL UPDATE) and rewrote `state-store.setConversationPendingPromptText` to call it inside `writeQueue.withWriteQueue` without touching the aggregate. Verified on dev server: 10 keystrokes rendered in 10–16 ms each (was 5 300–6 200 ms).
- **Lesson**: Pattern 2. Single-column writes go through focused setters, not the general `mutate*` path. Bonus: this also resolved Issue "event-loop starvation cascade" above.
