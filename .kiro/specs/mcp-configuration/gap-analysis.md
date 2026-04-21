# Gap Analysis: MCP Configuration

## Analysis Summary

The requirements describe a first-class MCP configuration system with hierarchical overrides, server-level toggles, tool-level filters, backend-neutral emission, and UI support across global, project, session, and conversation scopes.

The codebase already has several useful foundations:

- A backend-neutral `PortableMcpServerConfig` shape in `src/lib/agent-backends/portable-mcp.ts`.
- Claude and Codex translators in `src/lib/agent-backends/mcp-translation.ts`.
- Conversation runtime hooks for applying portable MCP config through `ConversationBackendRuntime.applyPortableMcpConfig`.
- Command Center injected MCP gateway server builders in `src/lib/mcp-gateway/portable-config.ts`.
- Presentational MCP UI components in `src/components/mcp/`.
- State, query, mutation, and SSE patterns that can be extended for MCP configuration.

The largest gaps are persistence, cascade resolution, source discovery, tool discovery/cache, backend capability modeling, UI data wiring, API routes, SSE updates, and safer backend emission semantics.

The overall goal is viable, but tool-level filtering is asymmetric across backends and transports. Codex appears to support `enabled`, `enabled_tools`, and `disabled_tools` in MCP server config. Claude supports dynamic MCP server replacement through the Agent SDK and has native tool policy fields for HTTP/SSE servers, but stdio tool filtering requires a permission-layer fallback unless further SDK behavior proves otherwise.

The requirements document has been generated but is not yet approved. Design should proceed only after Alex confirms the requirements or explicitly chooses to fast-track.

## Document Status

- Spec: `mcp-configuration`
- Language: `en`
- Current phase: `requirements-generated`
- Requirements generated: yes
- Requirements approved: no
- Design generated: no
- Tasks generated: no
- Analysis approach: loaded spec metadata, requirements, all steering files, gap-analysis rules, current focus context, SDK typings, backend runtimes, MCP translators, gateway config, state schemas, API routes, query/mutation patterns, SSE infrastructure, and existing MCP UI components.

## Current Implementation Assets

### Backend Abstraction

- `src/lib/agent-backends/portable-mcp.ts`
  - Defines the current canonical portable MCP config.
  - Already includes `enabled`, `enabledTools`, and `disabledTools`.
  - Includes `McpApplyResult` dispositions for live/deferred/unsupported/rejected updates.

- `src/lib/agent-backends/conversation.ts`
  - Defines `ConversationToolingOverrides`.
  - Defines `ConversationBackendRuntime.applyPortableMcpConfig`.
  - This is the correct backend-neutral seam for applying resolved MCP config.

- `src/lib/agent-backends/types.ts`
  - Defines backend IDs and capability flags.
  - Current capabilities are too coarse for MCP feature negotiation.

### Backend Translators

- `src/lib/agent-backends/mcp-translation.ts`
  - Codex translator already emits server enablement, tool allow/deny lists, timeouts, env, HTTP headers, and bearer-token env vars.
  - Claude translator currently drops disabled servers and rejects `enabledTools`/`disabledTools`.
  - Claude translator needs to account for native HTTP/SSE tool policy support and permission-layer fallback.

### Claude Runtime

- `src/lib/agent-backends/claude/conversation-runtime.ts`
  - Already applies portable MCP updates through `query.setMcpServers(...)`.
  - Reports `portableMcpAtStart` and `portableMcpBetweenTurns` capability support.
  - Needs `strictMcpConfig: true` when Command Center owns the effective MCP list.

- `src/lib/agent-backends/claude/query-session.ts`
  - Wraps the Anthropic Agent SDK.
  - Supports passing `mcpServers`, `canUseTool`, and SDK options.
  - Does not currently pass `strictMcpConfig`.

- `src/lib/agent-backends/claude/native-tooling.ts`
  - Central permission hook exists through `canUseTool`.
  - Currently handles Command Center-specific tools such as `AskUserQuestion`; it does not enforce MCP tool filters.

### Codex Runtime

- `src/lib/agent-backends/codex/conversation-runtime.ts`
  - Creates per-turn Codex SDK clients while preserving thread ID.
  - Stages portable MCP config and applies it on the next turn.
  - Emits translated config through `options.config.mcp_servers`.
  - This matches the "next turn" requirement naturally.

### Command Center MCP Gateway

- `src/lib/mcp-gateway/portable-config.ts`
  - Builds CC injected gateway servers such as `cc-session-tools`, `cc-graph-workflow`, and `cc-workflow-draft`.
  - Merges portable MCP configs by server ID.
  - Needs explicit non-togglable/injected metadata and collision protection.

