# Research & Design Decisions — state-persistence-optimization

## Summary

- **Feature**: `state-persistence-optimization`
- **Discovery Scope**: Complex Integration (extension to existing persistence + logging subsystems with hard performance/compat constraints)
- **Key Findings**:
  - The Phase 1 measurement (`memory-bank/phase-1-findings.md`) localizes the page-load cost to whole-file `readFile` + `JSON.parse` + Zod re-validation of the 17 MB `state.json` on every read. Under parallel x6 fan-out, `readMs` alone climbs from ~50 ms baseline to ~1.6 s per call.
  - The codebase already contains a production-grade SQLite pattern (`src/lib/notification-db.ts`): `better-sqlite3` with WAL, `getGlobalSingleton` HMR-safe initialization, schema-on-first-use, explicit row-to-domain mappers, and a `db.transaction()` boundary for multi-statement integrity.
  - `mutateState(label, callback)` is the most awkward API to preserve: callers receive a mutable `ManagerState` object and apply arbitrary mutations. Three viable strategies were surfaced in `gap-analysis.md`; the load-callback-diff-write strategy is the only one that preserves R5.1 without a large up-front rewrite of ~344 call sites.
  - `withStateLock` (FIFO promise mutex) protects writes only; reads run unguarded today, so the existing concurrency contract is preserved by an SQLite cutover that uses an analogous async write queue.
  - `TraceContext` currently lacks `conversationId`, and the logger writes to a single global `cc-debug.log`. R7 (scoped logging) requires both a context extension and a routing layer beneath `createLogger`.

## Research Log

### `synchronous` pragma — `FULL` vs `NORMAL` for the consolidated DB

- **Context**: Today's `notification-db.ts` uses `synchronous = NORMAL`. Requirement 2.1 demands "durable on disk before returning to the caller" for state mutations. Need to confirm which setting actually satisfies that.
- **Sources Consulted**: SQLite `pragma synchronous` docs, WAL-mode durability semantics, in-tree `notification-db.ts` configuration.
- **Findings**:
  - Under WAL mode + `synchronous = NORMAL`, an `fsync` is issued at WAL checkpoint time, **not** at every commit. A power-loss event between commit and the next checkpoint can roll the WAL back, losing transactions that have already returned success to the caller.
  - Under `synchronous = FULL`, every transaction commit issues an `fsync` before returning. Acknowledged commits survive power loss.
  - The cost is one extra `fsync` per write transaction. On modern SSDs this is tens of microseconds at most; in this app, every write is already serialized through the JS write-queue tick, which dominates the marginal disk cost.
  - The previous `notification-db.ts` choice of `NORMAL` was acceptable in isolation because notification history is non-critical and ephemeral. Once the same DB hosts session/conversation state, R2.1 governs.
- **Implications**: `state-db.ts` opens the connection with `synchronous = FULL`. The consolidation task therefore tightens durability for notification rows as a side-effect, which is acceptable. No new code path is needed; only the pragma value changes.

### `better-sqlite3` concurrency under the Node event loop

- **Context**: R3.2 originally claimed reads continue "without blocking on the write." Need to confirm what `better-sqlite3` actually guarantees in-process, on a single connection.
- **Sources Consulted**: `src/lib/notification-db.ts` (existing in-tree pattern), `gap-analysis.md` Section "SQLite Concurrency Reality", official `better-sqlite3` docs (synchronous API surface).
- **Findings**:
  - `better-sqlite3` exposes a synchronous API. Each `prepare().get/all/run` runs to completion on the JS thread.
  - In WAL mode, SQLite supports concurrent readers across processes/connections, but a single Node process with a single connection serializes all SQL on the event loop.
  - A write transaction (`BEGIN IMMEDIATE`) holds the writer slot until commit; concurrent reads in the same connection queue behind it.
  - For a single-user local app, transaction durations are short (single-row writes ≪ 1 ms), so event-loop queuing cost is bounded.
- **Implications**: R3.2 was relaxed to acknowledge transient queuing; the write-queue boundary lives in JS (`withWriteQueue`), and the SQLite transaction inside it stays synchronous and minimal. No multi-connection read/write split is required for the targeted load.

### Storage artifact consolidation strategy

