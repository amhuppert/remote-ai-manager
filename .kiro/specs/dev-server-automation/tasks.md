# Implementation Plan

## Phase 1: Dev Server Lifecycle Management

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
  - Create a `globalThis`-backed Map registry using the established `__cc_*` singleton pattern for HMR safety
  - Key entries by `${projectPath}::${sessionName}::${serverName}` to guarantee uniqueness across worktrees
  - Store per-server runtime state: server name, project path, session name, command, PID, status, discovered port, remote URL, started-at timestamp, error message, and recent output buffer
  - Provide query methods to retrieve all servers for a session and a specific server by key
  - Ensure a clean slate on CC restart (empty registry on first access)
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Contracts: DevServerRegistry State Management_

- [x] 3.2 Implement process spawning with port detection
  - Spawn the configured command as a child process using `spawn` with `shell: true` and the session's worktree path as the working directory
  - Set the initial server status to `starting` and broadcast an SSE event immediately
  - Line-buffer stdout and match `^CC_PORT=(\d+)$` to discover the listening port
  - On port detection, transition status to `running`, record the port, invoke the Tailscale service to register it, store the remote URL, and broadcast a `running` SSE event
  - If the process exits before emitting `CC_PORT`, transition to `error` with a descriptive message including captured output
  - Enforce a 60-second startup timeout — if `CC_PORT` is not detected within the timeout, transition to `error`
  - Capture the last 50 lines of combined stdout/stderr in a circular buffer for diagnostic display
  - Prevent duplicate starts: reject if a server with the same name is already in `starting` or `running` status for the session
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 7.2_
  - _Contracts: DevServerRegistry Service Interface (startServer)_

- [x] 3.3 Implement stop operations and SSE broadcasting
  - Stop a specific server: remove its Tailscale Serve registration first, then send SIGTERM to the child process with a 5-second grace period before escalating to SIGKILL
  - Transition the server status to `stopped` and broadcast an SSE event
  - Implement session-level stop: stop all running/starting servers for a given project+session in parallel
  - Implement global stop: stop all registered servers across all sessions (for CC shutdown)
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
  - Merge configured servers from the project's `CommandCenter.json` with runtime state from the registry — a configured-but-not-started server appears with status `stopped`
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

- [x] 7.2 (P) CC process shutdown handler
  - Register a `process.on('SIGTERM')` handler at module initialization that stops all running dev servers and removes their Tailscale registrations
  - Ensure the handler is registered once (idempotent via globalThis guard)
  - Log the shutdown cleanup for diagnostics
  - _Requirements: 10.3_

---

## Phase 2: Preset Configuration Support

- [x] 8. Preset registry and script generation
  - Define Next.js and Storybook preset definitions with complete metadata: ID, display name, description, badge character, base port, config server name, command string, and script filename
  - Implement the shared helper script generator producing POSIX-compatible shell functions for: checking whether a TCP port is in use (via `ss` with `lsof` fallback), finding the PID listening on a port, resolving a process's working directory via `/proc/<pid>/cwd`, comparing it against the current worktree path, and scanning upward from a base port to find the next available port
  - Use exit codes to communicate port status: 0 for available, 1 for owned by the current worktree, 2 for conflict with a different process
  - Implement per-preset startup script generators that source the shared helpers, check the default port, reuse an owned server without spawning a duplicate (reporting `CC_PORT` and exiting), or find an available port before starting the framework command
  - Next.js preset: base port 3000, `npx next dev --port`; Storybook preset: base port 6006, `npx storybook dev --port`
  - Each generated script emits `CC_PORT=<port>` before `exec`-ing the dev server for immediate port detection by CC
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 12.1, 12.2, 12.3, 12.4, 12.5_
  - _Contracts: PresetRegistry Service Interface_

- [x] 9. Preset installation service
  - Implement installation logic that creates the `.cc/dev-servers/` directory if missing, writes the shared helper script and the preset-specific startup script with executable permissions (mode 0755), and reads or creates `CommandCenter.json` to append the preset's `devServers` entry
  - When the config file already exists with a `devServers` array, append the new entry without removing or modifying existing entries
  - When a matching server name already exists in the config, reject the installation with a descriptive error
  - Implement installed-preset detection by reading the project's config and matching server names against known preset definitions
  - Write scripts before updating config — if script writing fails, the config remains untouched
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.7_
  - _Contracts: PresetInstaller Service Interface_

- [x] 10. Preset API routes
- [x] 10.1 (P) GET presets endpoint
  - Create a GET endpoint that returns all available presets with their installed status for the given project
  - Merge preset registry metadata with installed-preset detection from the installer service
  - Return 404 if the project is not found
  - Follow existing API route patterns: `withTracing` wrapper, `force-dynamic` export, decoded path params
  - _Requirements: 13.6_

- [x] 10.2 (P) POST install endpoint
  - Create a POST endpoint that accepts a preset ID in the request body, validates it against a Zod schema, and delegates to the installer service
  - Return the list of installed files and whether the config was updated on success
  - Return 400 for unknown preset ID, 409 if the preset is already installed, 404 if the project is not found
  - _Requirements: 13.1_

- [x] 11. Wire PresetInstallDialog to backend
  - Add a query that fetches available presets with installed status from the GET endpoint, using the existing query factory pattern
  - Add a mutation that calls the POST install endpoint, using the existing mutation factory pattern
  - Replace the `console.log` stub in SessionsList with the mutation call, passing installed presets from the query to the dialog's `installedPresets` prop
  - On successful installation, close the dialog and invalidate the preset query cache
  - On failure, display the error message within the dialog
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_

---

## Phase 3: Simplification — Remove Adoption, Port-Based Lifecycle

- [x] 12. Remove adoption concept and switch to port-based lifecycle
- [x] 12.1 Remove `adopted` and `pid` fields from schemas
  - Remove `adopted` from `devServerStatusEventSchema` and `devServerRuntimeStateSchema`
  - Remove `pid` from `devServerRuntimeStateSchema`
- [x] 12.2 Rewrite dev server registry
  - Add `isPortAlive()` — TCP connect test for liveness checking
  - Add `killByPort()` — finds PIDs via `lsof`, SIGTERM, wait 5s, SIGKILL
  - Remove adoption marker parsing (`CC_ADOPTED`, `CC_ADOPTED_PID`)
  - On script exit with `running` status, check port liveness before transitioning to stopped
  - Stop uses `killByPort()` instead of only `_process.kill()`
- [x] 12.3 Rewrite liveness poller
  - Switch from PID-based (`process.kill(pid, 0)`) to port-based (`isPortAlive()`)
  - Use `setTimeout` chain instead of `setInterval` for async-safe scheduling
- [x] 12.4 Update shell script generation
  - Remove `adopt_port()` function from generated scripts
  - When `check_port` returns 1 (owned), emit `CC_PORT` and exit without adoption markers
- [x] 12.5 Regenerate installed shell scripts
- [x] 12.6 Update API route — remove `adopted` and `pid` from response
- [x] 12.7 Update UI components — remove adopted badge, always show stop button for active servers
- [x] 12.8 Update tests — remove adopted test block, update liveness tests for port-based checking

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
| 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7 | 8 |
| 12.1, 12.2, 12.3, 12.4, 12.5 | 8 |
| 13.1, 13.2, 13.3, 13.4, 13.5, 13.7 | 9, 10.2 |
| 13.6 | 10.1 |
| 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7 | 11 |