### State and Config

- `src/lib/schemas.ts`
  - Defines global config, project state, session state, conversation state, and SSE event schemas.
  - No MCP override state exists today.

- `src/lib/state.ts`
  - Provides atomic state mutation and persistence for project/session/conversation data.
  - Good fit for project, session, and conversation MCP override state.

- `src/lib/config.ts`
  - Provides OS-aware global config paths.
  - Needs either an MCP-specific global state file or additions to global config.

### UI

- `src/components/mcp/`
  - Presentational components already exist for server lists, server cards, tool rows, inheritance badges, popovers, modals, global config sections, and info chips.
  - Components are not wired to query/mutation APIs yet.

- `src/app/config/ConfigEditor.tsx`
  - Existing global config page can host a global MCP section.

- `src/app/projects/[name]/[session]/SessionDetailPage.tsx`
  - Existing prompt toolbar, backend controls, and info strip can host conversation/session MCP entry points.

- `src/app/projects/[name]/ProjectActionsBar.tsx`
  - Existing project actions area can host project-level MCP configuration.

## Requirement-to-Asset Map

| Requirement | Existing assets | Gap type | Gaps and constraints |
| --- | --- | --- | --- |
| 1. Hierarchical MCP configuration | State/config patterns; graph workflow cascade patterns; presentational inheritance UI | Missing | No global/project/session/conversation override schema, resolver, effective-view API, conflict model, or reset-to-inherit mutation exists. Need deterministic cascade resolution and explicit diff persistence. |
| 2. Enable/disable MCP servers | Portable config has `enabled`; Codex translator emits `enabled`; Claude translator drops disabled servers | Partial | Need persisted server overrides, UI mutations, backend-specific application, and clear handling for disabled inherited servers. Claude should omit disabled user servers from dynamic config; injected CC servers must remain included. |
| 3. Auto-promote inherited server toggles | Presentational UI supports source/inheritance status | Missing | No mutation behavior exists to create explicit overrides at the current scope when inherited state is changed. Need resolver to report source scope and mutation layer to persist a minimal override. |
| 4. Per-tool filtering | Portable config has `enabledTools`/`disabledTools`; UI types include tools; Codex translator emits tool lists | Partial | Claude translator rejects tool filters today. Claude SDK has native HTTP/SSE tool policy support, but stdio filtering likely needs `canUseTool` fallback. Need capability model, enforcement path, and UI compatibility indicators. |
| 5. Dynamic tool discovery/cache | Claude SDK exposes MCP server status with tool metadata; UI has discovery-state fields | Missing | No discovery service, cache, refresh endpoint, stale-state model, orphaned override handling, or Codex discovery strategy exists. Codex SDK does not expose a typed tool-list API in current typings. |
| 6. Mid-conversation reconfiguration | Runtime hook exists; Claude uses `setMcpServers`; Codex stages config for next turn | Partial | Orchestration does not yet resolve/apply persisted MCP updates before each turn. Claude needs `strictMcpConfig: true` to make Command Center authoritative. UI needs pending/deferred feedback. |
| 7. Read-only discovery from backend config files | Repo has `.mcp.json` and `.codex/config.toml`; config path helpers exist | Missing | No discovery module reads backend config files. No TOML parser dependency is present. Need read-only parsing, merge precedence, malformed-file diagnostics, and secret-safe logging. |
| 8. Backend-agnostic abstraction | Portable MCP config and translators exist | Partial | Capability flags are too broad. Need canonical config/view models, explicit translator capability results, and backend feature metadata that does not leak Claude/Codex assumptions into UI components. |
| 9. CC injected gateway servers | Gateway portable config builder exists | Partial | Need explicit internal/injected server marker, no user override ability, collision handling, and UI hiding or locked display. Must avoid letting user config shadow required CC servers. |
| 10. First-class UI surfaces | Presentational components exist; target pages exist | Partial | Need API routes, query keys, query hooks, mutations, SSE invalidation, modal state integration, and layout insertion points on `/config`, project actions, session info, and prompt toolbar. |
| 11. Live cross-client updates | SSE broadcaster and typed event union exist | Missing | Need MCP SSE event schemas, server-side broadcasts after mutations/discovery refresh, and client-side invalidation for global/project/session/conversation views. |

## SDK Viability Findings

### Anthropic Agent SDK

Claude support is viable with important constraints:

