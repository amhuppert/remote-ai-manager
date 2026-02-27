# Implementation Plan

> **Note**: Tasks 1–5 cover the original session-lifecycle test suite (all completed). Tasks 6–14 implement the Conversation model extension.

- [x] 1. Add unit tests for session name validation and branch name sanitization
- [x] 1.1 (P) Test session name validation rules
  - Export `validateSessionName` for direct testing or test through the public `createSession` interface
  - Verify empty string returns "Session name cannot be empty"
  - Verify whitespace-only input returns "Session name cannot be empty"
  - Verify names over 100 characters return "Session name must be 100 characters or less"
  - Verify names starting with special characters return the allowed character set error
  - Verify names with invalid characters (e.g., `@`, `#`, `.`) return the character set error
  - Verify valid names (alphanumeric start, letters/numbers/spaces/hyphens/underscores) return null
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 1.2 (P) Test branch name sanitization logic
  - Export `sanitizeBranchName` for direct testing or test through the public interface
  - Verify session name is converted to lowercase
  - Verify non-alphanumeric, non-hyphen characters are replaced with hyphens
  - Verify consecutive hyphens are collapsed to a single hyphen
  - Verify leading and trailing hyphens are stripped
  - Verify the caller adds `csm/` prefix to form the full branch name
  - Test representative inputs: `"My Feature"` → `"my-feature"`, `"test__name"` → `"test-name"`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 2. Add integration tests for session creation flow
- [x] 2.1 Test session creation with worktree and state persistence
  - Mock git CLI (`execFile`) to simulate successful worktree creation
  - Mock state module to verify read/write calls
  - Verify the created session has all required properties: `sessionName`, `worktreePath`, `branchName`, `claudeSessionId` (null), `transcriptPath` (null), `status` ("ready"), `createdAt`, `lastActivityAt`, `promptCount` (0), `archived` (false)
  - Verify worktree path follows the `.worktrees/<sanitized-name>` pattern
  - Verify branch name follows the `csm/<sanitized-name>` pattern
  - Verify ISO 8601 timestamps are set for `createdAt` and `lastActivityAt`
  - Verify a project entry is auto-created when the project is not yet in state
  - _Requirements: 3.1, 3.2, 7.1, 7.2, 7.3, 7.4_

- [x] 2.2 Test session uniqueness enforcement
  - Mock state to return existing sessions for a project
  - Verify that creating a session with a duplicate name throws the expected error message
  - Verify that sessions in different projects can share the same name
  - _Requirements: 4.1, 4.2_

- [x] 2.3 Test worktree path conflict detection
  - Mock filesystem existence check to simulate an existing worktree directory
  - Verify the error message includes the conflicting path
  - _Requirements: 3.3_

- [x] 3. Add integration tests for init script execution
- [x] 3.1 Test init script runs when configured
  - Mock `CommandCenter.json` to contain an `initScriptPath`
  - Verify the script is executed with the correct working directory (worktree path)
  - Verify environment variables `PROJECT_ROOT`, `WORKTREE_PATH`, `SESSION_NAME`, and `BRANCH_NAME` are passed
  - Verify a 60-second timeout is configured for script execution
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 3.2 (P) Test init script error scenarios
  - Verify a missing init script path triggers the "Init script not found" error
  - Verify a failing init script triggers full rollback (worktree and branch cleaned up)
  - Verify no session state is persisted when the init script fails
  - _Requirements: 5.5, 5.6_

- [x] 4. Add integration tests for rollback on failure
- [x] 4.1 Test rollback cleans up worktree and branch
  - Simulate git worktree creation success followed by init script failure
  - Verify `git worktree remove --force` is called for cleanup
  - Verify `git branch -D` is called to delete the created branch
  - Verify the original error is re-thrown after cleanup
  - _Requirements: 6.1, 6.3, 3.4_

- [x] 4.2 Test rollback falls back to filesystem removal
  - Simulate `git worktree remove` failure
  - Verify fallback to recursive filesystem deletion of the worktree directory
  - Verify cleanup errors are suppressed and the original failure error is propagated
  - _Requirements: 6.2, 6.4_

- [x] 4.3 (P) Test no state persistence on creation failure
  - Simulate any creation step failure
  - Verify `writeState` is never called with session data after a failure
  - _Requirements: 6.5_

- [x] 5. Add integration tests for session deletion
- [x] 5.1 Test successful session deletion
  - Mock state to contain a project with an existing session
  - Mock git CLI for worktree removal
  - Verify the worktree is removed via `git worktree remove --force`
  - Verify the session record is removed from state
  - Verify the git branch and transcript files are not deleted
  - _Requirements: 8.1, 8.3, 8.4_

- [x] 5.2 (P) Test session deletion with missing worktree
  - Mock filesystem existence check to return false for the worktree path
  - Verify the session is still removed from state without error
  - _Requirements: 8.7_

