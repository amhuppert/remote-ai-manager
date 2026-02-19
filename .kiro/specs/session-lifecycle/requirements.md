# Requirements Document

## Introduction

The Session Lifecycle feature manages the full create/monitor/delete lifecycle of isolated coding sessions within the Claude Session Manager (CSM). Each session is backed by a git worktree and a dedicated branch (`csm/<name>`), providing complete git isolation for parallel Claude Code instances working within the same repository.

This feature is expanded to support **multiple Conversations per session**. A Conversation maps one-to-one with a Claude Code session and carries its own Claude Code session ID, status, and message history. A CSM session can have many Conversations, enabling seamless switching between CSM UI and terminal-based Claude Code usage, as well as automatic import of CLI-created sessions.

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
2. The Session Manager shall store the following session properties: `sessionName`, `worktreePath`, `branchName`, `createdAt`, `lastActivityAt`, `archived` (false), `finished` (false), and `conversations` (empty array).
3. When a session is created for a project not yet in state, the Session Manager shall create the project entry automatically.
4. The Session Manager shall record ISO 8601 timestamps for `createdAt` and `lastActivityAt` at the time of creation.

### Requirement 8: Session Deletion

**Objective:** As a developer, I want to delete sessions cleanly, so that worktree resources are freed and state is updated without leaving orphaned artifacts.

#### Acceptance Criteria

1. When a session is deleted, the Session Manager shall remove the worktree directory from the filesystem using `git worktree remove --force`.
2. If `git worktree remove` fails, the Session Manager shall fall back to recursively removing the worktree directory.
3. When a session is deleted, the Session Manager shall remove the session record from the application state, including all associated conversation records.
4. When a session is deleted, the Session Manager shall not delete the session's git branch or Claude Code transcript files (these are preserved for history).
5. If the project does not exist in state, the Session Manager shall return the error "Project not found: <path>".
6. If the session does not exist within the project, the Session Manager shall return the error "Session '<name>' not found in project".
7. While the worktree directory does not exist on disk, the Session Manager shall still remove the session from state without error.

### Requirement 9: Conversation Entity

**Objective:** As a developer, I want each Claude Code session interaction to be modeled as a distinct Conversation within a CSM session, so that a session can track multiple independent Claude Code sessions over its lifetime.

#### Acceptance Criteria

1. The Session Manager shall model each Conversation with the following properties: a unique identifier, a Claude Code session ID (nullable), a transcript path (nullable), a status, a message history array, a prompt count, and `createdAt`/`lastActivityAt` timestamps.
2. The Session Manager shall generate a unique identifier for each Conversation at creation time.
3. The Session Manager shall support the following Conversation statuses: `idle`, `ready`, and `running`.
4. When a Conversation is created, the Session Manager shall initialize its status to `ready`, its prompt count to 0, and its messages to an empty array.

### Requirement 10: Session-Conversation Relationship

**Objective:** As a developer, I want CSM sessions to own multiple Conversations in a one-to-many relationship, so that switching between CSM UI and terminal-based Claude Code usage is seamless within the same session.

#### Acceptance Criteria

1. The Session Manager shall store Conversations as an ordered array within the parent session state.
2. The Session Manager shall no longer store `claudeSessionId`, `transcriptPath`, `status`, `messages`, or `promptCount` directly on the session; these properties shall reside on individual Conversation records.
3. When a session's status is queried, the Session Manager shall derive it from its Conversations: the session is `running` if any Conversation has status `running`, otherwise `ready` if any Conversation exists with status `ready`, otherwise `idle`.
4. When a session's `lastActivityAt` is queried, the Session Manager shall derive it as the most recent `lastActivityAt` among its Conversations.
5. When a session's `promptCount` is queried, the Session Manager shall derive it as the sum of prompt counts across all its Conversations.

### Requirement 11: Conversation List View

**Objective:** As a developer, I want the session detail page to display a list of all Conversations for that session, so that I can see the full history of Claude Code interactions and select one to view.

#### Acceptance Criteria

1. When a user navigates to a session detail page, the Session Manager shall display a list of all Conversations belonging to that session, ordered by most recently active first.
2. The Session Manager shall display the following for each Conversation in the list: its status, its creation timestamp, its last activity timestamp, its prompt count, and a summary or first prompt text when available.
3. The Session Manager shall visually highlight the most recently active Conversation in the list.
4. The Session Manager shall provide a "New Conversation" action on the session detail page that creates a new Conversation within the session.
5. When a user clicks on a Conversation in the list, the Session Manager shall navigate to the Conversation detail view at a sub-route (e.g., `/projects/[name]/[session]/[conversationId]`).

### Requirement 12: Conversation Detail View

**Objective:** As a developer, I want a dedicated view for each Conversation that shows its message history and allows me to send prompts, so that I can interact with a specific Claude Code session.

