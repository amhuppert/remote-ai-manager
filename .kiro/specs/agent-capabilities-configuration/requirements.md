# Requirements Document

## Project Description (Input)
Configurable agent capabilities (skills, plugins, sub-agents) with 4-level cascade override system. Mirrors the existing MCP configuration architecture (global → project → session → conversation) but exposes 5 independent per-backend cascades — claude-skills, claude-plugins, claude-agents, codex-skills, codex-plugins — because skills/plugins/agents are backend-specific resources (different file locations, different identity, separate ecosystems), unlike MCP servers which are genuinely cross-backend. Each cascade supports per-item enable/disable with cascade-disable semantics (disabling a plugin disables its child skills/agents). Defaults mirror existing backend settings (`~/.claude/settings.json` for Claude, `~/.codex/` directory contents for Codex). Plugin install/uninstall is out of scope — CC only toggles what's already installed. Claude live-applies enable/disable changes via SDK `applyFlagSettings()` and `reloadPlugins()` when idle; Codex stages changes as next-turn config. UI exposes 5 separate config panels matching the cascades. Graph-workflow transient overrides are deferred to a follow-up spec.

## Introduction

Command Center (CC) drives both Claude Code and Codex agent backends, each of which exposes capabilities — skills, plugins, and sub-agents — that the user may want to enable or disable on a per-context basis. Today CC has no UI or storage for this: capabilities default to whatever each backend resolves from its own configuration sources, giving the user no way to scope a capability narrowly to a single project, session, or conversation, or to silence a noisy plugin for one conversation only.

This spec adds five independent per-backend cascade override systems that parallel the existing MCP configuration architecture: **claude-skills**, **claude-plugins**, **claude-agents**, **codex-skills**, **codex-plugins**. Each cascade resolves through four layers — global → project → session → conversation — and composes the effective enable/disable state at conversation start. Claude applies supported capability changes when the conversation is idle, without restarting; Codex stages changes as the next-turn configuration, matching its existing MCP pattern. The UI exposes the five cascades as five independent panels, because skills, plugins, and sub-agents are backend-specific resources with different identities, file locations, and ecosystems — unlike MCP servers, which are genuinely portable across backends.

Plugin install/uninstall, marketplace browsing, and graph-workflow transient overrides are out of scope.

## Glossary

- **Capability** — generic term covering skills, plugins, and sub-agents.
- **Skill** — a Claude or Codex skill (instructions + optional script) discovered from the backend's native sources.
- **Plugin** — a Claude marketplace/local plugin or a Codex plugin. Each backend has its own ecosystem; plugin identifiers do not overlap across backends.
- **Sub-agent (Agent)** — a Claude agent definition. Codex has no equivalent today.
- **Cascade** — the 4-level override resolution chain: global → project → session → conversation.
- **Override** — a stored entry at one cascade layer that sets, clears, or modifies a capability's enable state.
- **Effective state** — the composed result of all four cascade layers for a given (backend, capability-kind, item) tuple.
- **Idle live-apply** — Claude applies effective state to an active session without restarting it, while no turn is in flight.
- **Next-turn apply** — Codex applies the staged effective state at the start of the next agent turn.

## Requirements

### Requirement 1: Five independent per-backend cascade stores

**Objective**: As a CC user, I want skills, plugins, and sub-agents configured independently per backend, so that backend-specific resources do not get conflated and each surface can be configured naturally.

#### Acceptance Criteria

1. WHEN the system stores agent-capability overrides THEN it SHALL maintain five separate cascade stores corresponding to: Claude skills, Claude plugins, Claude sub-agents, Codex skills, and Codex plugins.
2. WHEN an override is read or written THEN the system SHALL key the operation by (cascade kind, layer, item identifier).
3. WHEN a backend is active for a conversation THEN the runtime composer SHALL only consult cascades belonging to that backend (a Claude session shall ignore Codex cascades, and vice versa).
4. The system SHALL NOT merge or deduplicate items across backends, even if their identifiers happen to coincide.

