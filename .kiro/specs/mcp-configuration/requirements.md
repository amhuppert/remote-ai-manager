# Requirements Document

## Project Description (Input)
mcp config

## Introduction

Command Center (CC) users currently cannot control which MCP servers (or which individual tools on those servers) are exposed to their coding agents from inside CC. They must rely entirely on each backend's static configuration files (`.mcp.json`, Claude `settings.json`, Codex `config.toml`), which cannot be adjusted per-session or per-conversation and cannot filter tools within a server.

This feature adds first-class, cross-backend MCP configuration to CC at **four cascading levels** — **global → project → session → conversation** — with mid-conversation changes applied automatically at the start of the next turn. Users can enable or disable entire servers and allow or deny individual tools within a server. The feature must work identically for Claude and Codex and must be structured so that adding a new backend requires only a backend-specific translator and a registry entry.

Creating, editing, and deleting MCP server **definitions** remains outside the scope of this feature. Users continue to manage server definitions by editing their existing backend config files. CC discovers servers from those files read-only and never writes back to them.

## Requirements

### Requirement 1: Hierarchical MCP Configuration

**Objective:** As a CC user, I want MCP configuration to cascade through global → project → session → conversation layers, so that I can set reasonable defaults once and override only where needed.

#### Acceptance Criteria
1. The Command Center shall resolve the effective MCP configuration for a conversation by applying overrides in the order global, project, session, conversation.
2. When a given level has no override for a server or tool, the Command Center shall inherit the value from the nearest ancestor level that provides one.
3. When a given level stores an override, the Command Center shall persist only the diff relative to the parent level, not a full copy of the configuration.
4. When the effective configuration is resolved for display at a given view level, the Command Center shall tag each row with an inheritance status of explicit, inherited, overridden, or disabled relative to that view level.
5. When an override is removed from a level, the Command Center shall fall back to the next ancestor level's value for that server or tool.
6. The Command Center shall persist global overrides in CC's own configuration storage and project, session, and conversation overrides in their respective state records.

### Requirement 2: Server-Level Enable and Disable

**Objective:** As a CC user, I want to enable or disable MCP servers at any level without editing config files, so that I can tailor agent capabilities to the task at hand.

#### Acceptance Criteria
1. When the user toggles a server to disabled at a given level, the Command Center shall persist an enabled-false override at that level.
2. When the effective configuration has a server disabled, the Command Center shall exclude that server from the MCP set sent to the active backend on the next turn.
3. While a server is disabled in the effective configuration, the Command Center shall continue to display the server in the UI in a visibly disabled state so the user can re-enable it.
4. When the user re-enables a previously disabled server, the Command Center shall include that server in the MCP set sent to the active backend on the next turn.
5. Where a server has explicit overrides in the effective configuration, the Command Center shall indicate both the current value and the level at which the override originates.

### Requirement 3: Auto-Promote on Toggle

**Objective:** As a CC user, I want clicking a toggle on an inherited row to automatically create an override at the current view level, so that I do not have to perform a separate "Override" step before each change.

#### Acceptance Criteria
1. When the user clicks the toggle on an inherited row at a given view level, the Command Center shall create an explicit override at the current view level with the flipped value.
2. When an inherited row has been auto-promoted, the Command Center shall display its inheritance status as overridden at the current view level.
3. Where an explicit "Override" affordance is offered, the Command Center shall allow the user to promote a row to the current view level without changing its current effective value.
4. When the user invokes a reset action on an overridden row, the Command Center shall remove the override entry at that level and restore the inherited value.

### Requirement 4: Per-Tool Filtering

**Objective:** As a CC user, I want to allow or deny individual tools exposed by an MCP server while keeping the rest enabled, so that I can remove noisy or risky tools without disabling the whole server.

#### Acceptance Criteria
1. The Command Center shall render each tool advertised by an enabled MCP server as an individually togglable row in that server's expanded view.
2. When the user disables an individual tool, the Command Center shall persist a disabled-tools override entry at the current view level.
3. When the user switches a server into allowlist mode by enabling a subset of tools, the Command Center shall persist an enabled-tools override entry at the current view level.
4. When an MCP tool is excluded by the effective configuration, the Command Center shall block the agent from invoking that tool on the next turn.
5. Where the active backend exposes native tool-level allow or deny fields, the Command Center shall use those native fields when emitting the effective MCP configuration.
6. Where the active backend has no native tool-filtering mechanism, the Command Center shall enforce filtering at the backend's tool-invocation permission layer.
7. If a tool denial is raised at the permission layer, the Command Center shall return the denial to the agent without terminating the turn.
8. When a tool override references a tool that the live server no longer advertises, the Command Center shall surface the override as orphaned in the UI.

### Requirement 5: Dynamic Tool Discovery

**Objective:** As a CC user, I want the list of tools shown for each MCP server to reflect what the live server actually exposes, so that I can toggle only tools that exist.

#### Acceptance Criteria
1. When a server's tool list is first requested, the Command Center shall query the live backend runtime for that server's advertised tools.
2. When a server's tool list has been previously discovered and its configuration signature is unchanged, the Command Center shall return the cached tool list.
3. When a server's command, URL, transport, or environment configuration changes, the Command Center shall invalidate the cached tool list for that server.
4. When the user activates the refresh affordance on a server, the Command Center shall force a re-discovery of that server's tool list and replace the cached entry.
5. If tool discovery fails for a server, the Command Center shall surface an error state on that server's row and shall not block discovery or rendering of other servers.
6. While tool discovery is in progress for a server, the Command Center shall display a loading state on that server's tool list.

