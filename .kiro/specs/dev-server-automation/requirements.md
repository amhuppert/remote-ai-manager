# Requirements Document

## Introduction

This specification defines the requirements for automated dev server lifecycle management within CSM sessions. The feature allows users to launch, monitor, and stop project-defined dev servers directly from the session overview page, with each server automatically exposed to the tailnet via Tailscale Serve. Dev servers run in the session's worktree directory, report their ports via a structured stdout protocol, and are tracked in-memory with periodic liveness checks. Auto-cleanup ensures no orphaned processes or stale Tailscale configurations when sessions end.

## Requirements

### Requirement 1: Per-Project Dev Server Configuration

**Objective:** As a CSM user, I want to declare dev servers in my project's configuration file, so that CSM knows which servers are available for any session in that project.

#### Acceptance Criteria

1. The CSM shall support an optional `devServers` array in the `ClaudeSessionManager.json` per-repo config file, where each entry contains a `name` (string) and `command` (string).
2. When `ClaudeSessionManager.json` is absent or contains no `devServers` array, the CSM shall treat the project as having zero configured dev servers.
3. When `devServers` is present, the CSM shall validate that each entry has a non-empty `name` and non-empty `command`.
4. The CSM shall support multiple dev server entries per project (e.g., an application server and a Storybook server simultaneously).

### Requirement 2: Dev Server Process Spawning

**Objective:** As a CSM user, I want to start dev servers for a session from the UI, so that I can test changes in the session's worktree without manual terminal setup.

#### Acceptance Criteria

1. When the user requests a dev server start, the CSM shall spawn the configured command as a child process with the working directory set to the session's worktree path.
2. When a dev server process is spawned, the CSM shall parse its stdout stream for a line matching the pattern `CSM_PORT=<port>` to discover the port the server is listening on.
3. When the `CSM_PORT=<port>` line is detected, the CSM shall transition the server's status from `starting` to `running` and record the discovered port.
4. If the dev server process exits before emitting a `CSM_PORT=<port>` line, the CSM shall transition the server's status to `error` with a descriptive message.
5. While a dev server is in `starting` or `running` status, the CSM shall not allow a duplicate start for the same server name within the same session.
6. The CSM shall capture and store recent stdout/stderr output from the dev server process for diagnostic display in the UI.

### Requirement 3: Dev Server Process Stopping

**Objective:** As a CSM user, I want to stop running dev servers, so that I can free resources and ports when I no longer need them.

#### Acceptance Criteria

1. When the user requests a dev server stop, the CSM shall terminate the child process and transition the server's status to `stopped`.
2. When a dev server is stopped, the CSM shall remove its Tailscale Serve registration before completing the stop transition.
3. The CSM shall support a "Stop All" action that stops all running dev servers for a session in parallel.

### Requirement 4: Tailscale Serve Integration

**Objective:** As a CSM user, I want dev servers to be automatically accessible over my Tailscale network, so that I can test from any device on my tailnet without manual Tailscale configuration.

#### Acceptance Criteria

1. When a dev server transitions to `running` (port discovered), the CSM shall register it with Tailscale Serve by executing `tailscale serve --https=<port> --bg localhost:<port>`.
2. When a dev server is stopped or its process exits, the CSM shall remove the Tailscale Serve registration by executing `tailscale serve --https=<port> off`.
3. The CSM shall resolve the Tailscale hostname (e.g., from `tailscale status`) to construct the full remote URL (`https://<hostname>:<port>`) for display in the UI.
4. If a Tailscale Serve command fails, the CSM shall log the error and continue the dev server lifecycle (Tailscale registration failure shall not prevent the server from running or being stopped).
5. The CSM shall operate Tailscale CLI commands without requiring root access, relying on the `--operator` configuration being set as a prerequisite.

### Requirement 5: In-Memory State Management

**Objective:** As a CSM developer, I want dev server state tracked in-memory only, so that the runtime state accurately reflects actual process state without stale persisted data.

#### Acceptance Criteria

1. The CSM shall track all dev server process state in a `globalThis`-backed Map registry (surviving HMR re-evaluation).
2. The CSM shall not persist dev server state to `state.json` or any other persistent store.
3. When CSM restarts, the CSM shall start with an empty dev server registry (clean slate).
4. The CSM shall store per-server runtime state including: process PID, status (`starting`, `running`, `stopped`, `error`), discovered port, server name, and recent output.

### Requirement 6: Liveness Polling

**Objective:** As a CSM user, I want the UI to accurately reflect whether dev servers are still running, so that I am not misled by stale status indicators.

#### Acceptance Criteria

1. While dev servers are registered in the in-memory registry, the CSM shall periodically check whether each tracked process is still alive.
2. When a liveness check detects that a dev server process has exited, the CSM shall transition the server's status to `stopped`, remove its Tailscale Serve registration, and broadcast the status change via SSE.
3. The CSM shall perform liveness checks at a reasonable interval (e.g., every 5-10 seconds) that balances accuracy with resource usage.

### Requirement 7: Real-Time Status Updates via SSE

**Objective:** As a CSM user, I want to see dev server status changes in real time, so that I know immediately when a server starts, stops, or encounters an error.

#### Acceptance Criteria

1. When a dev server's status changes, the CSM shall broadcast a `dev-server-status` SSE event containing the project name, session name, server name, new status, and port (when available).
2. The CSM shall broadcast SSE events for all status transitions: `starting`, `running`, `stopped`, and `error`.

### Requirement 8: API Endpoints

**Objective:** As a CSM frontend developer, I want REST API endpoints for dev server operations, so that the UI can start, stop, and query dev server status.

#### Acceptance Criteria

1. The CSM shall provide a GET endpoint that returns the current status of all dev servers for a session, including available server configurations and their runtime states.
2. The CSM shall provide a POST endpoint that starts a specific dev server (by name) or all configured dev servers for a session.
3. The CSM shall provide a POST endpoint that stops a specific running dev server (by name) or all running dev servers for a session.
4. When a start request is made for a project with no `devServers` configuration, the CSM shall return an appropriate error response.

### Requirement 9: Session Overview UI Controls

**Objective:** As a CSM user, I want a dev server control panel on the session overview page, so that I can manage dev servers without leaving the session context.

#### Acceptance Criteria

1. Where a project has `devServers` configured, the session overview page shall display a dev server control panel listing each configured server.
2. The dev server control panel shall show each server's current status with a visual indicator (e.g., starting, running, stopped, error).
3. While a dev server is running, the control panel shall display a clickable link to the server's Tailscale remote URL that opens in a new tab.
4. The control panel shall provide a start button for each stopped server and a stop button for each running server.
5. The control panel shall provide "Start All" and "Stop All" bulk action buttons.
6. The control panel shall update in real time via SSE events without requiring page refresh.
7. Where a project has no `devServers` configured, the session overview page shall not display the dev server control panel.

### Requirement 10: Auto-Cleanup on Session Lifecycle Events

**Objective:** As a CSM user, I want dev servers to be automatically stopped when a session ends, so that I don't accumulate orphaned processes and stale Tailscale configurations.

#### Acceptance Criteria

1. When a session is deleted, the CSM shall stop all running dev servers for that session and remove their Tailscale Serve registrations.
2. When a session is merged, the CSM shall stop all running dev servers for that session and remove their Tailscale Serve registrations.
3. When the CSM process exits, the CSM shall attempt to stop all running dev servers and remove their Tailscale Serve registrations.
