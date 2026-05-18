# Gap Analysis: Agent Capabilities Configuration

## Document Status

- Spec: `agent-capabilities-configuration`
- Source requirements: `.kiro/specs/agent-capabilities-configuration/requirements.md`
- Spec phase: `requirements-generated`
- Requirements approval: not approved
- Purpose: inform design-phase choices only. This document does not authorize implementation.

## Analysis Summary

- The existing MCP configuration subsystem is the strongest architectural precedent for four-layer cascade resolution, atomic patching, runtime apply tracking, SSE invalidation, and UI interaction patterns.
- Agent capabilities need a dedicated domain model because backend-native skills, plugins, and agents have different identities, discovery sources, parent-child semantics, and apply behavior from portable MCP servers.
- Existing command discovery covers part of skill discovery for autocomplete, but it does not model enablement defaults, plugin ownership, sub-agents, stale overrides, diagnostics, or runtime-visible state.
- Claude SDK surfaces useful runtime controls (`applyFlagSettings()`, `reloadPlugins()`, `supportedCommands()`, `supportedAgents()`), but the exact settings keys and native default semantics for per-skill/per-agent toggles need design-phase research.
- Codex currently exposes no typed skill/plugin API in the SDK usage present in this codebase; Codex capability composition likely depends on generic config pass-through or native file discovery that must be verified before design is finalized.

## Current Assets

### MCP Configuration Precedent

- `src/lib/schemas.ts` defines MCP override, runtime application, API response, diagnostics, and SSE schemas.
- `src/lib/mcp/global-store.ts` persists global MCP overrides through a dedicated atomic JSON file.
- `src/lib/mcp/scope-store.ts` writes project, session, and conversation MCP overrides through the state manager.
- `src/lib/mcp/overrides-patch.ts` applies pure patch operations and prunes empty overrides.
- `src/lib/mcp/resolver.ts` composes global -> project -> session -> conversation state and builds UI-ready effective views.
- `src/lib/mcp/composer.ts` and `src/lib/mcp/compose-for-conversation.ts` build runtime MCP configuration for a conversation.
- `src/lib/mcp/runtime-apply.ts` tracks applied/pending hashes and differentiates Claude live application from Codex next-turn staging.
- `src/lib/mcp-config-mutation-service.ts` provides conflict-checked atomic writes.
- `src/lib/mcp-config-route-handlers.ts` exposes GET/PATCH endpoints and broadcasts updates.
- `src/lib/mcp/sse-broadcast.ts` and `src/lib/mcp/sse-invalidation.ts` provide real-time invalidation patterns.
- `src/components/mcp/*`, `src/lib/queries.ts`, `src/lib/mutations.ts`, and `src/lib/query-keys.ts` provide UI/query/mutation patterns for inherited configuration.

### Backend Runtime Seams

- `src/lib/agent-backends/types.ts` has backend capability metadata, but only for broad conversation features and MCP-related behavior.
- `src/lib/agent-backends/conversation.ts` defines runtime operations for MCP application and MCP tool listing, but not skills/plugins/agents.
- `src/lib/agent-backends/claude/conversation-runtime.ts` already has an idle/deferred runtime-apply pattern for MCP.
- `src/lib/agent-backends/claude/query-session.ts` accepts Claude SDK options including `plugins`, `settingSources`, and MCP options.
- `src/lib/agent-backends/codex/conversation-runtime.ts` stages MCP configuration for the next turn and passes generic Codex config into each SDK client.
- `src/lib/workflows/conversation/actor-implementations.ts` is the conversation-start and turn-start integration point for composed runtime tooling.

### Discovery and Native Source Clues

- `src/lib/commands.ts` scans Claude and Codex command/skill directories for autocomplete.
- `src/lib/commands.ts` resolves enabled Claude plugin paths from Claude native files, read-only, for plugin-provided command and skill discovery.
- `src/lib/commands-route-handlers.ts` exposes command/skill autocomplete results.
- Claude SDK typings expose `applyFlagSettings()`, `reloadPlugins()`, `supportedCommands()`, `supportedAgents()`, plugin options, agent definitions, and initialization messages that include skills/plugins/agents.
- Codex SDK usage in this codebase exposes generic config pass-through for MCP but no typed skill/plugin-specific APIs.

