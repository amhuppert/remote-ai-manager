# Gap Analysis: State Persistence Optimization

## Analysis Summary

- Phase 1 already validated the central suspicion: `state.json` is the page-load bottleneck. A 17 MB state file with 7 projects, 193 sessions, and 708 conversations turns each focused read into a whole-file `readFile`, `JSON.parse`, legacy guard, and full `managerStateSchema.safeParse`.
- The current persistence API is convenient but coarse. `getSession`, `getProjectSessions`, `getSessionConversations`, `getConversation`, roadmap accessors, reference-document accessors, discovery, startup recovery, and active-conversation panels all route through full-state reads.
- The repository has strong reusable foundations for a replacement: Zod entity schemas, dependency-injected `createStateManager`, focused test patterns, OS-aware config resolution, and an existing `better-sqlite3` WAL singleton in `notification-db.ts`.
- The largest design gaps are not whether SQLite is viable, but how to preserve drop-in mutation semantics, how to model entity tables without duplicating schemas, how to keep reads fast while writes serialize safely, and how to consolidate storage with the existing notification database.
- Scoped logging is a separate but related gap. Current logs are enriched with trace/session fields and written to one global `cc-debug.log`; there is no conversation trace context or per-session/per-conversation log routing yet.

## Document Status

- Spec: `state-persistence-optimization`
- Language: `en`
- Current phase: `requirements-generated`
- Requirements generated: yes
- Requirements approved: no
- Design generated: no
- Tasks generated: no
- Analysis approach: reviewed `spec.json`, `requirements.md`, all steering files, `.kiro/settings/rules/gap-analysis.md`, `memory-bank/focus.md`, `memory-bank/phase-1-findings.md`, current state persistence code, mutex code, SQLite notification store, schemas, logging/tracing, startup recovery, representative API routes, React Query fan-out, and existing tests.
- Note: requirements are still draft. This validation can inform design, but Alex still needs to approve requirements before the normal design phase proceeds.
- Note: a Codex one-shot inventory timed out at the tool boundary. A late transient inventory file was read for useful compatibility notes, then removed because the main gap analysis incorporates the relevant material.

## Current Implementation Assets

### JSON State Manager

- `src/lib/state.ts`
  - `createStateManager(deps)` already provides the dependency-injection seam tests need.
  - `readState()` reads the configured `stateFilePath`, parses JSON, runs the legacy workflow-payload guard, validates the full `managerStateSchema`, and logs `state.read.timing`.
  - `writeState()` writes JSON to a temp file and renames it into place.
  - `mutateState()`, `mutateSession()`, and `mutateConversation()` provide the public mutation API that many call sites depend on.
  - `mutateConversation()` includes domain behavior: it auto-updates both conversation and session `lastActivityAt`.
  - `writeState()` is still exported even though it is deprecated because it bypasses the mutex.
  - Focused read helpers such as `getSession()`, `getProjectSessions()`, `getRoadmapItems()`, and `getReferenceDocuments()` still call `readState()` internally.
  - Raw non-test references in `src/lib` and `src/app/api` include `getSession` 170 times, `mutateSession` 61, `readState` 56, `mutateConversation` 34, `mutateState` 33, `getRoadmapItems` 12, `getReferenceDocuments` 12, and `getProjectSessions` 8.

- `src/lib/state-mutex.ts`
  - Provides FIFO write serialization through a promise-chain mutex.
  - Current reads are not protected by this mutex, which matches the Phase 1 conclusion that read slowdown is not caused by lock contention.

- `src/lib/config.ts`
  - Resolves the OS-aware config directory.
  - Default global config still contains `stateFilePath: <config-dir>/state.json`, which will need to be removed or ignored by the final cutover.

### Existing SQLite Pattern

- `src/lib/notification-db.ts`
  - Uses `better-sqlite3`, `getGlobalSingleton`, WAL mode, `foreign_keys = ON`, `CREATE TABLE IF NOT EXISTS`, explicit row-to-domain mapping, and an in-memory DB helper for tests.
  - Already owns durable notification and job history under `<config-dir>/notifications.db`.
  - Uses `db.transaction()` for stale-job recovery.

- `src/instrumentation.node.ts`
  - Initializes notification DB on startup.
  - Also runs state-backed recovery flows before/around notification initialization, so startup ordering matters for any cutover.

### Schemas and Types

- `src/lib/schemas.ts`
  - `conversationStateSchema`, `sessionStateSchema`, `projectStateSchema`, and `managerStateSchema` are the current canonical shapes.
  - `SessionState` contains nested conversations, graph workflow execution/history, reference documents, workflow envelopes, workflow lanes, and MCP overrides.
  - `ProjectState` contains sessions, roadmap items, and MCP overrides.
  - `Notification` already has a Zod schema, but `notification-db.ts` currently casts row fields instead of validating each read through `notificationSchema`.

