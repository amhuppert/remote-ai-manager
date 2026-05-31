# Requirements Document

## Introduction

The Smart Merge feature improves CC's merge-into-main workflow across four interconnected areas: (1) a **prepare-then-publish merge architecture** that produces and validates a candidate squash commit without ever modifying the target (main) worktree, then publishes atomically via a compare-and-swap on the branch ref; (2) a safer two-phase merge strategy that resolves conflicts on the feature branch rather than main; (3) asynchronous background processing for commit and merge operations so the user is never blocked; and (4) automated merge conflict resolution powered by Claude Code with structured output and per-conflict review controls.

The current implementation runs the entire squash merge inside the target worktree, throws a hard `MergePreconditionFailed` when the target has any tracked dirty file, and relies on a project-wide in-memory lock that wraps the full prepare + publish window. This revision rewrites the architecture so that long-running prepare and validation work runs entirely off the target worktree, the lock is held only during the narrow publish/finalization critical section, branch-ref correctness is guaranteed by an atomic `git update-ref` CAS, and a dirty target at publish time produces a new terminal outcome (`ready-to-land`) that parks the prepared commit for a subsequent user-initiated "Land" action instead of failing the job.

## Requirements

### Requirement 1: Two-Phase Merge with Conflict Resolution on Feature Branch

**Objective:** As a developer, I want the merge process to resolve conflicts on the feature branch before producing the squash commit, so that the target branch is never left in a conflicted state.

#### Acceptance Criteria

1. When the user initiates a merge, the Smart Merge Service shall first merge the target branch into the session's feature branch (regular merge in the session worktree) before producing the squash commit.
2. When the merge of target into the feature branch completes without conflicts, the Smart Merge Service shall proceed to the prepare phase that produces the squash commit.
3. If the merge of target into the feature branch produces conflicts, the Smart Merge Service shall halt the merge pipeline and surface the conflicting files to the user without modifying the target branch in any way.
4. If the merge of target into the feature branch produces conflicts, the Smart Merge Service shall leave the session worktree in the conflict state (not abort the merge) so that conflict resolution can proceed in-place.
5. When the publish phase succeeds, the Smart Merge Service shall report the resulting merge commit hash to the user.

### Requirement 2: Prepare-Then-Publish Merge Architecture

**Objective:** As a developer, I want the long-running prepare and validation phases of a merge to never touch the target (main) worktree, so that uncommitted work in the target worktree does not block or interfere with merge jobs and so that the target worktree's state is unaffected by merge preparation.

#### Acceptance Criteria

1. The Smart Merge Service shall split the squash merge into two distinct phases: a **prepare** phase that produces a candidate squash commit OID, and a **publish** phase that advances the target branch ref to that OID.
2. While the prepare phase is running, the Smart Merge Service shall not perform any `git` operation that writes to the target branch's checked-out worktree (no `merge`, `commit`, `reset`, `checkout`, `read-tree`, or any other operation that mutates the target worktree's index, HEAD, or working tree).
3. While pre-merge validation is running, the Smart Merge Service shall not perform any operation that writes to the target branch's checked-out worktree.
4. When the prepare phase completes successfully, the Smart Merge Service shall produce both a prepared commit OID and the target SHA observed at the start of prepare (recorded as the `expected-old` value for the subsequent publish CAS).
5. When the prepare phase completes successfully, the Smart Merge Service shall park the prepared commit at a private ref `refs/cc-merges/<jobId>` so that the commit is reachable and not eligible for garbage collection until publish (or cleanup) consumes it.
6. The Smart Merge Service shall remove the `MergePreconditionFailed` error from the prepare phase entirely; uncommitted changes in the target worktree shall not block, abort, or fail the prepare phase regardless of which files are dirty.

### Requirement 3: Plumbing-Based Prepare with Detached-Worktree Fallback

**Objective:** As a developer, I want merge preparation to use fast, side-effect-free git plumbing on supported Git versions and to fall back transparently when plumbing is not viable, so that the prepare path is robust across environments without sacrificing speed or isolation on the common path.

