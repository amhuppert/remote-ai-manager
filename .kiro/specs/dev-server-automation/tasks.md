# Implementation Plan

- [x] 1. Schemas and Configuration
- [x] 1.1 Define dev server schemas and types
  - Add `devServerConfigSchema` (name + command, both non-empty strings) and `devServerStatusSchema` enum (`starting`, `running`, `stopped`, `error`)
  - Add `devServerStatusEventSchema` for the SSE event contract with project name, session name, server name, status, port, remote URL, and error message fields
  - Add `devServerRuntimeStateSchema` and `devServersStatusResponseSchema` for the API response contract
  - Add the new SSE event type to the `SSEEvent` union
  - Export all derived types from the types module
  - _Requirements: 5.4, 7.1_

- [x] 1.2 Extend per-repo config with devServers support
  - Add an optional `devServers` array field to the existing per-repo config schema, referencing the new dev server config schema
  - Validate that the config reader returns the extended schema with dev server entries when present
  - Ensure projects without the `devServers` field or without a config file are treated as having zero configured servers
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. (P) Tailscale service for dev server exposure
  - Implement a service that encapsulates all Tailscale CLI interactions behind a clean interface
  - Resolve the machine's Tailscale hostname by parsing `tailscale status --json` output, caching the result for the process lifetime
  - Register a local port with Tailscale Serve (`tailscale serve --https=<port> --bg localhost:<port>`) and return the constructed remote URL, or null on failure
  - Unregister a Tailscale Serve entry (`tailscale serve --https=<port> off`) with error swallowing
  - All Tailscale CLI failures must be logged but never propagated — the service degrades gracefully when Tailscale is unavailable
  - Use `execFile` for short-lived CLI commands, consistent with existing subprocess patterns
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - _Contracts: TailscaleService Service Interface_

- [x] 3. Dev server process registry
- [x] 3.1 Implement in-memory registry singleton
  - Create a `globalThis`-backed Map registry using the established `__csm_*` singleton pattern for HMR safety
  - Key entries by `${projectPath}::${sessionName}::${serverName}` to guarantee uniqueness across worktrees
  - Store per-server runtime state: server name, project path, session name, command, PID, status, discovered port, remote URL, started-at timestamp, error message, and recent output buffer
  - Provide query methods to retrieve all servers for a session and a specific server by key
  - Ensure a clean slate on CSM restart (empty registry on first access)
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Contracts: DevServerRegistry State Management_

- [x] 3.2 Implement process spawning with port detection
  - Spawn the configured command as a child process using `spawn` with `shell: true` and the session's worktree path as the working directory
  - Set the initial server status to `starting` and broadcast an SSE event immediately
  - Line-buffer stdout and match `^CSM_PORT=(\d+)$` to discover the listening port
  - On port detection, transition status to `running`, record the port, invoke the Tailscale service to register it, store the remote URL, and broadcast a `running` SSE event
  - If the process exits before emitting `CSM_PORT`, transition to `error` with a descriptive message including captured output
  - Enforce a 60-second startup timeout — if `CSM_PORT` is not detected within the timeout, transition to `error`
  - Capture the last 50 lines of combined stdout/stderr in a circular buffer for diagnostic display
  - Prevent duplicate starts: reject if a server with the same name is already in `starting` or `running` status for the session
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 7.2_
  - _Contracts: DevServerRegistry Service Interface (startServer)_

- [x] 3.3 Implement stop operations and SSE broadcasting
  - Stop a specific server: remove its Tailscale Serve registration first, then send SIGTERM to the child process with a 5-second grace period before escalating to SIGKILL
  - Transition the server status to `stopped` and broadcast an SSE event
  - Implement session-level stop: stop all running/starting servers for a given project+session in parallel
  - Implement global stop: stop all registered servers across all sessions (for CSM shutdown)
  - Broadcast SSE events for every status transition (`starting`, `running`, `stopped`, `error`)
  - _Requirements: 3.1, 3.2, 3.3, 7.2_
  - _Contracts: DevServerRegistry Service Interface (stopServer, stopAllForSession, stopAll)_

