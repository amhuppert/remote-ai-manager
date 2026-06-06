# Requirements Document

## Introduction
CC's notification system currently suffers from critical reliability issues: background jobs (merge, commit, resolve-conflicts) don't reliably appear in the Activities panel, completed operations fail to trigger toast notifications, and all state is ephemeral — lost on server restart or browser refresh. This specification redesigns the notification system with SQLite-backed persistence, read/unread tracking, and cross-tab/cross-device delivery to provide a reliable, observable notification experience.

## Requirements

### Requirement 1: SQLite Notification Persistence
**Objective:** As a developer, I want notifications and job states persisted in a SQLite database, so that notification history survives server restarts and browser refreshes.

#### Acceptance Criteria
1. The CC server shall store all notifications and background job records in a SQLite database file located in the platform config directory.
2. When a background job is dispatched (merge, commit, or resolve-conflicts), the CC server shall insert a job record into the database with status `running` before beginning execution.
3. When a background job transitions to a terminal state (completed, failed, or conflicts), the CC server shall update the corresponding database record with the final status and result metadata (merge hash, commit hash, conflict count, error message).
4. When the CC server starts, the CC server shall recover any stale job records stuck in `running` status and mark them as `failed` with an appropriate error message.
5. The CC server shall store notification records with fields including: id, type, title, message, status, read/unread state, timestamps, and associated project/session context.
6. The CC server shall provide an API endpoint to query persisted notifications with support for filtering by read/unread state and pagination.

### Requirement 2: Pending Jobs Visible in Activities Panel
**Objective:** As a developer, I want to see pending and running jobs in the Activities panel immediately after initiating them, so that I have real-time visibility into ongoing operations.

#### Acceptance Criteria
1. When a merge job is dispatched, the Activities panel shall display the job with status `running` within 1 second of the API response.
2. When a commit job is dispatched, the Activities panel shall display the job with status `running` within 1 second of the API response.
3. When a resolve-conflicts job is dispatched, the Activities panel shall display the job with status `running` within 1 second of the API response.
4. While a job is running, the Activities panel shall show an animated indicator (spinner or pulse) next to the job entry.
5. The Activities panel shall display jobs sourced from the SQLite database via an API query, not solely from ephemeral client-side state.
6. When the Activities panel is opened, the CC client shall fetch the latest job and notification data from the server to ensure consistency with persisted state.

### Requirement 3: Completed Operations Trigger Notifications
**Objective:** As a developer, I want to be notified when operations complete (success or failure), so that I can take appropriate follow-up action.

#### Acceptance Criteria
1. When a merge job completes successfully, the CC server shall create a notification record and broadcast a notification event that triggers a toast in all connected clients.
2. When a merge job fails or encounters conflicts, the CC server shall create a notification record and broadcast a notification event that triggers a toast showing the error or conflict details.
3. When a commit job completes successfully, the CC server shall create a notification record and broadcast a notification event that triggers a toast in all connected clients.
4. When a commit job fails, the CC server shall create a notification record and broadcast a notification event that triggers a toast showing the error message.
5. When a resolve-conflicts job completes or fails, the CC server shall create a notification record and broadcast a notification event that triggers a toast in all connected clients.
6. The toast notification shall display for at least 8 seconds and include an action button to navigate to the relevant session or conflict resolution page.

### Requirement 4: Read/Unread State Management
**Objective:** As a developer, I want notifications to track read/unread state, so that I can distinguish new notifications from ones I've already seen.

#### Acceptance Criteria
1. The CC server shall store a `read` boolean flag for each notification record in the database, defaulting to `false` (unread).
2. The Activities panel shall visually distinguish unread notifications from read notifications (e.g., bold text, accent indicator, or background highlight).
3. When a user clicks on a notification in the Activities panel, the CC client shall mark that notification as read via an API call.
4. The CC server shall provide an API endpoint to mark one or more notifications as read.
5. The CC server shall provide an API endpoint to mark all notifications as read.
6. The Topbar badge shall display the count of unread notifications only, not the total notification count.

### Requirement 5: Cross-Tab Notification Synchronization
**Objective:** As a developer, I want notifications to stay synchronized across multiple browser tabs, so that dismissing or reading a notification in one tab is reflected everywhere.

#### Acceptance Criteria
1. When a new notification is created on the server, all connected SSE clients (across all tabs) shall receive the notification event and display it.
2. When a notification is marked as read in one tab, the CC server shall broadcast an update event so all other connected tabs reflect the read state.
3. When a toast is displayed and dismissed in one tab, other tabs that received the same notification shall still display it independently (toasts are per-tab).
4. The Activities panel shall reflect the same notification list and read/unread states across all tabs connected to the same server.

### Requirement 6: Cross-Device Notification Consistency
**Objective:** As a developer, I want notification state persisted on the server, so that accessing CC from a different device shows the same notification history and read states.

#### Acceptance Criteria
1. The CC server shall serve notification data (including read/unread state) from the SQLite database, making it available to any client that connects.
2. When a client opens the Activities panel from any device, the CC server shall return the full notification history with current read/unread states.
3. When a notification is marked as read from one device, subsequent requests from any other device shall reflect the updated read state.

### Requirement 7: Notification Lifecycle and Cleanup
**Objective:** As a developer, I want old notifications automatically cleaned up, so that the database and UI don't grow unbounded.