#### Acceptance Criteria

1. When the host Git version is 2.38 or newer and no documented parity gap applies, the Smart Merge Service shall use the plumbing prepare path: `git merge-tree --write-tree <TARGET_SHA> <FEATURE_SHA>` to compute the merge tree, then `git commit-tree <tree> -p <TARGET_SHA> -m <message>` to produce a single-parent squash commit.
2. If `git merge-tree --write-tree` reports conflicts (non-zero exit status with conflict-info output), the Smart Merge Service shall surface the conflicts through the existing conflict-resolution pipeline (Requirements 10–12) without attempting to produce a commit.
3. Where the host Git version is older than 2.38 or a documented parity gap applies, the Smart Merge Service shall use the fallback prepare path: create a temporary detached worktree at `.worktrees/__merge_<jobId>` from the target SHA, run `git merge --squash <featureBranch>` followed by `git commit --no-verify -m <message>` inside it, capture the resulting commit SHA, and then remove the temporary worktree with `git worktree remove -f`.
4. The Smart Merge Service shall ensure both prepare paths produce the same downstream artifact shape: `{ preparedSha, expectedTargetSha, parkedRef }` plus optional conflict information.
5. When either prepare path produces a commit, the Smart Merge Service shall intentionally match commit metadata (author identity, committer identity, message handling, signing posture) to today's `git commit --no-verify` behavior, and shall document any deliberate deltas.
6. If the fallback temporary worktree exists when the prepare phase ends (success or failure), the Smart Merge Service shall remove it before returning so that no stray `.worktrees/__merge_<jobId>` directory is left behind.

### Requirement 4: Atomic Publish via Compare-and-Swap on Target Ref

**Objective:** As a developer, I want the published merge to land atomically against the target ref I expected, so that two concurrent merges cannot silently overwrite each other and so that a moving target tip is detected and handled deterministically rather than producing a stale-base merge.

#### Acceptance Criteria

1. When the publish phase advances the target branch, the Smart Merge Service shall use `git update-ref refs/heads/<targetBranch> <NEW_SHA> <expected-old>`, where `<expected-old>` is the target SHA recorded at the start of the prepare phase.
2. If `git update-ref` fails because the current target SHA differs from `<expected-old>` (stale base / lost CAS), the Smart Merge Service shall re-run the prepare phase against the new target tip and retry the publish, up to a bounded retry count (default: 3 attempts including the original try).
3. If the bounded retry count is exhausted without a successful CAS, the Smart Merge Service shall transition the merge job to `failed` with an error message identifying repeated CAS contention on the target branch.
4. The Smart Merge Service shall treat `git update-ref` (with explicit `<expected-old>`) as the authoritative correctness primitive for branch-ref integrity; it shall not rely on an in-process lock alone to prevent concurrent merges from clobbering each other's commits.
5. When `git update-ref` succeeds, the Smart Merge Service shall record the new commit SHA as the merge result and surface it via the job status and the `merge-completed` SSE event.

### Requirement 5: `ready-to-land` Terminal Outcome for Dirty Target Worktree

**Objective:** As a developer, I want a prepared merge to be parked (not failed) when the target branch is checked out in a worktree that has uncommitted tracked changes at publish time, so that my in-progress work on main is never lost or trampled and I can land the prepared commit myself when convenient.

#### Acceptance Criteria

