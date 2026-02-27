# Requirements Document

> **UPDATED (2026-02-22) — SDK Migration:** Requirement 3 (Broadcasting) originally described triggering notifications from `POST /api/hooks` Stop events. The hook system was removed. Broadcasting now happens directly from `prompt.ts` via `conversation-status` SSE events. The `session-ready` event type referenced in Req 3 has been superseded by `conversation-status`. Requirements 1, 2, 4, 5 (permission, SSE connection, display, lifecycle) remain valid.

## Introduction
CC (Command Center) enables developers to run multiple parallel Claude Code sessions across repositories. When Claude finishes work in a session, the user needs to know it's ready for input — especially when they've switched to another tab or application while waiting. This feature adds OS-level browser notifications via the Browser Notification API, delivered through a global Server-Sent Events (SSE) channel, so users are alerted when any session completes work regardless of which CC page they're viewing.

## Requirements

### Requirement 1: Notification Permission
**Objective:** As a developer, I want CC to request notification permission from my browser, so that OS-level notifications can be displayed when sessions finish work.

#### Acceptance Criteria
1. When the user loads CC for the first time and notification permission is "default" (not yet decided), CC shall prompt the user to grant notification permission via the Browser Notification API.
2. When the user grants notification permission, CC shall persist the granted state and begin delivering notifications without further prompts.
3. When the user denies notification permission, CC shall not request permission again and shall not attempt to display notifications.
4. If the browser does not support the Notification API, CC shall degrade gracefully without errors or user-facing prompts.

### Requirement 2: Global SSE Connection
**Objective:** As a developer, I want a persistent real-time connection between my browser and CC, so that session status changes are delivered immediately without polling.

#### Acceptance Criteria
1. When the CC application loads in the browser, CC shall establish a single Server-Sent Events connection to a dedicated SSE endpoint.
2. While the SSE connection is active, CC shall keep the connection alive across page navigations within the application.
3. If the SSE connection drops, CC shall automatically reconnect with a backoff strategy.
4. The SSE endpoint shall stream session status change events containing the project name, session name, and new status.

### Requirement 3: Server-Side Event Broadcasting
**Objective:** As a developer, I want the server to broadcast session status changes to all connected browsers, so that notifications are triggered in real time.

#### Acceptance Criteria
1. When the hook API receives a `Stop` event from Claude Code, CC shall broadcast a "session ready" event to all connected SSE clients.
2. The broadcast event shall include the project name, session name, and conversation identifier so the notification can provide meaningful context.
3. While no SSE clients are connected, CC shall discard events without accumulating them in memory.

### Requirement 4: Notification Display
**Objective:** As a developer, I want to see an OS-level notification when a Claude Code session finishes work, so that I can return to provide the next prompt without constantly checking the app.

#### Acceptance Criteria
1. When CC receives a "session ready" event via SSE and notification permission is granted, CC shall display an OS-level notification using the Browser Notification API.
2. The notification shall include the project name and session name so the user can identify which session is ready.
3. When the user clicks the notification, CC shall focus the browser tab and navigate to the corresponding session page.
4. While the CC tab is in the foreground and visible, CC shall still display notifications for sessions on other pages (since the user may be viewing a different session).

### Requirement 5: Connection Lifecycle
**Objective:** As a developer, I want the SSE connection to be managed efficiently, so that it does not leak resources or degrade browser performance.

#### Acceptance Criteria
1. The CC client shall maintain at most one SSE connection per browser tab.
2. When the browser tab is closed or the user navigates away from CC, CC shall close the SSE connection cleanly.
3. When the SSE endpoint receives a client disconnect, CC shall remove the client from the broadcast registry immediately.
