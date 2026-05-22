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

## Resolved issues

Each entry: symptom → root cause → fix → lesson. Add new entries at the top.

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
