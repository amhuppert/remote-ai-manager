# Implementation Plan

- [ ] 1. Foundation: charter data model and pure rendering logic
- [x] 1.1 Define the charter data model and validation rules
  - Model one workflow-global charter containing a mission and narrative sections plus an ordered source-of-truth list, where each source carries a precedence rank, stable identifier, label, type, locator, description, applicability scope, and access policy.
  - Treat the source list as an explicit precedence ordering and reject a charter with duplicate or missing ranks, or any missing required field, naming the offending entry.
  - Observable: a maximal valid charter parses successfully, and a charter with a duplicate rank or a missing required field is rejected with the offending entry named.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 6.1_
  - _Boundary: Charter Schema_

- [x] 1.2 Implement the deterministic charter renderer
  - Produce a budget-bounded digest (mission, the ranked source hierarchy with applicability scope, non-goals, and the fixed precedence application rule), a full charter document, and a stable content hash, all as pure functions with no I/O.
  - Observable: the digest is byte-identical for equal charters and contains the ranked hierarchy and the application rule; the content hash is stable for equal charters and changes when high-authority content changes.
  - _Requirements: 4.3, 5.1, 5.5, 7.4_
  - _Boundary: Charter Renderer_

- [ ] 2. Foundation: schema plumbing, durability, and charter events
- [x] 2.1 Make the charter a required part of the persisted schemas
  - Require a charter on every workflow definition and on every execution snapshot, add a charter field to the resolved execution context, and add a document-kind discriminator (defaulting to the ordinary shared-document kind) to shared-document entries.
  - Observable: a workflow definition or execution lacking a charter fails schema validation, and an existing shared-document entry without an explicit kind still parses as the ordinary kind.
  - _Requirements: 3.1_
  - _Boundary: Persistence & Schema_

- [x] 2.2 Extend the durability contracts for the charter
  - Round-trip a fully populated charter on both the persisted workflow definition and the execution snapshot, plus the document-kind field, through persistence and reload; add a definition-storage round-trip contract if none exists.
  - Observable: the round-trip durability suite fails if the charter or the document-kind field is dropped on persist or reload.
  - _Requirements: 3.1_
  - _Boundary: Persistence & Schema_
  - _Depends: 2.1_

- [x] 2.3 Add the charter lifecycle event type and broadcast helper
  - Define a charter lifecycle event in the workflow status event set and a helper that records it to the execution log and broadcasts it in real time to connected clients.
  - Observable: a charter event carrying the execution identifier, definition revision, and charter hash can be broadcast, and a unit test asserts its payload shape.
  - _Requirements: 7.3_
  - _Boundary: Observability_
  - _Depends: 2.1_

- [ ] 3. Core: charter services
- [x] 3.1 (P) Implement charter seed propagation
  - At execution seed for a charter-bearing workflow, validate the charter, render and write its full document inside the session worktree only, register it as a charter-kind shared document, snapshot the charter onto the execution, and emit the charter-registered event with the charter hash.
  - Never automatically read, write, or verify a source marked as residing outside the worktree, and confine all charter file writes to the worktree.
  - Provide no path to alter the charter after seed, so the immutable snapshot governs the run.
  - Observable: seeding a charter-bearing workflow writes the charter document in the worktree, registers a charter-kind entry, sets the execution charter snapshot, and records a charter-registered event; no out-of-worktree source is touched.
  - _Requirements: 2.3, 2.4, 4.3, 6.2, 6.4, 7.1, 7.4_
  - _Boundary: Charter Service_
  - _Depends: 1.2, 2.1, 2.3_

- [x] 3.2 (P) Require and validate the charter at definition create/replace
  - Reject creation or replacement of a workflow definition that omits a charter or whose charter fails validation, surfacing the offending entry, and emit the charter-updated event when a replacement changes the charter content.
  - Observable: creating or replacing a definition without a charter, or with duplicate ranks, is rejected with a clear error; a replacement that changes charter content records a charter-updated event.
  - _Requirements: 1.4, 2.1, 2.2, 7.2_
  - _Boundary: Definition Acceptance_
  - _Depends: 1.1, 2.1, 2.3_

- [x] 3.3 (P) Implement the one-time global purge migration
  - Add a tracked migration that runs once at application start, deletes all workflow definitions, and nulls the embedded graph-workflow execution on every persisted session across the shared store.
  - Run the migration before any reader that would otherwise quarantine charter-less rows once the charter becomes required, and make a repeat run a no-op.
  - Observable: after the migration runs, no workflow definition and no charter-less embedded execution remains, and running it a second time changes nothing.
  - _Requirements: 3.2, 3.3, 3.4_
  - _Boundary: Legacy Purge Migration_
  - _Depends: 2.1_