## Requirement-to-Asset Map

| Requirement | Existing assets | Gap tags | Notes |
| --- | --- | --- | --- |
| 1. Five independent per-backend cascade stores | MCP has one portable cascade store shape in `src/lib/schemas.ts` and MCP store modules. | Missing, Constraint | New schemas and persistence are needed. Reusing MCP server/tool schemas would conflate backend-native identities. |
| 2. Four-layer cascade resolution | `src/lib/mcp/resolver.ts`, `src/lib/mcp/scope-store.ts`, `src/lib/mcp/global-store.ts`. | Missing | Resolution pattern is reusable, but capability items need backend/kind/item keys, native defaults, stale status, and plugin-parent forcing. |
| 3. Defaults mirror existing backend settings | `src/lib/commands.ts` reads some native Claude/Codex sources for discovery. | Missing, Unknown, Constraint | Native defaults must be read-only and must converge after external changes. Exact Claude and Codex enablement/default sources need research. |
| 4. Per-item enable/disable toggling | MCP patch service and route handlers support set/reset operations. | Missing | Need capability-specific patch operations and validation for five cascade kinds. |
| 5. Plugin parent-child disable semantics | No equivalent in MCP. Plugin path resolution exists only for Claude command/skill autocomplete. | Missing, Unknown | Need plugin contribution mapping and a resolver rule that forces contributed children disabled while preserving child override state. Codex plugin contribution model is unknown. |
| 6. Override patch operations | `src/lib/mcp/overrides-patch.ts`, `src/lib/mcp-config-mutation-service.ts`. | Missing | Existing atomic-write and conflict-checking patterns can be adapted, but the operation schema must target capability cascades. |
| 7. Discovery of available items per backend | `src/lib/commands.ts`, MCP tool discovery cache/probe/runtime modules. | Missing, Unknown | Current discovery is autocomplete-oriented and lacks enablement/defaults, plugin ownership, agents, diagnostics, refresh cache, and runtime-visible state. |
| 8. Composition at conversation start | `composePortableMcpForConversation()` and `createManagedBackendRuntime()` compose MCP before runtime creation. | Missing | Need a separate capability composer and backend runtime options for Claude skills/plugins/agents and Codex skills/plugins. |
| 9. Claude idle live-apply | `src/lib/mcp/runtime-apply.ts`, Claude runtime `applyPortableMcpConfig()`, Claude SDK methods. | Missing, Unknown | Apply mechanics exist for MCP. Capability-specific SDK calls and exact live-applicable settings need research and new runtime methods. |
| 10. Codex next-turn staging | Codex runtime already stages MCP via `stagedPortableMcp`. | Missing, Unknown | Need Codex capability config shape and staging path. SDK does not expose typed capability APIs in current usage. |
| 11. Five UI configuration panels | `src/components/mcp/*` and MCP query/mutation hooks. | Missing | UI patterns are reusable, but server/tool components do not model five panels, backend-native metadata, plugin-child forcing, filters, or layer switching. |
| 12. Backend capability metadata for gating | `src/lib/mcp/backend-capabilities.ts`; broad metadata in `src/lib/agent-backends/types.ts`. | Missing | Need capability-kind metadata: supported kinds, discovery sources, apply semantics, runtime visibility, and composition strategy. |
| 13. Validation and user-visible errors | Zod schemas in `src/lib/schemas.ts`; route-handler validation patterns. | Missing | Need structured schemas/errors for capability item IDs, cascade kinds, stale override acceptance, and composition/apply diagnostics. |
| 14. Persistence | State manager for project/session/conversation; MCP global atomic file. | Missing, Constraint | Need a persistence shape that survives restart without corrupting existing state. Global capability state should likely follow the MCP dedicated-file pattern, but design must confirm. |
| 15. Cross-client synchronization | MCP SSE broadcast/invalidation and TanStack query keys. | Missing | Need new SSE event(s), invalidation rules, query keys, optimistic updates, and conflict behavior for capability cascades. |
| 16. Diagnostics and error visibility | Structured logging guidance in `.kiro/steering/logs.md`; MCP diagnostics schemas. | Missing | Need logging module names/events and UI diagnostics for mutation, discovery, composition, and apply outcomes. |

