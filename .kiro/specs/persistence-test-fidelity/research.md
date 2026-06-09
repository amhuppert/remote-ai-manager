# Research & Discovery Log — persistence-test-fidelity

## Discovery Scope

- **Type:** Light discovery (Extension of existing test infrastructure over existing persistence repos).
- **No external dependencies / no new libraries.** Reuses existing primitives: `_createTestDb`/`openStateDb` (state-db.ts), `createStateStore`, Zod schemas, Vitest, dependency injection.

## Key Findings

### Six persistence repositories, two shapes

| Repo | File | Write seam | Read seam | Domain schema | JSON columns |
|---|---|---|---|---|---|
| Conversations | `src/lib/state-store/conversations-repo.ts` | `upsert(projectPath, sessionName, conversation)` | `findById` / `findByKey` | `conversationStateSchema` (`src/lib/conversations/schemas`) | `machine_snapshot`, `pending_questions`, `forked_from`, … via `jsonOrNull`/`parseJsonColumn` |
| Sessions | `src/lib/state-store/sessions-repo.ts` | `upsert(projectPath, session)` | `findByKey` | `sessionStateSchema` (`src/lib/sessions/schemas`) | graph-workflow-execution column (+ legacy migration) |
| Projects | `src/lib/state-store/projects-repo.ts` | `upsert(project)` | `findByRootPath` | `projectRowSchema` (`src/lib/projects/schemas`) | mcpOverrides / agentCapabilityOverrides via `stableStringify` |
| Reference documents | `src/lib/state-store/reference-documents-repo.ts` | `upsert(projectPath, sessionName, doc)` | `findById` | `referenceDocumentSchema` (`src/lib/reference-documents/schemas`) | none |
| Notifications | `src/lib/notifications/repo.ts` | `createNotification()` (module fn) | `getNotifications()` | `notificationSchema` (`src/lib/notifications/schemas`) | `conflict_files` |
| Background jobs | `src/lib/jobs/repo.ts` | `createJobRecord()` / `updateJobRecord()` (module fns) | list query / `rowToBackgroundJob` | `backgroundJobSchema` (`src/lib/jobs/schemas`) | `conflict_files` |

State-store repos are factory + upsert/findById (symmetric). Notifications/jobs are module-level functions over the `getDb()` singleton (create-then-list). **Implication:** the round-trip harness cannot assume `upsert`/`findById`; it must take `persist(fixture)` and `reload()` closures.

### `createStateStore` exposes the conversation seam
`store.ts` returns `mutateConversation(projectPath, sessionName, conversationId, label, mutate)` and `getConversation(...)`; both route to `repos.conversations` over the injected `db` + write queue. The default consumer deps (`defaultMutateConversation`/`defaultGetConversation`) resolve to this store. **Implication:** the R3 real-store fixture is a thin wrapper over `createStateStore({ db: _createTestDb({inMemory:true}), writeQueue: createWriteQueue() })` plus parent-row seeding — no new persistence code.

### Existing contract-test convention
`*-repo.contract.test.ts` in `src/lib/state-store/`. Setup: `db = _createTestDb({ inMemory: true })`, seed parent rows in FK order (project → session → conversation via an `insertParentSession` helper), `repo = create*Repo(db)`, `afterEach` closes the db. Hand-authored `makeMinimalX`/`makeFullX` fixtures already exist but are not schema-complete.

### Consumer-fake inventory (the migration target is bounded)
~28 files reference `mutateConversation`/`getConversation`. Classified:
- **Round-trip fakes (persistence under test) — ~8–10 files:** apply the mutator to an in-memory object and read the result back. These are the exact pattern that hid the `pendingQueue` bug. Confirmed: `conversations/mark-unread.test.ts`, `conversations/mark-read-route-handlers.test.ts`, `workflows/conversation/persistence.test.ts`, `conversations/ask-user-question-tool.test.ts`. → **migrate to the real-store fixture.**
- **Stub-only (persistence not under test) — ~15–18 files:** `getConversation` returns a fixed input state (e.g. `prompt/route-handlers.test.ts`, `workflow-graph/*`, `mcp/runtime-apply.test.ts`). → **leave on lightweight fakes (R3.4).**
- **Already real-DB (hybrid) — ~2–3:** e.g. `conversations/service.test.ts` builds a real store over `_createTestDb`. → reference as the pattern to follow.

Two injection styles among round-trip fakes: setter (`setPersistenceDeps({...})`) and `deps` parameter object. The fixture must produce a deps object usable by both.

## Synthesis & Decisions

1. **Generic harness parameterized by closures**, not by a repo interface — spans factory repos and module-fn repos uniformly. `assertRoundTripDurability({ schema, buildMaximalFixture, persist, reload, exclusions })`.
2. **Single explicit exclusion map with a reason tag** per repo: `{ key: "not-persisted" | "derived-on-write" }`. Both excluded from deep-equality; both reviewable. Closes two loopholes at once — (a) silencing a dropped field by ignoring it, (b) false positives from write-touched timestamps. The completeness guard requires every schema key to be either compared or present in the exclusion map.
3. **Schema-completeness guard via `schema.shape`**: every top-level key must be present in the maximal fixture and set to a non-default value (compare against `ZodDefault` default where present). A new schema key with no fixture assignment fails the test (R1.4).
4. **R3 fixture = real store over fresh `:memory:` DB** reusing `createStateStore`; expose `{ mutateConversation, getConversation }` plus `seedProject`/`seedSession`/`reset`. Usable by both setter- and deps-style consumers.
5. **Schema-derived reset**: `truncateAllTables(db)` enumerates tables from `sqlite_master` (excluding sqlite internals + schema-version table) so a new table is cleared without a hand-maintained list (R4.3). Primary isolation is still fresh `:memory:` per test (R6.1); truncation serves file-scoped reuse cases.
6. **Test-only, cross-domain helpers** live in `src/lib/shared/testing/` (used by state-store, notifications, jobs, and consumer tests); production code must not import them. Per-repo maximal fixtures + exclusion maps are **colocated** in each repo's contract test (no central fixture dump).

## Risks

- **False positives from non-deterministic/derived fields** (timestamps, generated ids): mitigated by the `derived-on-write` exclusion tag — but the tag must be justified in review, not used to hide real drops.
- **Migration churn** across ~8–10 consumer tests; mitigated by a single reusable fixture and judgment-driven scope (don't touch stub-only tests).
- **Suite runtime**: fresh `:memory:` DB per migrated test adds setup cost; in-memory keeps it small (R6). Watch aggregate suite time after migration.
- **`schema.shape` introspection** assumes top-level `ZodObject`; discriminated-union or wrapped schemas may need a small adapter. Column-drop detection only needs top-level keys; nested drops are still caught by deep-equality within persisted JSON columns.