### Requirement 2: Four-layer cascade resolution

**Objective**: As a CC user, I want capability configuration to inherit from broader scopes and be overridable at narrower scopes, so that I can set a sane default once and refine per project, session, or conversation.

#### Acceptance Criteria

1. The cascade SHALL resolve in the order: global → project → session → conversation, with narrower layers overriding broader layers.
2. WHEN no override exists at any layer for a given item THEN the system SHALL fall back to the backend's native default (see Requirement 3).
3. WHEN overrides exist at multiple layers for the same item THEN the value at the narrowest layer SHALL win.
4. The system SHALL expose the resolved effective state to the runtime composer as a single enable/disable record per cascade kind.
5. Resolving the effective state SHALL be deterministic given the same layered inputs and defaults.

### Requirement 3: Defaults mirror existing backend settings

**Objective**: As a CC user, I want CC's default state to match what each backend would do on its own, so that introducing CC does not silently change capability availability.

#### Acceptance Criteria

1. WHEN no CC override exists at any cascade layer for a given item THEN the effective state SHALL match the active backend's native configured and installed capability state.
2. CC SHALL read each backend's native capability sources read-only; CC SHALL NOT modify the backend's own configuration files.
3. WHEN a native source is missing, unreadable, or malformed THEN the system SHALL surface diagnostics, SHALL NOT corrupt stored CC overrides, and SHALL NOT block the conversation from starting.
4. WHEN the underlying backend configuration changes outside of CC THEN CC's view of native defaults SHALL converge to the new state without requiring a CC restart.

> **Discovery sources (informative, settled in design)**: for Claude, `~/.claude/settings.json` (skill and plugin enablement), `~/.claude/plugins/installed_plugins.json`, and Claude's own agent/skill discovery; for Codex, the `~/.codex/` directory and Codex's plugin discovery. Exact files, commands, and refresh strategy are determined in the design phase.

### Requirement 4: Per-item enable/disable toggling

**Objective**: As a CC user, I want to toggle individual skills, plugins, and sub-agents at any cascade layer, so that I can scope capability availability precisely.

#### Acceptance Criteria

1. WHEN a user toggles an item THEN the system SHALL persist a single-item override at the currently-edited cascade layer.
2. WHEN a user clears an override on an item THEN that layer SHALL no longer contribute to that item's resolution, and resolution SHALL fall through to the next-broader layer or the backend default.
3. Toggling a single item SHALL NOT alter sibling items, parent plugins, or unrelated cascades.
4. The UI SHALL distinguish, for each item, the value at the currently-edited layer from the inherited value from broader layers.

### Requirement 5: Plugin parent-child disable semantics

**Objective**: As a CC user, I want disabling a plugin to silence everything it contributed, so that turning off a noisy plugin actually quiets it.

#### Acceptance Criteria

1. WHEN a plugin is `disabled` at any cascade layer THEN the effective state of every skill and sub-agent contributed by that plugin SHALL be `disabled`, regardless of those children's own per-item overrides.
2. WHEN a child item is forced to `disabled` by a parent plugin's cascade-disable THEN the UI SHALL indicate the inherited-disable reason (which plugin, which layer).
3. WHEN a parent plugin is re-enabled (either by clearing the disabling override or by enabling at a narrower layer) THEN each child SHALL revert to its own per-item effective state.
4. Cascade-disable SHALL flow only from plugin to its own children; child overrides SHALL NOT affect siblings or the parent.

### Requirement 6: Override patch operations

**Objective**: As a CC user, I want override operations to be reliable and predictable, so that I can configure capabilities without fear of partial writes or corruption.

#### Acceptance Criteria

1. The system SHALL support setting an enable/disable value at a layer, clearing an override at a layer, and applying multiple item changes atomically.
2. WHEN an override change is applied THEN the change SHALL be visible all-or-nothing — no partial state SHALL be persisted on failure.
3. WHEN an override change is applied successfully THEN connected clients SHALL observe the change promptly.
4. WHEN an override change fails validation THEN the system SHALL reject the change and return a structured error describing the cause.

