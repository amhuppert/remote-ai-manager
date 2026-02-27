# Requirements Document

## Introduction

This specification defines the requirements for automated dev server lifecycle management within CC sessions. The feature allows users to launch, monitor, and stop project-defined dev servers directly from the session overview page, with each server automatically exposed to the tailnet via Tailscale Serve. Dev servers run in the session's worktree directory, report their ports via a structured stdout protocol, and are tracked in-memory with periodic liveness checks. Auto-cleanup ensures no orphaned processes or stale Tailscale configurations when sessions end.

**Phase 2 — Preset Configuration Support** extends the dev server system with reusable presets that simplify project setup. Instead of manually writing shell commands and port management logic, users select a preset (e.g., Next.js, Storybook) from the CC UI, and CC installs framework-specific helper scripts into the project's `.cc/dev-servers/` directory and configures `CommandCenter.json` automatically. The helper scripts handle port detection, worktree-aware port selection, and the `CC_PORT` protocol. Installed scripts are intended to be committed to the project repository for team reuse.

## Requirements

### Requirement 1: Per-Project Dev Server Configuration

**Objective:** As a CC user, I want to declare dev servers in my project's configuration file, so that CC knows which servers are available for any session in that project.

#### Acceptance Criteria

1. The CC shall support an optional `devServers` array in the `CommandCenter.json` per-repo config file, where each entry contains a `name` (string) and `command` (string).
2. When `CommandCenter.json` is absent or contains no `devServers` array, the CC shall treat the project as having zero configured dev servers.
3. When `devServers` is present, the CC shall validate that each entry has a non-empty `name` and non-empty `command`.
4. The CC shall support multiple dev server entries per project (e.g., an application server and a Storybook server simultaneously).

### Requirement 2: Dev Server Process Spawning

**Objective:** As a CC user, I want to start dev servers for a session from the UI, so that I can test changes in the session's worktree without manual terminal setup.

#### Acceptance Criteria

1. When the user requests a dev server start, the CC shall spawn the configured command as a child process with the working directory set to the session's worktree path.
2. When a dev server process is spawned, the CC shall parse its stdout stream for a line matching the pattern `CC_PORT=<port>` to discover the port the server is listening on.
3. When the `CC_PORT=<port>` line is detected, the CC shall transition the server's status from `starting` to `running` and record the discovered port.
4. If the dev server process exits before emitting a `CC_PORT=<port>` line, the CC shall transition the server's status to `error` with a descriptive message.
5. While a dev server is in `starting` or `running` status, the CC shall not allow a duplicate start for the same server name within the same session.
6. The CC shall capture and store recent stdout/stderr output from the dev server process for diagnostic display in the UI.

### Requirement 3: Dev Server Process Stopping

**Objective:** As a CC user, I want to stop running dev servers, so that I can free resources and ports when I no longer need them.

#### Acceptance Criteria

1. When the user requests a dev server stop, the CC shall terminate the child process and transition the server's status to `stopped`.
2. When a dev server is stopped, the CC shall remove its Tailscale Serve registration before completing the stop transition.
3. The CC shall support a "Stop All" action that stops all running dev servers for a session in parallel.

### Requirement 4: Tailscale Serve Integration

**Objective:** As a CC user, I want dev servers to be automatically accessible over my Tailscale network, so that I can test from any device on my tailnet without manual Tailscale configuration.

#### Acceptance Criteria

1. When a dev server transitions to `running` (port discovered), the CC shall register it with Tailscale Serve by executing `tailscale serve --https=<port> --bg localhost:<port>`.
2. When a dev server is stopped or its process exits, the CC shall remove the Tailscale Serve registration by executing `tailscale serve --https=<port> off`.
3. The CC shall resolve the Tailscale hostname (e.g., from `tailscale status`) to construct the full remote URL (`https://<hostname>:<port>`) for display in the UI.
4. If a Tailscale Serve command fails, the CC shall log the error and continue the dev server lifecycle (Tailscale registration failure shall not prevent the server from running or being stopped).
5. The CC shall operate Tailscale CLI commands without requiring root access, relying on the `--operator` configuration being set as a prerequisite.

