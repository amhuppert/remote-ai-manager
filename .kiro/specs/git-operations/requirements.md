# Requirements Document

## Introduction

This specification covers adding git operations and session lifecycle states to the Command Center (CC). Currently, CC creates isolated coding sessions backed by git worktrees and branches (`csm/<name>`), and displays uncommitted diffs against the merge-base (the point where the session branch diverged from `main`). These new capabilities allow users to commit changes within a worktree, squash-merge the session branch back into `main`, view the commit history for a session, archive sessions, and distinguish between active, archived, and finished (merged) sessions.

Two new session lifecycle concepts are introduced:
- **Archived** — User-initiated soft hide. Archived sessions are still fully editable (prompts, commits, merges all work). They are simply filtered out of the default sessions view.
- **Finished** — Automatically set when a session is merged into `main`. Finished sessions are read-only: no prompts, commits, or merges allowed. They serve as a historical record of completed work.

A session can be both archived and finished (e.g., merged then archived).

## Requirements

### Requirement 1: Commit Changes in Worktree

**Objective:** As a developer, I want to commit all changes in a session's worktree from the CC UI, so that I can create meaningful checkpoints without switching to a terminal.

#### Acceptance Criteria

1. When the user initiates a commit action from the session detail page, CC shall display a commit dialog requesting a commit message.
2. When the user submits the commit dialog with a non-empty message, CC shall stage all changes (modified, new, and deleted files) and create a commit in the session's worktree branch.
3. When the commit succeeds, CC shall dismiss the dialog, refresh the session view to reflect the new commit, and update the diff panel (since committed changes are no longer uncommitted).
4. If the worktree has no uncommitted changes when the user initiates a commit, CC shall disable the commit action and indicate that there are no changes to commit.
5. If the commit operation fails (e.g., git error), CC shall display the error message within the commit dialog without dismissing it, allowing the user to retry or cancel.
6. While a prompt is running (session status is "running"), CC shall disable the commit action to prevent committing mid-execution.
7. While the session is finished, CC shall disable the commit action.

### Requirement 2: Squash Merge Session Branch into Main

**Objective:** As a developer, I want to squash-merge a session's branch into `main` from the CC UI, so that I can integrate completed work as a single clean commit without leaving the dashboard.

#### Acceptance Criteria

1. When the user initiates a merge action from the session detail page, CC shall display a merge dialog showing the branch name, total number of commits to be squashed, and a field for the merge commit message.
2. When the user submits the merge dialog, CC shall perform a squash merge of the session branch into `main` using the provided commit message.
3. When the squash merge succeeds, CC shall mark the session as finished, archive the session, and navigate back to the project's sessions list.
4. If the session's worktree has uncommitted changes when the user initiates a merge, CC shall block the merge action and display a message indicating that uncommitted changes must be committed or discarded before merging.
5. If the squash merge fails due to conflicts or other git errors, CC shall display the error message within the merge dialog without dismissing it, allowing the user to cancel and resolve issues manually.
6. While a prompt is running (session status is "running"), CC shall disable the merge action to prevent merging mid-execution.
7. If the session branch has no commits beyond `main` (nothing to merge), CC shall disable the merge action and indicate that there are no changes to merge.
8. While the session is finished, CC shall disable the merge action.

### Requirement 3: View Session Commit History

**Objective:** As a developer, I want to see a list of commits made in a session since it diverged from `main`, so that I can review the work done during the session and understand its progression.

#### Acceptance Criteria

1. The session detail page shall display a commit history list showing all commits on the session branch since it diverged from `main`.
2. Each commit entry in the list shall display the abbreviated commit hash, commit message, relative timestamp, and number of files changed.
3. When the user clicks on a commit entry, CC shall expand it to show the per-file diff for that commit.
4. For the first commit after the branch diverged from `main`, the per-commit diff shall compare against the merge-base (not the current tip of `main`), so that only the branch's own changes are shown.
5. For subsequent commits on the branch, the per-commit diff shall compare against the commit's immediate parent.
6. When a commit entry is expanded, clicking it again shall collapse the diff view.
7. If the session branch has no commits beyond `main`, the commit history shall display an empty state indicating no commits have been made yet.
8. When a new commit is created (via Requirement 1), the commit history list shall update to include the new commit without requiring a full page reload.

### Requirement 4: Session Archiving

**Objective:** As a developer, I want to archive and unarchive sessions, so that I can keep my sessions list focused on active work without permanently deleting completed sessions.

#### Acceptance Criteria

1. The sessions list page shall provide an archive action for each non-archived session and an unarchive action for each archived session.
2. When the user archives a session, CC shall mark the session as archived and it shall no longer appear in the default sessions view.
3. When the user unarchives a session, CC shall remove the archived flag and the session shall reappear in the default sessions view.
4. The sessions list page shall provide a toggle to show or hide archived sessions, following the same pattern used for archived projects on the projects dashboard.
5. While the sessions list shows archived sessions, each archived session shall be visually distinct (e.g., reduced opacity, dashed border) following the same treatment as archived projects.
6. Archived sessions shall remain fully editable — prompts, commits, and merges shall continue to work on archived sessions that are not finished.

### Requirement 5: Finished Session State

**Objective:** As a developer, I want merged sessions to be clearly marked as finished and read-only, so that I can distinguish completed work from sessions still in progress.

#### Acceptance Criteria

1. When a session is marked as finished (via successful merge in Requirement 2), CC shall persist the finished state and the session shall become read-only.
2. While a session is finished, the session detail page shall disable the prompt input, commit action, and merge action.
3. While a session is finished, the session detail page shall display a visible indicator that the session has been merged and is read-only.
4. The sessions list shall display finished sessions with a distinct visual treatment (e.g., a "merged" badge) so users can identify them at a glance.
5. Finished sessions shall remain viewable — conversation history, commit history, and diffs shall be accessible in read-only mode.