#### Acceptance Criteria

1. When a user navigates to a Conversation detail route, the Session Manager shall display the full message history for that Conversation, including user and assistant messages with timestamps.
2. The Session Manager shall display a sidebar listing all Conversations for the parent session, with the current Conversation highlighted, allowing quick switching without navigating back to the session list.
3. When a user clicks a different Conversation in the sidebar, the Session Manager shall navigate to that Conversation's detail view.
4. While a Conversation has status `running`, the Session Manager shall display a visual indicator that a prompt is being processed.
5. While the parent session is marked as `finished`, the Session Manager shall display the Conversation in read-only mode with the prompt input disabled.
6. The Session Manager shall retain the existing layout modes (`conversation`, `default`, `split`, `diff`) for the Conversation detail view.

### Requirement 13: Conversation Creation from CSM

**Objective:** As a developer, I want to start new Claude Code Conversations directly from the CSM interface, so that I can begin fresh interactions without switching to the terminal.

#### Acceptance Criteria

1. When a user triggers the "New Conversation" action on a session, the Session Manager shall create a new Conversation record with status `ready` and persist it to the session state.
2. When a user sends the first prompt to a new Conversation, the Session Manager shall execute the Claude Code CLI without the `-c` (continue) flag to start a new Claude Code session.
3. When a user sends a subsequent prompt to an existing Conversation that has a Claude Code session ID, the Session Manager shall execute the Claude Code CLI with the `--session-id` flag to continue that specific session.
4. When the Claude Code CLI returns a `session_id` in its output, the Session Manager shall store it on the Conversation record.

### Requirement 14: Auto-Import of Claude Code Sessions

**Objective:** As a developer, I want CSM to automatically discover and import Claude Code sessions that were created via direct CLI usage in a session's worktree, so that terminal-initiated conversations appear in the CSM interface without manual action.

#### Acceptance Criteria

1. When a session detail page is loaded, the Session Manager shall scan for Claude Code sessions associated with the session's worktree path.
2. The Session Manager shall discover sessions by reading the Claude Code project directory at `~/.claude/projects/`, using the path-to-directory naming convention (slashes replaced with dashes, leading dash prefix).
3. Where a `sessions-index.json` file exists in the Claude Code project directory, the Session Manager shall read it to obtain session metadata (session ID, first prompt, message count, timestamps, git branch).
4. Where no `sessions-index.json` file exists, the Session Manager shall fall back to scanning JSONL transcript files in the project directory and parsing their initial entries for session metadata.
5. When a discovered Claude Code session ID is not already tracked by any Conversation in the CSM session, the Session Manager shall create a new Conversation record for it with the discovered metadata.
6. The Session Manager shall filter discovered sessions to only import those whose `cwd` or `gitBranch` match the session's worktree path or branch name.
7. When importing a Conversation, the Session Manager shall populate its Claude Code session ID, transcript path, and available metadata (timestamps, message count).

### Requirement 15: Prompt Execution per Conversation

**Objective:** As a developer, I want prompt execution to be scoped to a specific Conversation, so that each Claude Code session maintains its own independent context and history.

#### Acceptance Criteria

1. When a prompt is submitted, the Session Manager shall target the specific Conversation identified by the conversation ID in the request.
2. The Session Manager shall update the targeted Conversation's status to `running` during prompt execution and to `ready` upon completion.
3. The Session Manager shall store user and assistant messages on the targeted Conversation's message array, not on the parent session.
4. The Session Manager shall update the targeted Conversation's `promptCount`, `lastActivityAt`, `claudeSessionId`, and `transcriptPath` after execution.
5. While a prompt is executing on any Conversation within a session, the Session Manager shall reject new prompt submissions for all Conversations in that session (single-flight lock at the session/worktree level).
6. If a prompt is submitted for a Conversation that does not exist, the Session Manager shall return the error "Conversation not found".

### Requirement 16: Hook Event Routing to Conversations

**Objective:** As a developer, I want Claude Code hook events to be routed to the correct Conversation, so that status and metadata updates from both CSM-initiated and CLI-initiated sessions are accurately tracked.

#### Acceptance Criteria

1. When a hook event is received with a `session_id`, the Session Manager shall match it to the Conversation with that Claude Code session ID.
2. If no Conversation matches the `session_id` but the `cwd` matches a session's worktree path, the Session Manager shall create a new Conversation record for the session and associate the hook event's `session_id` and `transcript_path` with it.
3. When a hook event is matched to a Conversation, the Session Manager shall update that Conversation's `claudeSessionId`, `transcriptPath`, and `lastActivityAt`.
4. The Session Manager shall not create duplicate Conversations when multiple hook events arrive for the same Claude Code session ID.