### Requirement 5: In-Memory State Management

**Objective:** As a CC developer, I want dev server state tracked in-memory only, so that the runtime state accurately reflects actual process state without stale persisted data.

#### Acceptance Criteria

1. The CC shall track all dev server process state in a `globalThis`-backed Map registry (surviving HMR re-evaluation).
2. The CC shall not persist dev server state to `state.json` or any other persistent store.
3. When CC restarts, the CC shall start with an empty dev server registry (clean slate).
4. The CC shall store per-server runtime state including: process PID, status (`starting`, `running`, `stopped`, `error`), discovered port, server name, and recent output.

### Requirement 6: Liveness Polling

**Objective:** As a CC user, I want the UI to accurately reflect whether dev servers are still running, so that I am not misled by stale status indicators.

#### Acceptance Criteria

1. While dev servers are registered in the in-memory registry, the CC shall periodically check whether each tracked process is still alive.
2. When a liveness check detects that a dev server process has exited, the CC shall transition the server's status to `stopped`, remove its Tailscale Serve registration, and broadcast the status change via SSE.
3. The CC shall perform liveness checks at a reasonable interval (e.g., every 5-10 seconds) that balances accuracy with resource usage.

### Requirement 7: Real-Time Status Updates via SSE

**Objective:** As a CC user, I want to see dev server status changes in real time, so that I know immediately when a server starts, stops, or encounters an error.

#### Acceptance Criteria

1. When a dev server's status changes, the CC shall broadcast a `dev-server-status` SSE event containing the project name, session name, server name, new status, and port (when available).
2. The CC shall broadcast SSE events for all status transitions: `starting`, `running`, `stopped`, and `error`.

### Requirement 8: API Endpoints

**Objective:** As a CC frontend developer, I want REST API endpoints for dev server operations, so that the UI can start, stop, and query dev server status.

#### Acceptance Criteria

1. The CC shall provide a GET endpoint that returns the current status of all dev servers for a session, including available server configurations and their runtime states.
2. The CC shall provide a POST endpoint that starts a specific dev server (by name) or all configured dev servers for a session.
3. The CC shall provide a POST endpoint that stops a specific running dev server (by name) or all running dev servers for a session.
4. When a start request is made for a project with no `devServers` configuration, the CC shall return an appropriate error response.

### Requirement 9: Session Overview UI Controls

**Objective:** As a CC user, I want a dev server control panel on the session overview page, so that I can manage dev servers without leaving the session context.

#### Acceptance Criteria

1. Where a project has `devServers` configured, the session overview page shall display a dev server control panel listing each configured server.
2. The dev server control panel shall show each server's current status with a visual indicator (e.g., starting, running, stopped, error).
3. While a dev server is running, the control panel shall display a clickable link to the server's Tailscale remote URL that opens in a new tab.
4. The control panel shall provide a start button for each stopped server and a stop button for each running server.
5. The control panel shall provide "Start All" and "Stop All" bulk action buttons.
6. The control panel shall update in real time via SSE events without requiring page refresh.
7. Where a project has no `devServers` configured, the session overview page shall not display the dev server control panel.

### Requirement 10: Auto-Cleanup on Session Lifecycle Events

**Objective:** As a CC user, I want dev servers to be automatically stopped when a session ends, so that I don't accumulate orphaned processes and stale Tailscale configurations.

#### Acceptance Criteria

1. When a session is deleted, the CC shall stop all running dev servers for that session and remove their Tailscale Serve registrations.
2. When a session is merged, the CC shall stop all running dev servers for that session and remove their Tailscale Serve registrations.
3. When the CC process exits, the CC shall attempt to stop all running dev servers and remove their Tailscale Serve registrations.

