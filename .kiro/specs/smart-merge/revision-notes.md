# Smart Merge — Revision Notes (2026-05-31)

The existing `requirements.md`, `design.md`, and `tasks.md` were approved against a porcelain squash-in-projectPath implementation. This revision rewrites them around a **prepare-then-publish** architecture that never modifies the main (target) worktree during the long-running phase and is not blocked by uncommitted changes there.

This document is the authoritative source for the revision. All Kiro phases (requirements → design → tasks) must reflect the architecture below.

## Current behavior (what the revision replaces)

`squashMerge()` in `src/lib/git/worktree.ts:96-196` runs the entire final merge inside the target worktree (`mergePath = projectPath` when target is `main`):

1. `git status --porcelain` on `mergePath` — throws `MergePreconditionFailed` if any tracked file is dirty (`worktree.ts:107-121`).
2. `git merge --squash <featureBranch>` in `mergePath` (`worktree.ts:127`).
3. `git commit --no-verify -m <msg>` (`worktree.ts:163-168`).
4. Cleanup paths: `git merge --abort` + `git reset --hard HEAD` on failure (`worktree.ts:134-136, 172`).

Consequences:
- Dirty main blocks the merge job (hard `MergePreconditionFailed`).
- Project-wide in-memory lock (`acquireProjectLock` in `src/lib/prompt/single-flight.ts:73-88`) is required to serialize squashes against the shared main worktree.
- Lock is in-process only — not crash-safe, not cross-process.

## Target architecture: prepare-then-publish

### Prepare phase (off the target worktree)

Produce a prepared squash-commit OID without touching the target worktree.

**Preferred path — git plumbing (default when available):**

1. Resolve target SHA: `git rev-parse refs/heads/<targetBranch>` → `TARGET_SHA`.
2. Compute merge tree: `git merge-tree --write-tree <TARGET_SHA> <FEATURE_SHA>` (Git ≥2.38, Oct 2022).
   - Stdout: tree OID on first line; on conflict, exit code 1 and conflict-info lines follow.
3. If clean: `git commit-tree <tree> -p <TARGET_SHA> -m <message>` → `NEW_SHA` (single-parent commit = squash semantics).
4. Park `NEW_SHA` at a private ref `refs/cc-merges/<jobId>` so it's reachable and not GC'd.

**Fallback path — temporary detached worktree (older Git or parity gaps):**

1. `git worktree add --detach <TARGET_SHA> .worktrees/__merge_<jobId>`.
2. `cd` into it; `git merge --squash <featureBranch>`; `git commit --no-verify -m <message>`.
3. Capture resulting commit SHA; park at `refs/cc-merges/<jobId>`.
4. `git worktree remove -f .worktrees/__merge_<jobId>`.

Both paths produce the same artifact: a prepared commit OID + the recorded `expected-old` target SHA. Downstream publish logic is identical.

### Preflight evidence (already complete)

- Git version pinned in this environment: **2.39.5** (≥2.38 ✓).
- Parity spike: `scripts/merge-tree-parity-spike.sh` (9 scenarios all PASS — clean merge, rename-vs-modify, delete-vs-modify, mode-vs-content, binary conflict, text conflict, gitattributes EOL, rename-rename conflict, submodule-add-vs-modify).
- Conclusion: plumbing path is the default; temp-worktree path is the documented fallback.

### Publish phase (narrow critical section)

Under a short-held project lock (the only place the lock is held in the new design):

1. **Resolve current target SHA.** If it has moved from the `expected-old` recorded during prepare → CAS retry: re-prepare against the new tip, bounded retries (default: 3).
2. **Check target-worktree state:**
   - Discover whether `<targetBranch>` is checked out in any worktree (`git worktree list --porcelain`).
   - If checked out AND has tracked dirty files → **`ready-to-land` terminal state.** Do not advance the ref. Leave prepared commit at `refs/cc-merges/<jobId>`. Surface the outcome via job status and SSE so the UI can prompt the user to land later. A separate user-initiated "Land prepared merge" action completes when the checkout is clean.
   - Otherwise proceed.
3. **Atomic publish:** `git update-ref refs/heads/<targetBranch> <NEW_SHA> <expected-old>`. This is the branch-integrity primitive; CAS prevents stale-base publication.
4. **Clean-checkout refresh:** If `<targetBranch>` is checked out in a clean worktree, run `git -C <targetWorktree> reset --hard <NEW_SHA>` (or `read-tree --reset -u`) so HEAD, index, and working tree stay coherent. Skip entirely if the target branch is not checked out anywhere.
5. **Finalization** (still under the lock): setSessionFinished, retargetOrphanedChildren, stopAllForSession, prepared-ref cleanup, job/SSE status broadcast.

### Locking & concurrency