1. When the publish phase is about to run, the Smart Merge Service shall discover, via `git worktree list --porcelain`, whether the target branch is currently checked out in any worktree.
2. If the target branch is checked out in a worktree AND that worktree has at least one tracked file with uncommitted changes (per `git status --porcelain` filtered to tracked entries), the Smart Merge Service shall NOT advance the target ref, shall leave the prepared commit parked at `refs/cc-merges/<jobId>`, and shall transition the merge job to a new terminal state `ready-to-land`.
3. When a merge job transitions to `ready-to-land`, the Smart Merge Service shall emit a `job-status` SSE event whose status is `ready-to-land` and whose payload includes the parked ref name and the prepared commit SHA.
4. When a merge job transitions to `ready-to-land`, the Smart Merge Service shall surface a notification informing the user that the merge has been prepared but the target worktree is dirty, with an affordance to land the prepared merge later.
5. The Smart Merge Service shall treat `ready-to-land` as a terminal state distinct from `failed` and from `completed`; downstream consumers (notifications, UI badges, history) shall display it as a successful preparation awaiting user action, not as a failure.
6. While a job is in `ready-to-land`, the Smart Merge Service shall not allow the parked ref `refs/cc-merges/<jobId>` to be garbage-collected and shall only delete it after the corresponding Land action succeeds or the user explicitly discards the prepared merge.

### Requirement 6: Land Prepared Merge Action

**Objective:** As a developer, I want a user-initiated "Land prepared merge" action that completes a `ready-to-land` job once the target worktree is clean (or no longer checked out), so that I can publish the prepared commit without re-running prepare and validation.

#### Acceptance Criteria

1. Where a merge job is in the `ready-to-land` state, the Smart Merge Service shall expose a "Land prepared merge" action keyed by the job's parked ref.
2. When the user invokes the Land action, the Smart Merge Service shall re-run only the publish-phase checks: (a) re-discover the target worktree, (b) re-check dirty state if the target branch is checked out, and (c) verify that `refs/cc-merges/<jobId>` still resolves to the previously prepared commit.
3. When the user invokes the Land action and the target is clean (or no longer checked out), the Smart Merge Service shall advance the target ref using the same CAS protocol as Requirement 4 and then run the standard finalization (Requirement 7 worktree refresh, Requirement 9 finalization side effects).
4. If the user invokes the Land action while the target worktree is still dirty, the Smart Merge Service shall keep the job in `ready-to-land`, leave the parked ref intact, and report that the target is still dirty.
5. When the Land action succeeds, the Smart Merge Service shall transition the job to `completed`, broadcast a `merge-completed` SSE event with the new merge SHA, and delete the parked ref `refs/cc-merges/<jobId>`.
6. If the user explicitly discards a `ready-to-land` job, the Smart Merge Service shall delete the parked ref and transition the job to a `discarded` terminal state without advancing the target branch.

### Requirement 7: Clean-Checkout Refresh After Publish

**Objective:** As a developer, I want the target worktree's HEAD, index, and working tree to stay coherent with the newly published commit when the target branch is checked out cleanly, so that the worktree does not silently fall behind the ref after a successful merge.

#### Acceptance Criteria

1. When the publish phase successfully advances the target ref AND the target branch is checked out in a worktree AND that worktree has no uncommitted tracked changes, the Smart Merge Service shall update the target worktree to match the new commit using `git -C <targetWorktree> reset --hard <NEW_SHA>` (or an equivalent `read-tree --reset -u` invocation).
2. When the publish phase successfully advances the target ref AND the target branch is not checked out in any worktree, the Smart Merge Service shall skip the worktree-refresh step entirely.
3. The Smart Merge Service shall never run the clean-checkout refresh against a worktree that has uncommitted tracked changes; Requirement 5 governs the dirty case instead.
4. If the clean-checkout refresh fails, the Smart Merge Service shall record the failure in the job result without rolling back the published ref (the merge itself is already durable in `refs/heads/<targetBranch>`), and shall surface the refresh failure to the user as a non-fatal warning.

### Requirement 8: Narrowed Project Lock Scope

**Objective:** As a developer, I want the project-level lock to wrap only the narrow publish + finalization critical section, so that long-running prepare and validation work does not starve concurrent activity on the project and so that the lock's purpose (serializing local finalization side effects) is clearly bounded.

#### Acceptance Criteria