- **Context**: R6.1/R6.2 require a single structured-state artifact, consolidated with the existing notification/job history store (`notifications.db`).
- **Sources Consulted**: `src/lib/notification-db.ts`, `src/instrumentation.node.ts` (startup ordering), gap-analysis.md "Store Artifact Consolidation".
- **Findings**:
  - Extending `notifications.db` keeps the file but the name becomes misleading.
  - Renaming to `command-center.db` is cleaner but requires an explicit notification cutover (acceptable per fresh-start policy: notification history is non-critical and ephemeral).
  - `getGlobalSingleton(GLOBAL_KEY, factory)` already abstracts DB construction; the same singleton can host `notifications`, `job_records`, and the new state tables.
- **Implications**: Final artifact is `command-center.db` opened by a unified `state-db.ts` singleton; `notification-db.ts` is refactored to consume that singleton. No data migration code; existing `notifications.db` is discarded at cutover.

### `mutateState(callback)` compatibility strategies

- **Context**: ~33 call sites of `mutateState` and ~62 call sites combined for `mutateSession`/`mutateConversation` exercise arbitrary in-memory mutation. R5.1 demands signature preservation and observable post-mutation state parity.
- **Sources Consulted**: `src/lib/state.ts` lines 195–278, gap-analysis.md "Full-State Mutation Semantics".
- **Findings**:
  - Option 1 (load full state → run callback → diff → write changed rows) preserves R5.1 with no call-site changes; cost is ~one full-state read per write (acceptable: writes are not the user-visible bottleneck).
  - Option 2 (compatibility adapter while migrating hot paths) is what we'd practically end up doing anyway.
  - Option 3 (rewrite all call sites to entity-specific APIs) violates the drop-in requirement.
- **Implications**: `mutateState` keeps the same signature; internally it loads the full `ManagerState` (via the same accessors `readState()` uses), runs the callback, diffs against pre-callback snapshot at the entity level, and writes changed entities in one transaction. `mutateSession` and `mutateConversation` get fast paths that load only the affected entity.

### Spike entity selection: sessions vs conversations

- **Context**: R9.1 requires routing exactly one entity slice through the new persistence layer first.
- **Sources Consulted**: gap-analysis.md endpoint inventory, Phase 1 measurement endpoints (`/diff`, `/conversations`, `/messages`).
- **Findings**:
  - `getSession()` is invoked 170 times across `src/lib` and `src/app/api`; many endpoints call it before doing real work, so a fast `getSession()` removes the largest fraction of `state.read.timing` cost from hot paths.
  - Conversations are larger but are typically read inside the same handler that already called `getSession()`; migrating sessions first gives the cleanest re-measurement signal.
- **Implications**: Spike slice = `sessions` table. `getSession()` and `getProjectSessions()` route through SQLite while everything else continues against `state.json`. Re-measure parallel x6 against the same harness used for Phase 1.

### Scoped logging path policy

- **Context**: R7 requires per-session and per-conversation log files with a global fallback.
- **Sources Consulted**: `src/lib/logging/logger.ts`, `src/lib/logging/context.ts`, `src/lib/logging/tracing.ts`.
- **Findings**:
  - `logger.ts` resolves the log file path once at first use and reuses it. Routing must be re-evaluated per call.
  - `TraceContext` carries `traceId`, `action`, `projectName`, `sessionName` but no `conversationId`. Conversation routes encode the id in route params and would need extraction in `withTracing`.
  - `appendFileSync` is fast for small lines but opens/closes the FD per call. Per-scope log files inherit that cost — acceptable for local app volumes.
- **Implications**: Extend `TraceContext` with `conversationId`; `withTracing` extracts it; `logger.ts` selects the destination at log time using the active context. Path layout: `<config-dir>/logs/global.log`, `<config-dir>/logs/sessions/<projectSlug>__<sessionName>.log`, `<config-dir>/logs/conversations/<conversationId>.log`. Each entry routes to exactly one file; a `request.start`/`request.complete` summary line is mirrored to the global log so operators retain a chronological cross-session view.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Repository + Facade | Per-entity repositories backed by SQLite; `state.ts` becomes a thin facade preserving the public API | Clean test seam; entity-scoped logging and validation; minimal call-site churn | Two layers to navigate during migration | Selected |
| In-place SQLite swap inside `state.ts` | Replace JSON internals; keep file as one large module | Smallest diff at first | `state.ts` becomes a 1000+ line persistence subsystem; harder to unit-test row mappers | Rejected — gap-analysis.md Option A |
| Entity-API rewrite | Replace `mutateState` with focused mutators in all call sites up front | Cleanest end state | Violates R5 drop-in requirement; sprawling change | Rejected |
| Multi-connection read/write split | Separate read and write `Database` handles | Theoretical concurrency | Not how `better-sqlite3` is used in-tree; no measured need for the targeted load | Deferred — revisit only if Phase D measurements show tail latency from queuing |

