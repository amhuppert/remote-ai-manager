# Implementation Plan

This plan covers the revision to the existing Smart Merge pipeline: split the squash merge into a prepare phase (off the target worktree) and a publish phase (atomic CAS), add the `ready-to-land` terminal outcome, narrow the project lock, and surface a Land/Discard affordance. The pre-revision async-merge, conflict-resolution, validation-recovery, notifications, and dialog surfaces are already implemented and are preserved as-is; tasks below touch them only where the revision requires.

WIP-commit cleanup is out of scope and is not represented in any task.

- [x] 1. Extend job and SSE schemas for the new statuses, fields, and phases
- [x] 1.1 (P) Extend `jobStatusSchema` and `backgroundJobSchema` with `ready-to-land` / `discarded` statuses and optional `parkedRef`, `preparedSha`, `refreshWarning` fields
  - Update `src/lib/jobs/schemas.ts` so `jobStatusSchema` includes `ready-to-land` and `discarded` alongside existing values; add `parkedRef`, `preparedSha`, `refreshWarning` as optional strings on `backgroundJobSchema`
  - Add corresponding optional fields to `jobStatusEventSchema`; ensure legacy events without these fields still parse
  - Update `BackgroundJob` and `JobStatusEvent` types so consumers can read the new fields
  - Add a round-trip schema test for each new status value and each new optional field in `src/lib/jobs/schemas.test.ts`
  - _Requirements: 5.3, 5.5, 6.6, 12.2_

- [x] 1.2 (P) Add the new phase enum values (`preparing`, `publishing`, `awaiting-land`) to the job phase surface
  - Extend the phase enum (or the `z.string()` field with documented values) in `src/lib/jobs/schemas.ts` to include `preparing`, `publishing`, `awaiting-land` alongside existing phase values
  - Document the phase-clearing rule: clear on `completed`/`failed`/`conflicts`/`discarded`; retain `awaiting-land` on `ready-to-land`
  - Add a schema test asserting each new phase value round-trips
  - _Requirements: 18.1, 18.2, 18.6, 18.7, 18.8, 18.10_

- [x] 2. Implement the new git plumbing primitives in `src/lib/git/worktree.ts`
- [x] 2.1 (P) Implement `discoverTargetCheckout` to classify the target worktree
  - Add `discoverTargetCheckout(projectPath, targetBranch)` that returns `{ kind: "not-checked-out" } | { kind: "clean", worktreePath } | { kind: "dirty", worktreePath, trackedDirtyPaths }`
  - Parse `git -C <projectPath> worktree list --porcelain` to find the worktree whose branch matches `refs/heads/<targetBranch>`
  - For a matching worktree, run `git -C <worktreePath> status --porcelain`, reuse the existing `parseDirtyPaths` helper, filter on `tracked === true` per Requirement 5.2
  - Treat untracked files as clean
  - Add unit tests in `worktree.test.ts` for not-checked-out, clean, dirty (tracked-only), and untracked-only-still-clean cases
  - _Requirements: 5.1, 7.2_