#### Acceptance Criteria
1. The CC server shall provide a configurable retention period for notifications (default: 7 days).
2. When the CC server starts, the CC server shall delete notification records older than the retention period.
3. The Activities panel shall not display notifications older than the retention period.
4. The CC server shall provide an API endpoint to dismiss (delete) individual notifications.

### Requirement 8: SSE Event Schema Extension
**Objective:** As a developer, I want the SSE event system extended to support notification-specific events, so that clients can react to notification lifecycle changes in real time.

#### Acceptance Criteria
1. The CC server shall broadcast a `notification-created` SSE event when a new notification is persisted to the database, including the full notification payload.
2. The CC server shall broadcast a `notification-updated` SSE event when a notification's read state changes, including the notification id and new read state.
3. The CC client shall listen for `notification-created` and `notification-updated` events and update the UI accordingly without requiring a full page refresh.
4. While the SSE connection is interrupted, when the connection is re-established, the CC client shall fetch the latest notification state from the server API to reconcile any missed events.

## PLC Additive Extension

The following requirements extend notification and client real-time refresh behavior for project-level conversations (PLCs). Existing job and session-conversation notification behavior remains unchanged. Browser/OS notification parity is limited to the readiness notification channel already defined for session conversations in the browser-notifications specification.

### Requirement 9: Project Conversation Notification Parity

**Objective:** As a developer, I want project-level conversations to notify me the same way session conversations do, so that repo-root work gets the same attention handling as session work.

#### Acceptance Criteria

1. When a project conversation reaches `awaiting` after an agent turn, the CC server shall create and deliver an equivalent readiness notification with project-conversation context. _(PLC-48)_
2. When a project conversation reaches `waiting-for-input`, the CC server shall create and deliver an equivalent user-attention notification with project-conversation context. _(PLC-48, PLC-51)_
3. When a project-conversation turn fails or ends with an error state, the CC server shall create and deliver an equivalent failure notification with project-conversation context. _(PLC-48, PLC-51)_
4. The notification record for a project conversation shall identify the project and project conversation without requiring a session name. _(PLC-1, PLC-48)_
5. The CC server shall preserve existing notification behavior for session conversations and background jobs while adding project-conversation notifications. _(PLC-43, PLC-48)_

### Requirement 10: Project Conversation Notification Actions

**Objective:** As a developer, I want notifications for project-level conversations to take me back to the relevant cockpit conversation, so that I can respond or review quickly.

#### Acceptance Criteria

1. When a toast or Activities entry represents a project-conversation notification, the CC client shall provide an action that navigates to the owning project cockpit and focuses the relevant conversation. _(PLC-48, PLC-50)_
2. When the relevant project conversation is closed but not archived, the notification action shall reopen it as a focusable cockpit tab before focusing it. _(PLC-50)_
3. If the relevant project conversation no longer exists or is no longer accessible, the notification action shall present a clear unavailable state rather than navigating to an invalid session route. _(PLC-50)_
4. The toast notification for a project conversation shall include enough context for the user to identify the project and conversation. _(PLC-48)_

### Requirement 11: Project Conversation Notification State and Channels

**Objective:** As a developer, I want project-level conversation notifications to participate in existing notification history and delivery channels, so that they behave consistently across tabs, devices, and OS notification settings.

#### Acceptance Criteria

1. When a project-conversation notification is created, the CC server shall persist it with the same read/unread, timestamp, retention, and dismissal behavior as other notifications. _(PLC-48)_
2. When a project-conversation notification is marked read or dismissed from one tab or device, the CC client shall synchronize that state across other connected tabs and subsequent devices. _(PLC-48)_
3. Where OS-level browser notifications are enabled for session-conversation readiness, the CC client shall deliver equivalent OS-level notifications for project-conversation readiness. _(PLC-48)_
4. If the browser cannot display OS-level notifications or permission is denied, project-conversation notifications shall degrade the same way session-conversation notifications degrade. _(PLC-48)_

### Requirement 12: Project Conversation Real-Time Refresh

**Objective:** As a developer, I want project-conversation surfaces to refresh when project-conversation events arrive, so that the cockpit stays current without manual refresh.

#### Acceptance Criteria

1. When a project-conversation change event is delivered to the client, the CC client shall refresh the project-conversation list views that depend on that event. _(PLC-46, PLC-47, cockpit Req 12.1)_
2. When a project-conversation message event is delivered to the client, the CC client shall refresh the affected project-conversation transcript views that depend on that event. _(PLC-46, cockpit Req 12.1)_
3. When a project-conversation open, close, archive, or restore event is delivered to the client, the CC client shall refresh the affected project open-count and conversation-list views without requiring a manual page reload. _(PLC-7, PLC-8, PLC-9, PLC-46, cockpit Req 12.1)_
4. While the real-time connection is interrupted, when the connection is re-established, the CC client shall reconcile missed project-conversation notification and conversation state before reporting the UI as current. _(PLC-46, PLC-48, cockpit Req 12.1)_
5. The notification extension shall consume project-conversation events defined by the project-level-conversations foundation and shall leave Active Conversations row rendering to the unified-conversations-panel extension and tab rendering to the project-conversation-cockpit spec. _(PLC-46-boundary, PLC-48-boundary, PLC-50-boundary)_
