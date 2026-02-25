# Implementation Plan

- [x] 1. Add Zod schemas and type definitions for background jobs, SSE events, and API contracts
  - Define the job-status SSE event schema with job type, status, project/session context, branch name, and optional result fields (merge hash, commit hash, conflict count, conflict files, error message)
  - Extend the SSE event union type to include the new job-status event alongside existing conversation-status and ask-question events
  - Define the smart merge request schema (message string, autoResolve boolean)
  - Define the conflict entry schema (file path, description, resolution text, rationale)
  - Define the resolve-conflicts request schema (merge message, optional array of per-conflict decisions with file, decision enum, and optional feedback)
  - Define the background job state interface (job ID, type, status, project/session context, branch, timestamps, optional result data)
  - Define the conflict analysis interface (job ID, project/session context, conflict entries array, optional resolved timestamp)
  - Export all new types from the types module
  - _Requirements: 4.2, 4.3, 6.2_

- [x] 2. Implement domain primitives for locking, git merge, and conflict resolution
- [x] 2.1 (P) Add project-level lock for serializing squash merges across sessions
  - Implement a lock function that prevents concurrent squash merge operations on the same project using an in-memory Map with the same globalThis singleton pattern as existing locks
  - The lock returns a release closure, consistent with the existing session lock pattern
  - If the lock is already held, throw immediately (callers implement their own retry/backoff)
  - Add unit tests: acquire and release, concurrent acquire rejection, verify independence from session locks
  - _Requirements: 4.7, 4.8_

- [x] 2.2 (P) Add two-phase merge capability to git operations
  - Implement a function that merges main into the session's feature branch worktree (not the main project path)
  - On success (no conflicts), return a clean status
  - On conflict, detect conflicted files by listing unmerged paths, leave the worktree in conflict state (do not abort), and return a conflicts status with the list of conflicting file paths
  - On non-conflict git errors, propagate the error
  - Add unit tests: clean merge, merge with conflicts (verify files listed and worktree left in conflict state), non-conflict error propagation
  - _Requirements: 1.1, 1.3, 1.4_

- [x] 2.3 (P) Implement conflict resolution module using Claude Agent SDK
  - Build a function that invokes the Claude Agent SDK query API in the session worktree with a system prompt adapted from the fix-merge-conflicts skill
  - The prompt instructs Claude to: find conflicted files, read and analyze each conflict, edit files to resolve conflict markers, stage resolved files, and output a JSON code fence with structured per-conflict analysis (file, description, resolution, rationale)
  - Support an optional decisions parameter for manual review re-submission: approved files resolved freely, rejected files incorporate user feedback, pending files resolved with extra care
  - Extract structured conflict entries from the last JSON code fence in Claude's response, validate with Zod schema
  - Return resolved status with conflict entries on success, or failed status with error and optional partial results on failure
  - Use bypass permissions mode and the configurable Claude timeout
  - Add unit tests: JSON extraction from mock responses, Zod parse failures, timeout handling, decisions parameter integration into prompt
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 3. Build the background jobs module for async job lifecycle management
- [x] 3.1 Implement core job infrastructure with registry, dispatch, and safety mechanisms
  - Create the in-memory job registry using a globalThis singleton Map keyed by project path and session name, following the existing SSE broadcaster pattern for HMR survival
  - Implement dispatch functions that: validate no active job exists for the session, acquire the session lock, register the job entry, spawn an un-awaited Promise for execution, and return the job ID immediately
  - Wrap all background job execution in try/finally to guarantee session lock release and job failure transition on unhandled exceptions
  - Implement stale job timeout recovery: when a dispatch is rejected because a job is already running, check if the running job exceeds the configurable timeout (default 10 minutes); if so, force-transition it to failed, release its lock, and accept the new job
  - Broadcast a job-status SSE event on every job state transition (running, completed, failed, conflicts)
  - Store conflict analysis results in a separate globalThis Map so they persist across job completions
  - Implement getJob and getConflictAnalysis query functions for the API layer
  - Add unit tests: dispatch validation, state transitions, concurrent job rejection, try/finally lock release on unhandled error, stale job timeout recovery, SSE event broadcasting
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 3.2 Implement the two-phase merge pipeline with auto-resolve capability
  - Orchestrate the merge job execution: Phase 1 merges main into the feature branch, Phase 2 squash merges the feature branch into main
  - On Phase 1 clean merge: acquire the project-level lock with retry/backoff (100ms intervals, 30s timeout), execute the squash merge, release the project lock, mark the session as finished, and broadcast completion with the merge hash
  - On Phase 1 conflicts with auto-resolve enabled: invoke the conflict resolution module, and on success commit the resolution, acquire the project lock, squash merge, and complete; on failure, broadcast conflicts status with the analysis for manual review
  - On Phase 1 conflicts with auto-resolve disabled: broadcast conflicts status with the conflicting file list for manual review
  - On project lock timeout: transition to failed with an explanatory error message
  - Implement the resolve-conflicts job dispatch: re-invokes conflict resolution with user decisions, then on success follows the same commit-and-squash-merge path
  - Add integration tests: full merge pipeline (clean path), conflict path with auto-resolve success, conflict path with auto-resolve failure fallback, resolve-conflicts re-entry, project lock timeout
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 4.7, 4.8, 5.2, 5.3, 5.4, 5.5_