1. The Smart Merge Service shall acquire `acquireProjectLock` (or equivalent project-level lock) only at the entry to the publish phase and shall release it at the end of finalization.
2. The Smart Merge Service shall not hold the project lock during the prepare phase, during pre-merge validation, during conflict resolution, or during auto-recovery of validation errors.
3. While the project lock is held, the Smart Merge Service shall perform only: target-worktree state discovery, the `git update-ref` CAS (with bounded retry per Requirement 4), the clean-checkout refresh (Requirement 7), and the finalization side effects (Requirement 9).
4. The Smart Merge Service shall treat the project lock as a finalization-side-effect serializer, not as the correctness primitive for branch-ref integrity; correctness against concurrent publishers is provided by the `git update-ref` CAS (Requirement 4).
5. The session lock (`acquireSessionLock`) and conversation lock (`acquireConversationLock`) shall be unchanged by this revision in scope and duration.

### Requirement 9: Finalization Side Effects

**Objective:** As a developer, I want session lifecycle bookkeeping to run reliably immediately after publish, so that a successful merge results in a finished session, retargeted orphans, stopped child sessions, cleaned-up parked refs, and broadcast job/SSE status.

#### Acceptance Criteria

1. When the publish phase succeeds, the Smart Merge Service shall mark the merging session as finished (`setSessionFinished`).
2. When the publish phase succeeds, the Smart Merge Service shall retarget any orphaned child sessions whose parent was the merged feature branch (`retargetOrphanedChildren`).
3. When the publish phase succeeds, the Smart Merge Service shall stop all running activity for the merged session (`stopAllForSession`).
4. When the publish phase succeeds, the Smart Merge Service shall delete the parked ref `refs/cc-merges/<jobId>`.
5. When the publish phase succeeds, the Smart Merge Service shall broadcast a terminal `job-status` SSE event whose status is `completed` and whose payload includes the new merge commit SHA.
6. All finalization side effects in this requirement shall execute under the same narrow project-lock window as the publish (per Requirement 8).

### Requirement 10: Asynchronous Merge Operations

**Objective:** As a developer, I want merge operations to run in the background, so that I can continue working in other sessions while the merge completes.

#### Acceptance Criteria

1. When the user submits a merge request, the Smart Merge Service shall accept the request, start the merge operation as a background job, and return an acknowledgment immediately without blocking the UI.
2. While a merge background job is running, the Smart Merge Service shall hold the session lock for the duration of the job to prevent concurrent git operations on the same session.
3. When a merge background job reaches any terminal state (`completed`, `failed`, `ready-to-land`, `discarded`, or conflicts detected), the Smart Merge Service shall broadcast the result via an SSE event so that all connected clients receive the notification.
4. When the user submits a merge request, the Smart Merge Service shall allow the user to close the merge dialog immediately and navigate freely to other pages while the merge runs.
5. When a merge job completes successfully, the Smart Merge Service shall display an ephemeral toast notification showing the branch name and merge commit hash with an action to view the result.
6. When a merge job ends in `ready-to-land`, the Smart Merge Service shall display an ephemeral toast notification showing the branch name and indicating that the prepared merge is awaiting a clean target.
7. When a merge job detects conflicts, the Smart Merge Service shall display an ephemeral toast notification showing the branch name and conflict count with an action to review the conflicts.
8. If a merge job fails with an error, the Smart Merge Service shall display an ephemeral toast notification showing the branch name and error message.

### Requirement 11: Asynchronous Commit Operations

**Objective:** As a developer, I want commit operations to run in the background, so that I am not blocked by pre-commit hooks or large changesets.

#### Acceptance Criteria

1. When the user submits a commit request, the Smart Merge Service shall accept the request, start the commit operation as a background job, and return an acknowledgment immediately.
2. While a commit background job is running, the Smart Merge Service shall hold the session lock for the duration of the job to prevent concurrent git operations.
3. When a commit background job completes (success or failure), the Smart Merge Service shall broadcast the result via an SSE event.
4. When a commit job completes successfully, the Smart Merge Service shall display a notification showing the commit hash and branch name.
5. If a commit job fails, the Smart Merge Service shall display a notification showing the error message and branch name.

### Requirement 12: Background Job Infrastructure

