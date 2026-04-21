# Research & Design Decisions: MCP Configuration

## Summary
- **Feature**: `mcp-configuration`
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  - Command Center already has a useful backend-neutral MCP layer (`PortableMcpServerConfig`, backend translators, and runtime apply hooks), but it only accepts caller-supplied runtime tooling. The missing layer is persistent, hierarchical configuration and resolution.
  - Claude and Codex can both support server-level toggles and next-turn application, but they differ at the boundary: Claude has typed SDK APIs and runtime server status, while Codex accepts MCP config through a generic config object and applies it per turn.
  - Tool-level filtering is viable, but not uniformly native. Claude has native tool policies for HTTP and SSE servers only; stdio requires `canUseTool` fallback. Codex exposes `enabled_tools` and `disabled_tools` config keys through CLI/SDK config flattening, but the SDK does not type them.
  - The existing session MCP route is the streamable HTTP gateway endpoint. Configuration APIs must use `/mcp-config` or `/config/mcp` paths to avoid colliding with the gateway protocol.
  - Existing presentational MCP UI components are available under `src/components/mcp/`, but they need data wiring, scope-aware API routes, SSE invalidation, and insertion into the required global, project, session, and conversation surfaces.

## Research Log

### Existing Backend Abstractions
- **Context**: Determine whether MCP configuration can be expressed without branching UI and storage by backend.
- **Sources Consulted**:
  - `src/lib/agent-backends/portable-mcp.ts`
  - `src/lib/agent-backends/mcp-translation.ts`
  - `src/lib/agent-backends/conversation.ts`
  - `src/lib/agent-backends/types.ts`
  - `src/lib/mcp-gateway/portable-config.ts`
- **Findings**:
  - `PortableMcpServerConfig` already models stdio and streamable HTTP servers, server `enabled`, `enabledTools`, `disabledTools`, and timeout fields.
  - Both conversation runtimes expose `applyPortableMcpConfig`, so a generic runtime application service can sit above Claude and Codex.
  - The existing capability model only says whether portable MCP is supported at start and between turns; it does not describe native disable, native tool filtering, strict authoritative config, or tool discovery support.
  - CC-injected gateway servers are built separately by `buildSessionToolsPortableMcp`, `buildGraphWorkflowPortableMcp`, and `buildWorkflowDraftPortableMcp`.
- **Implications**:
  - Keep the generic MCP domain model close to the existing portable model, but extend capabilities and resolution rather than replacing backend runtimes.
  - Preserve runtime-injected graph workflow and draft tooling as transient runtime input, not persistent user MCP state.

