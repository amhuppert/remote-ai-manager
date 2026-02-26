# Requirements Document

## Introduction
CSM's notification system currently suffers from critical reliability issues: background jobs (merge, commit, resolve-conflicts) don't reliably appear in the Activities panel, completed operations fail to trigger toast notifications, and all state is ephemeral — lost on server restart or browser refresh. This specification redesigns the notification system with SQLite-backed persistence, read/unread tracking, and cross-tab/cross-device delivery to provide a reliable, observable notification experience.

## Requirements

### Requirement 1: SQLite Notification Persistence
**Objective:** As a developer, I want notifications and job states persisted in a SQLite database, so that notification history survives server restarts and browser refreshes.

#### Acceptance Criteria
1. The CSM server shall store all notifications and background job records in a SQLite database file located in the platform config directory.
2. When a background job is dispatched (merge, commit, or resolve-conflicts), the CSM server shall insert a job record into the database with status `running` before beginning execution.
3. When a background job transitions to a terminal state (completed, failed, or conflicts), the CSM server shall update the corresponding database record with the final status and result metadata (merge hash, commit hash, conflict count, error message).
4. When the CSM server starts, the CSM server shall recover any stale job records stuck in `running` status and mark them as `failed` with an appropriate error message.
5. The CSM server shall store notification records with fields including: id, type, title, message, status, read/unread state, timestamps, and associated project/session context.
6. The CSM server shall provide an API endpoint to query persisted notifications with support for filtering by read/unread state and pagination.

### Requirement 2: Pending Jobs Visible in Activities Panel
**Objective:** As a developer, I want to see pending and running jobs in the Activities panel immediately after initiating them, so that I have real-time visibility into ongoing operations.

#### Acceptance Criteria
1. When a merge job is dispatched, the Activities panel shall display the job with status `running` within 1 second of the API response.
2. When a commit job is dispatched, the Activities panel shall display the job with status `running` within 1 second of the API response.
3. When a resolve-conflicts job is dispatched, the Activities panel shall display the job with status `running` within 1 second of the API response.
4. While a job is running, the Activities panel shall show an animated indicator (spinner or pulse) next to the job entry.
5. The Activities panel shall display jobs sourced from the SQLite database via an API query, not solely from ephemeral client-side state.
6. When the Activities panel is opened, the CSM client shall fetch the latest job and notification data from the server to ensure consistency with persisted state.

### Requirement 3: Completed Operations Trigger Notifications
**Objective:** As a developer, I want to be notified when operations complete (success or failure), so that I can take appropriate follow-up action.

#### Acceptance Criteria
1. When a merge job completes successfully, the CSM server shall create a notification record and broadcast a notification event that triggers a toast in all connected clients.
2. When a merge job fails or encounters conflicts, the CSM server shall create a notification record and broadcast a notification event that triggers a toast showing the error or conflict details.
3. When a commit job completes successfully, the CSM server shall create a notification record and broadcast a notification event that triggers a toast in all connected clients.
4. When a commit job fails, the CSM server shall create a notification record and broadcast a notification event that triggers a toast showing the error message.
5. When a resolve-conflicts job completes or fails, the CSM server shall create a notification record and broadcast a notification event that triggers a toast in all connected clients.
6. The toast notification shall display for at least 8 seconds and include an action button to navigate to the relevant session or conflict resolution page.

### Requirement 4: Read/Unread State Management
**Objective:** As a developer, I want notifications to track read/unread state, so that I can distinguish new notifications from ones I've already seen.

#### Acceptance Criteria
1. The CSM server shall store a `read` boolean flag for each notification record in the database, defaulting to `false` (unread).
2. The Activities panel shall visually distinguish unread notifications from read notifications (e.g., bold text, accent indicator, or background highlight).
3. When a user clicks on a notification in the Activities panel, the CSM client shall mark that notification as read via an API call.
4. The CSM server shall provide an API endpoint to mark one or more notifications as read.
5. The CSM server shall provide an API endpoint to mark all notifications as read.
6. The Topbar badge shall display the count of unread notifications only, not the total notification count.

### Requirement 5: Cross-Tab Notification Synchronization
**Objective:** As a developer, I want notifications to stay synchronized across multiple browser tabs, so that dismissing or reading a notification in one tab is reflected everywhere.

#### Acceptance Criteria
1. When a new notification is created on the server, all connected SSE clients (across all tabs) shall receive the notification event and display it.
2. When a notification is marked as read in one tab, the CSM server shall broadcast an update event so all other connected tabs reflect the read state.
3. When a toast is displayed and dismissed in one tab, other tabs that received the same notification shall still display it independently (toasts are per-tab).
4. The Activities panel shall reflect the same notification list and read/unread states across all tabs connected to the same server.

### Requirement 6: Cross-Device Notification Consistency
**Objective:** As a developer, I want notification state persisted on the server, so that accessing CSM from a different device shows the same notification history and read states.

#### Acceptance Criteria
1. The CSM server shall serve notification data (including read/unread state) from the SQLite database, making it available to any client that connects.
2. When a client opens the Activities panel from any device, the CSM server shall return the full notification history with current read/unread states.
3. When a notification is marked as read from one device, subsequent requests from any other device shall reflect the updated read state.

### Requirement 7: Notification Lifecycle and Cleanup
**Objective:** As a developer, I want old notifications automatically cleaned up, so that the database and UI don't grow unbounded.

#### Acceptance Criteria
1. The CSM server shall provide a configurable retention period for notifications (default: 7 days).
2. When the CSM server starts, the CSM server shall delete notification records older than the retention period.
3. The Activities panel shall not display notifications older than the retention period.
4. The CSM server shall provide an API endpoint to dismiss (delete) individual notifications.

### Requirement 8: SSE Event Schema Extension
**Objective:** As a developer, I want the SSE event system extended to support notification-specific events, so that clients can react to notification lifecycle changes in real time.

#### Acceptance Criteria
1. The CSM server shall broadcast a `notification-created` SSE event when a new notification is persisted to the database, including the full notification payload.
2. The CSM server shall broadcast a `notification-updated` SSE event when a notification's read state changes, including the notification id and new read state.
3. The CSM client shall listen for `notification-created` and `notification-updated` events and update the UI accordingly without requiring a full page refresh.
4. While the SSE connection is interrupted, when the connection is re-established, the CSM client shall fetch the latest notification state from the server API to reconcile any missed events.