**Objective:** As a developer, I want a reliable background job system for git operations, so that async commit and merge operations are tracked and their results are delivered.

#### Acceptance Criteria

1. The Smart Merge Service shall maintain an in-memory registry of active background jobs, keyed by session.
2. The background job system shall track job lifecycle states including `pending`, `running`, `preparing`, `publishing`, `completed`, `failed`, `ready-to-land`, `discarded`, and `conflicts`.
3. When a background job transitions between states, the Smart Merge Service shall broadcast a `job-status` SSE event containing the job type (commit or merge), status, project name, session name, and result data.
4. While a background job is running for a session, the Smart Merge Service shall prevent new commit or merge jobs from starting on the same session.
5. When a background job completes (success, failure, or any terminal state including `ready-to-land` and `discarded`), the Smart Merge Service shall guarantee the session lock is released, even if the job throws an unhandled exception.
6. If a running job exceeds a configurable timeout (default: 10 minutes), the Smart Merge Service shall allow the stale job to be force-transitioned to `failed` and its lock released when a new job is dispatched for the same session.
7. When two or more publish phases attempt to advance the same target branch concurrently, the Smart Merge Service shall serialize the publish side effects via the narrowed project lock (Requirement 8) and rely on the `git update-ref` CAS (Requirement 4) as the correctness primitive.

### Requirement 13: Auto-Resolve Conflicts Toggle

**Objective:** As a developer, I want to choose between automatic and manual conflict resolution at merge time, so that I can either let Claude fix everything or review each conflict individually.

#### Acceptance Criteria

1. When the user opens the merge dialog, the Smart Merge Service shall display an auto-resolve conflicts toggle that is enabled by default.
2. When auto-resolve is enabled and the merge encounters conflicts, the Smart Merge Service shall automatically invoke Claude Code to analyze and resolve all conflicts without requiring user review first.
3. When auto-resolve is disabled and the merge encounters conflicts, the Smart Merge Service shall notify the user and direct them to the conflict resolution page for manual review.
4. When auto-resolve is enabled and Claude successfully resolves all conflicts, the Smart Merge Service shall commit the resolution and proceed with the prepare-then-publish merge pipeline automatically.
5. When auto-resolve is enabled and Claude fails to resolve conflicts, the Smart Merge Service shall fall back to notifying the user and directing them to the conflict resolution page.

### Requirement 14: Conflict Analysis with Claude Code

**Objective:** As a developer, I want Claude Code to analyze merge conflicts and provide structured resolution proposals, so that I can understand each conflict and its proposed fix before applying.

#### Acceptance Criteria

1. When conflict resolution is triggered, the Smart Merge Service shall invoke the Claude Agent SDK `query()` API in the session worktree (never the target worktree) with a prompt adapted for merge conflict analysis.
2. The Smart Merge Service shall request structured output from Claude containing, for each conflict: the file path, a description of the conflict, the proposed resolution, and a rationale explaining why the resolution is correct and will not lose work.
3. When Claude returns conflict analysis, the Smart Merge Service shall store the structured results and make them available via the conflicts API endpoint.
4. The conflict resolution prompt shall instruct Claude to resolve conflict markers in the session worktree files directly, in addition to providing the structured analysis.
5. While the `analyzingConflicts` and `resolvingConflicts` workflow states are active, the Smart Merge Service shall preserve today's UX (state machine surface, SSE events, conflict-resolution UI behavior) with no behavioral change introduced by this revision.

### Requirement 15: Manual Conflict Review Page

**Objective:** As a developer, I want a dedicated full-page view for reviewing merge conflicts, so that I can approve, reject, or provide feedback on each conflict resolution individually.

#### Acceptance Criteria