### Anthropic Agent SDK MCP Controls
- **Context**: Verify whether Claude supports dynamic MCP server updates and tool filtering.
- **Sources Consulted**:
  - `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  - `src/lib/agent-backends/claude/query-session.ts`
  - `src/lib/agent-backends/claude/conversation-runtime.ts`
  - `src/lib/agent-backends/claude/native-tooling.ts`
- **Findings**:
  - `Options.strictMcpConfig?: boolean` allows SDK config to be authoritative instead of additive with settings-file MCP servers.
  - `Query.setMcpServers(...)` replaces dynamic MCP servers but does not affect servers loaded from settings files.
  - `Query.mcpServerStatus()` exposes connected server status and discovered tool metadata.
  - HTTP and SSE server configs accept native `tools?: McpServerToolPolicy[]`; stdio server configs do not.
  - `canUseTool` receives raw tool names and can deny a tool call without ending the conversation turn.
- **Implications**:
  - Claude turns should be created with `strictMcpConfig: true` and the fully resolved MCP server set from Command Center.
  - Server-level changes can use `setMcpServers` between turns for active runtimes; while a turn is running, the UI should mark the change pending for the next turn.
  - Tool filtering should use native policies where available and `canUseTool` fallback for stdio and unsupported cases.

### Codex SDK MCP Controls
- **Context**: Verify whether Codex can receive server toggles and tool filters from Command Center.
- **Sources Consulted**:
  - `node_modules/@openai/codex-sdk/dist/index.d.ts`
  - `src/lib/agent-backends/codex/conversation-runtime.ts`
  - `memory-bank/phase-0-verification.md`
  - `package.json`
- **Findings**:
  - `CodexOptions.config?: CodexConfigObject` is generic and is flattened to CLI config arguments by the SDK.
  - The existing runtime already stages translated `mcp_servers` config and applies it when building the next Codex turn options.
  - Local verification confirmed `mcp_servers.<name>.enabled = false` prevents Codex from spawning a configured MCP server. Omitting a server is not equivalent, because Codex can fall back to config TOML.
  - SDK typings expose MCP tool call events, but not a typed list-tools or MCP inventory API.
- **Implications**:
  - Codex server disable must emit `enabled: false`, not omit the server.
  - Codex dynamic configuration is next-turn only because the runtime constructs per-turn SDK requests.
  - Tool discovery for Codex should use a direct MCP SDK probe instead of relying on SDK runtime status.

### Source Discovery and Parsing
- **Context**: Discover native MCP server definitions without taking ownership of native config files.
- **Sources Consulted**:
  - `.mcp.json`
  - `.claude/settings.json`
  - `.codex/config.toml`
  - `src/lib/config.ts`
  - `src/lib/state.ts`
  - `npm view smol-toml`
- **Findings**:
  - The worktree has `.mcp.json` and `.codex/config.toml` definitions for `next-devtools` and `chrome-devtools`.
  - `.claude/settings.json` exists but currently does not contain MCP server definitions.
  - No TOML parser is currently part of the app dependency set.
  - `smol-toml@1.6.1` is typed, dependency-free, and suitable for parsing Codex config without bringing in a larger parser.
  - Project, session, and conversation state already use atomic state mutation helpers; global config writes do not currently provide a scoped MCP override file.
- **Implications**:
  - Native files should be read-only source inputs with diagnostics for missing, malformed, or unsupported entries.
  - Persistent overrides should live in Command Center state, separate from native config files.
  - Global MCP overrides should use a dedicated atomic `mcp-global.json` file in the CC config directory rather than expanding `config.json` with large per-server state.

### Tool Discovery
- **Context**: Determine how to populate per-server tool toggles while avoiding slow work on every render.
- **Sources Consulted**:
  - `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts`
  - `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts`
  - `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts`
  - `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- **Findings**:
  - The MCP SDK `Client` exposes `listTools`.
  - `StdioClientTransport` and `StreamableHTTPClientTransport` can be used for direct probes.
  - Claude can provide live tool metadata through `mcpServerStatus()` for active conversation runtimes.
  - Direct probes need timeouts, process cleanup, sanitized error reporting, and cache invalidation when server config signatures change.
- **Implications**:
  - Tool discovery should be lazy, per-server, and cached by a stable config signature.
  - Runtime discovery should be preferred when available because it matches the active backend process.
  - The UI must show loading and error states independently per server.

### API, State, and SSE Integration
- **Context**: Identify project patterns for routes, state mutation, and live client updates.
- **Sources Consulted**:
  - `src/lib/schemas.ts`
  - `src/lib/state.ts`
  - `src/lib/sse-broadcaster.ts`
  - `src/components/NotificationListener.tsx`
  - `src/app/api/projects/[name]/sessions/[session]/mcp/route.ts`
  - `src/app/api/config/route.ts`
  - `src/app/api/projects/[name]/queue/queue-route-handlers.ts`
- **Findings**:
  - `src/lib/schemas.ts` is the central Zod schema file and should receive new state and SSE event schemas.
  - Route handlers commonly delegate to testable factory functions with injected dependencies.
  - `NotificationListener` centralizes EventSource handling and TanStack Query invalidation.
  - The current `/api/projects/[name]/sessions/[session]/mcp` path is an MCP protocol endpoint, so configuration routes must avoid that namespace.
- **Implications**:
  - Add `mcp-config-updated` and `mcp-tools-updated` SSE events to the existing event union.
  - Use new route paths such as `/api/config/mcp` and `/api/.../mcp-config`.
  - Keep route handlers thin and test core logic through dependency-injected services.

### UI Integration
- **Context**: Map the required first-class UI surfaces to existing components.
- **Sources Consulted**:
  - `src/components/mcp/McpGlobalSection.tsx`
  - `src/components/mcp/McpServersModal.tsx`
  - `src/components/mcp/McpConfigPopover.tsx`
  - `src/components/mcp/McpInfoChip.tsx`
  - `src/app/config/ConfigEditor.tsx`
  - `src/app/projects/[name]/ProjectActionsBar.tsx`
  - `src/app/projects/[name]/[session]/SessionDetailPage.tsx`
  - `src/app/projects/[name]/[session]/InfoDetailsPopover.tsx`
