# Requirements Document

## Introduction

The Smart Merge feature improves CC's merge-into-main workflow across three interconnected areas: a safer two-phase merge strategy that resolves conflicts on the feature branch rather than main, asynchronous background processing for commit and merge operations so the user is never blocked, and automated merge conflict resolution powered by Claude Code with structured output and per-conflict review controls.

Currently, merge operations are synchronous (blocking the user), merge directly into main (risking conflicts on the main branch), and offer no automated conflict resolution path. Smart Merge addresses all three shortcomings in a unified workflow.

## Requirements

### Requirement 1: Two-Phase Merge Strategy

**Objective:** As a developer, I want the merge process to resolve conflicts on the feature branch before touching main, so that the main branch is never left in a conflicted state.

#### Acceptance Criteria

1. When the user initiates a merge, CC shall first merge `main` into the session's feature branch (regular merge in the session worktree) before attempting the squash merge into main.
2. When the merge of main into the feature branch completes without conflicts, CC shall proceed to squash merge the feature branch into main using the existing squash merge logic.
3. If the merge of main into the feature branch produces conflicts, CC shall halt the merge pipeline and report the conflicting files to the user without modifying the main branch.
4. If the merge of main into the feature branch produces conflicts, CC shall leave the worktree in the conflict state (not abort the merge) so that conflict resolution can proceed in-place.
5. When the squash merge into main succeeds, CC shall report the resulting merge commit hash to the user.

### Requirement 2: Asynchronous Merge Operations

**Objective:** As a developer, I want merge operations to run in the background, so that I can continue working in other sessions while the merge completes.

#### Acceptance Criteria

1. When the user submits a merge request, CC shall accept the request, start the merge operation as a background job, and return an acknowledgment immediately without blocking the UI.
2. While a merge background job is running, CC shall hold the session lock for the duration of the job to prevent concurrent git operations on the same session.
3. When a merge background job completes (success, failure, or conflicts detected), CC shall broadcast the result via an SSE event so that all connected clients receive the notification.
4. When the user submits a merge request, CC shall allow the user to close the merge dialog immediately and navigate freely to other pages while the merge runs.
5. When a merge job completes successfully, CC shall display an ephemeral toast notification showing the branch name and merge commit hash with an action to view the result.
6. When a merge job detects conflicts, CC shall display an ephemeral toast notification showing the branch name and conflict count with an action to review the conflicts.
7. If a merge job fails with an error, CC shall display an ephemeral toast notification showing the branch name and error message.

### Requirement 3: Asynchronous Commit Operations

**Objective:** As a developer, I want commit operations to run in the background, so that I am not blocked by pre-commit hooks or large changesets.

#### Acceptance Criteria

1. When the user submits a commit request, CC shall accept the request, start the commit operation as a background job, and return an acknowledgment immediately.
2. While a commit background job is running, CC shall hold the session lock for the duration of the job to prevent concurrent git operations.
3. When a commit background job completes (success or failure), CC shall broadcast the result via an SSE event.
4. When a commit job completes successfully, CC shall display a notification showing the commit hash and branch name.
5. If a commit job fails, CC shall display a notification showing the error message and branch name.

### Requirement 4: Background Job Infrastructure

**Objective:** As a developer, I want a reliable background job system for git operations, so that async commit and merge operations are tracked and their results are delivered.

#### Acceptance Criteria

1. CC shall maintain an in-memory registry of active background jobs, keyed by session.
2. The background job system shall track job lifecycle states: pending, running, completed, failed, and conflicts.
3. When a background job transitions between states, CC shall broadcast a `job-status` SSE event containing the job type (commit or merge), status, project name, session name, and result data.
4. While a background job is running for a session, CC shall prevent new commit or merge jobs from starting on the same session.
5. When a background job completes (success, failure, or any terminal state), CC shall guarantee the session lock is released, even if the job throws an unhandled exception.
6. If a running job exceeds a configurable timeout (default: 10 minutes), CC shall allow the stale job to be force-transitioned to `failed` and its lock released when a new job is dispatched for the same session.
7. When multiple sessions attempt to squash merge into main concurrently, CC shall serialize the squash merge operations using a project-level lock so that only one squash merge executes against the main branch at a time.
8. If a squash merge cannot acquire the project-level lock within a timeout period (default: 30 seconds), CC shall transition the merge job to `failed` with an explanatory error message.

### Requirement 5: Auto-Resolve Conflicts Toggle

**Objective:** As a developer, I want to choose between automatic and manual conflict resolution at merge time, so that I can either let Claude fix everything or review each conflict individually.