1. When the user navigates to the conflict resolution page (MergeConflictsPage), the Smart Merge Service shall display each conflict as an expandable review card showing the file path, conflict description, proposed resolution, and rationale.
2. The Smart Merge Service shall allow the user to approve or reject each conflict resolution independently using per-card toggle buttons.
3. When the user approves a conflict resolution, the Smart Merge Service shall auto-collapse that conflict card.
4. When the user rejects a conflict resolution, the Smart Merge Service shall auto-expand the card and display a text input for the user to provide additional guidance to Claude.
5. The Smart Merge Service shall display a summary banner showing the total conflict count and counts for approved, rejected, and pending conflicts.
6. When the user clicks "Accept All and Fix," the Smart Merge Service shall mark all conflicts as approved and fire an async resolution job.
7. When the user clicks "Fix with Claude," the Smart Merge Service shall send the per-conflict decisions (approved, rejected with feedback, or pending) to the resolve-conflicts API as an async job.
8. While a conflict resolution job is running, the Smart Merge Service shall allow the user to navigate away from the conflicts page without losing progress.
9. The MergeConflictsPage behavior described above shall be preserved exactly as today by this revision; this requirement is included to pin the unchanged contract.

### Requirement 16: Notifications Panel

**Objective:** As a developer, I want a persistent activity panel that shows all active conversations and background job results in one place, so that I can track ongoing work and find completed job results without relying on ephemeral toasts.

#### Acceptance Criteria

1. The Smart Merge Service shall provide a slide-in notifications panel accessible from the topbar that displays both active conversations and background job statuses.
2. The notifications panel shall display items grouped into "Conversations" and "Jobs" sections, each with a count badge.
3. The notifications panel shall support notification types for: active conversations (running, awaiting, waiting for input), merge jobs (running, success, conflicts, error, `ready-to-land`), and commit jobs (running, success, error).
4. Each notification item shall display a category icon, title, project/session context, status badge, and relative timestamp.
5. When the user clicks a notification item, the Smart Merge Service shall navigate to the relevant page (conversation page, session page, conflicts page, or land-prepared-merge affordance for `ready-to-land`) and close the panel.
6. The topbar badge shall reflect the total count of active items (active conversations plus in-progress or actionable jobs, including `ready-to-land` jobs awaiting user action).
7. When a new `job-status` SSE event is received, the Smart Merge Service shall update the notifications panel in real time without requiring a page refresh.

### Requirement 17: Pre-Merge Validation Auto-Recovery

**Objective:** As a developer, I want the merge pipeline to automatically fix pre-merge validation failures (lint errors, type errors, formatting issues) when auto-resolve is enabled, so that fixable issues don't block the merge.

#### Acceptance Criteria

1. When the merge pipeline runs pre-merge validation (e.g., ESLint, TypeScript, Prettier) and the validation fails, the Smart Merge Service shall attempt auto-recovery if auto-resolve is enabled.
2. When auto-recovery is triggered, the Smart Merge Service shall invoke Claude Code in the session worktree (never the target worktree) with the validation output, instructing it to fix all reported issues and stage the changes.
3. If Claude successfully fixes the validation errors, the Smart Merge Service shall commit the fixes and re-run the validation script once to verify.
4. If the re-validation passes, the Smart Merge Service shall proceed with the prepare-then-publish merge pipeline.
5. If Claude fails to fix the errors or the re-validation fails, the Smart Merge Service shall report the original validation error as a merge failure (same behavior as without auto-recovery).
6. Auto-recovery shall attempt at most one retry to prevent infinite loops.
7. The validation-fix module shall follow the same patterns as conflict resolution: Claude Agent SDK `query()` with `bypassPermissions`, configurable timeout, and `persistSession: false`.
8. Pre-merge validation shall not require, and shall not hold, the project-level lock; it executes entirely off the target worktree per Requirement 2.

### Requirement 18: Phase-Aware Job Status

**Objective:** As a developer, I want to see what phase a merge job is currently in (preparing, validating, fixing errors, publishing, awaiting-land), so that I have better visibility into long-running merge operations and the new prepare-then-publish split.

#### Acceptance Criteria

