# Research & Design Decisions: Smart Merge

## Summary
- **Feature**: smart-merge
- **Discovery Scope**: Complex Integration (revises an existing merge pipeline; introduces a prepare/publish split, plumbing-based merge, CAS publish, and a new terminal state)
- **Key Findings**:
  - `git merge-tree --write-tree` (Git 2.38+, Oct 2022) performs an in-memory three-way merge that writes the merged tree object directly to the object DB without ever touching a worktree or index. It exits non-zero on conflict with structured conflict information, making it the ideal correctness-preserving primitive for off-worktree merge preparation. Combined with `git commit-tree`, it produces a stand-alone squash commit OID without ever running `git merge --squash`.
  - `git update-ref refs/heads/<branch> <new> <expected-old>` is an atomic compare-and-swap on the branch ref. Failure due to a mismatched expected-old is reported deterministically (non-zero exit, distinguishable from network/IO errors), so the merge pipeline can react to lost races by re-preparing against the new tip without risking a stale-base merge or a corrupted ref.
  - `git worktree list --porcelain` is the authoritative source for which worktree (if any) has a given branch checked out. Combined with `git -C <worktree> status --porcelain`, the publish phase can decide between three outcomes — refresh the target worktree, skip refresh (branch not checked out), or park as `ready-to-land` (target dirty) — without touching the target worktree until after the ref has been advanced.
  - The existing `acquireProjectLock` in `src/lib/prompt/single-flight.ts` is throw-on-busy and finalization-shaped. Narrowing its scope to publish + finalization (rather than wrapping the entire prepare + validate window) reclaims a large amount of project-level concurrency and aligns its semantics with what it actually serializes (local finalization side effects), with branch-ref correctness moving to `git update-ref` CAS.
  - The current `squashMerge()` in `src/lib/git/worktree.ts` throws `MergePreconditionFailed` when the target has any tracked dirty file. Requirement 2 deletes that error; the dirty-target case is reabsorbed into the new `ready-to-land` outcome (Requirement 5).

## Research Log