- `Options.mcpServers` can provide dynamic MCP server config.
- `Query.setMcpServers(...)` can update dynamically-added servers.
- `strictMcpConfig: true` is needed if Command Center should own the full effective MCP set and avoid settings-file servers continuing outside CC's control.
- `Query.mcpServerStatus()` can expose connected server status and tool metadata.
- HTTP/SSE MCP server configs support a `tools` policy field with `always_allow`, `always_ask`, and `always_deny`.
- Stdio MCP server configs do not appear to expose the same `tools` policy in the installed typings, so stdio per-tool filtering should use a permission-layer fallback unless further testing proves a native path.

Design implication: Claude emission should combine native server omission for disabled servers, native HTTP/SSE tool policy where available, and `canUseTool` enforcement as fallback for unsupported native filtering.

### Codex SDK

Codex support is viable with a different application model:

- `CodexOptions.config` accepts a generic config object that can include `mcp_servers`.
- The existing runtime already creates a new Codex client per turn while preserving thread identity.
- Staged MCP config naturally takes effect on the next turn.
- Local spike artifacts indicate Codex honors `enabled: false`.
- Binary/config evidence and the existing translator indicate support for `enabled_tools` and `disabled_tools`, but the installed SDK does not provide typed MCP config schemas.

Design implication: Codex should keep using portable-to-config translation, but tests should lock down the emitted config shape and at least one runtime spike should remain available for validating behavior against SDK upgrades.

## Key Constraints

### API Route Collision

`src/app/api/projects/[name]/sessions/[session]/mcp/route.ts` is already the streamable HTTP MCP endpoint used by agents. It cannot also become the human-facing MCP configuration API without conflicting with MCP transport methods and semantics.

Recommended config API paths:

- Global: `/api/config/mcp`
- Project: `/api/projects/[name]/mcp-config`
- Session: `/api/projects/[name]/sessions/[session]/mcp-config`
- Conversation: `/api/projects/[name]/sessions/[session]/conversations/[conversationId]/mcp-config`

### Secrets and Logging

Backend config files may contain env var names, headers, and token references. Discovery and resolver logs should report counts, IDs, scopes, and error classes, not full command arguments, headers, tokens, or raw config payloads.

### Requirements Approval

The spec is still in `requirements-generated` state. Design should treat the requirements as draft until Alex approves them.

### TOML Parsing

Codex user/project config discovery requires reading TOML. The app currently has no TOML parsing dependency. The design should choose a structured TOML parser rather than hand-parsing arbitrary TOML.

## Implementation Options

### Option A: Extend Existing Paths Directly

Add MCP fields directly to existing schemas, add route handlers near existing project/session APIs, wire UI components directly to those APIs, and expand existing translators.

Pros:

- Fastest path to visible functionality.
- Reuses current project/session/conversation state machinery.
- Minimal new folder structure.

Cons:

- Resolver, discovery, and backend application logic can become scattered.
- Backend-specific capability checks may leak into UI/API code.
- Harder to test the cascade and translation behavior in isolation.

### Option B: Build a Dedicated MCP Domain Subsystem

Create a focused `src/lib/mcp/` domain with schemas, source discovery, override persistence helpers, cascade resolver, tool discovery/cache, backend capability projection, and translator integration.

Pros:

- Clean domain boundary for a cross-cutting feature.
- Easier red-green TDD around pure resolver/discovery logic.
- Better fit for future backends.
- Keeps UI and conversation orchestration thin.

Cons:

- More upfront structure.
- Requires careful integration with existing state/config APIs.
- May feel heavier than necessary if the feature scope shrinks.

### Option C: Hybrid Pure Core Plus Thin Integration

Create pure MCP domain modules for the data model, discovery normalization, cascade resolution, compatibility computation, and translator-policy decisions. Keep persistence in existing state/config modules, backend application in existing runtimes, and UI wiring in existing page components.

Pros:

- Preserves current architecture while keeping complex MCP logic testable.
- Supports red-green TDD for the risky pieces.
- Avoids scattering cascade and compatibility logic through route handlers.
- Leaves room for future backends without over-abstracting UI components.

Cons:

- Requires disciplined boundaries between pure resolver logic and state/API wiring.
- Some duplicate-looking adapter code will be needed for global/project/session/conversation endpoints.

Recommendation: Option C.

## Effort and Risk

- Effort: XL
- Risk: High

Rationale:

- Four-level configuration persistence plus live UI updates is broad.
- Tool discovery and tool filtering semantics vary by backend and transport.
- Claude and Codex apply runtime updates differently.
- The route-space collision with existing MCP gateway endpoints requires careful API design.
- The feature touches state schemas, global config, API routes, SSE events, query/mutation hooks, conversation orchestration, backend translators, and multiple UI surfaces.

