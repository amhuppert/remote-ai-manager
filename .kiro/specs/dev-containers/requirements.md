# Requirements Document

## Introduction

CSM currently executes Claude Code directly on the host machine with `--dangerously-skip-permissions`, providing no filesystem or network isolation. This feature replaces direct host execution with mandatory dev container support: every Claude Code session runs inside its own Docker container, based on Anthropic's reference dev container implementation. Each session gets a dedicated container with filesystem isolation, network-level firewall rules (domain whitelisting via iptables), and controlled access to the host workspace via bind mounts. Projects can provide their own `.devcontainer/devcontainer.json` for project-specific tooling; CSM provides a secure default when none exists. This enables safe unattended operation of Claude Code with `--dangerously-skip-permissions` in a controlled sandbox.

## Requirements

### Requirement 1: Container Lifecycle Management

**Objective:** As a CSM user, I want each session to automatically get its own Docker container, so that Claude Code runs in an isolated environment without manual setup.

#### Acceptance Criteria

1. When a new session is created, CSM shall build (if needed) and start a Docker container for that session before Claude Code can be invoked.
2. When a session is deleted, CSM shall stop and remove the associated Docker container and any ephemeral resources (networks, unnamed volumes).
3. While a session's container is being built or started, CSM shall report the container status (building, starting, running, stopped, error) to the client.
4. If a container fails to start, CSM shall report the error with container logs and prevent prompt execution for that session until the container is healthy.
5. When CSM starts up, CSM shall detect sessions with stale or missing containers and reconcile them (restart or mark as unhealthy).
6. The container lifecycle shall be independent per session — stopping or removing one session's container shall not affect other sessions.

### Requirement 2: Default Container Configuration

**Objective:** As a CSM operator, I want CSM to ship a secure default dev container configuration, so that projects without custom setups still get sandboxed execution.

#### Acceptance Criteria

1. CSM shall include a default dev container configuration based on Anthropic's reference implementation (Node.js base image, firewall script, required tooling).
2. The default container shall include a firewall initialization script that restricts outbound network access to a whitelisted set of domains (Anthropic API, npm registry, GitHub, and essential services).
3. The default container shall require `NET_ADMIN` and `NET_RAW` capabilities for iptables-based firewall enforcement.
4. The default container shall run Claude Code as a non-root user.
5. The default container shall include Claude Code CLI pre-installed and ready for invocation.
6. The default firewall shall block all outbound traffic not matching the allowlist and verify the rules on container startup.

### Requirement 3: Per-Project Container Customization

**Objective:** As a developer, I want to provide project-specific dev container configuration, so that Claude Code has access to the language runtimes and tools my project needs.

#### Acceptance Criteria

1. When a project contains a `.devcontainer/devcontainer.json` file, CSM shall use that configuration to build the session container instead of the CSM default.
2. When a project does not contain a `.devcontainer/devcontainer.json` file, CSM shall fall back to the CSM default container configuration.
3. The per-project configuration shall support standard devcontainer spec features including custom Dockerfiles, Docker Compose, devcontainer features, and post-create/post-start commands.
4. If a project's devcontainer configuration fails to build, CSM shall report the build error with logs and not fall back silently to the default.
5. CSM shall rebuild the container image when the project's devcontainer configuration files change.

### Requirement 4: Prompt Execution Inside Containers

**Objective:** As a CSM user, I want prompts to be executed inside the session's dev container, so that Claude Code operates within the sandbox.

#### Acceptance Criteria

1. When a prompt is submitted, CSM shall execute the Claude Code CLI inside the session's running container rather than on the host.
2. CSM shall stream Claude Code's NDJSON output from within the container to the client in real time (SSE), maintaining the same streaming behavior as current host execution.
3. CSM shall pass the selected model, prompt text, `--dangerously-skip-permissions`, `--output-format stream-json`, `--verbose`, and `--max-turns` flags to Claude Code inside the container.
4. When resuming a conversation (`--resume`), CSM shall pass the session ID to Claude Code inside the container, and the container shall retain Claude session state between prompts.
5. CSM shall enforce single-flight locking per session — concurrent prompt submissions to the same session shall be rejected with HTTP 409.
6. CSM shall apply the configured timeout to containerized prompt execution and terminate the process inside the container on timeout.