### Git 2.38 plumbing for in-memory squash merge
- **Context**: Requirement 3 demands the prepare phase produce a candidate squash commit OID without touching the target worktree. The legacy implementation runs `git merge --squash` in a checkout, which requires a worktree and an index.
- **Sources Consulted**: `git merge-tree(1)`, `git commit-tree(1)`, `git update-ref(1)` man pages; Git 2.38 release notes.
- **Findings**:
  - `git merge-tree --write-tree <TARGET_SHA> <FEATURE_SHA>` computes the three-way merge of `<TARGET_SHA>` and `<FEATURE_SHA>` using their merge base, writes blobs and trees to the object DB, and prints the resulting top-level tree OID on stdout. It has no side effect on any worktree, index, or HEAD.
  - On clean merge: exit 0, stdout = tree OID.
  - On conflict: exit 1 (success-with-conflicts is exit 1; outright failure is ≥ 2), stdout contains the (conflicted) tree OID followed by a NUL-terminated conflicted-files section and an `Auto-merging` informational block, depending on `-z` / `--name-only` flags. The conflicting paths are recoverable without re-running git.
  - `git commit-tree <tree> -p <TARGET_SHA> -m <message>` creates a commit object pointing at the merged tree with a single parent (the target tip). This produces the same shape as today's `git commit` after `git merge --squash`: a single-parent commit whose tree captures the feature branch's effective changes squashed atop the target.
  - Author and committer identity for `git commit-tree` come from `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars or the user/system config — matching the identity resolution `git commit` performs.
- **Implications**:
  - The plumbing prepare path is `merge-tree --write-tree` → `commit-tree` → `update-ref refs/cc-merges/<jobId> <preparedSha>` (park). No worktree creation, no checkout, no index manipulation.
  - Conflict detection in the prepare phase is a check on the `merge-tree` exit code plus its conflict output, not a stderr string match.
  - To match today's `--no-verify` posture, the prepare path simply uses `commit-tree` (which never runs pre-commit hooks) and inherits identity from the same env/config that today's `git commit` already inherits.

### Fallback prepare path for pre-2.38 Git or parity gaps
- **Context**: Requirement 3.3 requires a fallback when `--write-tree` is unavailable or has a documented parity gap with `merge --squash` for the project's merge configuration.
- **Sources Consulted**: `git worktree(1)` man page; CC's own `worktree-fast-remove.ts`.
- **Findings**:
  - `git worktree add --detach <path> <SHA>` creates a temporary worktree at `<path>` with HEAD detached at `<SHA>`. It is self-contained: it does not modify any other worktree.
  - `git -C <tempPath> merge --squash <featureBranch>` then `git -C <tempPath> commit --no-verify -m <message>` reproduces today's exact merge behavior, including merge-driver application and `.gitattributes` rules.
  - `git worktree remove -f <path>` reliably removes both the worktree directory and the administrative entry. The existing `worktree-fast-remove.ts` handles edge cases (locked worktrees, leftover admin files).
- **Implications**:
  - The fallback prepare path provisions `.worktrees/__merge_<jobId>`, runs the legacy merge → commit sequence inside it, captures the new commit's SHA via `git rev-parse HEAD`, parks the commit at `refs/cc-merges/<jobId>`, and removes the temp worktree in a `finally` block. The target worktree is never touched.
  - Both paths must converge on the same artifact shape: `{ preparedSha, expectedTargetSha, parkedRef }` plus optional structured conflict info. Downstream code (publish, finalization, ready-to-land handling) is shared.

### Atomic publish via `update-ref` CAS
- **Context**: Requirement 4 requires that two concurrent merges cannot silently overwrite each other and that a moving target tip is detected deterministically rather than producing a stale-base merge.
- **Sources Consulted**: `git update-ref(1)`; git refs locking semantics.
- **Findings**:
  - `git update-ref refs/heads/<branch> <newvalue> <oldvalue>` requires the current ref value to match `<oldvalue>` exactly; otherwise it fails non-zero with `fatal: cannot lock ref ... is at X but expected Y`.
  - The check + write is atomic with respect to the loose-ref or packed-refs lock and is safe against arbitrary concurrent writers (including other processes).
  - The failure mode is distinguishable from IO errors by the stderr message, so the pipeline can react specifically to lost-CAS by re-preparing against the new tip.
- **Implications**:
  - `git update-ref` becomes the authoritative correctness primitive for branch integrity. The project lock (Requirement 8) is demoted to a finalization-side-effect serializer.
  - The retry policy is bounded (default 3 attempts including the original try). Exhaustion is a job-level failure with an explanatory error message.

### Target worktree discovery and refresh
- **Context**: Requirements 5 and 7 require the publish phase to distinguish three target-worktree states (not checked out, checked out clean, checked out dirty) without ever modifying a dirty target.
- **Sources Consulted**: `git worktree list --porcelain` output format; `git status --porcelain` output format.
- **Findings**:
  - `git worktree list --porcelain` emits stanzas with `worktree <abs-path>`, `HEAD <sha>`, `branch refs/heads/<branchName>` (or `detached`). Parsing yields a deterministic map from branch name → worktree path.
  - `git -C <worktreePath> status --porcelain` lists each changed path with a two-byte status code. Filtering out `??` (untracked) yields the tracked-dirty set; emptiness is the precise definition of "clean" for Requirement 5.
  - `git -C <worktreePath> reset --hard <NEW_SHA>` (or `git -C <worktreePath> read-tree --reset -u <NEW_SHA>` followed by a HEAD update) fast-forwards the worktree's HEAD, index, and working tree to a new commit when the worktree is on the target branch.
- **Implications**:
  - The publish-time discovery is two cheap, read-only git calls. The clean-checkout refresh is a single `reset --hard` after the CAS succeeds. A failed refresh does not roll back the ref because the merge is already durable; the refresh failure is surfaced as a non-fatal warning per Requirement 7.4.

### Existing lock semantics and the narrowed scope
- **Context**: Requirement 8 narrows the project lock to wrap only the publish + finalization critical section.
- **Sources Consulted**: `src/lib/prompt/single-flight.ts`.
- **Findings**:
  - `acquireProjectLock(projectPath)` throws immediately when the lock is held — there is no internal queue.
  - `acquireSessionLock` and `acquireConversationLock` are out of scope for this revision (unchanged in duration and surface).
- **Implications**:
  - The acquire-with-retry loop currently in `squashMergeActor` and `graph-context-squash-merge-actor` continues to exist but moves to a `publishPreparedMerge` helper. The prepare phase never calls `acquireProjectLock`.
  - The narrowed window holds only: worktree discovery (read-only), `update-ref` CAS (bounded retry per Requirement 4), the clean-checkout refresh (Requirement 7), and the finalization side effects (Requirement 9). All of these are sub-second operations on a healthy repo.

### `ready-to-land` terminal state and the parked ref
- **Context**: Requirement 5 introduces a new terminal outcome where the prepared commit is preserved across user sessions until they land it manually.
- **Sources Consulted**: existing `BackgroundJob` + `JobStatusEvent` schemas in `src/lib/jobs/schemas.ts`; `git update-ref` for setting and deleting refs.
- **Findings**:
  - Parking via `git update-ref refs/cc-merges/<jobId> <preparedSha>` creates a regular ref under a private namespace. Git treats it as a normal ref for reachability/GC purposes, so the prepared commit cannot be garbage collected as long as the ref exists.
  - `git update-ref -d refs/cc-merges/<jobId>` deletes the ref, releasing the commit to GC. This is the only place a parked ref should ever be removed (on successful Land, on explicit discard).
- **Implications**:
  - The `ready-to-land` state must be persisted in the job registry so the UI can surface the Land action and so the parked ref is not orphaned.
  - The Job/SSE schemas gain a `ready-to-land` status, a `discarded` status (for explicit discard), a `parkedRef` field, and an `awaiting-land` phase string.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Keep single `squashMerge()` and gate dirty-target check | Soften the existing single-pass merge to skip the dirty-target precondition | Smallest diff | Doesn't address worktree-mutation risk, doesn't isolate publish, doesn't enable ready-to-land | Rejected — does not meet Requirements 2, 4, 5 |
| Two-phase split: `prepareSquashMerge` + `publishPreparedMerge` | Pure prepare runs off the target; publish does CAS + refresh + finalization under a narrow lock | Maps directly to requirements; small, well-bounded primitives; allows ready-to-land | Adds a parked ref to manage | **Selected** |
| Background queue across processes (filesystem lockfile) | Move to a cross-process lock for branch ref serialization | Survives multi-process deployments | CAS already provides correctness; in-process lock is sufficient for CC deployment | Deferred (Out of Scope in requirements) |

## Design Decisions

### Decision: Prepare/publish split replaces single-pass `squashMerge`
- **Context**: Requirements 2, 4, 5 demand off-worktree preparation, CAS-based publish, and a `ready-to-land` outcome — none of which can be expressed by parameterizing the current single-pass `squashMerge()`.
- **Alternatives Considered**:
  1. Add flags to the existing `squashMerge()` (toggle dirty-target check, toggle CAS) — fails the off-worktree requirement.
  2. Introduce two new functions and retire `squashMerge()` — yes, this is the change.
- **Selected Approach**: Add `prepareSquashMerge(...)` and `publishPreparedMerge(...)` to `src/lib/git/worktree.ts`; remove `squashMerge` and `MergePreconditionFailed` from the public surface. Both new functions are pure git wrappers; the orchestration (lock, retry, finalization) lives in the machine actor.
- **Rationale**: Each function has a single responsibility and a clear contract. Tests can exercise prepare and publish independently.
- **Trade-offs**: Two call sites in the codebase (`actors.ts`, `graph-context-squash-merge-actor.ts`) must be updated together; no consumer of the old `squashMerge` remains.
- **Follow-up**: Update tests in `worktree.test.ts`, `actors` test surface (`machine.test.ts`), and `graph-context-squash-merge-actor.test.ts`.

### Decision: Plumbing-first with detached-worktree fallback
- **Context**: Requirement 3 requires plumbing on Git ≥ 2.38 with a transparent fallback.
- **Alternatives Considered**:
  1. Plumbing-only (assume Git ≥ 2.38) — fails if a deployment has older Git or hits a merge-driver parity gap.
  2. Always use the detached-worktree path — fails Requirement 3's speed/isolation goal on the common path.
- **Selected Approach**: `prepareSquashMerge` first inspects host Git version (via cached `git --version` parse); if ≥ 2.38 and no documented parity gap applies, run `merge-tree --write-tree` + `commit-tree`. Otherwise create `.worktrees/__merge_<jobId>` from the target SHA, run `merge --squash` + `commit --no-verify`, capture HEAD, and remove the temp worktree in a `finally`. Both paths return the same artifact shape.
- **Rationale**: Both prepare paths produce a stand-alone single-parent squash commit reachable from a parked ref, so the publish phase is identical regardless of which prepare path was used.
- **Trade-offs**: Two code paths to maintain; offset by the shared artifact shape and the shared conflict-surfacing route.
- **Follow-up**: Document the parity-gap matrix as it emerges; for now, no specific gap is known.

### Decision: `update-ref` CAS is the only correctness primitive for branch integrity
- **Context**: The existing `acquireProjectLock` is in-process and cannot defend against multi-process or external writers; CAS is needed regardless.
- **Alternatives Considered**:
  1. Rely on the project lock alone — fails against cross-process writers.
  2. Use CAS and keep the wide project-lock scope — wastes concurrency.
  3. CAS as the correctness primitive; project lock as a finalization serializer only — selected.
- **Selected Approach**: `publishPreparedMerge` performs `git update-ref refs/heads/<target> <new> <expected-old>` with bounded retry (default 3). On CAS failure, the orchestrator re-runs prepare against the new target tip and retries publish. The project lock wraps only the narrow publish + finalization window.
- **Rationale**: CAS is atomic and process-agnostic; the project lock's job becomes serializing local side effects (target-worktree refresh, session-state mutations) rather than protecting the ref.
- **Trade-offs**: Bounded re-prepare on contention can be expensive on a hot target branch; capping at 3 attempts plus surfacing the contention as a user-actionable failure is the pragmatic balance.
- **Follow-up**: Confirm telemetry captures CAS contention for tuning the retry cap.

### Decision: `ready-to-land` parks the prepared commit at `refs/cc-merges/<jobId>`
- **Context**: Requirement 5 turns the legacy `MergePreconditionFailed` into a recoverable outcome that preserves the prepared work.
- **Alternatives Considered**:
  1. Store the prepared SHA only in the in-memory job registry — at risk of GC because nothing pins the commit.
  2. Park the commit under a private ref namespace and persist the ref name in the job — selected.
- **Selected Approach**: Always create `refs/cc-merges/<jobId>` at prepare time. On success, the publish phase deletes the parked ref as part of finalization. On `ready-to-land`, the ref is left intact until the user lands or discards.
- **Rationale**: A real git ref pins reachability across server restarts (the prepared commit survives even if the in-memory job registry is rebuilt).
- **Trade-offs**: A discarded or forgotten `ready-to-land` job leaks a ref; mitigated by the explicit discard action (Requirement 6.6) and a future maintenance task (out of scope).
- **Follow-up**: Add a manual `git for-each-ref refs/cc-merges/` cleanup recipe to operator docs.

### Decision: Narrowed project-lock scope; session/conversation locks untouched
- **Context**: Requirement 8.
- **Alternatives Considered**:
  1. Hold project lock for the entire job (current behavior) — starves project concurrency during long validation.
  2. Drop project lock entirely — leaves no serializer for finalization-side-effect ordering.
  3. Narrow scope to publish + finalization — selected.
- **Selected Approach**: Acquire project lock only inside `publishPreparedMerge` (and its corresponding actor wrapper), release immediately after finalization.
- **Rationale**: The lock's only remaining job is serializing local finalization side effects (target-worktree refresh, `setSessionFinished`, child retargeting, parked-ref cleanup, SSE terminal broadcast). All of those need ordering; none of them need the prepare phase to be inside the same window.

### Decision: Schema additions for `ready-to-land`, `discarded`, `parkedRef`, and new phases
- **Context**: Requirements 5, 6, 12, 18.
- **Alternatives Considered**:
  1. Encode `ready-to-land` as a sub-state of `failed` — misclassifies it as a failure, breaks downstream UI/badging.
  2. Add explicit `ready-to-land` and `discarded` to `jobStatusSchema` plus a `parkedRef` field on `backgroundJobSchema` and `jobStatusEventSchema` — selected.
- **Selected Approach**: Extend `jobStatusSchema` enum with `ready-to-land` and `discarded`; add `parkedRef?: string` and the new `phase` strings (`preparing`, `publishing`, `awaiting-land`) used by Requirement 18.
- **Rationale**: Schema is the authoritative contract; the dual-validator model means consumers refuse invalid events outright if these aren't represented.

## Risks & Mitigations
- **Git version drift in dev/prod**: Production may run Git < 2.38 — Mitigation: Detect version at prepare time and fall back to the detached-worktree path; log the chosen path so deployments can confirm.
- **CAS thrash on a hot target branch**: Repeated prepare → CAS-loss cycles waste work — Mitigation: Bounded retry (default 3), explicit failure with retry-count message, telemetry-driven tuning.
- **Parked-ref leak from forgotten `ready-to-land` jobs**: A ref under `refs/cc-merges/` persists forever if the user neither lands nor discards — Mitigation: Explicit discard action (Requirement 6.6), operator cleanup recipe, future maintenance task.
- **Refresh-after-publish failure**: `reset --hard` could fail (e.g. filesystem permissions) after the ref has advanced — Mitigation: The merge is already durable in `refs/heads/<target>`; surface the refresh failure as a non-fatal warning (Requirement 7.4) without rolling back the ref.
- **`merge-tree --write-tree` parity gap with `merge --squash`**: A future merge-driver or attribute could produce different output between the two prepare paths — Mitigation: Single artifact shape, single conflict-handling route, and a documented escape hatch to force the fallback path.

## References
- `git merge-tree(1)` — in-memory merge primitive with `--write-tree`
- `git commit-tree(1)` — low-level commit creation
- `git update-ref(1)` — atomic ref CAS
- `git worktree(1)` — worktree discovery + temp worktree provisioning
- `src/lib/git/worktree.ts` — current `squashMerge` and `MergePreconditionFailed` usage
- `src/lib/workflows/merge/actors.ts` + `src/lib/workflows/merge/machine.ts` — current `squashMerge` actor and state graph
- `src/lib/workflow-graph/graph-context-squash-merge-actor.ts` — graph fan-in variant that must adopt the same prepare/publish split
- `src/lib/prompt/single-flight.ts` — existing `acquireProjectLock` semantics
- `src/lib/jobs/schemas.ts` — existing `JobStatus` / `BackgroundJob` / `JobStatusEvent` schemas
