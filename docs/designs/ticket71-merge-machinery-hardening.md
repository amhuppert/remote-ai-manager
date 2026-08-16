# Smart Merge machinery hardening — ticket command-center#71

Status: APPROVED — plan of record (Alex, 2026-08-16). Implementation intentionally **on hold**; do not start coding from this document until Alex green-lights a phase. The former open questions are settled in "Resolved decisions" at the end.
Ticket: command-center#71 — "Merge machinery commits conflict markers when the conflict resolver fails on a backend quota error"
Sources: ticket charter (`.cc/session-alignment/charter.md`); full Smart Merge review performed 2026-08-16 in this session (five scenarios: merge to main, merge into graph lane worktree, lane→session fan-in, non-main target branch, Smart Commit).

## 1. Problem statement

The incident on execution `3edd5fd7` chained three defects: a backend quota error was reported as an unresolvable content conflict (defect 1), the join preflight's index resync destroyed the `MERGE_HEAD` its own self-healing abort depended on (defect 2), and the merge machine then committed raw conflict markers as a single-parent `"WIP: uncommitted changes"` commit (defect 3).

The review established that these are instances of two systemic weaknesses, plus a set of adjacent lifecycle gaps:

1. **Error identity is destroyed at every boundary.** The backend failure classifier's output (`AgentFailureClassification`, `src/lib/agent-backends/errors.ts:15`) is flattened to a bare string in `TaskRunResult` (`execute-workflow-task-run.ts:129-131`), collapsed to `{status:"failed"}` in `mapTaskRunResultToResolution` (`conflict-resolution.ts:507-517`), stripped of even the message at the actor boundary (`ResolveConflictsOutput` has no error field, `merge/actors.ts:69-73`), and surfaces as the literal `"Join merge failed"` in the join halt (`join-runner.ts:501-507`). The same disease affects the validation fix agent (`validation-fix/states.ts:204-211` discards the fix agent's error) and CAS publishing (`worktree.ts:961-974` classifies *any* `update-ref` failure as CAS loss).

2. **Mid-merge worktree safety is a property of one caller, not of the machinery.** Only the join runner runs `abortInProgressMerge`, and it runs it too late (defect 2). Four other doors reach the same unguarded `commitChanges` (`git add -A` + `commit --no-verify`, `commits.ts:158-192`) with a mid-merge or poisoned tree: user re-merge after a `conflicts` halt, graph fan-in context merges (`execution-loop.ts:~2017`), Smart Commit on a mid-merge tree, and the `resolve-conflicts` re-entry whose ground-truth marker scan runs nearly blind (`conflictFiles` never seeded — `MergeInput` lacks the field entirely).

3. **Job lifecycle gaps**: resolver turns have no timeout (`timeoutMs ?? 0` never arms the timer, `execute-workflow-task-run.ts:348-352`); there is no abort path at all (`MergeEvent = {type:"ABORT"}` is dead code); stale-job recovery (`queue.ts:350-371`) force-fails the registry record without stopping the actor, broadcasting, or persisting; ready-to-land state is not restart-durable (`parkedRef`/`preparedSha`/`expectedTargetSha` never persisted; land/discard resolve from the in-memory registry only, `route-handlers.ts:240-280`); `refs/cc-merges/*` refs leak.

## 2. Goals and non-goals

**Goals**

- A backend infrastructure failure during conflict resolution is classified, carried end-to-end, surfaced as an infrastructure halt naming the cause, never burns the transient-failure retry, and is never auto-retried when non-retryable.
- No CC code path can commit conflict markers or unmerged index entries. This must hold for every door, not just the join preflight.
- The join preflight's self-healing works (abort before resync) and cannot destroy an operator's completed manual resolution.
- Merge jobs are bounded (resolver timeout), stoppable (abort), honestly reported (stale recovery stops what it fails), and restart-durable where they park state (`ready-to-land`).
- Publish-side misclassifications and destructive races are closed (CAS-loss verification, dirty re-check before `reset --hard`, up-to-date prepare handling).

**Non-goals**

