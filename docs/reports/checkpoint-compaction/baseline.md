# Checkpoint compaction — P1 validation and seam baseline

Captured before any feature edit for the `cc-checkpoint-compaction` delivery lane, so
later contexts can separate workflow-introduced regressions from failures the lane
already carried.

## Lane starting revision

| Field | Value |
|---|---|
| Branch | `csm/compaction-f29f1a-checkpoint-delivery` |
| Revision | `154e8a46422d60d6acc54814d44e8f589543a456` |
| Committed | 2026-09-07 00:44:03 -0400 |
| Subject | `Merge branch 'csm/cc-validators-spike-8ad04c'` |
| Working tree | clean (`git status --short` empty) |

This matches the delivery contract's verified-premises HEAD.

## Settled registered validation

All runs used `cctl validate run <name> --queue-if-busy --json` from the lane worktree.

| Command | Scope requested → effective | Verdict | Run ID |
|---|---|---|---|
| `typecheck` | changed → full | passed | `vrun-eb9e4538-806a-41cd-b154-61ddfbf7b4b3` |
| `seams` | changed → full | passed | `vrun-1b82a3ee-23a2-4f07-931a-ac02c0276afd` |
| `lint` | changed (native) | passed | `vrun-2507a173-b2ab-4961-a070-3bfa23b07741` |
| `lint` | full | passed | `vrun-ee487839-fb60-4e2f-9fef-158a483b80d9` |
| `test` | full | **failed (exit 1)** | `vrun-292c4e94-2e6d-4e95-b18a-ca67456e017a` |
| `test` | paths (the two failing files) | passed | `vrun-45b654c8-54b8-45dc-a82b-016d52863f33` |

The clean tree makes a changed-scope run vacuous, so `lint` was also run at full scope;
`typecheck` and `seams` fall back to full on their own.

### Full-suite totals

`Test Files 2 failed | 1927 passed | 3 skipped (1932)` ·
`Tests 1 failed | 28661 passed | 12 skipped (28674)` · duration 2322.79s.

## Known baseline failures

Both failures are timeouts in `scripts/` tests that shell out to real git repositories and
wrapper scripts. Neither touches checkpoint, conversation, or state-store code.

### 1. `scripts/pre-merge-hermetic.test.ts` — suite-level hook timeout

```
Error: Hook timed out in 10000ms.
 ❯ scripts/pre-merge-hermetic.test.ts:73:1
     73| beforeAll(() => {
     74|   workdir = mkdtempSync(join(tmpdir(), "premerge-hermetic-"));
     75|   const repo = join(workdir, "repo");
```

### 2. `scripts/validation-scope-wrappers.test.ts` — test-level timeout

```
Error: Test timed out in 15000ms.
 ❯ scripts/validation-scope-wrappers.test.ts:112:3
    112|   it("composes only full variants for a full pre-merge run", () => {
    113|     const invocations = runWrapper(wrapperPaths.preMergeFull);
```

**Classification: load-induced flakes, not defects.** Re-running exactly these two files at
the same clean revision passed (`vrun-45b654c8-54b8-45dc-a82b-016d52863f33`, 2 files
matched). The failing full run executed while three other registered validations held the
scheduler concurrently; both tests fail on wall-clock hooks that spawn subprocesses, so
contention alone explains them. A later full-suite run that reproduces only these two
timeouts is the same known state, not a workflow regression. A failure with a different
assertion — or in any other file — is not covered by this baseline.

This baseline records the state; per the delivery contract it does not waive a configured
failing gate.

## Deletion-path and store-boundary inventory

Taken before changes so checkpoint retention can join the existing owners rather than add a
parallel one.

### How a conversation row actually dies

Every path bottoms out in a `DELETE` against `conversations` or `project_conversations`:

| Entry point | Route | Reaches conversation rows by |
|---|---|---|
| `deleteConversation` (`src/lib/conversations/service.ts:296`) | → `mutateSession` splice → `store.ts:286` `repos.conversations.delete(id)` | direct `DELETE FROM conversations` |
| `deleteSessionRow` (`src/lib/state-store/setters.ts:650`) | `repos.sessions.delete` | FK `ON DELETE CASCADE` from `sessions` |
| `applyFusedSessionDelete` (`setters.ts:700`) | batched `repos.sessions.delete` in one transaction | FK `ON DELETE CASCADE` from `sessions` |
| `deleteProjectRow` (`setters.ts:743`) | `repos.projects.delete` | FK `ON DELETE CASCADE` to `sessions` → `conversations`, and directly to `project_conversations` |

Service-level callers of the last three live in `src/lib/sessions/service.ts` (`:676`
rollback, `:1060` fused session delete, `:1339` project delete).

### The two existing retention owners

1. **DB-enforced sidecar cleanup** — `conversation_machine_snapshots`
   (`state-db.ts:2391`) is owner-discriminated (`owner IN ('session','project')` +
   `conversation_id`) and so cannot express a single FK. Its
   `trg_conversation_machine_snapshots_session_cleanup` / `_project_cleanup` AFTER DELETE
   triggers (`state-db.ts:2407`, `:2414`) fire for **both** direct deletes and FK cascade
   deletes, inside the parent's transaction. One canonical owner covers all four entry
   points above.
2. **Hand-wired scope deletion** — `context_artifacts` (`state-db.ts:2659`) has no FK and
   no trigger; `src/lib/sessions/service.ts:316` calls `deleteByScope` from the session and
   project delete paths only. Its own header records the resulting gap: per-conversation
   deletion has no wiring, so a session conversation deleted through
   `deleteConversation` leaves its artifact row orphaned.

Checkpoint records have the identical two-parent shape, so P1 follows owner (1). Owner (2)
is the documented counter-example of what hand-wiring costs.

### Non-deleting paths that must retain checkpoint records

- **Archiving** is `UPDATE`-only: `repos.projectConversations.setArchived`
  (`setters.ts:1316`) and `repos.projects.setArchived` (`setters.ts:1380`). No row leaves
  the table.
- **Compaction / artifact refresh** writes `context_artifacts` through
  `src/lib/context-artifacts/repo.ts` upserts. It never touches conversation rows and must
  never reach checkpoint records.
- **Transcript images** are stored assets under `src/lib/images/transcript-images.ts`; no
  deletion path in the table above removes them.

### Store boundaries P1 writes against

| Boundary | Current state |
|---|---|
| `KNOWN_SCHEMA_VERSION` | `14` (`state-db.ts:157`), pinned by `state-db.test.ts:1210` |
| Highest migration | `0043-close-policy-admitted-approval-requests` |
| Schema floor | `state-db.ts:2780-2802` concatenates per-table `*_SCHEMA_DDL` constants; migrations re-`exec` the same shared constant rather than a copy |
| Compatibility barrier | `schema-compatibility.ts` — append-only per-version marker file plus the `schema_migrations` ledger; `publishSchemaCompatibilityBarrier` runs **before** the migration transaction (see `0038-ticket-relationships-and-status-updates.ts`) |
| Test reset | `truncateAllTables` derives its table set from `sqlite_master`, so a new table needs no registration |
| Repo composition | `AllRepos` (`schemas.ts:22`) holds only the core row repos. Sibling domain tables (`context_artifacts`, memory, notepads) use a standalone `createXRepo(db[, writeQueue])` factory owned by the domain — the pattern P1 follows |
| Backend reference column | `backend_ref` on both `conversations` (`conversations-repo.ts:202`) and `project_conversations` (`project-conversations-repo.ts:127`); the atomic readiness clear must target the correct one per scope |
