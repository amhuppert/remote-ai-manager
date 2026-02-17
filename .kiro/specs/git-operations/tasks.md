# Implementation Plan

- [x] 1. Add schema definitions and type exports for git operations and session lifecycle
  - Add `finished` boolean field (defaulting to `false`) to the session state schema
  - Add request validation schemas for commit message, merge message, and session archive toggle
  - Add a schema for commit log entries (hash, full hash, message, date, files changed)
  - Export all new types from the central types module
  - _Requirements: 1.2, 2.2, 3.2, 4.1, 5.1_

- [x] 2. Implement git operations domain module
- [x] 2.1 Create module with commit and change-detection functions
  - Implement a function to stage all changes and create a commit with a user-provided message in a session worktree
  - Implement a function to detect whether a worktree has uncommitted changes
  - Follow the existing `execFile("git", ...)` invocation pattern used by session lifecycle functions
  - Create the module logger using the established logging pattern
  - _Requirements: 1.2, 2.4_

- [x] 2.2 Add commit log and per-commit diff retrieval
  - Implement a function to return the list of commits since the branch diverged from `main`, parsing git log output into structured entries
  - Implement a function to return the parsed diff for a single commit, reusing the existing diff parser
  - Handle the edge case where the first commit after divergence needs to diff against `main` rather than the previous commit
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 2.3 Add squash merge function
  - Implement a function to squash-merge a session branch into `main`, executing in the project root directory (not the worktree)
  - Pre-check that the project root working tree is clean before attempting the merge
  - Execute the squash merge and commit as two sequential git commands
  - _Requirements: 2.2_

- [x] 2.4 Unit tests for git operations module
  - Test all functions with mocked `execFile` calls, verifying correct git arguments and working directories
  - Test git log output parsing with edge cases (multiline messages, special characters, empty log)
  - Test precondition validation (no changes to commit, empty message, dirty project root)
  - Test the first-commit-after-divergence diff edge case
  - _Requirements: 1.2, 2.2, 2.4, 3.1, 3.2, 3.3_

- [x] 3. (P) Extend session state with archive and finish helpers
  - Implement a function to toggle a session's archived flag, following the same read-update-write pattern used for project archiving
  - Implement a function to mark a session as finished and archived atomically (both flags set in a single state write)
  - Add unit tests for both functions verifying state persistence and the atomic finish+archive behavior
  - _Requirements: 2.3, 4.1, 4.2, 4.3, 5.1_

- [x] 4. Implement API routes for git operations and session archiving
- [x] 4.1 (P) Commit API endpoint
  - Create a POST handler that validates the commit message, acquires the session lock, checks the session is not finished, and delegates to the commit domain function
  - Return the commit hash on success; return appropriate error codes for busy, no changes, finished, and git failures
  - Follow the existing `withTracing` and `resolveProjectPath` patterns
  - _Requirements: 1.2, 1.5, 1.7_

- [x] 4.2 (P) Merge API endpoint
  - Create a POST handler that validates the merge message, acquires the session lock, and checks all preconditions (not finished, no uncommitted changes, has commits to merge, project root is clean)
  - Call the squash merge domain function, then mark the session as finished and archived via the state helper
  - Return the merge commit hash on success; return descriptive error codes for each failure scenario
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.8_

- [x] 4.3 (P) Commits list and per-commit diff API endpoints
  - Create a GET handler that returns the commit log for a session branch since divergence from `main`
  - Create a GET handler that returns the parsed diff for a single commit identified by hash
  - Both endpoints resolve the session worktree path and delegate to domain functions
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 4.4 (P) Session archive API endpoint
  - Create a PATCH handler that validates the archived boolean and delegates to the session archive state helper
  - Return success on completion; return appropriate errors for invalid input or missing session
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 5. Build commit and merge dialog components
- [x] 5.1 (P) CommitDialog component
  - Build a modal dialog with a textarea for the commit message, Cancel and Commit action buttons
  - Include an error display area that shows git errors without dismissing the dialog
  - On successful commit, signal the parent to close the dialog and refresh the view
  - Follow the existing modal and button patterns from the design system
  - _Requirements: 1.1, 1.3, 1.5_

- [x] 5.2 (P) MergeDialog component
  - Build a modal dialog showing the branch name and commit count as read-only context, with a textarea for the merge commit message pre-filled with the session name
  - Include error display for merge failures (conflicts, dirty main, etc.) without dismissing the dialog
  - On successful merge, signal the parent to navigate back to the sessions list
  - _Requirements: 2.1, 2.5_

- [x] 6. Build commit history and tabbed diff panel
- [x] 6.1 CommitHistory component
  - Build a scrollable list of commit entries showing abbreviated hash (monospace, accent-colored), commit message, relative timestamp, and files-changed count
  - Support expand/collapse: clicking a commit fetches its per-commit diff from the API and renders it inline using the existing diff line styles
  - Clicking an expanded commit collapses it and clears the cached diff
  - Display an empty state message when no commits exist
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 6.2 Add tab bar to DiffPanel for switching between uncommitted changes and commit history
  - Add two tabs ("Uncommitted" and "Commits") below the panel header using the filter-pills styling pattern
  - "Uncommitted" tab shows the existing diff content unchanged; "Commits" tab renders the CommitHistory component
  - Default to "Uncommitted" if uncommitted changes exist, otherwise default to "Commits"
  - Accept new props for commits data, project name, and session name to pass through to CommitHistory
  - _Requirements: 3.1, 3.6_

- [x] 7. (P) Update sessions list with archive filtering and merged badges
  - Add an archive toggle button following the same pattern used on the projects dashboard for showing/hiding archived projects
  - By default, hide sessions marked as archived; when the toggle is active, show all sessions with archived ones visually distinct (dashed border, reduced opacity)
  - Add an archive/unarchive action button in each session row that calls the session archive API endpoint
  - Display a "merged" badge on finished sessions so users can identify completed work at a glance
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.4_

- [x] 8. Integrate git operations into session detail page and server data fetching
- [x] 8.1 Update server page to fetch commit log and pass to client components
  - Import the commit log function and call it alongside the existing diff computation in the server component
  - Pass the commits list as a new prop to the client-side session detail page, which forwards it to the diff panel
  - _Requirements: 3.1, 3.6_

- [x] 8.2 Add commit and merge action buttons to session detail page topbar
  - Add a commit button that is disabled when there are no uncommitted changes, a prompt is running, or the session is finished
  - Add a merge button that is disabled when there are no commits to merge, uncommitted changes exist, a prompt is running, or the session is finished
  - Wire both buttons to open their respective dialogs
  - _Requirements: 1.4, 1.6, 1.7, 2.6, 2.7, 2.8_

- [x] 8.3 Implement finished state display and dialog flow orchestration
  - Add dialog open/close state and wire CommitDialog and MergeDialog into the page
  - On commit success: close dialog and refresh the page to update both the diff panel and commit history
  - On merge success: close dialog and navigate to the project's sessions list
  - When a session is finished: display a banner indicating the session has been merged and is read-only, disable the prompt input and send button
  - Ensure archived-but-not-finished sessions remain fully editable
  - _Requirements: 1.3, 2.3, 4.6, 5.2, 5.3, 5.5_