- [x] 3.3 Implement the commit job execution pipeline
  - Orchestrate the commit job: execute git commit in the session worktree, broadcast completion with commit hash on success, broadcast failure with error message on failure
  - Ensure pre-commit hook failures are captured and included in the error message
  - Add integration tests: successful commit with SSE broadcast, failed commit (hook failure) with error broadcast
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 4. Create and update API routes for async merge, commit, and conflict operations
- [x] 4.1 (P) Convert the merge route to async dispatch with 202 response
  - Replace the synchronous squash merge call with a dispatch to the background jobs merge function
  - Accept the extended request body with merge message and auto-resolve boolean
  - Return 202 Accepted with the job ID on successful dispatch
  - Return 409 with SESSION_BUSY code when a job is already running for the session
  - Remove the pre-checks for uncommitted changes and commit count (the background job handles the full pipeline)
  - Retain existing validation: project exists, session exists, not finished, message non-empty
  - Add route tests: successful dispatch returns 202, session busy returns 409, validation errors return 400
  - _Requirements: 2.1, 9.3_

- [x] 4.2 (P) Convert the commit route to async dispatch with 202 response
  - Replace the synchronous commit call with a dispatch to the background jobs commit function
  - Return 202 Accepted with the job ID on successful dispatch
  - Return 409 with SESSION_BUSY code when a job is already running
  - Retain existing validation
  - Add route tests: successful dispatch returns 202, session busy returns 409
  - _Requirements: 3.1_

- [x] 4.3 (P) Create the conflicts retrieval route
  - Implement a GET endpoint that reads the stored conflict analysis for a session from the background jobs module
  - Return the conflict entries, job ID, and optional resolved timestamp
  - Return 404 if no conflict analysis exists for the session
  - Add route tests: returns conflict data when available, returns 404 when no analysis exists
  - _Requirements: 6.3, 7.8_

- [x] 4.4 (P) Create the resolve-conflicts route
  - Implement a POST endpoint that accepts a merge message and optional per-conflict decisions (file, decision, feedback)
  - Dispatch a resolve-conflicts background job with the provided decisions
  - Return 202 Accepted with the job ID on successful dispatch
  - Return 409 when a job is already running for the session
  - Add route tests: successful dispatch returns 202, session busy returns 409, validation errors return 400
  - _Requirements: 7.6, 7.7_

