# Implementation Plan

> **Note**: The session-lifecycle feature is fully implemented. All tasks below address the test coverage gap identified during gap analysis. No new production code is needed.

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
  - Mock `ClaudeSessionManager.json` to contain an `initScriptPath`
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