- No redesign of the prepare/publish CAS pipeline, the delivery gate, or the validation service — their shapes are sound.
- No cross-process job resumption (jobs stay ephemeral per plan D12); durability work is limited to the parked-merge fields land/discard need.
- No automatic scheduling of retries at a provider's quota-reset time (surfaced as an operator hint only; see Open Questions).
- No rebase-machine changes (shares some helpers but had no findings in scope).

## 3. Design overview

Two structural moves carry most of the weight:

- **Part A — one failure vocabulary, threaded end-to-end.** Reuse the existing `AgentFailureClassification` (extended with a `quota_exhausted` kind) instead of inventing a parallel taxonomy, and stop flattening it: `TaskRunResult` → conflict-resolution outcome → machine terminal/halt reason → join halt each carry the classification forward. Retry policy at every layer keys off `retryable`, not off status strings.
- **Part B — worktree safety at the chokepoint.** `commitChanges` refuses to commit conflict artifacts, and the merge machine classifies the worktree at entry (clean / dirty / mid-merge / poisoned) with an explicit per-caller stale-merge policy. The join preflight reorders abort-before-resync and becomes defense in depth rather than the only defense.

Parts C–E cover job lifecycle, publish hardening, and call-site consistency.

---

## Part A — failure classification pipeline (defect 1 + M1, L5, retry policy)

### A1. Extend the backend failure vocabulary

`src/lib/agent-backends/errors.ts`:

```ts
export const agentFailureKindSchema = z.enum([
  "timeout",
  "aborted",
  "schema_validation",
  "structured_output_exhausted",
  "stale_resume_ref",
  "session_died",
  "capability_unavailable",
  "quota_exhausted",          // NEW
  "backend_error",
]);

export const agentFailureClassificationSchema = z.object({
  kind: agentFailureKindSchema,
  message: z.string(),
  retryable: z.boolean(),
  /** Opaque provider text naming when capacity returns (e.g. "Aug 19th, 2026
   *  11:29 PM"). Display-only — never parsed for scheduling. */
  retryAfterHint: z.string().optional(),   // NEW
});
```

Per-backend classifiers (`claude/failure-classifier.ts`, `codex/failure-classifier.ts`) gain quota/rate-limit recognizers following the existing `isLikelyStaleResumeMessage` pattern (marker-first message shapes: Codex `"You've hit your usage limit"` / `"usage limit"` + purchase/try-again clause; Claude 429 / `"rate limit"` / overloaded shapes). `quota_exhausted` classifies `retryable: false` and extracts the reset text into `retryAfterHint` when present. Everything currently falling through to `backend_error` keeps doing so.

### A2. Thread classification through `TaskRunResult`

`execute-workflow-task-run.ts` error variant gains an optional field:

```ts
| {
    kind: "error";
    error: string;
    aborted: boolean;
    /** Neutral classification when the conversation layer produced one;
     *  absent for legacy paths. */
    failure?: AgentFailureClassification;   // NEW
    ...
  }
```

The three construction sites (`:413`, `:426`, `:437`) attach the classification where the conversation actor recorded one; where only a string exists, the task-run layer runs the registered classifier for the conversation's backend as a fallback. `aborted: true` maps to `{kind: "aborted", retryable: false}` so downstream code has one field to consult.

### A3. Typed resolution outcome in `conflict-resolution.ts`

Replace the two-way `ConflictResolutionResult` failure branch with a three-way outcome:

```ts
export type ConflictResolutionResult =
  | { status: "resolved"; conflicts: ConflictEntry[] }
  | {
      /** The resolver ran against the conflict and it is still unresolved:
       *  parse-valid output that failed ground-truth verification, or the
       *  agent's own unresolved report. Content-level. */
      status: "unresolved";
      error: string;
      partialConflicts?: ConflictEntry[];
    }
  | {
      /** The resolver never (or only partially) ran: backend error, quota,
       *  abort, timeout, structured-output exhaustion. Infrastructure-level. */
      status: "infrastructure";
      failure: AgentFailureClassification;
    };
```

