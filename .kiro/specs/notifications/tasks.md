# Implementation Plan

- [x] 1. Add notification schemas and install better-sqlite3
  - Add notification type enum, notification record schema, SSE event schemas (notification-created, notification-updated), and API request/response schemas to the shared schema module
  - Extend the SSEEvent union type with the two new notification event types
  - Install better-sqlite3 and @types/better-sqlite3 as project dependencies
  - _Requirements: 1.5, 8.1, 8.2_

- [x] 2. Build the notification persistence layer
- [x] 2.1 Initialize the SQLite database with notification and job record tables
  - Create the notification-db module with a globalThis-based singleton database connection
  - Initialize the database in WAL mode at the platform config directory path
  - Create the notifications table with columns for id, type, title, message, read state, project/session/branch context, job reference, optional result metadata, and timestamp
  - Create the job_records table with columns for job id, type, status, project/session/branch context, timestamps, and result metadata
  - Add indexes for unread queries, timestamp-based cleanup, project/session filtering, and job status
  - _Requirements: 1.1_

- [x] 2.2 Implement notification CRUD operations
  - Create notifications with a generated UUID, notification type derived from job type and status, title, message, and associated project/session/branch context
  - Query notifications with optional unread filter, pagination (limit/offset), and return total count plus unread count
  - Delete individual notifications by id
  - Serialize conflict_files arrays as JSON text on write and parse them back on read
  - _Requirements: 1.5, 1.6, 7.4_

- [x] 2.3 Implement read/unread state operations
  - Mark a single notification as read by id
  - Mark all notifications as read in a single statement
  - Get the count of unread notifications for badge display
  - Default all new notifications to unread (read = false)
  - _Requirements: 4.1, 4.4, 4.5_

- [x] 2.4 Implement job record operations
  - Insert a job record with status running when a background job is dispatched, capturing job id, type, project/session/branch context, and start time
  - Update a job record on terminal state with final status, completion time, and result metadata (merge hash, commit hash, conflict count, error message)
  - _Requirements: 1.2, 1.3_

- [x] 2.5 Implement startup recovery and retention cleanup
  - On initialization, find all job records stuck in running status and mark them as failed with an error message indicating server restart interruption
  - Create failure notifications for each recovered stale job
  - Delete notifications older than a configurable retention period (default 7 days)
  - Run both recovery and cleanup during database initialization
  - _Requirements: 1.4, 7.1, 7.2, 7.3_

- [x] 2.6 Write unit tests for the persistence layer
  - Test database initialization creates both tables and indexes
  - Test notification CRUD: create, query with filters, pagination, delete
  - Test read/unread operations: mark single, mark all, unread count
  - Test job record lifecycle: create running, update to terminal states
  - Test stale job recovery: detect and fail stale running jobs, create failure notifications
  - Test retention cleanup: delete old notifications while preserving recent ones
  - Use an in-memory or temporary SQLite database for test isolation
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 4.1, 4.4, 4.5, 7.1, 7.2, 7.3, 7.4_

- [x] 3. Integrate persistence into the background job lifecycle
- [x] 3.1 (P) Record job state to the database on dispatch and terminal transitions
  - On job dispatch, call the persistence layer to insert a running job record before beginning execution
  - On job terminal state (completed, failed, conflicts), update the job record with final status and result metadata
  - Preserve the existing fire-and-forget dispatch pattern and session locking behavior
  - _Requirements: 1.2, 1.3_

- [x] 3.2 Create notifications on job completion and broadcast via SSE
  - After updating a job record to terminal state, create a notification record with appropriate type, title, and message based on the job type and outcome
  - Include result metadata (merge hash, commit hash, conflict count, conflict files, error message) in the notification
  - Broadcast a notification-created SSE event containing the full notification payload after database insert
  - Cover all job types: merge (completed, failed, conflicts), commit (completed, failed), resolve-conflicts (completed, failed)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.1, 8.1_