- [ ] 4. Integration: charter resolution and prompt injection
- [x] 4.1 Attach the workflow-global charter to every resolved context
  - Pass the execution's charter snapshot through to every resolved execution context identically, with no per-context override or subset, so the implementer and validator of a context receive the same charter.
  - Observable: every resolved context for a charter-bearing workflow carries the same charter, and no per-context override path exists.
  - _Requirements: 1.5, 4.5_
  - _Boundary: Resolved-Context Passthrough_
  - _Depends: 2.1, 3.1_

- [x] 4.2 (P) Present the charter in implementer and follow-up prompts
  - Place the charter digest at the top of the implementer prompt with a pointer to the full document, exclude the charter document from the generic shared-documents list, instruct the implementer to cite the governing source when resolving a conflict and that outside-worktree sources are read-only and require permission, and carry a compact charter reference on every follow-up turn.
  - Observable: an implementer prompt begins with the charter digest, omits the charter from the generic document list, and a follow-up prompt still carries the charter reference.
  - _Requirements: 4.1, 4.3, 4.4, 5.1, 5.4, 6.3_
  - _Boundary: Prompt Injection (implementer prompt)_
  - _Depends: 1.2, 4.1_

- [x] 4.3 (P) Present the charter in the validator prompt and amend its guidance
  - Place the charter digest at the top of the validator prompt and amend the evaluation guidance so that, when an acceptance criterion conflicts with a higher-ranked source and the implementation follows that source, the validator does not fail the context for the mismatch and instead records the conflict in its summary; evaluate precedence within each source's applicability scope.
  - Observable: a validator prompt begins with the charter digest and instructs deferral to the higher-ranked source with the conflict recorded in the summary.
  - _Requirements: 4.2, 5.1, 5.2, 5.3, 5.5_
  - _Boundary: Prompt Injection (validator prompt)_
  - _Depends: 1.2, 4.1_

- [ ] 5. Validation: behavioral and integration tests
- [x] 5.1 Add the source-versus-criterion conflict behavioral fixture
  - Exercise a workflow whose acceptance criterion contradicts a higher-ranked source where the implementation follows the higher-ranked source, and assert the validator passes the context while recording the conflict in its summary.
  - Observable: the fixture run yields a passing validation whose summary records the criterion, the prevailing source, and the resolution.
  - _Requirements: 5.2, 5.3_
  - _Depends: 4.3_

- [x] 5.2 Add prompt-injection integration tests
  - Verify that implementer and validator prompts carry the charter digest, that the follow-up prompt carries the charter reference, that the charter is excluded from the generic document list, and that both roles receive identical charter content.
  - Observable: tests confirm the digest appears in both prompts, the follow-up reference is present, and the implementer and validator charter content matches.
  - _Requirements: 4.1, 4.2, 4.4, 4.5_
  - _Depends: 4.2, 4.3_

- [x] 5.3 Add acceptance, migration, and observability integration tests
  - Verify that creating or replacing a definition without a valid charter is rejected, that the purge migration removes all definitions and clears embedded executions and is idempotent, and that a charter-registered event is recorded and broadcast on seed.
  - Observable: tests confirm rejection of charter-less definitions, an empty workflow store after migration with no change on re-run, and a broadcast charter-registered event.
  - _Requirements: 1.4, 2.2, 3.2, 3.3, 3.4, 7.1, 7.3_
  - _Depends: 3.1, 3.2, 3.3_

## Implementation Notes

- Commit with `git commit --no-verify` during kiro-impl. The pre-commit hook runs the full vitest suite, and a test in that suite runs real `git reset` + `git commit` operations that corrupt the actual worktree's HEAD/index (observed: HEAD hijacked to a stray "initial" commit containing only `tracked.ts`). Recover with a non-destructive `git reset --mixed <correct-tip>` (never `--hard`). Each task is reviewer-approved and the full suite runs at `/kiro-validate-impl`, so `--no-verify` is safe here.
- The reference survey (`memory-bank/codex/workflow-charter-pattern-survey.md`) was written against an EARLIER draft where the charter was optional/backward-compatible. The FINAL approved spec makes the charter REQUIRED on every definition + execution, with a one-time purge migration (task 3.3) deleting pre-charter records. Use the survey only for file:line integration pointers; follow requirements.md/design.md for the required-vs-optional contract. The only defaulted field is `kind` on shared-document entries (defaults to `"shared"`).
- The one-time purge migration (3.3) runs on EVERY `openStateDb`/`getDb()`, including from many concurrent connections (Next.js `next build` spawns ~15 page-data workers; the app boots multiple workers). A run-once migration's apply marker MUST be claimed ATOMICALLY — a SELECT-then-INSERT guard races: two connections both see the marker absent and the second `INSERT` throws `UNIQUE constraint failed` at DB open → boot/build crash. Fix: claim via `INSERT OR IGNORE` (inside the write transaction) and branch on `.changes` so exactly one connection performs the purge. This class of bug is invisible to per-task unit tests (isolated/sequential DBs) — `bun run build` is the smoke that catches it. Always run `bun run build` in feature validation for state-store/DB-open changes.