- [x] 4. (P) Liveness poller for dead process detection
  - Implement a periodic health check that verifies each registered dev server process is still alive using signal-zero existence checks
  - When a dead process is detected, transition its status to `stopped`, trigger Tailscale unregistration, and broadcast an SSE event
  - Use a `globalThis`-backed interval (HMR-safe) with a 5-second polling cadence
  - Auto-start the poller when the first dev server is registered; auto-stop when the registry empties
  - Ensure exactly one polling interval is active at a time
  - _Requirements: 6.1, 6.2, 6.3_
  - _Contracts: LivenessPoller Service Interface_

- [x] 5. (P) API routes for dev server operations
- [x] 5.1 (P) GET status endpoint
  - Create a GET route that returns the current status of all dev servers for a session
  - Merge configured servers from the project's `ClaudeSessionManager.json` with runtime state from the registry — a configured-but-not-started server appears with status `stopped`
  - Return 404 if the project or session is not found
  - Return an appropriate error if the project has no `devServers` configuration
  - Follow existing API route patterns: `withTracing` wrapper, `force-dynamic` export, decoded path params
  - _Requirements: 8.1, 8.4_

- [x] 5.2 (P) POST start and start-all endpoints
  - Create a POST route to start a specific dev server by name, returning 202 (accepted) since the operation is asynchronous
  - Create a POST route to start all configured dev servers for a session
  - Return 409 if the server is already running or starting
  - Return 400 if the project has no `devServers` configuration
  - Resolve project path and session, read the repo config to get the command, and delegate to the registry
  - _Requirements: 8.2, 8.4_

- [x] 5.3 (P) POST stop and stop-all endpoints
  - Create a POST route to stop a specific running dev server by name, returning 200
  - Create a POST route to stop all running dev servers for a session
  - Return 404 if the server is not found or not running
  - Delegate to the registry's stop methods
  - _Requirements: 8.3_

- [x] 6. UI components for dev server management
- [x] 6.1 Implement useDevServers data-fetching hook
  - Create a hook that fetches initial dev server state from the GET endpoint using the existing data-fetching pattern
  - Subscribe to `dev-server-status` SSE events and update the local cache in real time when events match the current project and session
  - Expose mutation functions for starting/stopping individual servers and bulk start-all/stop-all
  - Provide loading and error states for the UI
  - _Requirements: 9.6_

- [x] 6.2 Implement DevServerPanel control component
  - Render a control panel on the session overview page listing each configured dev server with its current status
  - Display a colored status indicator per server: gray for stopped, yellow for starting, green for running, red for error
  - Show a clickable link to the server's Tailscale remote URL (opens in a new tab) when the server is running
  - Provide per-server start/stop buttons that toggle based on current status
  - Include "Start All" and "Stop All" bulk action buttons
  - Show truncated recent output when a server is in error state for diagnostics
  - Hide the entire panel when the project has no `devServers` configured
  - Update in real time via the useDevServers hook without requiring page refresh
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

- [x] 7. (P) Lifecycle integration and cleanup
- [x] 7.1 (P) Auto-cleanup on session delete and merge
  - Hook into the session delete flow to stop all running dev servers and remove their Tailscale registrations before the worktree is removed
  - Hook into the session merge/finish flow to stop all running dev servers and remove their Tailscale registrations
  - Ensure cleanup is best-effort and does not block or fail the parent operation
  - _Requirements: 10.1, 10.2_

- [x] 7.2 (P) CSM process shutdown handler
  - Register a `process.on('SIGTERM')` handler at module initialization that stops all running dev servers and removes their Tailscale registrations
  - Ensure the handler is registered once (idempotent via globalThis guard)
  - Log the shutdown cleanup for diagnostics
  - _Requirements: 10.3_

## Requirements Coverage

| Requirement | Task(s) |
|-------------|---------|
| 1.1, 1.2, 1.3, 1.4 | 1.2 |
| 2.1, 2.2, 2.3, 2.4, 2.5, 2.6 | 3.2 |
| 3.1, 3.2, 3.3 | 3.3 |
| 4.1, 4.2, 4.3, 4.4, 4.5 | 2 |
| 5.1, 5.2, 5.3, 5.4 | 3.1 |
| 6.1, 6.2, 6.3 | 4 |
| 7.1, 7.2 | 3.2, 3.3 |
| 8.1, 8.4 | 5.1 |
| 8.2, 8.4 | 5.2 |
| 8.3 | 5.3 |
| 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7 | 6.1, 6.2 |
| 10.1, 10.2 | 7.1 |
| 10.3 | 7.2 |