- **CAS is the correctness primitive** for branch-ref integrity (`update-ref <new> <expected-old>`). It is the only thing protecting against two concurrent merges landing on the same target.
- **The project lock is a finalization-side-effect guard**, narrowed to wrap only the publish/finalization critical section (ref update + worktree refresh + finalization). It serializes worktree refresh and lifecycle side effects between concurrent winners; it no longer wraps prepare or validation.
- The conversation lock (`acquireConversationLock`) and session lock (`acquireSessionLock`) are unchanged.

## New user-facing outcome: `ready-to-land`

This is the only material change to the user-facing contract.

- **Trigger:** target branch is checked out in a worktree that has tracked dirty files at the moment of publish.
- **Behavior:** the merge job succeeds at preparing a validated commit. The commit is parked at `refs/cc-merges/<jobId>`. The job transitions to a new terminal state `ready-to-land` (not `failed`, not `completed`).
- **UX:** notification + SSE event communicates "merge prepared, target dirty, land when clean". The UI exposes a "Land prepared merge" affordance.
- **Land action:** re-runs the publish-phase checks; if the target is now clean (or no longer checked out), advances the ref via CAS and runs finalization. If still dirty, remains in `ready-to-land`.

Today's `MergePreconditionFailed` is deleted. Dirty target during the long-running prepare phase no longer fails the job; it only matters at publish time, and even then it converts to `ready-to-land` instead of failure.

## Conflict resolution — unchanged

Claude-driven conflict resolution (`src/lib/sessions/conflict-resolution.ts`) operates in the *session/feature worktree*, not in the target. The `analyzingConflicts` and `resolvingConflicts` machine states (`src/lib/workflows/merge/machine.ts`) are unaffected by this revision. The pre-merge step that merges target → feature (for validation) also stays.

## Implementation surface

The revision touches more than `squashMerge()` alone:

- `src/lib/git/worktree.ts` — split `squashMerge()` into:
  - `prepareSquashMerge(target, feature, message, opts)` → `{ preparedSha, expectedTargetSha, parkedRef, conflicts? }`. Uses plumbing when available, temp-worktree fallback otherwise.
  - `publishPreparedMerge(target, preparedSha, expectedTargetSha, parkedRef, opts)` → handles CAS retry, checked-out target discovery, dirty-target → ready-to-land, clean-target refresh, prepared-ref cleanup. Returns `{ outcome: "published" | "ready-to-land", mergeSha?, parkedRef? }`.
- `src/lib/workflows/merge/actors.ts` — new actors `prepareSquashMerge` and `publishPreparedMerge`; remove the single `squashMerge(projectPath, ...)` actor.
- `src/lib/workflows/merge/machine.ts` — split the `squashMerging` state (`machine.ts:510-535`) into `preparing` → `publishing` → `completed | ready-to-land`. Add the `ready-to-land` terminal state. Surface the new outcome via SSE phase events.
- `src/lib/prompt/single-flight.ts:73-88` — narrow `acquireProjectLock` usage to wrap only the publish actor.
- `src/lib/workflow-graph/graph-context-squash-merge-actor.ts` — use the same prepare/publish primitives so the graph fan-in path stays consistent.
- Job/SSE schemas — add `ready-to-land` to the terminal-status union; surface it in the UI.
- A new API route + UI affordance for "Land prepared merge" against a prepared ref.
- Tests:
  - `src/lib/git/worktree.test.ts` — `prepareSquashMerge` (plumbing path, fallback path, conflict detection, parity), `publishPreparedMerge` (CAS success, CAS retry on stale target, dirty-checkout → ready-to-land, clean-checkout refresh, prepared-ref cleanup).
  - `src/lib/workflows/merge/machine.test.ts` — new state transitions, `ready-to-land` terminal, Land action.
  - `src/lib/workflow-graph/graph-context-squash-merge-actor.test.ts` — graph fan-in with new primitives.

`commit-tree` metadata must be intentionally matched to today's `git commit --no-verify` behavior: author/committer identity, message handling, signing posture. Document deliberate deltas.

## Out of scope (explicitly deferred)

- **WIP-commit cleanup** (`committingUncommitted` state in `machine.ts:243-257`). Today, uncommitted changes on the feature branch are committed as `WIP: uncommitted changes` before merging target in. A cleaner approach (stash, or `git write-tree` snapshot included in the prepared squash) is a separate follow-up slice. It addresses branch-history cleanliness, not the main-worktree dirty block; bundling it with this revision expands scope unnecessarily.
- **Cross-process / filesystem-level lockfile** for `acquireProjectLock`. CAS already protects branch-ref integrity across processes; an in-process lock for finalization side effects is sufficient for current CC deployment patterns.

## Live verification (final phase)

End-to-end manual verification on a freshly created project — see the workflow's `live-verification` context for specifics. Must exercise:

1. Happy-path merge against a clean main → published via plumbing.
2. Merge against a dirty main → ends in `ready-to-land`; subsequent Land action after main is cleaned completes the publish.
3. No `MergePreconditionFailed` is thrown during prepare/validation regardless of main state.