- [x] 2.2 Implement `prepareSquashMerge` plumbing path on Git ≥ 2.38
  - Add `prepareSquashMerge(input)` returning `{ kind: "prepared"; preparedSha; expectedTargetSha; parkedRef } | { kind: "conflicts"; expectedTargetSha; conflictFiles }`
  - On exit 0 from `git merge-tree --write-tree -z <targetSha> <featureSha>`: read tree OID from stdout, then `git commit-tree <tree> -p <targetSha> -m <message>` to produce `preparedSha`; thread `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env so identity matches today's `git commit --no-verify`
  - On exit 1 from `merge-tree --write-tree`: parse the conflicted-files section into `conflictFiles` and return `kind: "conflicts"`; do not invoke `commit-tree`
  - On successful commit, park via `git update-ref refs/cc-merges/<jobId> <preparedSha>`
  - Cache `git --version` once per process and gate this path on `>= 2.38.0`
  - Add unit tests in `worktree.test.ts` for plumbing-clean (parked ref exists, target ref unchanged) and plumbing-conflicts (no commit, no parked ref)
  - _Requirements: 2.1, 2.2, 2.4, 2.5, 3.1, 3.2, 3.4, 3.5_

- [x] 2.3 Implement `prepareSquashMerge` detached-worktree fallback
  - When the plumbing path is not available (Git < 2.38 or `repoConfig.preMergePreparePath === "fallback"`), provision `.worktrees/__merge_<jobId>` via `git worktree add --detach <path> <targetSha>`
  - Inside that worktree: `git merge --squash <featureBranch>` then `git commit --no-verify -m <message>`, then `git rev-parse HEAD` to capture `preparedSha`
  - Detect conflicts via the existing stderr / diff-filter inspection; on conflict, return `kind: "conflicts"` without producing a commit
  - On both success and failure, remove `.worktrees/__merge_<jobId>` via `git worktree remove -f <path>` in a `finally` so no stray directory survives
  - On success, park via `git update-ref refs/cc-merges/<jobId> <preparedSha>` so the output shape matches the plumbing path exactly
  - Add unit tests in `worktree.test.ts` for fallback-success (commit produced, temp worktree removed, ref parked) and fallback-failure cleanup (temp worktree removed even when the commit step throws)
  - _Requirements: 2.1, 2.2, 2.4, 2.5, 3.3, 3.4, 3.5, 3.6_

- [x] 2.4 Implement `publishPreparedMerge` with CAS, refresh, and parked-ref cleanup
  - Add `publishPreparedMerge(input)` returning `{ kind: "published"; mergeHash; refreshWarning? } | { kind: "cas-lost"; actualTargetSha }`
  - Perform `git update-ref refs/heads/<targetBranch> <preparedSha> <expectedTargetSha>`; on failure, run `git rev-parse refs/heads/<targetBranch>` to capture `actualTargetSha` and return `cas-lost`
  - When CAS succeeds AND `cleanTargetWorktreePath` is non-null: run `git -C <cleanTargetWorktreePath> reset --hard <preparedSha>`; on error, capture stderr into `refreshWarning` and continue — do not throw
  - When CAS succeeds AND `cleanTargetWorktreePath` is null: skip refresh entirely
  - When CAS succeeds: delete the parked ref via `git update-ref -d <parkedRef> <preparedSha>` (with expected-old) before returning
  - Add unit tests in `worktree.test.ts` for: CAS success + clean refresh, CAS success + no target worktree, CAS success + refresh failure surfaces `refreshWarning` and still deletes parked ref, CAS loss returns `cas-lost` with `actualTargetSha` and retains the parked ref
  - _Requirements: 1.5, 4.1, 4.5, 5.6, 7.1, 7.2, 7.3, 7.4, 9.4_

- [x] 2.5 Remove `squashMerge` and `MergePreconditionFailed`
  - Delete `squashMerge` from `src/lib/git/worktree.ts` and `MergePreconditionFailed` from `src/lib/workflow-graph/errors.ts`
  - Update direct importers (`src/lib/workflows/merge/actors.ts`, `src/lib/workflow-graph/graph-context-squash-merge-actor.ts`) in the same change; do not retain a backwards-compat shim
  - Delete or rewrite tests that targeted the removed functions; coverage migrates to the new prepare/publish primitives' tests
  - _Requirements: 2.6_

- [x] 3. Rework merge orchestration around the prepare/publish split
- [x] 3.1 Add `prepareActor` XState wrapper around `prepareSquashMerge`
  - Add `prepareActor` to `src/lib/workflows/merge/actors.ts` that reads `featureSha` via `git -C <worktreePath> rev-parse HEAD` and `targetSha` via `git -C <projectPath> rev-parse refs/heads/<targetBranch>` immediately before invoking `prepareSquashMerge`
  - Map the result to `{ status: "prepared"; preparedSha; expectedTargetSha; parkedRef } | { status: "conflicts"; expectedTargetSha; conflictFiles }`
  - Do not acquire any lock in this actor
  - Add actor tests in `actors.test.ts` (or `machine.test.ts`) verifying the captured `expectedTargetSha` is the SHA read immediately before invocation
  - _Requirements: 2.1, 2.4, 2.5_

- [x] 3.2 Add `publishActor` XState wrapper with narrowed project-lock scope
  - Add `publishActor` to `src/lib/workflows/merge/actors.ts`: call `discoverTargetCheckout` first (no lock); if `dirty`, return `ready-to-land` immediately without acquiring the lock
  - Acquire `acquireProjectLock(projectPath)` (factor the existing 30s / 100ms retry loop into a shared helper so it is reused by the graph actor); release in `finally`
  - Inside the lock: invoke `publishPreparedMerge` with `cleanTargetWorktreePath` derived from discovery, then (when `finalizeSession === true`) run `setSessionFinished`, `retargetOrphanedChildren`, `stopAllForSession`, and broadcast the terminal SSE
  - Map outputs to `{ status: "completed"; mergeHash; refreshWarning? } | { status: "ready-to-land"; parkedRef; preparedSha; targetWorktreePath } | { status: "cas-lost"; actualTargetSha } | { status: "failed"; error }`
  - Add tests covering: dirty short-circuit does not acquire the lock; CAS loss returns without finalizing; finalization is gated on `finalizeSession`
  - _Requirements: 4.1, 4.4, 4.5, 5.1, 5.2, 5.6, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 12.7_

- [x] 3.3 Extend `mergeMachine` with `preparing`, `publishing`, and `readyToLand` states
  - Add `preparing` (invokes `prepareActor`, entry assigns `phase: "preparing"`) and `publishing` (invokes `publishActor`, entry assigns `phase: "publishing"`) to `src/lib/workflows/merge/machine.ts`; remove the old `squashMerging` state
  - Wire `validating → preparing` on success, `preparing → publishing` on `prepared`, `preparing → failed` on `conflicts` (carrying `conflictFiles`)
  - Wire `publishing → completed` (carry `mergeHash` and optional `refreshWarning`)
  - Wire `publishing → readyToLand` on the `ready-to-land` output; `readyToLand` is terminal, entry assigns `phase: "awaiting-land"`, output carries `parkedRef` and `preparedSha`
  - Add `casAttempt` (initial 1), `maxCasAttempts` (default 3), `preparedSha`, `expectedTargetSha`, `parkedRef`, `refreshWarning`, `entryMode` to machine context
  - Add tests in `machine.test.ts` for `preparing → publishing` happy path and `publishing → readyToLand` short-circuit
  - _Requirements: 4.2, 5.2, 5.5, 12.2, 18.6, 18.7, 18.8_

- [x] 3.4 Add the CAS-loss → re-prepare loop with bounded retry
  - Add a guarded `publishing → preparing` edge with `guard: ({ context }) => context.entryMode === "merge" && context.casAttempt < context.maxCasAttempts`; on transition, assign `casAttempt: ({ context }) => context.casAttempt + 1` and clear `preparedSha`/`expectedTargetSha`/`parkedRef`
  - Add an explicit `publishing → failed` edge for CAS loss when retries are exhausted, error message `"CAS contention exhausted on target branch <name>"`
  - Add an explicit `publishing → failed` edge for CAS loss in Land mode (`entryMode === "land"`), error message `"Target branch advanced since prepare; re-run merge to refresh the prepared commit."`
  - Add tests in `machine.test.ts`: CAS-loss + retries-remain reruns prepare and increments `casAttempt`; CAS-loss + retries-exhausted ends in `failed` with the expected error; Land-mode CAS-loss never re-enters `preparing`
  - _Requirements: 4.2, 4.3, 6.2_

- [x] 3.5 Add `entryRouting`, `landing`, `discarding`, and `discarded` states
  - Add a transient `entryRouting` initial state with three guarded `always` transitions: `merge → verifyingBranch`, `land → publishing`, `discard → discarding`; set `entryMode` from `MergeInput` so the input-to-context mapping runs before the routing transitions
  - For the `land` entry path: enter `publishing` directly with `preparedSha`, `expectedTargetSha`, and `parkedRef` taken from the existing job record; the machine must not visit `verifyingBranch`, `checkingUncommitted`, `mergingMain`, `validating`, `preparing`, or any conflict state on this path
  - For the `discard` entry path: enter `discarding`, invoke a thin actor that deletes the parked ref via `git update-ref -d <parkedRef> <preparedSha>`, then transition to terminal `discarded`
  - Extend the machine output union with `"ready-to-land"` and `"discarded"` statuses; carry `parkedRef`, `preparedSha`, `refreshWarning` on the appropriate outputs
  - Add tests in `machine.test.ts`: Land entry path skips prepare and the conflict/validation chain; Discard entry path transitions to `discarded` with the parked ref deleted
  - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 3.6 Apply phase-clearing rule on terminal transitions
  - On entry to `completed`, `failed`, `conflicts`, and `discarded`: clear `phase` (assign `null` in context, omit from the terminal SSE payload)
  - On entry to `readyToLand`: assign `phase: "awaiting-land"` and retain it on the in-memory job record until Land or Discard runs
  - Add a test verifying the terminal SSE event for `completed`/`failed`/`conflicts`/`discarded` carries no `phase`, and the `readyToLand` event carries `phase: "awaiting-land"`
  - _Requirements: 18.8, 18.10_

- [x] 4. Rewrite `graphContextSquashMergeActor` to use the prepare/publish primitives
- [x] 4.1 Replace `runGraphContextSquashMerge` with the prepare/publish split
  - In `src/lib/workflow-graph/graph-context-squash-merge-actor.ts`, capture `targetSha` and `featureSha`, invoke `prepareSquashMerge`, then `discoverTargetCheckout`, then acquire the project lock (via the shared helper from task 3.2), invoke `publishPreparedMerge`, and release the lock
  - On `cas-lost`, release the lock and re-run from the prepare step up to `maxCasAttempts` (default 3); on exhaustion, return `failed`
  - On `dirty` discovery, return `ready-to-land` without acquiring the lock and without finalizing
  - Extend the actor's output union to `{ kind: "completed" | "ready-to-land" | "cas-lost" | "failed", ... }` so the graph runner can route each outcome
  - Do not run `setSessionFinished`, `retargetOrphanedChildren`, or `stopAllForSession` from this actor (existing contract preserved)
  - Add tests in `graph-context-squash-merge-actor.test.ts`: clean-target completed path, dirty-target `ready-to-land` path without finalization, CAS-loss re-prepare loop, CAS exhaustion `failed` path
  - _Requirements: 2.1, 4.1, 4.2, 5.2, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4_

- [x] 5. Add Land and Discard API routes and update the existing merge route
- [x] 5.1 (P) Create `POST /api/projects/[name]/sessions/[session]/merge/land`
  - Add the route under `src/app/api/projects/[name]/sessions/[session]/merge/land/route.ts` re-exporting handlers from `src/lib/merge/route-handlers.ts` (or the existing merge route-handlers module)
  - Validate that the job exists, is in `ready-to-land`, and that `refs/cc-merges/<jobId>` still resolves; return 400/404/409 on mismatch
  - Dispatch a new job via the existing jobs queue with `entryMode: "land"`; return 202 with the job ID
  - Add route tests for: success (202), unknown job (404), wrong status (409), missing parked ref (409)
  - _Requirements: 6.1, 6.3_

- [x] 5.2 (P) Create `POST /api/projects/[name]/sessions/[session]/merge/discard`
  - Add the route under `src/app/api/projects/[name]/sessions/[session]/merge/discard/route.ts` re-exporting from the merge route-handlers module
  - Validate the job is in `ready-to-land`; dispatch a job with `entryMode: "discard"`; return 202 with the job ID
  - Add route tests for: success (202), wrong status (409)
  - _Requirements: 6.6_

- [x] 5.3 (P) Remove the target-worktree precondition from the existing merge route
  - In the existing `POST /api/projects/[name]/sessions/[session]/merge` handler, remove any pre-check, warning payload, or 4xx response that was derived from the target worktree's dirty state
  - Preserve all other validation (project exists, session exists, not finished, message non-empty)
  - Update or remove the route test that asserted the precondition warning behavior
  - _Requirements: 20.7_

- [x] 6. Surface `ready-to-land` and the Land action in the UI
- [x] 6.1 (P) Add `LandPreparedMergeButton` cross-feature component
  - Create `src/components/LandPreparedMergeButton.tsx` taking a `job: BackgroundJob` prop (must be in `ready-to-land`)
  - Render two actions — **Land** (POST `/merge/land`) and **Discard** (POST `/merge/discard`) — each disabled while the matching request is in flight
  - Display truncated `preparedSha` and the branch name from the job record
  - Add a Storybook story exercising idle, Land-in-flight, and Discard-in-flight states
  - _Requirements: 5.4, 6.1, 6.6_

- [x] 6.2 (P) Extend `NotificationsPanel` to render `ready-to-land` jobs
  - In the notifications panel, render `ready-to-land` jobs with a distinct success-pending-action badge (per Requirement 5.5 — not the failure style)
  - Embed `LandPreparedMergeButton` per row; clicking the row navigates to the session page
  - Count `ready-to-land` jobs toward the topbar badge
  - Update or add a Storybook story showing the `ready-to-land` row variant
  - _Requirements: 5.4, 6.1, 16.3, 16.5, 16.6_

- [x] 6.3 (P) Add a `ready-to-land` variant to `MergeToast`
  - Add a toast variant whose body shows the branch name, an "Awaiting clean target" subtitle, and the Land affordance
  - The toast must persist (not auto-dismiss) until the user lands or discards
  - Update or add a Storybook story for the new variant
  - _Requirements: 5.4, 10.6_

- [x] 6.4 (P) Remove the target-dirty warning from `SmartMergeDialog`
  - Delete any UI element that warned about, blocked, or asked about the target worktree state inside `SmartMergeDialog`
  - Preserve the auto-resolve toggle, the message field, the submit button, the session-uncommitted-changes warning (about the session worktree, not the target), and the submitted confirmation state
  - Update or remove the Storybook story for the removed warning
  - _Requirements: 20.7_

- [x] 7. Update notification store and SSE handling for new statuses and phases
- [x] 7.1 (P) Surface `ready-to-land`, `discarded`, and the new phases through the notification store
  - In `notification.store.ts` `addOrUpdateJob`, map `parkedRef`, `preparedSha`, `refreshWarning`, and `phase` from the incoming event onto the stored job
  - Treat `ready-to-land` as an actionable terminal state (counted in the active-jobs selector that drives the topbar badge); treat `discarded` as a terminal non-actionable state
  - Update `getActiveJobs` and `getJobsBySession` selectors so `ready-to-land` jobs are surfaced as actionable until the user lands or discards
  - Add unit tests for the new fields and the `ready-to-land`/`discarded` transitions
  - _Requirements: 5.5, 6.6, 16.6, 18.2_

- [x] 7.2 (P) Map phase-aware labels in `NotificationsPanel`
  - Update `getItemLabel()` (or equivalent) to return "Preparing merge..." for `preparing`, "Publishing..." for `publishing`, and "Awaiting clean target..." for `awaiting-land`, in addition to existing phase labels
  - Update or add a Storybook story exercising each of the three new labels
  - _Requirements: 18.9_

## Coverage check

- prepareSquashMerge plumbing path → 2.2
- prepareSquashMerge temp-worktree fallback → 2.3
- publishPreparedMerge with CAS retry → 2.4 (CAS + refresh + parked-ref cleanup), 3.4 (retry loop in machine), 4.1 (retry loop in graph actor)
- Checked-out target discovery → 2.1
- Ready-to-land terminal state in the merge state machine → 3.3, 3.5
- Clean-checkout refresh → 2.4
- Narrowed project lock to publish-only → 3.2 (machine actor), 4.1 (graph actor)
- `graphContextSquashMergeActor` updated → 4.1
- Job / SSE schemas updated → 1.1, 1.2
- Land API route + UI affordance → 5.1, 6.1, 6.2, 6.3
- Discard API route → 5.2
- `SmartMergeDialog` precondition removal → 5.3, 6.4
- Tests updated across `worktree.test.ts` → 2.1, 2.2, 2.3, 2.4; `machine.test.ts` → 3.3, 3.4, 3.5, 3.6; `graph-context-squash-merge-actor.test.ts` → 4.1
- WIP-commit cleanup → not included (out of scope, per Requirements §Out of Scope)