- **Findings**:
  - Presentational MCP components already model levels, source scopes, inheritance status, backend labels, per-tool states, and callbacks.
  - Required insertion points exist in the global config page, project actions bar, session info strip, session details popover, and conversation prompt toolbar.
  - The existing components are not yet connected to TanStack Query, mutation APIs, or SSE invalidation.
- **Implications**:
  - Keep the presentational component set and add a small data hook layer instead of duplicating UI per scope.
  - Surface the same resolved view model at every level so the UI never branches by backend.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Native file mutation | Toggle MCP by directly editing `.mcp.json`, `.claude/settings.json`, and `.codex/config.toml` | Mirrors user-visible native tools | Violates read-only requirement, creates backend branching in UI, risks corrupting user config | Rejected |
| Backend-specific config paths | Build separate Claude and Codex config flows from UI to runtime | Lower initial abstraction cost | Duplicates UI and storage semantics, makes future backends harder, weakens inheritance model | Rejected |
| Generic MCP domain with backend adapters | Store overrides and resolve effective config once, then translate at the emission boundary | Testable core, backend-neutral UI, preserves current runtime boundaries | Requires careful capability modeling and tool-filter fallback | Selected |
| Gateway proxy for all MCP servers | Route every MCP tool call through a CC-owned proxy that enforces filters | Strong enforcement and observability | Larger feature, process lifecycle and auth complexity, unnecessary for server toggles | Deferred |

## Design Decisions

### Decision: Use a Generic MCP Domain Layer
- **Context**: Requirements call for Claude, Codex, and future backend support without UI or storage branching.
- **Alternatives Considered**:
  1. Backend-specific UI and API paths.
  2. Direct native file mutation.
  3. Backend-neutral resolver with translator adapters.
- **Selected Approach**: Add an MCP domain layer that discovers native sources, stores Command Center overrides, resolves effective config, and emits a portable server set to backend adapters.
- **Rationale**: This matches existing portable MCP runtime boundaries and keeps backend differences contained in translators and capability declarations.
- **Trade-offs**: The domain layer must own canonical identifiers, diagnostics, inheritance, and capability checks.
- **Follow-up**: Add focused resolver and translator tests before wiring API routes.

### Decision: Store Overrides Separately From Native Sources
- **Context**: Native config files should be sources of server definitions, not write targets.
- **Alternatives Considered**:
  1. Write native config files.
  2. Extend `config.json` with all MCP state.
  3. Store global overrides in `mcp-global.json` and lower scopes in existing state records.
- **Selected Approach**: Read native files only. Persist global overrides in a dedicated atomic file and lower-scope overrides in project, session, and conversation state.
- **Rationale**: This preserves user-owned native config files and matches the requirement for scope-specific Command Center state.
- **Trade-offs**: Effective config requires resolution at read/apply time instead of reading one flat file.
- **Follow-up**: Implement invariant cleanup so empty override records are removed automatically.

### Decision: Use `/mcp-config` Route Names
- **Context**: The session `/mcp` route already implements the streamable HTTP MCP gateway.
- **Alternatives Considered**:
  1. Put config routes under `/mcp`.
  2. Use `/tools/mcp`.
  3. Use `/mcp-config` and `/config/mcp`.
- **Selected Approach**: Use `/api/config/mcp` globally and `/api/.../mcp-config` for project, session, and conversation scopes.
- **Rationale**: The path makes intent explicit and avoids protocol route collisions.
- **Trade-offs**: Slightly longer route names.
- **Follow-up**: Add route tests that assert the gateway route remains unchanged.

### Decision: Prefer Runtime Tool Discovery, Fall Back to Direct Probe
- **Context**: Tool filters need tool lists, but the backend SDKs expose different runtime metadata.
- **Alternatives Considered**:
  1. Always spawn direct MCP probes.
  2. Always rely on backend runtime metadata.
  3. Prefer backend runtime metadata when available, otherwise probe directly with the MCP SDK.
- **Selected Approach**: Use Claude `mcpServerStatus()` when available for conversation scope, and direct MCP SDK probes for Codex, inactive runtimes, and force refresh.
- **Rationale**: Runtime metadata best matches active Claude behavior, while direct probes provide a backend-neutral fallback.
- **Trade-offs**: Direct stdio probes can be slower and must be aggressively timed out and cleaned up.
- **Follow-up**: Add probe tests with fake transports and a manual verification case for real stdio servers.

### Decision: Apply Changes on the Next Turn Boundary
- **Context**: Requirement 6 permits mid-conversation edits but requires changes to take effect on the agent's next turn without aborting active work.
- **Alternatives Considered**:
  1. Restart active agents immediately.
  2. Apply live changes during a running turn.
  3. Persist immediately and apply at the next turn boundary, using live replace only when safely between turns.
