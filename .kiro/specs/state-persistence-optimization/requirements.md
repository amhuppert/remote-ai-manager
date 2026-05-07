# Requirements Document

## Project Description (Input)
state-persistence-optimization

## Introduction

Command Center currently persists nearly all application state in a single ~17 MB `state.json` file (7 projects, 193 sessions, 708 conversations on the reference machine). Phase 1 measurements (`memory-bank/phase-1-findings.md`) identified the file as the dominant page-load cost: under typical 5–6 parallel API fan-out, `readFile` time alone climbs from ~50 ms to 1.6 s per call, and the fixed CPU floor of `JSON.parse` + Zod re-validation adds ~120 ms to every read regardless of load.

This feature replaces the JSON-file persistence layer with a per-entity persistence mechanism (the design phase will commit to SQLite; this phase only fixes the *behavior* the new layer must exhibit). The replacement must eliminate the parallel-read regression, preserve the schema-first discipline (Zod schemas remain the source of truth, types derived via `z.infer`), keep the public state-access API drop-in compatible across the existing ~344 call sites, and require no migration UX (existing local `state.json` contents may be discarded). Transcripts remain as standalone JSONL files; only structured state moves to the new layer.

## Requirements

### Requirement 1: Page Load Performance
**Objective:** As a developer using Command Center locally, I want pages to load near-instantly even when they fan out into multiple parallel API calls, so that navigating between projects, sessions, and conversations does not block on persistence I/O.

#### Acceptance Criteria
1. When the client issues 6 concurrent state-read API requests against a state corpus equivalent to the current production fixture (≥7 projects, ≥190 sessions, ≥700 conversations), the Command Center backend shall serve each request with a per-request `state.read.timing.totalMs` of less than 50 ms at p95.
2. When the client issues a state-read API request scoped to a single entity (one session, one conversation, or one project), the Command Center backend shall not read or deserialize data belonging to other entities of the same type as part of that request.
3. The Command Center backend shall not re-validate the full persisted state corpus through Zod on each read; validation cost shall be bounded to the entities actually returned.
4. While serving concurrent read requests, the Command Center backend shall not exhibit per-request file-I/O time that grows monotonically with the number of in-flight requests.

### Requirement 2: Durability and Consistency
**Objective:** As a Command Center user, I want every state change to be durably persisted and consistently readable, so that I never lose work and never observe a partial write across an application restart.

#### Acceptance Criteria
1. When a state mutation completes successfully, the Command Center backend shall guarantee the change is durable on disk before returning to the caller.
2. When the application restarts, the Command Center backend shall recover the exact state corresponding to the most recent successful mutation.
3. If a mutation fails midway (process crash, disk error, validation error), the Command Center backend shall leave the persistent store in a state equivalent to the last successful mutation, with no partial entity writes visible to subsequent reads.
4. While the application is running, the Command Center backend shall serve reads that reflect every previously-completed mutation issued from the same process.

### Requirement 3: Concurrent Access
**Objective:** As a developer, I want concurrent reads and writes to behave predictably under load, so that no update is silently lost and unrelated read traffic is not serialized behind writes.

#### Acceptance Criteria
1. When two mutations targeting the same entity arrive concurrently, the Command Center backend shall apply them in arrival order with no lost updates.
2. While a write transaction is in progress, the Command Center backend shall not hold a long-lived application-level lock that blocks unrelated reads beyond the duration of the in-flight transaction itself. Reads arriving during a write shall complete within the latency target defined in Requirement 1, inclusive of any time spent waiting for the in-flight write transaction to commit.
3. When multiple read requests arrive in parallel, the Command Center backend shall not place them behind a single global read lock that serializes them with respect to each other.
4. The Command Center backend shall preserve at least the same write-serialization guarantees as the current `withStateLock`-based implementation.

### Requirement 4: Schema-First Boundary Validation
**Objective:** As a developer maintaining the codebase, I want every persisted value to be validated against its Zod schema at the persistence boundary, so that the store cannot drift from the canonical entity shapes.

This requirement governs every entity that lives inside the consolidated structured-state store, including the notification and background-job rows brought into the same store under Requirement 6.2. Today's `notification-db.ts` casts row fields rather than running its Zod schemas; bringing those rows under a single store also brings them inside this requirement's envelope.