## Design Decisions

### Decision: Repository + Facade with `state-store/` module

- **Context**: Preserve `state.ts` public API while moving persistence into a structured, testable subsystem.
- **Alternatives Considered**:
  1. In-place rewrite of `state.ts` internals (rejected — module bloat, harder TDD).
  2. Entity-API rewrite across call sites (rejected — violates R5).
- **Selected Approach**: Introduce `src/lib/state-store/` containing `state-db.ts` (singleton + schema), repositories per entity (`projects-repo.ts`, `sessions-repo.ts`, etc.), `write-queue.ts`, and `state-store.ts` (facade composition). `src/lib/state.ts` becomes a thin compatibility adapter that wires the existing exported names to the new store.
- **Rationale**: Aligns with the codebase's existing `notification-db.ts` shape and `createStateManager(deps)` DI pattern. Each repository is independently testable against an in-memory DB.
- **Trade-offs**: One additional directory of indirection vs a much cleaner test surface and migration path.
- **Follow-up**: Verify that `createStateManager(deps)` continues to compose with the new store and that focused test suites do not need to mock SQLite.

### Decision: Single `command-center.db` artifact, consolidating notifications

- **Context**: R6.1 + R6.2 require a single structured-state artifact and consolidation with `notifications.db`.
- **Alternatives Considered**:
  1. Extend `notifications.db` in place (file name misleading).
  2. New artifact + leave `notifications.db` alone (R6.2 violation).
- **Selected Approach**: Open `command-center.db` from a unified `state-db.ts`. Refactor `notification-db.ts` exports to consume the same singleton. Drop runtime references to `notifications.db`.
- **Rationale**: Inspection requirements + steering's "OS-aware config dir" + the fresh-start policy (no migration code; existing local files discardable) make a clean rename trivial.
- **Trade-offs**: One-time refactor of `notification-db.ts`; no production data loss because notifications are ephemeral.
- **Follow-up**: Confirm the startup sequence in `src/instrumentation.node.ts` still initializes notification recovery before SSE broadcast.

### Decision: `mutateState` preserved via load-callback-diff-write

- **Context**: Preserve R5.1 without a sprawling call-site refactor.
- **Alternatives Considered**:
  1. Compatibility adapter that lazily delegates only to migrated entity APIs (incomplete — leaves cold paths broken).
  2. Up-front rewrite of all `mutateState` call sites (rejected — R5).
- **Selected Approach**: `mutateState` loads the full `ManagerState` from SQLite, runs the callback, diffs entities against the pre-callback snapshot, validates each changed entity through its Zod schema, and writes changed rows in a single transaction.
- **Rationale**: Preserves observable post-mutation state. Cost is bounded by full-state read time, which is identical to today's `mutateState` cost on the read side.
- **Trade-offs**: Writes pay one full-state read each. Mitigation: log `state.mutate_state.full_diff` events with timing so cost is visible; encourage migration of hot mutation paths to focused mutators.
- **Follow-up**: Add a mutation-rate measurement during the spike to confirm write traffic isn't a hidden bottleneck.

### Decision: Spike slice = sessions table

- **Context**: R9.1 requires a single-slice spike before broader migration.
- **Alternatives Considered**:
  1. Conversations slice (larger payloads, but downstream of `getSession()`).
  2. Roadmap items (low traffic, weak signal).
- **Selected Approach**: Migrate `sessions` only. `getSession`/`getProjectSessions` read from SQLite; everything else stays on `state.json`. All write paths still go through `state.json` during the spike.
- **Rationale**: `getSession()` is invoked 170 times and gates many handlers; the strongest signal per unit of code change.
- **Trade-offs**: Temporarily, sessions writes go through `state.json` and reads through SQLite — fine because writes are not on the page-load hot path. The dual-path window must be removed before declaring cutover (R9 introduction).
- **Follow-up**: Re-run parallel x6 measurement against the production fixture and document results in `memory-bank/phase-2-spike-results.md`.