### Requirement 6: Mid-Conversation Reconfiguration

**Objective:** As a CC user, I want to change MCP configuration while a conversation is mid-turn and have the change apply on the next turn without interruption, so that I can iterate without restarting sessions.

#### Acceptance Criteria
1. When the user changes MCP configuration while a conversation has no turn running, the Command Center shall apply the change before the next turn begins.
2. While a turn is running, the Command Center shall accept MCP configuration changes, persist them, and display a "pending — applies on next turn" indicator on the affected rows.
3. When a running turn completes and pending configuration changes exist for the conversation, the Command Center shall emit the updated MCP set to the backend before the next turn begins.
4. While a turn is running, the Command Center shall not abort or interrupt the turn as a result of any MCP configuration change.
5. Where the active backend supports replacing the MCP server set on a live session, the Command Center shall apply configuration changes via that backend's native live-update path.
6. Where the active backend lacks a live-update path, the Command Center shall apply configuration changes by reconstructing the per-turn runtime at the start of the next turn.
7. When pending configuration changes have been applied at turn start, the Command Center shall clear the pending indicator for the affected rows.

### Requirement 7: Unified Command Center Source Discovery

**Objective:** As a CC user, I want CC to read MCP server definitions from Command Center's own unified `.mcp.json` files so that there is one canonical source per scope regardless of which backend runs the session.

#### Acceptance Criteria
1. The Command Center shall read global MCP server definitions from `<CC_CONFIG_DIR>/.mcp.json`.
2. The Command Center shall read project MCP server definitions from the active worktree's `.mcp.json` at the repository root.
3. When the same `serverKey` is defined at both the global and project scope, the Command Center shall treat the project definition as an override and use it in the resolved set.
4. When a discovered server originates from a specific scope, the Command Center shall tag the scope (global or project) on the resolved row.
5. If a `.mcp.json` file is missing, malformed, or unreadable, the Command Center shall surface a discovery error for that file and continue discovery of the other scope.
6. When a stored override references a server that is no longer present in discovery, the Command Center shall mark that override as orphaned and omit it from the emitted MCP set.
7. The Command Center shall not read, migrate, or fall back to backend-native MCP source files (e.g. `~/.claude/settings.json`, `.claude/.mcp.json`, `~/.codex/config.toml`) for discovery.

### Requirement 8: Backend-Agnostic Abstraction

**Objective:** As a CC maintainer, I want the MCP configuration pipeline to be backend-neutral except at the emission boundary, so that adding a new backend requires only a translator and a registry entry.

#### Acceptance Criteria
1. The Command Center shall represent the effective MCP configuration in a single canonical portable shape that drives the UI and every storage layer.
2. The Command Center shall resolve the four-level cascade, store overrides, and render the UI without branching on which backend is active.
3. Where backend-specific emission is required, the Command Center shall translate the canonical portable shape through a dedicated backend translator at the emission boundary and nowhere else.
4. When a new backend is added, the Command Center shall require only a new backend translator module and a new backend registry entry to support MCP emission for that backend.
5. The Command Center shall declare each backend's MCP capabilities (e.g. portable MCP at start, portable MCP between turns, native tool filtering) through the backend registry so callers can branch on capability rather than on backend identity.

### Requirement 9: CC-Injected Gateway Servers

**Objective:** As a CC user, I want CC's own internal MCP servers to remain available regardless of my toggle state, so that the platform's own integrations (roadmap, notifications, planner, etc.) continue to work.

#### Acceptance Criteria
1. The Command Center shall always include its injected gateway servers in the effective MCP set sent to the backend.
2. The Command Center shall not present its injected gateway servers as togglable entries in any MCP configuration surface.
3. Where a user-defined server shares an identifier with an injected gateway server, the Command Center shall preserve the injected gateway server's configuration.

### Requirement 10: Configuration UI Surfaces

**Objective:** As a CC user, I want the MCP configuration UI to appear at every level where I can override, so that I can change configuration from the context where I am already working.

#### Acceptance Criteria
1. The Command Center shall expose a global-level MCP configuration section on the `/config` page.
2. The Command Center shall expose a project-level MCP configuration modal reachable from the project actions bar.
3. The Command Center shall expose a session-level MCP configuration modal reachable both from the session info strip and from the session details popover.
4. The Command Center shall expose a conversation-level MCP configuration popover reachable from the prompt toolbar.
5. Each MCP configuration surface shall display the effective inheritance status for every server row relative to the view level of that surface.
6. Each MCP configuration surface shall allow the user to toggle servers, toggle tools, reset overrides, and refresh a server's tool list.
7. Each MCP configuration surface shall use the same underlying presentational primitives so that inheritance semantics, toggle behavior, and tool-list UX are consistent across levels.

### Requirement 11: Live Cross-Client Updates

**Objective:** As a CC user, I want MCP configuration changes made from one client to appear in other open clients in real time, so that multiple tabs or devices stay consistent.

#### Acceptance Criteria
1. When an MCP override is created, modified, or removed at a given level, the Command Center shall broadcast a corresponding MCP update SSE event scoped to that level.
2. When a connected client receives an MCP update event, the Command Center shall invalidate the relevant cached queries so the UI reflects the new effective configuration.
3. When an MCP update event affects a conversation whose turn is currently running, the Command Center shall queue the change for application on the next turn and surface the pending indicator on the affected rows.