Risk is manageable if the design splits pure MCP resolution/translation tests from integration tests and keeps backend-specific behavior behind explicit capability declarations.

## Design Phase Recommendations

1. Define canonical MCP domain types before UI/API wiring:
   - `McpServerDefinition`
   - `McpToolDefinition`
   - `McpScope`
   - `McpOverridePatch`
   - `McpEffectiveServer`
   - `McpEffectiveTool`
   - `McpResolvedConfig`
   - `McpBackendCompatibility`

2. Represent override state as sparse diffs:
   - Server override: explicit enabled/disabled/reset.
   - Tool override: explicit enabled/disabled/reset.
   - Source metadata: global/project/session/conversation.
   - Preserve orphaned tool overrides when a tool is absent from current discovery.

3. Keep discovery read-only:
   - Normalize Claude `.mcp.json` style config.
   - Normalize Codex TOML config.
   - Never mutate backend config files.
   - Report malformed or unsupported entries as diagnostics in the effective view.

4. Make Command Center authoritative at runtime:
   - For Claude, pass `strictMcpConfig: true` with the full resolved dynamic set.
   - For Codex, pass full resolved `mcp_servers` config on each turn.
   - Append CC injected gateway servers after user-resolved servers and protect reserved IDs.

5. Model backend capabilities explicitly:
   - Server enable/disable support.
   - Mid-conversation application mode: immediate, next turn, unsupported.
   - Native tool filtering support by server transport.
   - Permission fallback availability.
   - Tool discovery support and discovery confidence.

6. Use native tool filtering when available:
   - Codex: emit `enabled_tools`/`disabled_tools`.
   - Claude HTTP/SSE: emit native tool policy if tests confirm behavior.
   - Claude stdio: enforce through `canUseTool` fallback unless a native SDK path is confirmed.

7. Avoid `/mcp` for config APIs:
   - Keep `/mcp` reserved for streamable MCP transport endpoints.
   - Use `/mcp-config` or `/config/mcp` paths for human/UI configuration.

8. Add SSE as a first-class part of the design:
   - Broadcast global/project/session/conversation MCP config updates.
   - Broadcast discovery refresh completion/errors.
   - Invalidate corresponding query keys in all open clients.

9. Test in layers:
   - Pure resolver tests for cascade behavior.
   - Source discovery tests using fixtures for `.mcp.json` and Codex TOML.
   - Translator tests for Claude/Codex config emission and unsupported-feature reporting.
   - Route handler tests for sparse patch persistence.
   - Conversation orchestration tests proving resolved config is applied before the next turn.
   - UI component integration tests only after data contracts stabilize.

## Research Needed Before Implementation

1. Confirm exact Claude permission hook inputs for MCP tool calls:
   - Tool name format passed to `canUseTool`.
   - Whether `disallowedTools` can hide MCP tools from the model using names such as `mcp__server__tool`.
   - Whether permission denial is acceptable UX or whether hidden tools are required.

2. Confirm Claude native tool policy behavior:
   - HTTP and SSE server behavior with `tools` policies.
   - Whether any undocumented stdio tool policy is accepted or rejected.
   - How policy interacts with `canUseTool`.

3. Confirm Codex tool filtering behavior:
   - `enabled_tools` and `disabled_tools` precedence.
   - Behavior when both lists are present.
   - Behavior for unknown tool names.
   - Whether config overrides replace or merge with user TOML.

4. Decide Codex tool discovery strategy:
   - Direct MCP client discovery from source config.
   - Runtime event-derived cache.
   - Codex CLI/SDK introspection if available in future versions.

5. Choose TOML parser:
   - Prefer a maintained structured parser compatible with Bun/Next.js server runtime.
   - Add focused malformed-file tests.

6. Decide global MCP override storage:
   - Add fields to existing global config.
   - Or create a separate `mcp-config.json` in the Command Center config directory with atomic writes.

## Suggested Next Steps

1. Alex reviews and approves or revises `.kiro/specs/mcp-configuration/requirements.md`.
2. Run `/kiro:spec-design mcp-configuration` after requirements approval.
3. In the design phase, settle the API path convention, global storage location, and tool filtering semantics.
4. Before implementation, run targeted SDK spikes for Claude tool policy and Codex tool filtering behavior.
5. Implement using red-green TDD, starting with pure cascade resolver tests before route/UI/backend wiring.
