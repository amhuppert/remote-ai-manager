# Implementation Plan

- [x] 1. (P) Add source field to session state schema
  - Add a `source` field to the session schema with values "csm" and "imported", defaulting to "csm" for backward compatibility
  - Set source to "csm" explicitly when creating sessions through the existing creation flow
  - Verify that existing state file entries lacking the source field parse correctly with the default value applied
  - _Requirements: 4.1, 4.2, 4.4_

- [x] 2. Implement worktree discovery core functions
- [x] 2.1 (P) Parse git worktree list porcelain output
  - Parse the structured porcelain output from git worktree list into worktree entries, extracting the absolute path, HEAD commit SHA, and branch name for each
  - Handle detached HEAD entries (no branch line), locked worktrees, and prunable worktrees
  - Identify the main working tree entry and mark it for exclusion from import
  - Handle edge cases: empty output, a single main-worktree-only result, and malformed or incomplete entry blocks
  - Include unit tests covering multi-worktree output, detached HEAD, locked/prunable entries, empty output, and malformed lines
  - _Requirements: 1.2, 1.3_

- [x] 2.2 (P) Derive session names and handle uniqueness
  - Strip the `refs/heads/` prefix (from git porcelain output) and the `csm/` prefix (CSM convention) from branch names to produce a human-readable display name
  - Preserve other branch prefixes like `feature/` or `bugfix/` as part of the display name since they carry user intent
  - Fall back to the worktree directory basename when the worktree has a detached HEAD and no branch name
  - When a derived name conflicts with an existing session name in the same project, append a numeric suffix (e.g., `name-2`, `name-3`) incrementing until unique
  - Include unit tests for prefix stripping, detached HEAD fallback, single-collision suffix, and multi-collision incrementing
  - _Requirements: 3.2, 3.3, 3.4_

- [x] 3. (P) Implement worktree reconciliation and import
  - Execute git worktree list with porcelain format in the project directory; on command failure, log the error and return an empty result without interrupting the session listing
  - Parse the output using the porcelain parser and filter out the main working tree
  - Compare discovered worktrees against existing sessions by matching on worktree path to identify untracked worktrees
  - For each untracked worktree, create a new session record with source set to "imported", timestamps set to the current time, and the actual branch name and absolute path stored as-is
  - Derive display names for imported sessions using the name derivation logic, resolving any collisions with existing session names
  - Identify orphaned sessions — those present in state but whose worktree path no longer exists on disk and that are not marked as finished — without deleting or modifying them
  - Persist all newly imported session records to the state file atomically
  - Log the reconciliation outcome: count of worktrees discovered, sessions imported, and orphaned sessions detected
  - Include unit tests with mocked git output verifying: successful import of new worktrees, deduplication of already-tracked worktrees, orphan detection, graceful handling of git failures, and that existing sessions are never modified
  - _Requirements: 1.1, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.5, 3.6, 4.3, 6.1, 6.2, 6.3, 6.4_
  - _Depends on tasks 1 and 2_

- [x] 4. (P) Modify session deletion based on source
  - When deleting an imported session, remove only the session record from the state file without attempting to remove the worktree directory from disk
  - When deleting a CSM-created session, continue the existing behavior: remove the worktree from disk via git worktree remove, then remove the state record
  - Return an indicator from the deletion function showing whether the worktree was actually removed from disk, so the API layer can report it
  - Update existing deletion tests to cover both source-based paths
  - _Requirements: 5.1, 5.2_
  - _Depends on task 1; parallel with tasks 2 and 3_

- [x] 5. Integrate reconciliation and deletion into API routes
  - In the session listing endpoint, call worktree reconciliation after reading sessions from state, then return all sessions (existing plus newly imported) along with any orphaned session names
  - If reconciliation fails due to a git error, fall back to returning state-only sessions without surfacing the error to the client
  - In the session deletion endpoint, include the worktree-removed indicator in the response so clients know whether the worktree was cleaned up from disk
  - Update client-side session fetching logic to handle the new response shape (wrapper object with sessions array and orphaned names instead of a plain array)
  - _Requirements: 1.4, 2.3, 5.3_
  - _Depends on tasks 3 and 4_