- `src/types/index.ts`
  - Re-exports entity types derived from schemas.

### Hot Read Paths

- `src/lib/queries.ts`
  - Session detail pages can fan out into sessions, session detail, diff, conversations, messages, MCP config, tools, debug stats, notifications, and other queries.

- `src/app/api/projects/[name]/sessions/[session]/diff/route.ts`
  - The Phase 1 representative endpoint calls `getSession()` before computing git diff. Measurements show `sessionMs` grows to 666-1779 ms under parallel x6.

- `src/app/api/projects/[name]/sessions/[session]/conversations/route.ts`
  - GET currently calls `getSession()` for existence and then `getSessionConversations()`, causing two full-state reads for one logical list request.

- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/messages/route.ts`
  - GET currently calls `getSession()` and then `getConversation()`, causing two full-state reads before reading the transcript JSONL file.

- `src/lib/active-conversations-route-handlers.ts`
  - Reads the full state and scans all projects, sessions, conversations, workflow executions, and collaboration envelopes. This is a legitimate aggregate read and should remain an explicit aggregate query.

- `src/lib/discovery.ts`
  - Scans the base directory and reads full state to compute project session counts.

### Logging and Tracing

- `src/lib/logging/logger.ts`
  - Writes all structured logs to one configured file, defaulting to `<config-dir>/cc-debug.log`.
  - Enriches entries with AsyncLocalStorage trace fields.

- `src/lib/logging/context.ts`
  - `TraceContext` includes `traceId`, `action`, `projectName`, and `sessionName`.
  - It does not include `conversationId`.

- `src/lib/logging/tracing.ts`
  - Extracts `name` and `session` route params into trace context.
  - It does not extract `conversationId` and does not choose a per-session or per-conversation log file.

- `src/lib/transcript.ts`
  - Keeps conversation transcripts as standalone JSONL files under `<config-dir>/transcripts`.
  - This matches the requirement to keep transcript content out of the structured-state store.

### Existing Measurement Assets

- `memory-bank/phase-1-findings.md`
  - Direct `readState()` averaged 78 ms over 5 runs, with parse and Zod as fixed CPU cost.
  - Parallel x6 HTTP requests pushed `readMs` from about 50 ms baseline to 1627 ms and end-to-end requests to about 2 seconds.
  - Recommends a SQLite-backed spike for conversations or sessions.

- `scripts/profile-state-read.ts`
  - Direct profiler for `readFile`, parse, legacy guard, and Zod phases.

## Requirement-to-Asset Map

| Requirement | Existing assets | Gap type | Gaps and constraints |
| --- | --- | --- | --- |
| 1. Page Load Performance | Phase 1 instrumentation, `state.read.timing`, `diff.timing`, `scripts/profile-state-read.ts`, query hooks, API routes | Partial | The bottleneck is measured, but all focused state reads still read and validate the full state corpus. There are no row/entity accessors backed by indexed storage. Some endpoints perform duplicate full-state reads in a single request. |
| 2. Durability and Consistency | Atomic temp-and-rename JSON writes, `withStateLock`, SQLite transaction precedent in `notification-db.ts` | Partial | JSON atomicity does not translate directly to multi-table persistence. Need transaction boundaries for every mutation, typed rollback behavior, startup recovery rules, and proof that successful mutations are durable before return. |
| 3. Concurrent Access | Promise-chain write mutex, SQLite WAL precedent | Partial | Current writes serialize globally; reads are concurrent but expensive. SQLite can improve read I/O, but `better-sqlite3` calls are synchronous in-process and SQLite writes are still serialized. Design must decide whether one connection is enough, whether to use read/write connections, and how to preserve same-entity arrival order. |
| 4. Schema-First Boundary Validation | `src/lib/schemas.ts`, `z.infer` type exports, existing safeParse in `readState()` | Partial | Validation exists only at whole-state read time. New row mappers must validate each entity on read and before commit. Existing `notification-db.ts` row mapping casts enum/string fields and should be tightened if it becomes part of the single structured store. Typed persistence errors do not yet exist. |
| 5. API Compatibility for Migration | `createStateManager`, `readState`, `mutateState`, `mutateSession`, `mutateConversation`, many DI-friendly tests | Partial | Public signatures can be preserved, but `mutateState(callback)` is arbitrary full-state mutation. Efficient DB writes need specialized entity mutations or a robust diff/writeback adapter. Focused accessors need to be added and then used in hot endpoints without forcing all 300+ call sites to change at once. |
| 6. Operational Inspection and Logging | OS-aware config dir, `notifications.db`, `cc-debug.log`, structured logger, Phase 1 timing logs | Partial | There is no single structured-state artifact yet. Design must decide whether to extend `notifications.db`, rename it to a broader DB, or create a new artifact and migrate notification code. There is no inspection script for the full persistent state. Persistence timing logs need entity type, identifier, operation, and duration, not just whole-state timings. |
| 7. Scoped Logging | AsyncLocalStorage trace context, `withTracing`, `createLogger`, standalone transcripts | Partial | Current logs route to one global file and trace context lacks `conversationId`. Need path policy, routing logic, fallback global log, and request/background propagation rules. Transcript JSONL storage already satisfies the requirement to keep conversation content separate. |
| 8. Fresh-Start Cutover | `state.json` default path, JSON read/write helpers, existing cleanup scripts | Missing | Final cutover still needs to remove runtime dependence on `state.json`, `stateFilePath`, JSON helpers, and legacy whole-file read paths. Requirements explicitly forbid JSON import, dual-read, and dual-write in the final state. Startup must initialize an empty DB when no store exists. |
| 9. Spike-Gated Rollout | Phase 1 findings, `notification-db.ts` template, hot endpoints, measurement harness | Partial | The process requirement is clear, but no SQLite state slice exists yet. The spike temporarily conflicts with final no-dual-path requirements by design; design must define when the spike path is allowed and when it must be removed. Need a repeatable x6 measurement script or documented procedure. |

## Key Gaps and Constraints

### Full-State Mutation Semantics

`mutateState(label, callback)` lets callers mutate a full `ManagerState` object with arbitrary logic. A relational store cannot know what changed unless it either:

- loads the full state, runs the callback, diffs before/after, and writes changed rows in a transaction; or
- keeps `mutateState` as a compatibility adapter while migrating hot paths to focused mutation APIs; or
- rewrites call sites to entity-specific APIs.

The first option preserves compatibility but risks carrying full-state cost into mutations. The second option is more practical for a spike and broad cutover. The third option may be clean long term but conflicts with the drop-in migration requirement if done up front.

`mutateSession()` and `mutateConversation()` are safer adaptation points than raw `mutateState()` because their entity scope is explicit. They still carry domain behavior that must be preserved, especially missing-session errors and `lastActivityAt` updates. The deprecated `writeState()` export is a separate compatibility risk because final fresh-start cutover needs to remove JSON writes without breaking any remaining consumers.

### Nested and Opaque State Shapes

`SessionState` currently embeds conversations, graph workflow execution/history, reference documents, workflow envelopes, workflow lanes, and MCP overrides. Some subfields are structured entities; others are intentionally opaque and validated at their own domain boundary. Design needs a table strategy that does not force all opaque workflow data into hand-written duplicate schemas.

### SQLite Concurrency Reality

SQLite WAL can support readers while a writer exists, but `better-sqlite3` executes synchronously on the Node event loop. Short transactions should be fast enough for local use, but the design should benchmark realistic write traffic before claiming unrelated reads never block. A separate read/write connection strategy or very small `BEGIN IMMEDIATE` transactions may be needed.

Some higher-level workflow stores currently depend on production `mutateSession()` as their serialization boundary. The new store should either preserve that boundary or provide an explicit replacement before moving workflow envelope/lane persistence.

### Store Artifact Consolidation

The requirements call for one structured-state artifact and consolidation with notification/job history. The existing durable artifact is named `notifications.db`. Extending that file is the lowest-friction way to satisfy the requirement without notification migration code, but the name becomes misleading. Renaming to a broader DB is cleaner but introduces a separate notification-history cutover decision.

### Logging Scope

Request tracing has only project and session scope. Conversation routes include `conversationId` in params, but `withTracing()` ignores it. Background jobs and startup have no request context, so scoped logging needs explicit fallback behavior and probably a small routing layer beneath `createLogger`.

## Implementation Options

### Option A: Extend `state.ts` In Place

Replace JSON internals inside `src/lib/state.ts` with SQLite operations while keeping the same exports and adding focused helpers there.

**Pros**

- Minimal import churn for existing consumers.
- Preserves the established `createStateManager(deps)` testing seam.
- Fastest way to keep signatures stable.

**Cons**

- `state.ts` is already broad and would become a large persistence subsystem.
- Harder to test row mapping, transactions, and migrations in isolation.
- In-place `mutateState` emulation risks reintroducing full-state work for writes.
- Less natural fit for consolidating notification tables and inspection tooling.

### Option B: Create a Dedicated Structured-State Store

Add a new persistence domain, for example `src/lib/state-store/`, with DB connection management, schema initialization, row mappers, repositories, transaction helpers, focused accessors, typed errors, and inspection helpers. Keep `src/lib/state.ts` as the compatibility facade.

**Pros**

- Clean boundary for row schemas, transactions, logging, and validation.
- Easier red-green TDD around pure row mappers and repository behavior.
- Lets `state.ts` stay a public API adapter rather than a database implementation.
- Better place to consolidate notification/job tables under one DB module.

**Cons**

- More upfront structure.
- Requires careful adapter design so existing call sites keep compiling.
- Needs startup initialization ordering and notification DB integration work.

### Option C: Hybrid Spike, Then Facade Cutover

Create the dedicated store from Option B, but initially implement one narrow entity slice behind a focused accessor and one hot endpoint. Keep JSON for the rest only during the spike. Re-measure, then either halt or expand the facade until `state.json` can be removed.

**Pros**

- Matches Requirement 9 and the session focus.
- Produces real performance evidence before broad migration.
- Keeps the first implementation small enough for red-green TDD.
- Avoids committing to a full table design before a measured win.
- Gives a clean path to final API compatibility by moving `state.ts` exports onto the new store after the spike.

**Cons**

- Temporarily operates with two persistence paths, which must be explicitly limited to the spike.
- Requires discipline to remove the spike compatibility path before declaring the cutover complete.
- Some duplicate lookup code may exist briefly while the focused accessors mature.

**Recommendation:** Option C, with Option B's module boundary.

## Preferred Design Direction

Use a dedicated SQLite-backed structured-state store and keep `src/lib/state.ts` as the compatibility facade. Start with the smallest hot slice that can prove the read-path win:

1. Add a SQLite store module modelled on `notification-db.ts`, but designed for all structured state rather than only notifications.
2. Implement schema initialization, Zod-validated row mapping, typed persistence errors, and structured timing logs for one slice.
3. Prefer sessions or conversations as the first slice. Conversations are attractive because message routes currently perform duplicate full-state reads before transcript I/O; sessions are attractive because many endpoints call `getSession()` before doing their real work.
4. Wire one representative endpoint to the focused accessor.
5. Re-run parallel x6 measurement against the same corpus and compare to `memory-bank/phase-1-findings.md`.
6. If the spike wins, expand the facade until hot reads stop using `readState()` and then plan the final fresh-start cutover that removes JSON runtime references.

## Effort and Risk

- Effort: `XL`
- Risk: `High`

### Why

- The change touches central persistence, startup recovery, API routes, workflow state, MCP overrides, roadmap items, reference documents, notification history, logging, and tests.
- The public API compatibility requirement is non-trivial because `mutateState()` exposes arbitrary full-state mutation semantics.
- The performance target is strict enough that design needs measured proof, not just a database swap.
- SQLite itself is familiar in this codebase, which reduces technology risk, but the breadth of state and compatibility constraints make the migration high risk.

## Design Phase Recommendations

1. Treat requirements as draft until Alex approves them.
2. Make the spike table design explicit and disposable if measurements do not improve enough.
3. Define the database artifact decision early: extend `notifications.db`, rename to a broader store, or introduce a new artifact with a deliberate notification cutover.
4. Define focused accessors before broad migration. At minimum: project metadata, session by key, sessions for project, conversation by id, conversations for session, active conversation summaries, roadmap items, and reference documents.
5. Preserve `readState()` as a compatibility/export/debug function during migration, but keep hot endpoints off it.
6. Keep all row mapping schema-first: row decode -> domain object -> Zod `safeParse` -> return typed entity.
7. Add typed persistence errors before route wiring so validation and disk/DB failures can be surfaced consistently.
8. Benchmark mutation traffic separately from read traffic, especially active prompt updates and conversation snapshot persistence.
9. Add scoped logging as a distinct design section. It should extend trace context with `conversationId` and route log writes by scope while keeping a global fallback.
10. Do not add JSON import, dual-write, or backward-compatibility migration code for `state.json`.

## Research Needed

- Whether the single artifact should remain `notifications.db` or become a broader DB name.
- Whether `better-sqlite3` with one HMR-safe connection is sufficient for the read/write concurrency requirement, or whether separate read/write connections are needed.
- Exact transaction strategy for `mutateState()` compatibility: full-state diff, compatibility-only fallback, or accelerated call-site migration.
- Table layout for graph workflow execution/history, workflow envelopes, workflow lanes, MCP overrides, and other nested or opaque state.
- Whether aggregate endpoints such as active conversations should query purpose-built summary tables/views or compose from indexed entity tables.
- Inspection script output format and whether it should reconstruct `ManagerState`, dump table summaries, or support both.
- Scoped log path format, retention policy, and whether per-session/per-conversation logs should duplicate entries to the global log or route exclusively.

## Validation Outcome

Gap validation found no evidence that the broad persistence migration should start before a narrow measured spike. The requirements are directionally aligned with the measured bottleneck, but design must resolve the API compatibility, SQLite concurrency, single-artifact, and scoped-logging details before implementation tasks are generated.