- [x] 3.3 (P) Wire stale job recovery into the server startup path
  - Call the persistence layer's stale recovery during server initialization, alongside existing stale conversation recovery
  - Log the number of recovered jobs for diagnostics
  - _Requirements: 1.4_

- [x] 4. Add notification API routes
- [x] 4.1 (P) Implement the notifications query endpoint
  - Create a GET endpoint that accepts optional unread filter, limit, and offset query parameters
  - Validate query parameters with Zod safeParse and return 400 on invalid input
  - Return a response containing the notifications array, total count, and unread count
  - Exclude notifications older than the retention period from results
  - _Requirements: 1.6, 2.5, 6.1, 6.2, 7.3_

- [x] 4.2 (P) Implement the mark-as-read endpoint
  - Create a PATCH endpoint that accepts a notification id and marks it as read
  - Validate the request body and return 404 if the notification does not exist
  - After updating the database, broadcast a notification-updated SSE event with the id and read state
  - _Requirements: 4.3, 4.4, 5.2, 6.3_

- [x] 4.3 (P) Implement the mark-all-as-read endpoint
  - Create a POST endpoint that marks all unread notifications as read in a single operation
  - Return the count of notifications marked as read
  - Broadcast a notification-updated SSE event with a special "all" marker to trigger full client refetch
  - _Requirements: 4.5, 8.2_

- [x] 4.4 (P) Implement the dismiss notification endpoint
  - Create a DELETE endpoint that removes a notification by id
  - Return 404 if the notification does not exist
  - _Requirements: 7.4_

- [x] 5. Update the client-side notification store and SSE listener
- [x] 5.1 (P) Refactor the notification store and toast display for notification-created events
  - Remove toast enqueue logic from the job-status terminal event handler — on terminal state, only remove the job from the running jobs map
  - Add a dedicated enqueueToast action that accepts notification-created event payloads
  - Change the toast queue type from job-status events to notification-created events
  - Update the toast container component to map notification fields (type, branchName, errorMessage, conflictCount, mergeHash, commitHash) to toast props instead of job-status event fields
  - Fix commit completion toasts showing incorrect "Merge complete" text by deriving the toast variant from the notification type
  - _Requirements: 2.1, 2.2, 2.3, 3.6, 5.3_

- [x] 5.2 Add notification SSE event handlers and reconnection recovery to the listener
  - Add notification query keys to the query key factory module
  - Add a notification-created event handler that invalidates the notifications query cache and calls enqueueToast on the store
  - Add a notification-updated event handler that invalidates the notifications query cache
  - Add SSE reconnection recovery: when the EventSource reconnects after an error, invalidate the notifications query to fetch the latest state and reconcile any missed events
  - _Requirements: 5.1, 5.2, 8.3, 8.4_

- [x] 6. Update the Activities panel and Topbar for server-backed notifications
- [x] 6.1 Rebuild the Activities panel to fetch notifications from the API and merge with running jobs
  - Create a useNotificationsQuery React Query hook that fetches from the notifications query endpoint
  - Replace direct Zustand store reads for notification history with the API-backed query
  - Merge server-persisted notifications with currently running jobs from the store into a unified list sorted by timestamp
  - Add resolve-conflicts job type mapping to fix the missing display bug
  - Enable fetch-on-panel-open behavior by tying the query's enabled flag to panel visibility
  - Show an animated indicator (spinner or pulse) for jobs in running state
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 5.4_

- [x] 6.2 Add read/unread visual distinction and mark-as-read interaction
  - Visually distinguish unread notifications from read ones using bold text, accent indicator, or background highlight
  - On notification click, call the mark-as-read API endpoint and optimistically update the query cache
  - Add a "Mark all as read" action that calls the mark-all-as-read endpoint
  - _Requirements: 4.2, 4.3_

- [x] 6.3 (P) Update the Topbar badge to show unread notification count
  - Replace the current badge logic (active conversations + active jobs count) with the unread notification count
  - Derive the count from the notifications query cache or a lightweight API call that returns only the unread count
  - _Requirements: 4.6_
