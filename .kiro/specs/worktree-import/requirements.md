# Requirements Document

## Introduction

CSM currently only tracks sessions it creates itself. Git worktrees created outside CSM (via `git worktree add`, other tools, or other CSM instances) are invisible to the dashboard. This feature enables CSM to discover existing worktrees for a project using `git worktree list`, reconcile them against its state file, and import untracked worktrees as manageable sessions — giving users a complete view of all active worktrees without requiring that every worktree originate from CSM.

## Requirements

### Requirement 1: Worktree Discovery

**Objective:** As a developer, I want CSM to detect all existing git worktrees for a project, so that I can see and manage worktrees regardless of how they were created.

#### Acceptance Criteria
1. When a project's sessions are listed, CSM shall query the project's git repository using `git worktree list --porcelain` to enumerate all worktrees on disk.
2. The CSM shall parse the porcelain output to extract each worktree's absolute path, HEAD commit, and branch name (if any).
3. The CSM shall exclude the project's main working tree (the bare/root checkout) from the list of importable worktrees.
4. If `git worktree list` fails (e.g., not a git repo, git not installed), CSM shall log the error and fall back to returning only state-tracked sessions without interrupting the user experience.

### Requirement 2: State Reconciliation

**Objective:** As a developer, I want CSM to automatically reconcile its state file with the actual worktrees on disk, so that the session list stays accurate without manual intervention.

#### Acceptance Criteria
1. When sessions are listed for a project, CSM shall compare worktrees discovered on disk against sessions already tracked in the state file, matching by worktree path.
2. When a worktree exists on disk but has no matching session in state, CSM shall identify it as an importable worktree.
3. When a session exists in state but its worktree path no longer exists on disk and the session is not marked as finished, CSM shall flag it as orphaned in the API response.
4. The CSM shall not automatically delete orphaned session records from state; it shall only surface them so the user can decide.

### Requirement 3: Automatic Session Import

**Objective:** As a developer, I want untracked worktrees to be automatically imported as CSM sessions, so that I don't have to manually register each one.

#### Acceptance Criteria
1. When an untracked worktree is discovered during reconciliation, CSM shall automatically create a new `SessionState` record for it and persist it to the state file.
2. The CSM shall derive the session name from the worktree's branch name by stripping known prefixes (`csm/`, `refs/heads/`) and using the remaining value as the display name.
3. If the worktree has a detached HEAD (no branch), CSM shall derive the session name from the worktree directory name.
4. If a derived session name conflicts with an existing session name in the same project, CSM shall append a numeric suffix (e.g., `my-feature-2`) to ensure uniqueness.
5. The imported session's `createdAt` and `lastActivityAt` shall be set to the current timestamp at import time.
6. The imported session's `source` field shall be set to `"imported"` to distinguish it from CSM-created sessions.

### Requirement 4: Source Tracking

**Objective:** As a developer, I want to distinguish between sessions I created in CSM and sessions that were imported from existing worktrees, so that I understand the origin of each session.

#### Acceptance Criteria
1. The `SessionState` schema shall include a `source` field with allowed values `"csm"` and `"imported"`, defaulting to `"csm"`.
2. When CSM creates a session via the existing create flow, the session's `source` shall be `"csm"`.
3. When CSM imports a session from a discovered worktree, the session's `source` shall be `"imported"`.
4. The CSM shall preserve backward compatibility: existing sessions in the state file that lack the `source` field shall default to `"csm"` when parsed.

### Requirement 5: Deletion Semantics for Imported Sessions

**Objective:** As a developer, I want deleting an imported session to only unlink it from CSM without destroying the worktree on disk, so that I don't accidentally lose work managed outside CSM.

#### Acceptance Criteria
1. When an imported session (source = `"imported"`) is deleted, CSM shall remove only the session record from the state file without running `git worktree remove` on the worktree directory.
2. When a CSM-created session (source = `"csm"`) is deleted, CSM shall continue to remove the worktree from disk as it does today.
3. The delete API response shall indicate whether the worktree was removed from disk or only unlinked from state.

### Requirement 6: Flexible Branch and Path Support

**Objective:** As a developer, I want CSM to work with worktrees that use any branch name and reside at any path, so that externally-created worktrees with non-CSM conventions are fully supported.

#### Acceptance Criteria
1. The CSM shall accept worktrees with any branch name, not only those matching the `csm/<name>` convention.
2. The CSM shall accept worktrees located at any absolute path, not only those inside `<projectPath>/.worktrees/`.
3. The session's `branchName` field shall store the actual branch name of the imported worktree (e.g., `feature/login`, `bugfix/issue-42`).
4. The session's `worktreePath` field shall store the actual absolute path of the imported worktree.