## Constraints

- Requirements are not approved, so design and implementation should not proceed until Alex approves or revises them.
- CC must not modify native backend configuration files such as Claude or Codex settings; native sources are read-only inputs.
- Plugin install/uninstall, marketplace browsing, graph-workflow transient overrides, cross-backend mirroring, layer promotion, and per-item parameter editing are out of scope.
- Agent capability configuration must not be modeled as portable MCP configuration. MCP servers are cross-backend; skills/plugins/agents are backend-specific.
- Disabling a plugin must force its contributed children disabled without deleting or rewriting the children's own override entries.
- Runtime failures must be diagnostic and non-blocking at conversation start, scoped to the failed cascade kind.
- All implementation work must follow red-green TDD, colocated tests, Zod schema-first validation, dependency injection for testability, and structured logging through `createLogger()`.

## Option A: Extend Existing MCP Configuration Components

### Rationale

Extend the existing MCP schemas, route handlers, resolver, mutation service, runtime apply service, query hooks, and UI components to handle capability cascades in addition to MCP servers/tools.

### Likely Changes

- Add capability kinds and item schemas near existing MCP schemas in `src/lib/schemas.ts`.
- Generalize MCP patch/resolver/composer modules to accept multiple resource kinds.
- Expand MCP routes and query keys or add sibling route variants backed by shared internals.
- Retrofit MCP UI components to render capability item rows and plugin-child state.

### Trade-offs

- Pros: fastest path to reuse four-layer cascade mechanics, atomic writes, SSE patterns, and pending apply UI.
- Pros: fewer new top-level modules.
- Cons: high risk of turning MCP-specific modules into an overly broad configuration framework.
- Cons: MCP semantics differ from backend-native capability semantics, especially native defaults, plugin-child disable forcing, and runtime apply.
- Cons: changes could destabilize existing MCP behavior.

### Fit

Viable only for small shared helpers. It is not a good primary design because the feature has materially different domain rules from MCP.

## Option B: Build a New Dedicated Agent-Capabilities Subsystem

### Rationale

Create a separate `src/lib/agent-capabilities/` domain with its own schemas, stores, resolver, discovery, composer, apply service, route handlers, SSE events, query keys, mutations, and UI components.

### Likely Changes

- Add capability-specific schemas for cascade kind, layers, override operations, item metadata, defaults, diagnostics, and apply state.
- Add global/project/session/conversation stores for capability overrides.
- Add discovery services for Claude skills/plugins/agents and Codex skills/plugins.
- Add pure resolver and patch modules with unit tests.
- Add conversation-start composer and runtime apply integration.
- Add five UI panels and API/query/mutation/SSE surfaces.

### Trade-offs

- Pros: clean boundaries and a domain model that matches backend-native capabilities.
- Pros: easier to test pure capability rules without risking MCP regressions.
- Pros: keeps plugin-child disable semantics explicit.
- Cons: more new code and more routes/hooks/components to maintain.
- Cons: risks duplicating MCP infrastructure if shared helpers are not factored carefully.

### Fit

Technically sound, but it may duplicate too much infrastructure unless the design deliberately reuses existing state, route, SSE, and runtime-apply patterns.

## Option C: Hybrid Dedicated Domain With Reused Infrastructure Patterns

### Rationale

Create a dedicated agent-capabilities domain model while reusing the proven MCP architectural patterns and low-level infrastructure where the semantics match.

### Likely Changes