### Decision: JSON-text columns for opaque nested state

- **Context**: `SessionState` embeds graph workflow execution/history, workflow lanes, MCP overrides — large, infrequently-queried, schema-validated by their own boundaries.
- **Alternatives Considered**:
  1. Fully normalize all nested types into tables (rejected — duplicates schemas, sprawling table count).
  2. Single JSON blob per session row (rejected — defeats indexed entity reads).
- **Selected Approach**: First-class columns for fields that are queried across rows or used in projections (`session_name`, `last_activity_at`, `archived`, `finished`, `tdd_enabled`, etc.). JSON text columns for opaque sub-trees (`graph_workflow_execution`, `workflow_lanes`, `mcp_overrides`); each column validated via its existing Zod schema on read/write.
- **Rationale**: Balances normalization (cross-session aggregate queries on hot fields) with YAGNI (don't model what we never query relationally).
- **Trade-offs**: Aggregate queries that touch JSON columns can't be indexed. Acceptable: those endpoints (e.g. active-conversations aggregate) read all sessions anyway.
- **Follow-up**: Promote a JSON column to a real table only when a future feature needs cross-row queries against it.

### Decision: Scoped logging via per-call route resolution

- **Context**: R7 demands per-session/per-conversation log files with a global fallback.
- **Alternatives Considered**:
  1. One log file with a `scope` field, queried via `jq` (rejected — R7 explicitly requires file separation).
  2. Per-scope logger instances captured in closures (rejected — `createLogger("module")` is module-scoped, not request-scoped).
- **Selected Approach**: Extend `TraceContext` with `conversationId`. Inside `writeEntry`, resolve destination path from the active context: per-conversation > per-session > global. Mirror `request.start`/`request.complete` lines from `withTracing` into the global log so chronological cross-session debugging stays possible.
- **Rationale**: Routing happens at write time rather than logger construction, so existing `createLogger("module")` call sites stay unchanged.
- **Trade-offs**: Slightly higher per-log overhead (one resolveDestPath call). Negligible at single-user volumes.
- **Follow-up**: Add a `CC_LOG_SCOPED=0` escape hatch for users who prefer the old single-file behavior during local debugging.

## Risks & Mitigations

- **Spike does not deliver win** — Halt per R9.3. Phase 2 stops; revisit design (e.g. precomputed per-entity caches in memory before re-trying SQLite).
- **`mutateState` diff path becomes a write-side bottleneck** — Detect via `state.mutate_state.full_diff.timing` logs; migrate top mutation call sites to focused mutators if needed.
- **Notification consolidation breaks startup ordering** — Mitigated by keeping the public exports of `notification-db.ts` stable; only the internal singleton source changes. Verified by existing notification tests + a new startup integration test.
- **Scoped log routing leaks across requests under HMR** — `getTraceContext()` already uses ALS, which is request-scoped; HMR rebuilds re-import the logger module but ALS context is request-scoped not module-scoped.
- **Schema drift between Zod and SQLite** — Each repository validates rows via the canonical Zod schema before returning. A regression test harness compares a known fixture round-tripped through the store.

## References

- `memory-bank/phase-1-findings.md` — measured baseline, parallel-x6 numbers, recommended Phase 2 approach.
- `memory-bank/focus.md` — session objective, scope decisions, "spike first" methodology.
- `.kiro/specs/state-persistence-optimization/gap-analysis.md` — full inventory of existing assets and gaps.
- `src/lib/notification-db.ts` — SQLite reference pattern (WAL, singleton, row mappers, transactions).
- `src/lib/state.ts` — current public API to preserve.
- `src/lib/state-mutex.ts` — current FIFO write-mutex contract (`withStateLock`).
- `src/lib/schemas.ts` — Zod source of truth for all persisted entities (2337 lines).
- `src/lib/logging/{context,logger,tracing}.ts` — existing trace/log machinery to extend.
- [better-sqlite3 README](https://github.com/WiseLibs/better-sqlite3) — synchronous API, WAL configuration.