Mapping in `mapTaskRunResultToResolution`:

- `result.kind === "error"` → `infrastructure` with `result.failure` (fallback: classify `{kind: "backend_error", retryable: false}` from the string; `aborted` → `kind: "aborted"`).
- Structured-output **parse failure** on a returned turn → `infrastructure` with `{kind: "schema_validation", retryable: true}` — the agent may well have edited files correctly; the retry is cheap and legitimate (this is the transient case the join's clean retry was built for).
- Ground-truth verification failure (unmerged entries remain / markers remain) → `unresolved` with the existing messages.
- Thrown errors from `executeWorkflowTaskRun` (`:497-504`) → `infrastructure`, classified via the same fallback.

`analyzeConflicts` gets the same split (`analyzed` / `infrastructure`), so a quota-failed *analysis* no longer silently produces an empty-analysis `conflicts` halt either.

### A4. Actor and machine: carry it, split the terminal

`ResolveConflictsOutput` (`merge/actors.ts`) mirrors the three-way outcome including `error`/`failure` fields — the current shape that drops the message is deleted.

`mergeMachine` changes:

- Context gains `resolutionFailure: AgentFailureClassification | null`.
- `resolvingConflicts.onDone` splits three ways:
  - `resolved` → `committingResolution` (unchanged);
  - `unresolved` → `conflicts` terminal, now assigning `error` from the outcome so the job/notification names the real reason instead of leaving `error: null`;
  - `infrastructure` → **`failed` terminal** with:

```ts
haltReason: {
  type: "resolution_infrastructure",
  failure,                      // AgentFailureClassification
  conflictFiles: context.conflictFiles,   // context, not blame
}
error: `Conflict resolution could not run (${failure.kind}): ${failure.message}`
```

- `MergeContext.haltReason` / `MergeOutput.haltReason` widen from `DeliveryGateHaltReason` to `MergeHaltReason = DeliveryGateHaltReason | ResolutionInfrastructureHaltReason`. The persisted Zod twin in `src/lib/jobs/schemas.ts` is extended in the same change — the `MutuallyAssignable` parity guard in `merge/types.ts:92-96` enforces this at compile time.
- **SSE**: the `job-status` event schema must accept the new halt-reason variant. Strict envelope schemas silently drop non-conforming events (prior incident: `_sentAt` vs `.strict()`), so this is a correctness step, not hygiene.

Terminal-status decision: **no new job status.** `conflicts` keeps meaning "content conflict awaiting resolution"; infrastructure failures use `failed` + structured `haltReason`. This avoids rippling a new enum member through `BackgroundJob`, SSE consumers, toasts, and notifications, while giving the join runner a machine-readable discriminator.

### A5. Join runner: retry and halt policy

`join-runner.ts`:

- The "one clean retry" (`:366-398`) fires only when the failure is worth retrying:
  - `status === "conflicts"` (genuine content conflict after a resolution attempt) → retry as today;
  - `status === "failed"` with `haltReason.type === "resolution_infrastructure"` and `failure.retryable === true` (schema_validation, timeout) → abort + retry once;
  - `failure.retryable === false` (quota_exhausted, aborted, backend_error) → **no retry**; halt immediately.
- Failure recording (`:492-522`): when the halt reason is `resolution_infrastructure`, record `join_failure` with a message built from the classification — `"Conflict resolution failed before reaching the conflict: quota_exhausted — You've hit your usage limit… (capacity hint: Aug 19th …)"` — and pass `conflictFiles` as context. `mergeHaltReason` already flows to `recordPendingHaltReason` (`execution-loop.ts:3624-3637`), so the workflow halt surface gets the structured reason for free.
- **Automatic join retry scheduling** (`workflow-manager.ts` `resume.join_retry_scheduled` path): skip scheduling when the pending halt reason is `resolution_infrastructure` with `retryable: false`. Operator-initiated `cctl workflow live resume` always proceeds (the operator may have restored quota).

### A6. Preserve the fix agent's failure (same family)

`validation-fix/states.ts:204-211`: when the fix agent reports `status: "failed"`, append its error to the context error instead of discarding it: `error = `${originalValidationError}\n\nFix agent failed: ${fixError}``. No classification plumbing here (the fix agent failure already routes to `failed`); this is message preservation only.

---

## Part B — worktree safety at the chokepoint (defects 2–3 + doors, M2, M10)

### B1. `commitChanges` refuses to commit conflict artifacts

`src/lib/git/commits.ts` — before `git add -A`, run a two-stage guard:

1. **Unmerged entries**: `git diff --name-only --diff-filter=U` non-empty → refuse. (Catches every genuinely mid-merge tree.)
2. **Marker scan**: `git diff HEAD --check` (native, fast, changed-lines-only), filtering its output to `leftover conflict marker` findings; each flagged file is then confirmed by reading it and applying the stricter `containsConflictMarkers` regex (`^(<{7}|>{7}|\|{7}) `, `conflict-resolution.ts:292-294`) so git's broader heuristics (e.g. a 7-char `=======` markdown underline) cannot cause a false refusal. (Catches the poisoned post-`reset` tree where `MERGE_HEAD` and unmerged entries are already gone — the exact defect-3 state.)

Refusal throws with an actionable message listing the files:

```
Refusing to commit: N file(s) contain conflict artifacts (src/lib/… ). Resolve the
conflicts (or abort the merge) before committing.
```

No opt-out parameter. Callers with a legitimate need to commit literal marker text (none exist in CC machinery) use git directly. `containsConflictMarkers` moves to the git layer (`src/lib/git/conflict-markers.ts`) so `commits.ts` does not import from `sessions/`; `conflict-resolution.ts` re-imports it from there.

This single guard covers every door at once: `committingUncommitted` (defect 3), `committingResolution` (a lying resolver), `committingFix`, the validation auto-commit, and Smart Commit's `committing`.

Cost note: the git-native first stage means no per-file reads in the common case; JS confirmation reads only flagged files.

### B2. Machine-owned entry classification

Replace the blind `checkingUncommitted` entry with a classification step (new actor `classifyWorktree`):

```ts
type WorktreeEntryState =
  | { kind: "clean" }
  | { kind: "dirty" }            // ordinary uncommitted work
  | { kind: "mid-merge";         // MERGE_HEAD present
      unresolved: boolean }      // unmerged entries or markers remain
  | { kind: "poisoned" };        // no MERGE_HEAD, but unmerged entries or
                                 // markers in dirty files (post-reset state)
```

New `MergeInput.staleMergePolicy: "refuse" | "abort"` (default `"refuse"`), stored in context. Routing from the new `classifyingWorktree` state:

- `clean` → `mergingMain`; `dirty` → `committingUncommitted` (now safe per B1).
- `mid-merge` with `unresolved: true`:
  - policy `"abort"` (machinery re-entries: join runner, fan-in) → new `abortingStaleMerge` state invoking `abortInProgressMerge`, then continue to `checkingUncommitted`;
  - policy `"refuse"` (user-driven dispatch) → `failed` with an instructive error: the worktree is mid-merge from a previous conflicted merge; resolve and commit, resume the conflict flow, or abort the merge. (Silently aborting would discard a resolver's or operator's partial work without consent.)
- `mid-merge` with `unresolved: false` → **always refuse**, both policies: the tree looks like a *completed manual resolution awaiting commit*; auto-abort here is exactly the operator-work destruction called out in the review (M10). Error message: "commit your resolution, then retry/resume."
- `poisoned` → `failed` with a loud, specific error naming the files. Nothing may auto-commit this state.

Dispatch wiring: `graph-merge-runner.ts` and the fan-in call pass `staleMergePolicy: "abort"`; `dispatchMergeJob` / `dispatchResolveConflictsJob` default to `"refuse"`. The Smart Commit machine reuses the same classification actor with the always-refuse behavior (it has no merge to continue).

### B3. Join preflight: reorder and demote (defect 2)

`join-runner.ts:261-303`:

1. `abortInProgressMerge(sourceWorktreePath)` moves **before** both `resyncSharedIndex` calls — abort first, then resync the now-quiescent tree. The abort itself adopts the B2 refinement: abort only when the merge is demonstrably unresolved (unmerged entries or markers present); a fully-resolved-but-uncommitted tree halts the join with "operator resolution awaiting commit" instead of destroying it.
2. The preflight becomes defense in depth: with B2 in place the machine would refuse/abort correctly anyway, but the preflight keeps the worktree clean *before* the shared-index resync runs (the resync's own documented precondition is a quiescent tree — `shared-index.ts:22-27`).
3. The clean-retry abort (`:390`) is unchanged (it already runs without a preceding resync).

`resyncSharedIndexToHead` itself stays untouched — its behavior is correct for its contract; the bug was call ordering.

### B4. Seed and widen the ground-truth scan (M2)

- `MergeInput` gains `conflictFiles?: string[]`; context initializes from it. `dispatchResolveConflictsJob` seeds it from the prior job's record (`deps.getJob(...).conflictFiles`), which the route already reads for other fields.
- `verifyResolutionGroundTruth` (`conflict-resolution.ts:324-392`) widens `filesToScan` from `conflictFiles ∪ claimed` to `conflictFiles ∪ claimed ∪ (tracked files dirty vs HEAD)` — the same `git diff --check`-based scan as B1, reusing one helper. An agent that stages a marker-bearing file it never mentions is now caught regardless of entry path.

### B5. Fan-in context merges join the safety envelope (M7)

The `execution-loop.ts` fan-in call site (~2017) passes:

- `staleMergePolicy: "abort"` (B2), and
- `conversationId` of the context's implementer conversation (the execution loop owns this mapping), closing the fallback-to-most-recently-active-conversation hazard that `merge/types.ts:133-141` documents and the join runner already avoids.

---

## Part C — job lifecycle (H2–H4, M6)

### C1. Resolver turn timeout

`MergeInput.resolutionTimeoutMs?: number`, default `900_000` (15 min). `resolveConflictsImpl` / `analyzeConflictsImpl` pass it as `timeoutMs` to `executeWorkflowTaskRun`, which already supports arming a timer (`:348-352`). A timeout surfaces as `infrastructure` with `{kind: "timeout", retryable: true}` — it gets the one clean retry, then halts with a reason naming the timeout.

### C2. Abort support

Minimal, honest abort:

- **Actor handle registry**: `machine-host.ts` records the started actor in an HMR-safe map keyed by `jobId` (mirroring the job registry pattern), removed on terminal.
- **Machine wiring**: root-level `on: { ABORT: ".aborting" }` in both merge and commit machines. `aborting` invokes a cleanup actor — best-effort `abortInProgressMerge(worktreePath)` when the current phase left a merge open — then lands in `failed` with `error: "Aborted by operator"`. XState v5 `fromPromise` actors receive an `AbortSignal` on stop; `resolveConflicts`/`runValidation` thread it (validation already does — `createRunValidationActor` passes `signal` through to `performMergeValidation`; the resolver actor forwards it into `executeWorkflowTaskRun`'s existing abort support so the LLM turn is genuinely cancelled, not orphaned).
- **API**: `POST /api/projects/[name]/sessions/[session]/merge/abort` → look up the running job + actor handle → send `ABORT`. 404 when no running job. The existing terminal-state projection handles broadcast/persist/lock-release with no special-casing.

This turns the dead `MergeEvent` type into the real contract.

### C3. Stale recovery that actually recovers

`queue.ts`:

- `BackgroundJob.lastProgressAt` updated on every phase broadcast and on `persistProgress`.
- `recoverStaleJob` triggers on **inactivity** (`now - lastProgressAt > STALE_INACTIVITY_MS`, default 30 min) rather than total runtime — with C1 in place every long-running stage is individually bounded, so this is a true backstop, not a routine tripwire.
- On trigger it performs a real teardown: send `ABORT` via the C2 handle (falling back to `actor.stop()`), then broadcast and persist the forced terminal state (today it does neither, leaving a ghost actor, a stale-running DB row, and the possibility of a merge publishing *after* the UI reported it failed).

### C4. Ready-to-land durability and parked-ref hygiene

- **Persist** `parked_ref`, `prepared_sha`, `expected_target_sha`, `finalize_session_on_publish`, `resolution_context` as additive nullable columns on `job_records` (Umzug migration per `src/lib/state-store/migrations/README.md`; repository mapping + `jobs/repo.contract.test.ts` round-trip fixture extended in the same change per the persistence contract rules).
- **Land/discard fallback**: `resolvePreparedJob` (`route-handlers.ts:240`) falls back from the in-memory registry to the latest persisted `ready-to-land` row for the session; before dispatch it verifies the parked ref still resolves (`rev-parse refs/cc-merges/<jobId>`) and 409s with a specific message when it does not. A land re-entry after restart reconstructs its `MergeInput` from the persisted fields.
- **Registry replacement discards explicitly**: when `prepareDispatch` replaces an existing `ready-to-land` job with a new dispatch, it first deletes the old parked ref (`update-ref -d`, logged) and marks the old row `discarded` — today the ref is silently orphaned.
- **Startup GC**: the existing stale-jobs startup sweep additionally lists `refs/cc-merges/*` per project and deletes refs with no corresponding `ready-to-land` row.

---

## Part D — publish/prepare hardening (M4, M5, M8, L4)

### D1. Verify CAS loss before declaring it

`publishPreparedMerge` (`worktree.ts:954-974`): on `update-ref` failure, compare the captured `actualTargetSha` with `expectedTargetSha`:

- differ → genuine `cas-lost` (unchanged behavior);
- equal → the ref did not move; return a new `{kind: "publish-failed", error}` result. The publish actor maps it to `status: "failed"` with the underlying git error, so a stale `refs/heads/main.lock` or permissions problem fails once with the real cause instead of burning three re-prepares and reporting "CAS contention exhausted".

### D2. Re-check the target checkout under the lock

`runPublish` (`merge/actors.ts:428-512`): the clean/dirty discovery currently runs before lock acquisition, and `git reset --hard` runs after CAS on the strength of that stale answer. Move (or repeat) the `discoverTargetCheckout` status check **inside** the project lock, immediately before publishing: if the target worktree turned dirty in the window, return `ready-to-land` instead of proceeding to a `reset --hard` that would destroy tracked human edits. The reset itself is unchanged — it only ever runs against a just-verified-clean checkout.

### D3. First-class "up to date" prepare result

`PrepareResult` gains `{kind: "up-to-date", expectedTargetSha}`:

- plumbing path: after `merge-tree`, compare the produced tree OID with `rev-parse <targetSha>^{tree}`; equal → `up-to-date` (today: publishes an empty commit);
- fallback path: the empty-staged case returns `up-to-date` (today: `conflicts` with `conflictFiles: []`, which the machine renders as "Prepare produced conflicts in 0 file(s)").

**Semantics (decided): a successful no-op merge that finalizes the session.** The user clicked Merge meaning "I'm done"; a branch already fully contained in the target completes exactly like a delivering merge, minus the commit. Flow: the machine routes `up-to-date` through `publishing` (the delivery gate still evaluates, with `preparedSha = expectedTargetSha` as the candidate — a workflow-linked no-op must still satisfy the proof floor) into `publishingCandidate` with a new `PublishActorInput.upToDate: true`. `runPublish` in up-to-date mode skips target-checkout discovery, the CAS `update-ref`, the worktree refresh, and the parked-ref delete (there is no parked ref), but **keeps** the project lock, the active-graph-workflow refusal, and the `finalizeSession` side effects (session finished, dev servers stopped, children retargeted) when `finalizeSessionOnPublish` is true. Graph lane merges pass `finalizeSessionOnPublish: false` as always, so a join's up-to-date lane completes as a pure no-op — correct, the lane content is already in the target. Output: `completed` with `mergeHash: null` and `MergeOutput.upToDate: true`. Notification copy: "Branch X is already fully merged into Y — session finished (nothing new to merge)."

### D4. Pin the git locale

`git/client.ts` merges `LC_ALL: "C"` into the child env for every git invocation, so `mergeTargetIntoFeature`'s `"CONFLICT"` substring detection (`worktree.ts:739-740`) cannot be broken by a localized git. (Cheap insurance even if `buildChildEnv` already strips locale vars.)

---

## Part E — call-site consistency and hygiene (M3, M9, L1–L3, L6)

- **E1. Decouple validation auto-fix from conflict auto-resolve.** `MergeInput.autoFixValidation?: boolean` (default: `autoResolve`) becomes the `shouldAttemptFix` gate. `dispatchResolveConflictsJob` passes `true`, restoring the fix loop the original merge had (today it silently loses it via the hard-coded `autoResolve: false`).
- **E2. Honest validation evidence.** The join's `addValidationEvidence` entry (`join-runner.ts:453-466`) gains `commandIdentity: string` (the `+`-joined command list, `""` when the configured selection was empty), with schema, repo mapping, and round-trip contract updates. Debt clearing on an empty selection remains (there is nothing to run, and never-clearable debt would be worse), but the ledger now shows exactly what ran.
- **E3. One workflow-active guard.** Extract the merge route's `GRAPH_WORKFLOW_ACTIVE` advisory refusal into a shared helper used by the route, the `/merge` conversation command (`conversation-commands/service.ts:440`), and optimistic mode (`optimistic.ts:108`) — today the latter two pay for resolution and validation before failing at publish time.
- **E4. Deduplicate policy code.** Single owner for the `finalizeSessionOnPublish` defaulting rule (one function in `queue.ts`; the graph runner keeps its explicit `false`); `recordMergeIntent` recording collapses into `mergeSubscription.mapOutput` with the intent source carried as a job fact (`intentSource: "session-merge" | "graph-join"` set at decorate time) — today `graph-merge-runner.ts:253-272` duplicates the block and double-writes the same SHA.
- **E5. Dead code removal.** Drop `"commit"` from `MergeContext.jobType`/`MergeInput.jobType` (Smart Commit is a separate machine; the member is unreachable and misleading); drop `targetWorktreePath` from `MergeInput`/`MergeContext` (stored, never read — publish rediscovers by branch; callers stop passing it); the `ABORT` event stops being dead by C2; `abortInProgressMerge` reuses `isMergeInProgress` (single MERGE_HEAD probe).
- **E6. Discard-path consistency** (documentation-level): `discardSession` keeps its raw `session.targetBranch ?? "main"` (it only deletes a ref), with a comment noting why it deliberately skips `resolveMergeTarget`.

---

## Persistence and schema change summary

| Change | Where | Ripples |
|---|---|---|
| `quota_exhausted` kind + `retryAfterHint` | `agent-backends/errors.ts` + both failure classifiers | conformance tests |
| `failure?` on `TaskRunResult` error variant | `execute-workflow-task-run.ts` | none persisted |
| `MergeHaltReason` union (`resolution_infrastructure`) | `merge/types.ts` + `jobs/schemas.ts` (Zod twin) | SSE `job-status` event schema (strict-schema drop hazard), parity guard, UI halt rendering |
| `conflictFiles`, `staleMergePolicy`, `resolutionTimeoutMs`, `autoFixValidation`, remove `targetWorktreePath`/`"commit"` | `MergeInput`/`MergeContext` | machine tests, dispatchers |
| `lastProgressAt`, `upToDate`, `intentSource` on `BackgroundJob` | `jobs/schemas.ts` | SSE event schema |
| `parked_ref`, `prepared_sha`, `expected_target_sha`, `finalize_session_on_publish`, `resolution_context` columns | Umzug migration + `jobs/repo.ts` mapping | `repo.contract.test.ts` round-trip extension |
| `commandIdentity` on join validation evidence | workflow-graph schemas + state-store mapping | contract fixtures |

All schema work follows the domain-ownership rule (`src/lib/<domain>/schemas.ts`, `z.infer` types, no hand-written duplicates).

## Test plan (red-green, in implementation order)

Every fix lands with its failing test first. The load-bearing ones:

1. **Defect 2 integration (real git, `createPersistenceFixture`-style temp repos)**: build a worktree left mid-merge with markers; run the join preflight; assert `MERGE_HEAD` was aborted *before* any resync and no `WIP` commit contains markers. Today's suite stubs `resyncSharedIndex` and pins `abortInProgressMerge: async () => false`, so this is the first real-git coverage of the interaction that broke.
2. **Defect 3 chokepoint**: `commitChanges` refuses on (a) unmerged entries, (b) marker-bearing dirty files with no `MERGE_HEAD` (the post-reset poisoned state), (c) passes on a legitimately dirty tree and on a marker-free merge conclusion; the markdown `=======`-underline false-positive case passes.
3. **Defect 1 chain**: `mapTaskRunResultToResolution` unit tests per classification kind; machine test that `infrastructure` routes to `failed` with the `resolution_infrastructure` halt reason and `conflicts` keeps its meaning; join-runner tests that `retryable: false` gets no clean retry, `retryable: true` gets exactly one, and the halt message names the classification; workflow-manager test that auto-retry scheduling skips non-retryable infra halts.
4. **Doors**: merge-machine entry classification per state × policy matrix (including "resolved-but-uncommitted refuses under both policies"); Smart Commit refusal on a mid-merge tree; fan-in dispatch passes `staleMergePolicy: "abort"` + implementer `conversationId`.
5. **Lifecycle**: resolver timeout arms and classifies as retryable infra (fake timers); abort endpoint drives the machine to `failed` and releases the session lock; stale recovery stops the actor and persists/broadcasts (fake actor handle); land-after-restart resolves from the persisted row (round-trip through the repo, per the durability testing rule).
6. **Publish**: `update-ref` failure with an unmoved ref returns `publish-failed` (not `cas-lost`); dirty-under-lock re-check yields `ready-to-land`; both prepare paths return `up-to-date` on an already-merged branch, the machine completes without publishing a commit, and session finalization runs iff `finalizeSessionOnPublish` (user merge finalizes; graph lane merge does not).

Validation gates: `cctl validate run test --wait`, `cctl validate run typecheck --wait` (seam ratchet — the machine and git-layer changes touch canonical boundaries), `cctl validate run lint --wait`.

## Phasing

**Phase 1 — ticket #71 core (the incident, end-to-end).** A1–A5 (classification chain through the join halt), B1 (`commitChanges` guard — closes defect 3 at the chokepoint for every door at once), B3 (preflight reorder). After this phase the observed incident cannot recur in any form: the quota error halts as infrastructure without burning retries, the preflight actually self-heals, and nothing can commit markers.

**Phase 2 — doors, bounds, and operator control.** B2 (entry classification + policies), B4, B5, C1 (resolver timeout), C2 (abort — pulled forward by decision: the incident's operator had no cancel path, and the timeout alone only bounds hangs, it does not let a human stop a doomed run), D1, D2, A6.

**Phase 3 — lifecycle and polish.** C3 (stale rework), C4 (ready-to-land durability + GC), D3, D4, E1–E6.

Phases 2 and 3 are independently shippable; nothing in Phase 1 depends on them.

## Resolved decisions (Alex, 2026-08-16)

1. **Design approved as the plan of record; implementation held.** No phase starts until explicitly green-lit.
2. **Marker guard (B1): hard refusal, no opt-out.** A hypothetical caller needing to commit literal conflict-marker fixtures uses git directly; `commitChanges` never commits conflict artifacts.
3. **Up-to-date merge (D3): complete and finalize the session** — a successful no-op merge, not a "nothing happened" notice. Design updated accordingly (gate still evaluates; publish runs in no-op mode keeping the lock, the workflow refusal, and finalization).
4. **Abort (C2): pulled into Phase 2.**

Standing defaults (raise an objection to change): stale inactivity threshold 30 min (C3); quota-aware auto-resume scheduling stays out of scope — `retryAfterHint` is display-only.