---

## Phase 2: Preset Configuration Support

### Requirement 11: Port Detection Helper Scripts

**Objective:** As a project maintainer, I want reusable shell scripts that detect port availability and verify worktree ownership, so that my dev server startup scripts can automatically find a usable port without manual coordination.

#### Acceptance Criteria

1. The CC shall provide a port detection helper script that checks whether a given TCP port is currently in use on the local machine.
2. When a port is in use, the helper script shall determine the PID of the process listening on that port.
3. When a PID is identified for a port, the helper script shall resolve the process's working directory and compare it against the current worktree path to determine ownership.
4. When the process on a port belongs to the current worktree, the helper script shall report the port as "owned" (already running for this worktree).
5. When the process on a port belongs to a different worktree or is unrelated, the helper script shall report the port as "in use" (conflict).
6. When no process is listening on a port, the helper script shall report the port as "available".
7. The helper scripts shall be implemented as POSIX-compatible shell scripts that work on Linux without additional dependencies.

### Requirement 12: Dev Server Preset Definitions

**Objective:** As a CC developer, I want a registry of supported dev server presets, so that each preset encapsulates the framework-specific knowledge needed to generate helper scripts and configuration.

#### Acceptance Criteria

1. The CC shall define a preset for Next.js dev servers that generates a startup script handling port detection, automatic port allocation, `next dev --port` invocation, and `CC_PORT` output.
2. The CC shall define a preset for Storybook dev servers that generates a startup script handling port detection, automatic port allocation, `storybook dev --port` invocation, and `CC_PORT` output.
3. Each preset shall define the list of files it installs (e.g., `.cc/dev-servers/<preset>.sh`) and the `devServers` entry it adds to `CommandCenter.json`.
4. Each preset's generated startup script shall use the port detection helpers (Requirement 11) to find an available port before starting the server.
5. When a server is already running on the expected port for the correct worktree, the preset's startup script shall reuse that port and report it via `CC_PORT` without spawning a duplicate process.

### Requirement 13: Preset Installation API

**Objective:** As a CC frontend developer, I want an API endpoint for installing presets into projects, so that the UI can trigger preset installation and report results.

#### Acceptance Criteria

1. The CC shall provide a POST endpoint that installs a preset (by ID) into a project, writing the helper scripts to `.cc/dev-servers/` in the project root and updating `CommandCenter.json` with the corresponding `devServers` entry.
2. When the `.cc/dev-servers/` directory does not exist in the project, the CC shall create it.
3. When `CommandCenter.json` does not exist in the project, the CC shall create it with the preset's `devServers` entry.
4. When `CommandCenter.json` already exists with a `devServers` array, the CC shall append the preset's entry without removing existing entries.
5. If a preset is already installed (matching server name exists in `devServers`), the CC shall return an appropriate error response indicating the preset is already configured.
6. The CC shall provide a GET endpoint that returns the list of available presets and which ones are already installed for a given project.
7. The CC shall make installed scripts executable (mode `0755`).

### Requirement 14: Preset Installation UI

**Objective:** As a CC user, I want to install dev server presets from the sessions list page, so that I can quickly configure dev servers for common frameworks without editing configuration files manually.

#### Acceptance Criteria

1. The sessions list page shall display an "Install Preset" button in the action bar alongside the "New Session" button.
2. When the user clicks "Install Preset", the CC shall display a modal dialog listing available dev server presets as selectable cards.
3. Each preset card shall display the preset name, a brief description, and the list of files that will be installed.
4. Where a preset is already installed for the current project, the preset card shall display an "Installed" indicator and be non-selectable.
5. When the user selects a preset and clicks "Install", the CC shall call the preset installation API and display a loading state while the installation is in progress.
6. When preset installation completes successfully, the CC shall close the dialog.
7. If preset installation fails, the CC shall display the error message within the dialog.