- Add `src/lib/agent-capabilities/` for schemas, patching, resolving, discovery, composition, backend metadata, runtime apply, diagnostics, and route-handler factories.
- Reuse state-manager write queues, atomic global-file patterns, Zod validation style, route-handler dependency injection, SSE invalidation style, TanStack query conventions, and runtime apply status concepts.
- Keep MCP modules stable except for extracting genuinely generic helpers if design proves they are worth sharing.
- Extend backend runtime interfaces with capability-specific composition/apply/discovery methods rather than overloading MCP tooling.
- Build capability-specific UI components that borrow MCP interaction patterns but model five panels and plugin-child forcing directly.

### Trade-offs

- Pros: preserves the proven cascade architecture without forcing MCP abstractions onto a different domain.
- Pros: reduces regression risk to MCP.
- Pros: gives the design enough room for Claude/Codex differences and future backend metadata.
- Cons: requires careful naming and module boundaries to avoid parallel-but-inconsistent implementations.
- Cons: design phase must settle native backend discovery and apply semantics before implementation tasks can be estimated tightly.

### Fit

Best fit for this requirements set. It treats MCP as a reference implementation and capability configuration as a sibling domain.

## Effort and Risk

- Effort: XL. This feature spans persistence schemas, route handlers, SSE, query/mutation state, UI, backend runtime composition, native discovery, live apply behavior, diagnostics, and a substantial test matrix.
- Risk: High. The largest risks are unknown native backend semantics for Claude per-item settings and Codex skills/plugins, plus cross-cutting changes to conversation runtime behavior.

## Design-Phase Recommendations

- Prefer Option C: a dedicated `agent-capabilities` domain that reuses MCP patterns rather than extending MCP modules directly.
- Define capability cascade schemas before UI or runtime work: cascade kind, item identifier, override value, native default, effective state, parent-disable reason, diagnostics, and apply status.
- Keep five cascade stores explicit in the data model even if implementation shares helper functions.
- Model plugin contributions as first-class discovery metadata so parent-disable semantics can be tested in the pure resolver.
- Add backend capability metadata before adding UI panels, so unsupported panels and apply labels derive from data rather than scattered conditionals.
- Preserve conversation startup resilience: composition failures should produce diagnostics and fall back only for the failed cascade kind.
- Keep graph-workflow transient overrides out of the initial design beyond ensuring the new domain is not named in a way that precludes future scoped overrides.

## Research Needed

- Claude native defaults: exact settings keys and precedence for enabling/disabling individual skills, plugins, and agents across user/project/local sources.
- Claude live apply: which capability changes can be represented through `applyFlagSettings()`, which require `reloadPlugins()`, and which only apply on a new conversation.
- Claude discovery: whether `supportedCommands()` reliably distinguishes skills from commands, whether `supportedAgents()` includes source/ownership metadata, and how plugin-contributed skills/agents are identified.
- Codex native defaults: authoritative files or commands for installed/enabled skills and plugins under Codex native configuration.
- Codex composition: exact config keys or SDK options required to enable/disable Codex skills/plugins at turn start.
- Codex discovery: whether runtime-visible skills/plugins can be queried, or whether CC must rely on file/native-source discovery only.
- Plugin contribution mapping: stable identifiers for child skills/agents contributed by plugins, including behavior when a plugin is installed but disabled natively.
- Cache invalidation: whether native source changes should be detected by filesystem mtime polling, explicit refresh only, runtime probes, or a combination.

## Suggested Test Focus for Implementation

- Pure patch tests for set, clear, multi-item atomic behavior, pruning, and validation failures.
- Pure resolver tests for four-layer precedence, native-default fallback, stale override acceptance, and plugin-parent disable forcing.
- Discovery tests using injected filesystem/native-source readers, including malformed and unreadable source diagnostics.
- Route-handler tests for GET/PATCH behavior, expected-hash conflicts if used, structured errors, and SSE broadcasts.
- Runtime apply tests for Claude idle apply, in-flight deferral, failed apply diagnostics, and Codex next-turn staging.
- UI tests for five panels, layer switching, inherited values, parent-disable reasons, stale/unavailable status, filtering, and search.