#### Acceptance Criteria
1. When a row is read from persistent storage, the Command Center backend shall validate it against the corresponding Zod schema in `src/lib/schemas.ts` before returning it to callers.
2. When a value is written to persistent storage, the Command Center backend shall validate it against the corresponding Zod schema before commit.
3. If a read or write validation fails, the Command Center backend shall log a structured event including the entity type and identifier and shall surface a typed error to the caller.
4. The Command Center backend shall derive all persisted-entity TypeScript types via `z.infer` from the schemas in `src/lib/schemas.ts` and shall not introduce hand-written duplicates.
5. Acceptance Criteria 1–4 shall apply uniformly to entities native to the new structured-state store (projects, sessions, conversations, roadmap items, reference documents) and to notification and background-job rows once they are consolidated into the same store under Requirement 6.2.

### Requirement 5: API Compatibility for Migration
**Objective:** As a developer migrating ~344 existing call sites, I want the public state-access API to remain drop-in compatible, so that the cutover does not require sprawling refactors across `src/lib/` and `src/app/api/`.

#### Acceptance Criteria
1. The Command Center backend shall preserve the public function signatures of `readState`, `mutateState`, `mutateSession`, and `mutateConversation` such that existing call sites compile without source modification and observable post-mutation state matches the current implementation.
2. Where a caller needs only a single entity (one session, one conversation, one project), the Command Center backend shall expose a focused accessor that returns just that entity without forcing a whole-state read.
3. The Command Center backend shall expose persistence access through a dependency-injected factory so that tests can construct an isolated instance against a temporary directory without using `vi.mock()` on internal modules.
4. The Command Center backend shall not require call sites to manage transactions, connections, or schema migrations explicitly.

### Requirement 6: Operational Inspection and Logging
**Objective:** As a developer or operator debugging the running system, I want to inspect persistent state without running the full app and to see structured timing data for every persistence operation, so that I can diagnose performance and correctness issues directly.

#### Acceptance Criteria
1. The Command Center backend shall persist all structured application state to a single store artifact under the existing OS-aware config directory.
2. The Command Center backend shall consolidate the new structured-state store with the existing notification/job history store so that operators have one persistent artifact to inspect, rather than several. Once consolidated, notification and background-job rows fall inside the boundary defined by Requirement 4, and read/write paths for those rows shall validate them through their canonical Zod schemas in `src/lib/schemas.ts`.
3. When invoked via a dedicated inspection script, the Command Center shall produce a human-readable dump of the current persistent state suitable for debugging.
4. When a read or mutation completes, the Command Center backend shall emit a structured log event via `createLogger` containing the entity type, identifier, operation name, and a duration measurement.

### Requirement 7: Scoped Logging
**Objective:** As a developer monitoring a specific session or conversation, I want logs to be scoped to that context, so that I can isolate signal without scanning a global log file containing every session.

#### Acceptance Criteria
1. While processing a request whose trace context identifies a session, the Command Center backend shall route log entries originating during that request to a per-session log file.
2. While processing a request whose trace context identifies a conversation, the Command Center backend shall route log entries originating during that request to a per-conversation log file.
3. When log context is unavailable (background jobs, application boot, requests without session/conversation scope), the Command Center backend shall route entries to a global fallback log.
4. The Command Center backend shall continue to write Claude Code transcripts to standalone JSONL files under the existing transcript directory layout and shall not move transcript content into the new persistence layer.

### Requirement 8: Fresh-Start Cutover
**Objective:** As the project owner accepting the local-single-user tradeoff, I want the cutover to ship without migration code, so that the implementation stays minimal and the new persistence path has no legacy coupling.

#### Acceptance Criteria
1. The Command Center shall not include code that reads from `state.json` and writes to the new persistence layer.
2. The Command Center shall not include any dual-read or dual-write path that targets `state.json` and the new layer simultaneously.
3. When the application starts and the new persistent store does not yet exist, the Command Center backend shall initialize an empty store with the required schema and proceed without error.
4. Once the cutover is complete, the Command Center codebase shall contain no runtime references to `state.json` or its read/write helpers.

### Requirement 9: Post-Cutover Re-Measurement
**Objective:** As the project owner, I want a recorded post-cutover re-measurement comparing the new persistence layer to the Phase 1 baseline, so that the page-load improvement is observable and any future regression is diagnosable against a known number.

The migration is **not** gated on the re-measurement outcome. Phase 1 measurements already justify moving structured state to SQLite; the cutover ships in a single PR (no per-phase gate, no dual-storage window). Correctness regressions surfacing post-merge are handled by standard PR-revert against the cutover commit.

#### Acceptance Criteria
1. Once the cutover lands, the Command Center shall produce a re-measurement document (`memory-bank/cutover-results.md`) capturing parallel-x6 `state.read.timing` and end-to-end request timings, and comparing them to the Phase 1 baseline in `memory-bank/phase-1-findings.md`. The document is produced for observability; it is not used as a gate.