### Requirement 7: Discovery of available items per backend

**Objective**: As a CC user, I want CC to show me the skills, plugins, and sub-agents that actually exist on each backend, so that I toggle from a real list rather than guessing names.

#### Acceptance Criteria

1. WHEN a capability panel is opened THEN the system SHALL enumerate items from the corresponding backend's native sources.
2. WHEN discovery fails (e.g., unreadable source, command failure) THEN the system SHALL surface the error in the panel and SHALL still allow viewing and editing existing overrides for previously-known items.
3. WHEN a conversation is currently active AND the backend can report its runtime-visible capability set THEN the panels SHALL reflect that runtime-visible state, clearly distinguishing items that are unavailable, stale, or source-only from items currently loaded in the running session.
4. The system SHALL refresh discovery on user demand and SHALL reflect external changes to the backend's native sources without requiring a CC restart.

### Requirement 8: Composition at conversation start

**Objective**: As a CC user, I want the effective cascade to be computed and applied when a conversation starts, so that the agent honors my configuration from turn one.

#### Acceptance Criteria

1. WHEN a Claude conversation starts THEN the runtime composer SHALL resolve effective state for Claude skills, plugins, and sub-agents and supply that state to the Claude session.
2. WHEN a Codex conversation starts THEN the runtime composer SHALL resolve effective state for Codex skills and plugins and supply that state to the Codex session.
3. WHEN composition fails for one cascade kind THEN the system SHALL surface a diagnostic, fall back to the backend's native defaults for that cascade kind only, and SHALL NOT block the conversation from starting.
4. Composing the effective state SHALL be deterministic and SHALL be exercisable in tests without spawning a real agent process.

### Requirement 9: Claude idle live-apply

**Objective**: As a CC user, I want to toggle Claude capabilities mid-conversation without restarting the session, so that I can react to noisy or missing capabilities in flight.

#### Acceptance Criteria

1. WHEN a user changes a Claude capability override AND the active Claude conversation is idle (no in-flight turn) AND the change is live-applicable THEN the system SHALL apply the change to the active session without restarting it, promptly after the write.
2. WHEN a Claude conversation has a turn in flight at the moment of change THEN the system SHALL NOT interrupt the turn; the change SHALL be applied as soon as the conversation becomes idle.
3. WHEN a Claude capability change is NOT live-applicable for the current SDK THEN the system SHALL mark the override with its actual apply point (e.g., next conversation start) and SHALL NOT silently drop or misreport the change.
4. The UI SHALL indicate, for each pending change, whether it is applied, staged for idle, or deferred to the next conversation start.
5. WHEN a live-apply attempt fails THEN the failure SHALL be surfaced to the UI, the override SHALL remain in storage, and the system SHALL allow retry.

### Requirement 10: Codex next-turn staging

**Objective**: As a CC user, I want Codex capability changes to take effect on the next turn, matching how Codex MCP changes already work in CC.

#### Acceptance Criteria

1. WHEN a user changes a Codex capability override THEN the system SHALL stage the change and apply it at the start of the next agent turn.
2. WHEN a Codex turn is in flight at the moment of change THEN the system SHALL NOT interrupt the turn; staging waits until the turn completes.
3. The UI SHALL indicate whether a pending Codex change is staged for the next turn or has been applied.
4. The system SHALL NOT attempt to live-apply Codex capability changes mid-turn.

### Requirement 11: Five UI configuration panels

**Objective**: As a CC user, I want one focused configuration panel per cascade kind, so that backend-specific ecosystems are not visually merged.

#### Acceptance Criteria

1. The UI SHALL expose five separate configuration panels: Claude Skills, Claude Plugins, Claude Sub-Agents, Codex Skills, and Codex Plugins.
2. Each panel SHALL display, per item: name, source (e.g., owning plugin, file location, or marketplace), backend, effective state, the cascade layer that set the effective state, inherited-disable reason (if applicable), and any pending or stale status.
3. Each panel SHALL allow filtering by enabled/disabled/stale state and searching by name.
4. Each panel SHALL clearly indicate which cascade layer is currently being edited and SHALL allow switching layers without leaving the panel.

