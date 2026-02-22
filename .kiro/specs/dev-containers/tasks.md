# Implementation Plan

- [x] 1. (P) Extend session schemas with container metadata
  - Add container status enum with values: none, building, starting, running, stopped, error
  - Add containerId, containerStatus, containerError, and claudeHostDir fields to the session state schema with nullable defaults for backward compatibility
  - Add optional csm_project_path and csm_session_name fields to the hook event data schema for container-originated events
  - Verify existing state files parse correctly with new defaults
  - _Requirements: 1.3, 8.3, 10.1_

- [x] 2. Create default container configuration files
- [x] 2.1 (P) Create Dockerfile and devcontainer.json defaults
  - Create a bundled defaults directory with the default container configuration
  - Build Dockerfile from Node.js 20 base image with Claude Code CLI pre-installed globally, firewall tools (iptables, ipset, iproute2, dnsutils, aggregate), git, curl, jq, and non-root node user with sudo for firewall only
  - Create devcontainer.json with host.docker.internal in runArgs for hook connectivity, NET_ADMIN/NET_RAW capabilities, API key passthrough via containerEnv, DEVCONTAINER=true, and postStartCommand for firewall initialization
  - _Requirements: 2.1, 2.3, 2.4, 2.5_

- [x] 2.2 (P) Create firewall initialization script
  - Adapt Anthropic's init-firewall.sh with domain allowlist: Anthropic API, npm registry, GitHub API, Sentry, Statsig, VS Code extensions
  - Allow DNS (UDP 53), SSH (TCP 22), localhost, and host network access for hook delivery to CSM
  - Implement default-deny policy with REJECT for immediate feedback
  - Add verification step that confirms blocked domains are unreachable and allowed domains are reachable
  - _Requirements: 2.2, 2.6, 8.2_

- [x] 3. Implement devcontainer service core
- [x] 3.1 Implement prerequisite checks and config resolution
  - Create the devcontainer service module
  - Implement prerequisite validation: check Docker daemon availability, Docker user permissions, and devcontainer CLI presence
  - Return structured results with specific error messages and setup guidance for each failure mode
  - Implement config resolution to detect project devcontainer.json and determine whether to use project config or CSM default with the --config flag
  - _Requirements: 3.1, 3.2, 9.1, 9.2, 9.3_

- [x] 3.2 Implement session environment preparation
  - Create per-session .claude/ host directory under CSM data directory
  - Generate container hook script that uses host.docker.internal for CSM connectivity and injects session identity via jq (CSM_PROJECT_PATH, CSM_SESSION_NAME)
  - Write Claude settings.json with UserPromptSubmit and Stop hook configurations pointing to the generated hook script
  - Build container environment variables: API key passthrough, CLAUDE* stripping, CSM_PROJECT_PATH, CSM_SESSION_NAME
  - Validate API key availability before proceeding
  - _Requirements: 6.1, 6.2, 6.3, 8.1_

- [x] 3.3 Implement container start and exec operations
  - Implement container start using devcontainer up with --workspace-folder pointing to worktree and --config flag for CSM defaults when no project config exists
  - Parse devcontainer up JSON output to capture containerId, remoteUser, remoteWorkspaceFolder
  - Support config change detection by comparing devcontainer configuration hash for rebuild triggering
  - Implement container exec using devcontainer exec, returning a child process with piped stdio compatible with existing readline-based NDJSON parsing
  - Configure workspace bind-mount (read-write) and .claude/ bind-mount for transcript persistence
  - _Requirements: 1.1, 3.3, 3.4, 3.5, 4.1, 5.1, 5.2, 5.3_

- [x] 3.4 Implement container cleanup and status operations
  - Implement container stop and removal using docker stop followed by docker rm
  - Handle cases where container is already stopped or doesn't exist
  - Implement container log retrieval using docker logs --tail
  - Implement container running check using docker inspect
  - Implement container reconciliation to check sessions with stored container IDs against actual Docker state, restarting or marking unhealthy as needed
  - _Requirements: 1.2, 1.5, 9.4, 10.3_

- [x] 4. Integrate container lifecycle with session management
- [x] 4.1 Extend session creation with container startup
  - Modify session creation to call environment preparation and container start after git worktree and branch creation
  - Persist containerId, containerStatus, and claudeHostDir to session state
  - Update containerStatus through transitions (none → building → starting → running) during creation
  - Report build and start errors with container logs and set containerStatus to error
  - Extend existing rollback logic: if container fails, stop/remove container and clean up worktree and branch
  - Ensure independent per-session container lifecycle with no shared state between sessions
  - _Requirements: 1.1, 1.3, 1.4, 1.6, 5.4_

- [x] 4.2 Extend session deletion with container cleanup
  - Modify session deletion to call container stop and remove before removing worktree
  - Preserve the session's .claude/ host directory so transcripts remain accessible after deletion
  - Handle missing or already-stopped containers gracefully without failing the deletion
  - _Requirements: 1.2, 7.3_

- [x] 5. Replace host prompt execution with container execution
  - Replace direct Claude CLI spawning in prompt execution with container exec via devcontainer service
  - Pass identical CLI flags to containerized Claude: model, prompt, --dangerously-skip-permissions, --output-format stream-json, --verbose, --max-turns
  - Support session resumption via --resume flag with session ID (container retains Claude state via .claude/ bind-mount)
  - Verify NDJSON stream parsing via readline and SSE event emission remain unchanged
  - Maintain timeout handling through SIGTERM signal on the exec process
  - Single-flight locking remains unchanged
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 6. (P) Update hook event matching for containerized sessions
  - Extend hook event processing to check for csm_project_path and csm_session_name fields first when present in the event payload
  - When session identity fields are present, match directly by project path and session name instead of cwd-based matching
  - Fall back to existing cwd-based matching for hook events without session identity fields
  - Ensure non-blocking hook delivery pattern is preserved (fire-and-forget in container)
  - _Requirements: 8.3, 8.4_

- [x] 7. (P) Update transcript access for bind-mounted paths
  - Modify Claude project directory resolution to use session's claudeHostDir when set
  - Encode the container-internal workspace path (/workspace) as the project path for transcript directory lookup
  - Extend conversation discovery to search the session's claudeHostDir for transcript files
  - Verify conversation history display, code diffs, and session metadata render identically
  - _Requirements: 7.1, 7.2, 7.4_

- [x] 8. Add container observability features
- [x] 8.1 (P) Create container logs API endpoint
  - Add GET route at the session-scoped container-logs path
  - Accept tail query parameter for number of log lines with a sensible default
  - Delegate to devcontainer service for log retrieval using the session's containerId
  - Return 404 when session has no associated container
  - _Requirements: 9.4, 10.3_

- [x] 8.2 (P) Add container status transition notifications
  - Broadcast a container status event via SSE when container status changes
  - Include project name, session name, container status, containerId, and error in the event payload
  - Integrate with the existing SSE broadcaster to notify connected clients in real time
  - _Requirements: 10.1, 10.2_

- [x] 9. Add startup prerequisites check and container reconciliation
  - Call prerequisite validation during CSM application startup
  - Display clear error messages and setup guidance for missing Docker, insufficient permissions, or missing devcontainer CLI
  - Block session creation when prerequisites are not satisfied
  - Call container reconciliation on startup to detect sessions with stale or missing containers
  - Restart viable containers or mark sessions as unhealthy
  - Log all reconciliation actions for debugging
  - _Requirements: 1.5, 9.1, 9.2, 9.3_