- [x] 5. Build frontend notification infrastructure
- [x] 5.1 (P) Create the notification Zustand store for job state and toast queue
  - Create a Zustand store with immer middleware (consistent with existing stores) containing: a jobs Map keyed by job ID, a FIFO toast queue for ephemeral notifications
  - Implement addOrUpdateJob action: upsert job data from SSE events into the Map; push to toast queue when a job reaches a terminal state (completed, failed, conflicts)
  - Implement dismissToast action: pop the first item from the toast queue
  - Implement getActiveJobs selector: return jobs with running or conflicts status
  - Implement getJobsBySession selector: filter jobs by project and session name
  - _Requirements: 8.2, 8.3, 8.7_

- [x] 5.2 Extend the SSE notification listener to handle job-status events
  - Add a job-status event listener alongside the existing conversation-status and ask-question listeners
  - Parse incoming events with the job-status schema, feed valid events into the notification store's addOrUpdateJob action
  - On completed merge events: invalidate session queries to refresh UI state
  - On completed commit events: invalidate diff and commits queries
  - _Requirements: 8.7, 2.5, 2.6, 2.7, 3.4, 3.5_

- [x] 6. Wire UI components to backend APIs and notification store
- [x] 6.1 (P) Wire the MergeToast component to the notification store
  - Connect to the notification store's toast queue to display the first queued item
  - Auto-dismiss after 8 seconds or on manual dismissal via the store's dismissToast action
  - Render action buttons that navigate to: session page on merge success, conflicts page on merge conflicts, session page on commit success
  - Mount as a portal in the root layout
  - _Requirements: 2.5, 2.6, 2.7, 3.4, 3.5_

- [x] 6.2 (P) Wire the SmartMergeDialog to the merge API
  - Replace the stub submit handler with a POST to the merge endpoint sending the commit message and auto-resolve toggle value
  - On 202 response: transition to the submitted confirmation state
  - On 409 response: display session busy error
  - Ensure the dialog is dismissible at any time including after submission
  - Support Cmd/Ctrl+Enter keyboard shortcut for submit
  - Display contextual messaging in the submitted state based on the auto-resolve setting
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 2.4_

- [x] 6.3 (P) Wire the MergeConflictsPage and create the conflicts page route
  - Create the Next.js page route that renders the conflicts page component with data fetched from the conflicts GET endpoint
  - Fetch conflict analysis data (entries, job ID) on page mount
  - Wire the Accept All and Fix button to POST to the resolve-conflicts endpoint with all decisions set to approved
  - Wire the Fix with Claude button to POST to the resolve-conflicts endpoint with per-conflict decisions (approved, rejected with feedback, or pending)
  - Handle navigation away without losing progress (conflict data persists in server memory)
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

- [x] 6.4 (P) Wire the NotificationsPanel to the notification store and replace the UnifiedPanel
  - Connect the Conversations section to existing active conversations query data
  - Connect the Jobs section to the notification store's jobs Map, sorted by start time descending
  - Render each item with category icon, title, project/session context, status badge, and relative timestamp
  - Navigate to the relevant page on item click (conversation page, session page, or conflicts page) and close the panel
  - Compute badge count from active conversations plus active jobs from the store
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [x] 7. Integrate into session page and topbar
- [x] 7.1 Swap the existing merge dialog for the SmartMergeDialog on the session detail page
  - Replace the current MergeDialog component usage with SmartMergeDialog, passing the existing props (branch name, commit count, uncommitted changes flag, merge message)
  - Verify the auto-resolve toggle is visible and defaults to enabled
  - _Requirements: 9.1, 5.1_

- [x] 7.2 Replace the UnifiedPanel toggle in the Topbar with the NotificationsPanel toggle and badge
  - Swap the existing panel toggle button to open the NotificationsPanel instead of the UnifiedPanel
  - Display the badge count reflecting active conversations plus in-progress or actionable jobs
  - Ensure real-time badge updates when job-status SSE events arrive
  - _Requirements: 8.1, 8.6, 8.7_