- [x] 5.3 (P) Test session deletion fallback to filesystem removal
  - Simulate `git worktree remove` failure
  - Verify fallback to recursive filesystem deletion
  - _Requirements: 8.2_

- [x] 5.4 (P) Test session deletion error cases
  - Verify deleting from a non-existent project throws "Project not found: <path>"
  - Verify deleting a non-existent session throws "Session '<name>' not found in project"
  - _Requirements: 8.5, 8.6_

- [ ] 6. Define Conversation schema and update Session schema
- [ ] 6.1 Add the Conversation entity schema with all required fields and export its type
  - Define a Zod schema for the Conversation entity with: unique ID, nullable Claude Code session ID, nullable transcript path, status (idle/ready/running), messages array, prompt count, timestamps, source (cc/imported), and nullable summary
  - Default status to `ready`, prompt count to 0, messages to empty array, source to `cc`
  - Generate unique IDs using `crypto.randomUUID()` at creation time
  - Export the inferred TypeScript type from the types module
  - _Requirements: 9.1, 9.2, 9.3, 9.4_
  - _Contracts: conversationStateSchema_

- [ ] 6.2 Update the Session schema to hold a conversations array and mark legacy fields as optional
  - Add a `conversations` field as an ordered array of Conversation schemas with `.default([])`
  - Mark existing per-session fields (`claudeSessionId`, `transcriptPath`, `status`, `messages`, `promptCount`) as `.optional()` for backward-compatible read-time migration
  - Export the updated SessionState type — consumers should access conversation data from the array, not from session-level fields
  - _Requirements: 10.1, 10.2_
  - _Contracts: sessionStateSchema_

- [ ] 7. Build conversation CRUD and session-derived helpers
- [ ] 7.1 Implement conversation creation, lookup, and listing within a session
  - Create a new conversations module for conversation domain logic
  - Implement creating a conversation within a session: generate a UUID, set defaults (status `ready`, prompt count 0, empty messages), and persist to the session's conversations array
  - Implement retrieving a single conversation by ID within a session
  - Implement listing all conversations for a session, ordered by most recently active first
  - Ensure conversation IDs are unique within a session and no duplicate Claude Code session IDs exist
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 13.1_
  - _Contracts: conversations.ts Service_

- [ ] 7.2 Implement derived session-level status, prompt count, and last activity from conversations
  - Derive session status: `running` if any conversation is running, `ready` if any is ready, otherwise `idle`
  - Derive session prompt count: sum of all conversation prompt counts
  - Derive session last activity: most recent `lastActivityAt` among conversations, falling back to the session's own `lastActivityAt`
  - These are pure functions operating on the session state object — they compute but do not store
  - _Requirements: 10.3, 10.4, 10.5_
  - _Contracts: conversations.ts Service_

- [ ] 7.3 Implement read-time migration of legacy session state into the conversations array
  - When a session has no conversations but has legacy fields (`claudeSessionId` or `messages` present), wrap them into a single Conversation record with source `cc`
  - Preserve all legacy data: session ID, transcript path, messages, prompt count, and status in the migrated conversation
  - Handle sessions that have neither conversations nor legacy fields gracefully (no migration needed)
  - Migration runs during state deserialization; the migrated state persists on the next write
  - _Requirements: 10.2_

- [ ] 8. Implement auto-import of Claude Code sessions from the filesystem
- [ ] 8.1 (P) Discover Claude Code sessions by reading the sessions-index.json file
  - Encode the worktree path to the Claude Code project directory naming convention (slashes replaced with dashes, leading dash prefix)
  - Read and parse `sessions-index.json` from the encoded project directory under `~/.claude/projects/`
  - Extract session metadata: session ID, first prompt, message count, timestamps, git branch
  - Filter discovered sessions by matching `cwd` to the session's worktree path or `gitBranch` to the session's branch name
  - Return empty results gracefully when the directory or index file does not exist
  - _Requirements: 14.1, 14.2, 14.3, 14.6_
  - _Contracts: conversations.ts Service_

- [ ] 8.2 Fall back to JSONL transcript parsing when no sessions-index.json exists
  - List all `.jsonl` files in the Claude Code project directory
  - Parse the first few lines of each JSONL file to extract session ID, cwd, git branch, and timestamp
  - Apply the same cwd/gitBranch filter as the index-based discovery
  - Handle filesystem errors gracefully (missing directory, unreadable files) by returning empty results
  - _Requirements: 14.4, 14.6_

- [ ] 8.3 Import untracked sessions as new Conversation records with deduplication
  - Compare discovered Claude Code session IDs against existing conversation `claudeSessionId` values to skip already-tracked sessions
  - Create Conversation records for each new discovery with source set to `imported`
  - Populate Claude Code session ID, transcript path, and available metadata (timestamps, message count) on imported conversations
  - Persist all imported conversations to the session state atomically
  - _Requirements: 14.5, 14.7_