### Requirement 12: Backend capability metadata for gating

**Objective**: As a CC maintainer, I want backend-specific capability metadata so that the UI and runtime know what each backend supports without scattering conditionals across the codebase.

#### Acceptance Criteria

1. The system SHALL declare, per backend, which capability kinds are supported, the apply semantics for each kind (idle live-apply, next-turn, or deferred-to-next-conversation), and which discovery sources are authoritative.
2. The runtime SHALL consult this metadata before attempting any live-apply or staging action.
3. The UI SHALL consult this metadata to decide which panels and status labels to render.
4. Adding a new backend in the future SHALL be expressible as additional metadata records rather than requiring backend-kind conditionals scattered at call sites.

### Requirement 13: Validation and user-visible errors

**Objective**: As a CC user, I want invalid overrides rejected at write time with a clear error, so that broken configuration does not silently fail at conversation start.

#### Acceptance Criteria

1. WHEN an override is written THEN the system SHALL validate the input against a structured schema and SHALL reject the write with a structured error if validation fails.
2. WHEN an override references an item identifier that is not currently present in discovery THEN the system SHALL accept the write and flag the override as stale in the UI, because the item may reappear later.
3. WHEN composition at conversation start surfaces a runtime error THEN the system SHALL surface the error to the UI and SHALL NOT block the conversation from starting (see Requirement 8).

### Requirement 14: Persistence

**Objective**: As a CC user, I want capability configuration to survive restart, so that my overrides are stable across CC sessions.

#### Acceptance Criteria

1. WHEN an override change is applied THEN the change SHALL be persisted such that an invalid write does not corrupt the stored cascade state.
2. WHEN the server restarts THEN all cascade layers SHALL be restored to their pre-restart state.
3. WHEN persistence fails THEN the system SHALL surface the failure and SHALL NOT report the change as successful.

### Requirement 15: Cross-client synchronization

**Objective**: As a CC user, I want capability configuration changes to propagate to all my connected clients in real time, so that multiple windows or devices stay in sync.

#### Acceptance Criteria

1. WHEN an override change is applied THEN every connected client SHALL observe the change promptly without requiring a page reload.
2. The change notification SHALL include enough information for clients to refresh the affected cascade and layer.
3. Two clients editing the same cascade SHALL converge to the same effective state after both edits are applied.

### Requirement 16: Diagnostics and error visibility

**Objective**: As a CC user or operator, I want capability-configuration events and errors to be observable, so that issues can be diagnosed without guessing.

#### Acceptance Criteria

1. WHEN an override is mutated, a discovery operation fails, a composition operation fails, or an apply attempt completes (success or failure) THEN the event SHALL be visible to operators through CC's structured diagnostics.
2. WHEN a user-visible error occurs (validation failure, live-apply failure, persistence failure) THEN the UI SHALL surface a clear message describing what failed and what the user can do next.
3. Diagnostics SHALL carry enough context (cascade kind, layer, item identifier, backend) for an operator to correlate events across the override lifecycle.

## Out of Scope

- **Plugin and skill install/uninstall** — CC only toggles already-installed items; managing the underlying installation is left to native backend tooling.
- **Plugin marketplace browsing**.
- **Graph-workflow transient overrides** — per-node capability configuration inside a workflow run is deferred to a follow-up spec; this spec does not pre-constrain that future feature's design.
- **Cross-backend mirroring** of capability configuration — the five cascades are intentionally independent and SHALL NOT be merged.
- **Migrating an override between cascade layers** (e.g., promoting a conversation-layer override to the project layer) — a future ergonomics feature.
- **Per-item parameter editing beyond enable/disable** (e.g., editing a skill's prompt template) — initial scope is the enable/disable toggle only.