- **Selected Approach**: Persist changes immediately, mark impacted running conversations pending, and apply the resolved config before the next turn starts. Claude may replace dynamic servers while idle; Codex stages config for its next turn.
- **Rationale**: This keeps behavior predictable and avoids interrupting active SDK runs.
- **Trade-offs**: A UI pending state is required.
- **Follow-up**: Add runtime tests for running, idle, and no-runtime conversations.

### Decision: Enforce Tool Filtering With Native Policy First
- **Context**: Tool-level enablement must work across backends even though native support differs.
- **Alternatives Considered**:
  1. Disable tool filtering unless native backend support exists.
  2. Use permission fallback for every backend.
  3. Use native filters when the backend and transport support them, with fallback where possible.
- **Selected Approach**: Claude HTTP/SSE uses native tool policies; Claude stdio uses `canUseTool`; Codex emits `enabled_tools` or `disabled_tools` through config. Any unsupported case is surfaced as a capability diagnostic.
- **Rationale**: This maximizes native support without hiding limitations.
- **Trade-offs**: Claude fallback depends on correct MCP tool-name parsing.
- **Follow-up**: Spike and test Claude raw MCP tool-name formats before enabling fallback broadly.

### Decision: Append and Protect CC-Injected Gateway Servers
- **Context**: CC-injected session, graph workflow, and workflow draft servers are operational infrastructure, not user configuration.
- **Alternatives Considered**:
  1. Show injected servers as editable rows.
  2. Hide injected servers but let user servers override IDs.
  3. Hide or lock injected servers and reserve their IDs during emission.
- **Selected Approach**: Append injected gateway servers after user-resolved config, keep them non-togglable in UI, and preserve injected definitions on ID collision.
- **Rationale**: This prevents users from disabling Command Center infrastructure by accident and preserves existing workflow tooling.
- **Trade-offs**: Collision diagnostics must explain why a user server was renamed, shadowed, or excluded.
- **Follow-up**: Add resolver tests for reserved ID collisions.

## Risks & Mitigations
- Claude stdio tool filtering depends on raw tool-name parsing. Mitigation: implement parser tests from observed SDK events and keep fallback disabled with a diagnostic if the name cannot be mapped confidently.
- Codex MCP filtering keys are not typed in the SDK. Mitigation: cover translator output with tests and retain the verified CLI config shape from phase 0.
- Direct tool discovery can spawn slow or hanging stdio processes. Mitigation: use strict timeouts, process cleanup, cache by config signature, and per-server error states.
- Native config files may be malformed or differ by user environment. Mitigation: return diagnostics and continue resolving valid sources.
- Server identity across Claude and Codex can be ambiguous when names match but configs differ. Mitigation: store stable `serverKey` values separately from backend-native IDs and only coalesce definitions when normalized configs are equivalent.
- Route namespace collisions could break the MCP gateway. Mitigation: use `/mcp-config` routes and keep the existing `/mcp` route untouched.

## References
- `src/lib/agent-backends/portable-mcp.ts` - Existing backend-neutral MCP server shape.
- `src/lib/agent-backends/mcp-translation.ts` - Existing Claude and Codex MCP translators.
- `src/lib/agent-backends/claude/conversation-runtime.ts` - Claude runtime MCP application hook.
- `src/lib/agent-backends/codex/conversation-runtime.ts` - Codex next-turn MCP staging hook.
- `src/lib/mcp-gateway/portable-config.ts` - CC-injected MCP gateway server builders.
- `src/lib/schemas.ts` - Central Zod schema and SSE event definitions.
- `src/lib/state.ts` - Project, session, and conversation state mutation helpers.
- `src/lib/config.ts` - Global configuration directory handling.
- `src/app/api/projects/[name]/sessions/[session]/mcp/route.ts` - Existing streamable HTTP MCP gateway route.
- `src/components/mcp/` - Existing presentational MCP UI primitives.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` - Installed Claude Agent SDK MCP types.
- `node_modules/@openai/codex-sdk/dist/index.d.ts` - Installed Codex SDK option and event types.
- `node_modules/@modelcontextprotocol/sdk/dist/esm/client/` - Installed MCP SDK client and transport types.
- `memory-bank/phase-0-verification.md` - Local Codex MCP disable verification.
- `smol-toml@1.6.1` - Candidate TOML parser for Codex config discovery.
