# Requirements Document

## Introduction

The Session Lifecycle feature manages the full create/monitor/delete lifecycle of isolated coding sessions within the Claude Session Manager (CSM). Each session is backed by a git worktree and a dedicated branch (`csm/<name>`), providing complete git isolation for parallel Claude Code instances working within the same repository. This feature encompasses session name validation, worktree and branch creation, optional init script execution, session deletion with cleanup, and rollback on failure during creation.

## Requirements

### Requirement 1: Session Name Validation

**Objective:** As a developer, I want session names to be validated before creation, so that sessions have consistent, git-safe identifiers and meaningful error messages are returned for invalid input.

#### Acceptance Criteria

1. When a session name is submitted, the Session Manager shall validate that the name is non-empty and does not exceed 100 characters.
2. When a session name is submitted, the Session Manager shall validate that the name starts with a letter or number and contains only letters, numbers, spaces, hyphens, or underscores.
3. If an empty or whitespace-only session name is provided, the Session Manager shall return the error "Session name cannot be empty".
4. If a session name exceeds 100 characters, the Session Manager shall return the error "Session name must be 100 characters or less".
5. If a session name contains invalid characters or starts with a special character, the Session Manager shall return a descriptive error message specifying the allowed character set.

### Requirement 2: Branch Name Sanitization

**Objective:** As a developer, I want session names to be sanitized into valid git branch suffixes, so that every session gets a predictable, git-compatible branch name under the `csm/` namespace.

#### Acceptance Criteria

1. When a session is created, the Session Manager shall convert the session name to lowercase.
2. When a session is created, the Session Manager shall replace all non-alphanumeric, non-hyphen characters with hyphens.
3. When a session is created, the Session Manager shall collapse consecutive hyphens into a single hyphen.
4. When a session is created, the Session Manager shall strip leading and trailing hyphens from the sanitized name.
5. The Session Manager shall prefix the sanitized name with `csm/` to form the branch name.

### Requirement 3: Worktree Creation

**Objective:** As a developer, I want each session to be backed by a dedicated git worktree and branch, so that multiple Claude Code sessions can operate on the same repository in isolation without interfering with each other.

#### Acceptance Criteria

1. When a session is created, the Session Manager shall create a git worktree at `.worktrees/<sanitized-name>` inside the project root directory.
2. When a session is created, the Session Manager shall create a new branch named `csm/<sanitized-name>` based on the `main` branch.
3. If a worktree directory already exists at the target path, the Session Manager shall return an error indicating the path conflict.
4. If the git worktree creation command fails, the Session Manager shall propagate the error after performing rollback cleanup.

### Requirement 4: Session Uniqueness

**Objective:** As a developer, I want session names to be unique within a project, so that sessions can be unambiguously identified and managed.

#### Acceptance Criteria

1. When a session is created, the Session Manager shall check the project's existing sessions for a name collision.
2. If a session with the same name already exists in the project, the Session Manager shall return the error "Session '<name>' already exists in this project".

### Requirement 5: Init Script Execution

**Objective:** As a developer, I want optional per-repository init scripts to run after worktree creation, so that project-specific setup (e.g., dependency installation, environment configuration) is automated for new sessions.

#### Acceptance Criteria

1. When a session is created, the Session Manager shall check for a `ClaudeSessionManager.json` config file in the project root.
2. Where the per-repo config specifies an `initScriptPath`, the Session Manager shall resolve the script path (absolute or relative to project root) and execute it in the worktree directory.
3. When the init script executes, the Session Manager shall provide environment variables: `PROJECT_ROOT`, `WORKTREE_PATH`, `SESSION_NAME`, and `BRANCH_NAME`.
4. The Session Manager shall enforce a 60-second timeout on init script execution.
5. If the init script path does not exist, the Session Manager shall return the error "Init script not found: <path>".
6. If the init script fails or times out, the Session Manager shall trigger a full rollback of the session creation.

### Requirement 6: Rollback on Failure

**Objective:** As a developer, I want failed session creation to be fully rolled back, so that no orphaned worktrees, branches, or partial state remain after a failure.

#### Acceptance Criteria

1. If any step during session creation fails after the worktree has been created, the Session Manager shall attempt to remove the worktree via `git worktree remove --force`.
2. If `git worktree remove` fails, the Session Manager shall fall back to recursively removing the worktree directory from the filesystem.
3. If any step during session creation fails after the branch has been created, the Session Manager shall attempt to delete the branch via `git branch -D`.
4. While performing rollback, the Session Manager shall suppress cleanup errors so the original failure error is propagated to the caller.
5. If session creation fails, the Session Manager shall not persist any session state.

### Requirement 7: Session State Persistence

**Objective:** As a developer, I want created sessions to be persisted in the application state, so that sessions survive server restarts and can be queried and managed later.

#### Acceptance Criteria

1. When a session is successfully created, the Session Manager shall persist the session record to the JSON state file.
2. The Session Manager shall store the following session properties: `sessionName`, `worktreePath`, `branchName`, `claudeSessionId` (null), `transcriptPath` (null), `status` ("ready"), `createdAt`, `lastActivityAt`, `promptCount` (0), `archived` (false), and `messages` (empty array).
3. When a session is created for a project not yet in state, the Session Manager shall create the project entry automatically.
4. The Session Manager shall record ISO 8601 timestamps for `createdAt` and `lastActivityAt` at the time of creation.

### Requirement 8: Session Deletion

**Objective:** As a developer, I want to delete sessions cleanly, so that worktree resources are freed and state is updated without leaving orphaned artifacts.

#### Acceptance Criteria

1. When a session is deleted, the Session Manager shall remove the worktree directory from the filesystem using `git worktree remove --force`.
2. If `git worktree remove` fails, the Session Manager shall fall back to recursively removing the worktree directory.
3. When a session is deleted, the Session Manager shall remove the session record from the application state.
4. When a session is deleted, the Session Manager shall not delete the session's git branch or transcript files (these are preserved for history).
5. If the project does not exist in state, the Session Manager shall return the error "Project not found: <path>".
6. If the session does not exist within the project, the Session Manager shall return the error "Session '<name>' not found in project".
7. While the worktree directory does not exist on disk, the Session Manager shall still remove the session from state without error.