1. The `job-status` SSE event shall include an optional `phase` field indicating the current merge pipeline stage.
2. The `BackgroundJob` type shall include an optional `phase` field that is propagated through the notification store to the UI.
3. When a merge job enters pre-merge validation, the Smart Merge Service shall broadcast `phase: "validating"`.
4. When a merge job is auto-recovering validation errors, the Smart Merge Service shall broadcast `phase: "fixing-validation"`.
5. When validation is re-running after a fix attempt, the Smart Merge Service shall broadcast `phase: "re-validating"`.
6. When a merge job enters the prepare phase, the Smart Merge Service shall broadcast `phase: "preparing"`.
7. When a merge job enters the publish phase, the Smart Merge Service shall broadcast `phase: "publishing"`.
8. When a merge job is in `ready-to-land`, the Smart Merge Service shall broadcast `phase: "awaiting-land"`.
9. The Activities panel shall display phase-aware labels for running merge jobs: "Validating...", "Fixing errors...", "Preparing merge...", "Publishing...", "Awaiting clean target..." in place of the generic "Merging...".
10. The phase field shall be cleared (undefined) when the job reaches a terminal state, except that `ready-to-land` retains `phase: "awaiting-land"` until the user lands or discards.

### Requirement 19: Error Details in Activities Panel

**Objective:** As a developer, I want to see why a merge or commit job failed directly in the Activities panel, so that I don't need to check logs to understand the failure.

#### Acceptance Criteria

1. When a merge, commit, or resolve-conflicts job fails, the Activities panel shall display a concise error summary below the notification metadata.
2. The error summary shall intelligently extract the most meaningful line from the raw error output (e.g., ESLint problem count, TypeScript error messages, test failure counts, CAS retry exhaustion).
3. If no structured error pattern is matched, the summary shall fall back to the first meaningful line of the error, truncated to 100 characters.
4. The full raw error message shall be available as a native browser tooltip on hover over the error summary.
5. The error summary shall be styled in monospace font with the error color, matching the design system.

### Requirement 20: Smart Merge Dialog

**Objective:** As a developer, I want a merge dialog that submits the merge as a background job and immediately confirms submission, so that I can continue working without waiting.

#### Acceptance Criteria

1. When the user opens the merge dialog, the Smart Merge Service shall display the branch name, commit count, merge commit message field, and auto-resolve toggle.
2. If the session has uncommitted changes, the Smart Merge Service shall display a warning indicating that changes will be committed first.
3. When the user submits the merge, the Smart Merge Service shall transition the dialog to a "submitted" confirmation state showing that the merge job has started.
4. While in the submitted state, the Smart Merge Service shall display contextual messaging based on the auto-resolve setting (auto-resolve enabled vs. manual review mode).
5. The Smart Merge Service shall allow the user to dismiss the merge dialog at any time, including after submission.
6. When the user presses Cmd+Enter (or Ctrl+Enter) in the message field, the Smart Merge Service shall submit the merge.
7. The merge dialog shall not present any precondition warning, error, or block based on the state of the target (main) worktree; the prepare phase tolerates a dirty target worktree per Requirement 2, and the publish phase converts a dirty target into the `ready-to-land` outcome per Requirement 5.

## Out of Scope

The following items are intentionally deferred to follow-up slices and are NOT part of this revision:

- **WIP-commit cleanup.** Today, uncommitted changes on the feature branch are committed as `WIP: uncommitted changes` before merging the target branch in (the `committingUncommitted` workflow state). A cleaner approach (e.g., stash-based or `git write-tree` snapshot folded into the prepared squash) is a separate follow-up slice. It addresses branch-history cleanliness on the feature branch, not the target-worktree dirty block, and bundling it with this revision expands scope unnecessarily.
- **Cross-process / filesystem-level lockfile** for the project lock. CAS via `git update-ref` already protects branch-ref integrity across processes; an in-process lock for finalization side effects is sufficient for current CC deployment patterns.
- **Changes to the conflict-resolution UX** (`analyzingConflicts` / `resolvingConflicts` state-machine surface, MergeConflictsPage behavior, Claude conflict-analysis prompt shape). These are preserved unchanged by Requirements 14 and 15.