#### Acceptance Criteria

1. When the user opens the merge dialog, CC shall display an auto-resolve conflicts toggle that is enabled by default.
2. When auto-resolve is enabled and the merge encounters conflicts, CC shall automatically invoke Claude Code to analyze and resolve all conflicts without requiring user review first.
3. When auto-resolve is disabled and the merge encounters conflicts, CC shall notify the user and direct them to the conflict resolution page for manual review.
4. When auto-resolve is enabled and Claude successfully resolves all conflicts, CC shall commit the resolution and proceed with the squash merge into main automatically.
5. When auto-resolve is enabled and Claude fails to resolve conflicts, CC shall fall back to notifying the user and directing them to the conflict resolution page.

### Requirement 6: Conflict Analysis with Claude Code

**Objective:** As a developer, I want Claude Code to analyze merge conflicts and provide structured resolution proposals, so that I can understand each conflict and its proposed fix before applying.

#### Acceptance Criteria

1. When conflict resolution is triggered, CC shall invoke the Claude Agent SDK `query()` API in the session worktree with a prompt adapted for merge conflict analysis.
2. CC shall request structured output from Claude containing, for each conflict: the file path, a description of the conflict, the proposed resolution, and a rationale explaining why the resolution is correct and will not lose work.
3. When Claude returns conflict analysis, CC shall store the structured results and make them available via the conflicts API endpoint.
4. The conflict resolution prompt shall instruct Claude to resolve conflict markers in the working tree files directly, in addition to providing the structured analysis.

### Requirement 7: Manual Conflict Review Page

**Objective:** As a developer, I want a dedicated full-page view for reviewing merge conflicts, so that I can approve, reject, or provide feedback on each conflict resolution individually.

#### Acceptance Criteria

1. When the user navigates to the conflict resolution page, CC shall display each conflict as an expandable review card showing the file path, conflict description, proposed resolution, and rationale.
2. CC shall allow the user to approve or reject each conflict resolution independently using per-card toggle buttons.
3. When the user approves a conflict resolution, CC shall auto-collapse that conflict card.
4. When the user rejects a conflict resolution, CC shall auto-expand the card and display a text input for the user to provide additional guidance to Claude.
5. CC shall display a summary banner showing the total conflict count and counts for approved, rejected, and pending conflicts.
6. When the user clicks "Accept All and Fix," CC shall mark all conflicts as approved and fire an async resolution job.
7. When the user clicks "Fix with Claude," CC shall send the per-conflict decisions (approved, rejected with feedback, or pending) to the resolve-conflicts API as an async job.
8. While a conflict resolution job is running, CC shall allow the user to navigate away from the conflicts page without losing progress.

### Requirement 8: Notifications Panel

**Objective:** As a developer, I want a persistent activity panel that shows all active conversations and background job results in one place, so that I can track ongoing work and find completed job results without relying on ephemeral toasts.

#### Acceptance Criteria

1. CC shall provide a slide-in notifications panel accessible from the topbar that displays both active conversations and background job statuses.
2. The notifications panel shall display items grouped into "Conversations" and "Jobs" sections, each with a count badge.
3. The notifications panel shall support notification types for: active conversations (running, awaiting, waiting for input), merge jobs (running, success, conflicts, error), and commit jobs (running, success, error).
4. Each notification item shall display a category icon, title, project/session context, status badge, and relative timestamp.
5. When the user clicks a notification item, CC shall navigate to the relevant page (conversation page, session page, or conflicts page) and close the panel.
6. The topbar badge shall reflect the total count of active items (active conversations plus in-progress or actionable jobs).
7. When a new job-status SSE event is received, CC shall update the notifications panel in real time without requiring a page refresh.

### Requirement 9: Smart Merge Dialog

**Objective:** As a developer, I want a merge dialog that submits the merge as a background job and immediately confirms submission, so that I can continue working without waiting.

#### Acceptance Criteria

1. When the user opens the merge dialog, CC shall display the branch name, commit count, merge commit message field, and auto-resolve toggle.
2. If the session has uncommitted changes, CC shall display a warning indicating that changes will be committed first.
3. When the user submits the merge, CC shall transition the dialog to a "submitted" confirmation state showing that the merge job has started.
4. While in the submitted state, CC shall display contextual messaging based on the auto-resolve setting (auto-resolve enabled vs. manual review mode).
5. CC shall allow the user to dismiss the merge dialog at any time, including after submission.
6. When the user presses Cmd+Enter (or Ctrl+Enter) in the message field, CC shall submit the merge.
