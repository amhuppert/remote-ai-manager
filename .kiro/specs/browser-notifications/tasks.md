# Implementation Plan

- [x] 1. Add event schemas and types
  - Define the SSE event schema for session-ready events with type discriminator, project name, session name, and conversation identifier
  - Define the hook event result schema that extends the current boolean return with optional project name, session name, and conversation identifier
  - Export inferred types from the schemas for use across server and client modules
  - _Requirements: 3.2_

- [x] 2. Server-side event infrastructure
- [x] 2.1 (P) Create the SSE broadcaster module
  - Implement an in-memory client registry that tracks active SSE stream controllers
  - Provide functions to register a client, remove a client, broadcast an event to all clients, and query the current client count
  - When broadcasting, encode events in SSE wire format (named event + JSON data payload) and enqueue to each controller
  - If a controller throws during enqueue (disconnected client), catch the error and remove it from the registry
  - When no clients are connected, discard events silently without accumulating
  - Write unit tests covering: add/remove lifecycle, broadcast to multiple clients, broadcast with zero clients is a no-op, failed enqueue auto-removes the client, and client count accuracy
  - _Requirements: 3.1, 3.2, 3.3, 5.3_

- [x] 2.2 (P) Enrich processHookEvent to return session context
  - Change the return type from a boolean to a result object containing the match status plus optional project name, session name, and conversation identifier
  - During the state traversal that matches worktree path to session, capture the project key from the projects map
  - Identify the relevant conversation (the one matching the Claude session ID, or the most recently active one)
  - Update the hook API route to destructure the new return shape (keeping the HTTP response unchanged as `{ matched }`)
  - Update existing hook tests to assert the enriched return values for matched and unmatched scenarios
  - _Requirements: 3.2_

- [x] 2.3 Create the SSE events endpoint
  - Add a GET route that returns a long-lived SSE response using a ReadableStream that stays open indefinitely
  - On stream start, register the controller with the broadcaster and send an initial connection heartbeat event
  - On stream cancel (client disconnect), remove the controller from the broadcaster
  - Use the same SSE headers as existing prompt streaming routes (event-stream content type, no-cache, keep-alive)
  - _Requirements: 2.4, 5.3_

- [x] 2.4 Integrate broadcasting into the hook route
  - After processHookEvent returns a matched result for a Stop hook event, call the broadcaster with the project name, session name, and conversation identifier from the result
  - The broadcast call is fire-and-forget — failures must not affect the hook response or existing hook processing
  - _Requirements: 3.1, 3.2_

- [x] 3. Client-side notification listener
- [x] 3.1 Create the NotificationListener component
  - Build a client component that renders no visible UI (returns null)
  - On mount, check if the browser supports the Notification API; if not, exit silently without errors
  - If notification permission is in the default state, request permission via the Notification API
  - If permission is denied, do not request again and do not attempt to show notifications
  - Establish a single EventSource connection to the SSE events endpoint
  - Listen for session-ready events; when received and permission is granted, display an OS-level notification with the session name as the title and project name in the body
  - Use a notification tag based on the conversation identifier to deduplicate across multiple tabs
  - On notification click, focus the browser window and navigate to the corresponding session detail page using the project name, session name, and conversation identifier from the event
  - Close the EventSource connection on component unmount for clean resource release
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2_

- [x] 3.2 Wire NotificationListener into the root layout
  - Add the NotificationListener component as a child of the body element in the root layout, alongside the existing children
  - Because the root layout persists across all navigations in Next.js App Router, this ensures a single SSE connection is maintained globally
  - _Requirements: 2.1, 2.2_