### Requirement 5: Workspace Mounting

**Objective:** As a developer, I want the session's git worktree to be accessible inside the container, so that Claude Code can read and modify the project files.

#### Acceptance Criteria

1. CSM shall bind-mount the session's worktree directory into the container as the workspace directory.
2. File changes made by Claude Code inside the container shall be reflected on the host filesystem immediately (for git operations, diff viewing, etc.).
3. The container shall have read-write access to the mounted workspace.
4. CSM shall continue to perform git operations (branch creation, worktree management, diff, merge, commit) on the host, outside the container.

### Requirement 6: Credential and Environment Management

**Objective:** As a CSM operator, I want API credentials to be securely passed into containers, so that Claude Code can authenticate with the Anthropic API.

#### Acceptance Criteria

1. CSM shall support three authentication methods for containers (checked in order): (a) `ANTHROPIC_API_KEY` environment variable passed into the container without writing to filesystem, (b) `CLAUDE_CODE_OAUTH_TOKEN` environment variable passed into the container, (c) host `~/.claude/.credentials.json` bind-mounted read-only into the container for Claude Max/Pro OAuth credentials.
2. CSM shall use a whitelist-only approach for container environment variables, passing only explicitly approved variables (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CSM_PROJECT_PATH`, `CSM_SESSION_NAME`, `DEVCONTAINER`) and excluding all other host environment variables including `CLAUDE*` variables.
3. If none of the three authentication methods are available, CSM shall report a clear error listing all supported methods before attempting container creation.
4. CSM shall write an onboarding configuration (`hasCompletedOnboarding: true`) into the container's Claude home directory so that Claude Code skips interactive onboarding when using OAuth credentials.

### Requirement 7: Transcript and Session State Access

**Objective:** As a CSM user, I want to view conversation transcripts and session history, so that observability features work the same as before.

#### Acceptance Criteria

1. CSM shall ensure Claude Code's transcript files (JSONL) written inside the container are accessible from the host for reading.
2. CSM shall persist the Claude configuration directory (`.claude/`) across container restarts within the same session, so that session resumption and transcript continuity are maintained.
3. When a session's container is removed (session deletion), CSM shall retain transcript data on the host for historical access.
4. CSM shall continue to parse transcripts and display conversation history, code diffs, and session metadata identically to current behavior.

### Requirement 8: Hook Integration

**Objective:** As a CSM user, I want Claude Code lifecycle hooks to continue working, so that session status tracking remains real-time.

#### Acceptance Criteria

1. CSM shall configure Claude Code hooks (UserPromptSubmit, Stop) inside each session container so that hook events are delivered to CSM's API endpoint.
2. The container's network configuration shall allow outbound connections from the container to the CSM host server (for hook event delivery).
3. When a hook event is received from a containerized session, CSM shall match it to the correct session and update state identically to current behavior.
4. If hook delivery fails (CSM unreachable from container), Claude Code operation inside the container shall not be blocked.

### Requirement 9: Docker Prerequisites and Error Handling

**Objective:** As a CSM operator, I want clear feedback when Docker is unavailable or misconfigured, so that I can resolve setup issues.

#### Acceptance Criteria

1. When CSM starts, CSM shall verify that Docker is installed and the Docker daemon is running.
2. If Docker is not available, CSM shall display a clear error message indicating Docker is required and provide setup guidance.
3. If the Docker daemon is running but the current user lacks permissions, CSM shall report the permissions error specifically.
4. CSM shall report Docker-related errors (build failures, start failures, exec failures) with container logs included in the error response.

### Requirement 10: Container Status Observability

**Objective:** As a CSM user, I want to see the status of each session's container, so that I can monitor and troubleshoot containerized sessions.

#### Acceptance Criteria

1. CSM shall expose the container status (building, starting, running, stopped, error) for each session via the session API and UI.
2. When a session's container transitions between states, CSM shall update the session state and notify connected clients.
3. CSM shall provide an API endpoint or mechanism to retrieve recent container logs for a session for debugging purposes.