- [ ] 9. Update prompt execution to target a specific conversation
- [ ] 9.1 (P) Scope prompt execution to a conversation using the --session-id CLI flag
  - Accept a conversation ID parameter in the prompt execution function
  - For new conversations (no Claude Code session ID yet): execute the Claude CLI without continuation flags to start a fresh session
  - For existing conversations (has a Claude Code session ID): execute the Claude CLI with `--session-id <uuid>` to continue that specific session
  - Store the returned `session_id` from the CLI JSON response on the conversation record
  - _Requirements: 13.2, 13.3, 13.4, 15.1_
  - _Contracts: prompt.ts Service_

- [ ] 9.2 Store messages, prompt count, and metadata on the conversation record
  - Add user and assistant messages to the targeted conversation's message array, not the parent session
  - Update the conversation's prompt count, last activity timestamp, Claude session ID, and transcript path after each execution
  - Transition conversation status to `running` during execution and back to `ready` on completion
  - Enforce session-level locking: reject prompts for any conversation when another is already running in the same session
  - Return error "Conversation not found" when the specified conversation ID does not exist in the session
  - _Requirements: 15.2, 15.3, 15.4, 15.5, 15.6_

- [ ] 10. (P) Route hook events to the correct conversation or auto-create for untracked CLI sessions
  - Match incoming hook events by `session_id` to find the conversation with that Claude Code session ID
  - When no conversation matches the `session_id` but the `cwd` matches a session's worktree path, create a new conversation record and associate the hook event's session ID and transcript path with it
  - Update the matched or newly created conversation's metadata: Claude session ID, transcript path, and last activity timestamp
  - Prevent duplicate conversation creation when multiple hook events arrive for the same Claude Code session ID
  - _Requirements: 16.1, 16.2, 16.3, 16.4_
  - _Contracts: hooks.ts Service_

- [ ] 11. Create API routes for conversation endpoints
- [ ] 11.1 (P) Add the conversations listing and creation endpoint
  - Handle GET requests to return all conversations for a session, ordered by most recently active first
  - When the GET request includes `?import=true`, trigger auto-import discovery before returning the list
  - Handle POST requests to create a new empty conversation with status `ready` and return it
  - Return 404 for unknown projects or sessions
  - _Requirements: 9.1, 11.1, 13.1, 14.1_
  - _Contracts: Conversations API_

- [ ] 11.2 (P) Add the conversation-scoped prompt execution endpoint
  - Handle POST requests with a prompt body targeting a specific conversation by ID
  - Return 400 for empty or missing prompt text, 404 for missing conversation, 409 when the session is busy
  - Wire the endpoint to the updated conversation-scoped prompt execution function
  - _Requirements: 15.1, 15.5, 15.6_
  - _Contracts: Prompt API_

- [ ] 12. (P) Update session creation and deletion for the conversation model
  - Remove explicit setting of per-session conversation fields (`claudeSessionId`, `transcriptPath`, `status`, `messages`, `promptCount`) during session creation — rely on the schema default (`conversations: []`)
  - Verify that session deletion inherently removes embedded conversation records when the session is removed from state
  - Update any references to legacy per-session fields in session lifecycle code paths
  - Verify existing session creation and deletion tests pass with the updated schema
  - _Requirements: 7.2, 8.3_

- [ ] 13. Build the conversation list view on the session page
  - Replace the current session detail view with a conversation list at the session route
  - Display each conversation as a card showing: status indicator, summary or first prompt text, prompt count, creation and last activity timestamps, and an imported badge when applicable
  - Visually highlight the most recently active conversation in the list
  - Include a "New Conversation" action that creates a new conversation via the API and navigates to it
  - Navigate to the conversation detail sub-route when a conversation card is clicked
  - Trigger auto-import on page load to discover CLI-created sessions
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ] 14. Build the conversation detail view with sidebar
- [ ] 14.1 Create the conversation detail page with message history and prompt input
  - Display the full message history for the selected conversation, including user and assistant messages with timestamps
  - Show a running indicator when the conversation status is `running`
  - Disable the prompt input when the parent session is marked as finished (read-only mode)
  - Retain existing layout modes (conversation, default, split, diff) — the diff panel remains session-level showing all worktree changes
  - _Requirements: 12.1, 12.4, 12.5, 12.6_

- [ ] 14.2 Create the conversation sidebar for quick switching between conversations
  - Display a collapsible sidebar listing all conversations for the parent session
  - Highlight the currently active conversation with a visual accent
  - Navigate to the selected conversation's detail view on click without returning to the session list
  - Include a "New" button to create a conversation directly from the sidebar
  - Persist the sidebar collapse state to local storage
  - _Requirements: 12.2, 12.3_
