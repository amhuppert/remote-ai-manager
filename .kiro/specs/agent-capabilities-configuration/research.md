# Research & Design Decisions: Agent Capabilities Configuration

## Summary
- **Feature**: `agent-capabilities-configuration`
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  - The existing MCP configuration subsystem is the correct architectural precedent for cascade stores, atomic patches, resolved view models, runtime apply tracking, SSE invalidation, and UI interaction patterns.
  - Agent capabilities need a separate domain model because skills, plugins, and sub-agents are backend-native resources with backend-specific discovery, identity, parent-child ownership, and apply behavior.
  - Project-level conversations reuse the existing `conversation` capability layer while omitting the session layer. They must not introduce a new cascade kind or expose the internal project-conversation sentinel through public capability APIs or UI state.
  - Claude Agent SDK exposes the strongest capability controls through `Settings.skillOverrides`, `Settings.enabledPlugins`, `Query.applyFlagSettings()`, `Query.reloadPlugins()`, `Query.supportedCommands()`, and `Query.supportedAgents()`.
  - Codex SDK exposes a generic `CodexOptions.config` pass-through but no typed skill or plugin API in the installed SDK. Codex runtime support must stay behind a translator seam and report diagnostics when a specific native toggle cannot be emitted.
  - Plugin-disable semantics should be modeled as first-class resolver behavior, not as destructive edits to child skill or agent override records.

## Research Log

### Existing MCP Configuration Precedent
- **Context**: Requirements explicitly mirror the MCP global -> project -> session -> conversation cascade, but the resources are not portable MCP servers.
- **Sources Consulted**:
  - `src/lib/agent-capabilities/schemas.ts`
  - `src/lib/mcp/global-store.ts`
  - `src/lib/mcp/scope-store.ts`
  - `src/lib/mcp/overrides-patch.ts`
  - `src/lib/mcp/resolver.ts`
  - `src/lib/mcp/compose-for-conversation.ts`
  - `src/lib/mcp/runtime-apply.ts`
  - `src/lib/mcp-config-route-handlers.ts`
  - `src/components/mcp/`
- **Findings**:
  - MCP already has four-layer persistence, pure patching, pure resolution, checked mutation service, effective hash conflict checks, runtime apply disposition tracking, and SSE invalidation.
  - MCP resolvers intentionally avoid backend branching and push backend differences into translators and capability metadata.
  - MCP storage is shaped around server/tool hierarchy, which does not match the five independent capability cascades or plugin parent-child forcing rules.
- **Implications**:
  - Build a sibling `src/lib/agent-capabilities/` domain instead of broadening MCP modules into a generic configuration framework.
  - Reuse infrastructure patterns and shared low-level helpers where they stay semantically neutral: write queues, atomic JSON writes, state mutators, route-handler factories, SSE broadcaster, React Query conventions, and runtime apply status concepts.

### Claude Agent SDK Capability Controls
- **Context**: Verify the exact installed SDK surfaces available for Claude discovery, default mirroring, and idle live-apply.
- **Sources Consulted**:
  - `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  - `src/lib/agent-backends/claude/query-session.ts`
  - `src/lib/agent-backends/claude/conversation-runtime.ts`
  - `src/lib/commands.ts`
  - `package.json`
  - `npm view @anthropic-ai/claude-agent-sdk version`
- **Findings**:
  - The installed package is `@anthropic-ai/claude-agent-sdk` `^0.2.111`; the npm registry currently reports `0.3.143`.
  - `Settings.skillOverrides` is keyed by skill name and supports `on`, `name-only`, `user-invocable-only`, and `off`. A binary CC enable maps to `on`; disable maps to `off`; clearing returns to the native mode.
  - `Settings.enabledPlugins` models enabled plugins by plugin id. It supports boolean and extended object values, so CC must preserve native metadata in discovery and emit the smallest flag-layer setting that expresses the effective state.
  - `Query.applyFlagSettings(settings)` dynamically merges a settings object into the SDK flag-settings layer.
  - `Query.reloadPlugins()` refreshes commands, agents, plugins, and MCP server status from disk and returns the refreshed items.
  - `Query.supportedCommands()` returns available command or skill-like slash command records. `Query.supportedAgents()` returns available sub-agent records, but the type does not expose source ownership metadata.
  - `Options.agents` can programmatically define sub-agents at session creation. The installed `Settings` type does not expose a typed per-agent disable map.
- **Implications**:
  - Claude skill and plugin toggles can be applied through the SDK flag-settings layer while the session is idle; plugin changes require `reloadPlugins()` after the setting update.
  - Claude sub-agent disable needs a conservative design: use discovery for list and ownership, but mark individual sub-agent suppression as deferred unless the implementation verifies a safe SDK removal path. Plugin-disabled agents still become unavailable when the owning plugin is disabled and reloaded.
  - Runtime-visible state should prefer `supportedCommands()`, `supportedAgents()`, and `reloadPlugins()` responses when an active runtime exists.

### Codex SDK Capability Controls
- **Context**: Determine how Codex skills and plugins can be discovered and applied without a typed SDK API.
- **Sources Consulted**:
  - `node_modules/@openai/codex-sdk/dist/index.d.ts`
  - `src/lib/agent-backends/codex/conversation-runtime.ts`
  - `src/lib/commands.ts`
  - `package.json`
  - `npm view @openai/codex-sdk version`
- **Findings**:
  - The installed package is `@openai/codex-sdk` `^0.125.0`; the npm registry currently reports `0.130.0`.
  - `CodexOptions.config` is an untyped nested object that the SDK flattens into Codex CLI `--config` values.
  - The current Codex conversation runtime already stages MCP config in memory and rebuilds `CodexOptions` at each turn.
  - `src/lib/commands.ts` discovers Codex skills by scanning `.agents/skills`, `.codex/skills`, and related native directories, but it does not read enablement defaults or plugin ownership.
  - The installed Codex SDK typings do not expose a runtime-visible skill/plugin inventory or a typed capability toggle contract.
- **Implications**:
  - Codex changes should follow the existing next-turn staging pattern.
  - Codex capability emission must sit behind a `CodexCapabilityTranslator` that validates supported config keys during implementation and can produce per-cascade diagnostics without blocking the conversation.
  - Codex discovery can start with filesystem-native skill/plugin discovery plus previously-known stale overrides, then add richer plugin metadata when a reliable native source is verified.

### Native Source Discovery and Plugin Ownership
- **Context**: Parent plugin disables require knowing which skills and agents a plugin contributes.
- **Sources Consulted**:
  - `src/lib/commands.ts`
  - `.claude/settings.json`
  - `plugins/command-center/command-center/.claude-plugin/plugin.json`
  - `plugins/command-center/command-center/skills/`
  - `.agents/skills/`
  - `.claude/skills/`
- **Findings**:
  - Current command discovery already scans Claude user/project skills and enabled plugin skill directories.
  - Claude plugin manifests live under `.claude-plugin/plugin.json`; plugin content is organized under child folders such as `skills/` and `agents/`.
  - Existing discovery collapses skills into autocomplete items and does not preserve stable item ids, owning plugin id, native default mode, runtime availability, or stale override information.
  - Plugin identity must include backend and marketplace or path-derived identity. Display names are not stable enough for persistence.
- **Implications**:
  - Discovery adapters must return a normalized inventory of plugins and contributed children in one pass.
  - Resolver input must include `owningPluginId` for each plugin-contributed skill or agent.
  - Stale override visibility must not depend on current discovery. The resolver must include placeholder rows for override ids not present in native inventory.

### Runtime Integration Points
- **Context**: Capability composition has to affect conversation start and mid-conversation apply without disrupting MCP.
- **Sources Consulted**:
  - `src/lib/agent-backends/conversation.ts`
  - `src/lib/agent-backends/types.ts`
  - `src/lib/workflows/conversation/actor-implementations.ts`
  - `src/lib/agent-backends/claude/query-session.ts`
  - `src/lib/agent-backends/codex/conversation-runtime.ts`
- **Findings**:
  - `ConversationToolingOverrides` currently contains `portableMcp` only.
  - `executePromptForMachine()` composes MCP immediately before creating a new runtime and seeds MCP runtime hashes after creation.
  - Claude uses one long-lived query session. Codex rebuilds the SDK client per turn and can stage config in the runtime.
  - Runtime recreation already happens when model, effort, or output format changes.
- **Implications**:
  - Extend `ConversationToolingOverrides` with `agentCapabilities` rather than adding independent ad hoc parameters to backend factories.
  - Add a capability composer beside MCP composition and call it at conversation start or runtime creation.
  - Add a separate runtime apply service so capability pending/apply state does not overload `mcpRuntime`.

### Project-Level Conversation Foundation
- **Context**: The PLC additive requirements extend the already-implemented capability cascade to session-less project conversations described in `.kiro/specs/project-level-conversations/brief.md`.
- **Sources Consulted**:
  - `.kiro/specs/project-level-conversations/brief.md`
  - `src/lib/conversations/project-conversation-scope.ts`
  - `src/lib/state-store/store.ts`
  - `src/lib/project-conversations/prompt-entry.ts`
  - `src/lib/project-conversations/route-handlers.ts`
  - `src/lib/project-conversations-client/query-keys.ts`
  - `src/features/project-detail/ProjectDetailView.tsx`
  - `src/features/project-detail/cockpit/ProjectCockpit.tsx`
  - `src/features/project-detail/cockpit/ConversationPane.tsx`
- **Findings**:
  - PLCs are durable session-less conversations that run in the repository root main worktree and keep their fixed `agentBackend` on the conversation record after initialization.
  - The PLC foundation uses `PROJECT_CONVERSATION_SESSION_SENTINEL = "__project__"` only to adapt otherwise session-keyed state and runtime boundaries. Public project-conversation routes use `/api/projects/[name]/conversations/[conversationId]`.
  - `stateManager.mutateConversation()` already routes the sentinel to `mutateProjectConversation()`, so storage can reuse the existing `ConversationState.agentCapabilityOverrides` and `agentCapabilitiesRuntime` fields if the capability adapter supplies the project-conversation identity correctly.
  - The current capability read chain, mutation scope, runtime composer, fanout enumeration, route handlers, hooks, query keys, and drawer component require `sessionName` for every conversation scope.
  - The project cockpit owns active tab selection, command dispatch, composer behavior, and backend locking. Capability support should add a narrow entry for the selected active PLC and should prevent conversation-layer edits when no PLC is selected.
- **Implications**:
  - Extend capability scope models with a discriminated project-conversation target that uses layer `conversation` but has no session layer.
  - Add project-conversation capability API routes that mirror PLC route shape instead of routing through `/sessions/__project__`.
  - In storage and runtime adapters, use the sentinel only as an internal bridge to existing state-manager APIs; never persist it as a user-facing session identity and never show it in query keys or route params.
  - Runtime fanout must enumerate active project conversations from the project-conversation repository and runtime registry, using repo-root `worktreePath` and the fixed `ConversationState.agentBackend`.

### API, State, SSE, and UI Patterns
- **Context**: New storage and UI must fit the existing Next.js and TanStack Query architecture.
- **Sources Consulted**:
  - `src/lib/agent-capabilities/schemas.ts`
  - `src/lib/state.ts`
  - `src/lib/query-keys.ts`
  - `src/lib/mutations.ts`
  - `src/lib/events/broadcaster.ts`
  - `src/components/NotificationListener.tsx`
  - `src/components/mcp/`
- **Findings**:
  - Zod schemas and types belong in the domain's `src/lib/agent-capabilities/schemas.ts`; types are inferred from schemas via `z.infer` (there is no central re-export file).
  - Project, session, and conversation state already have optional `mcpOverrides` fields; capability overrides can follow the same state-placement pattern with a new field.
  - MCP route handlers are dependency-injected and tested as pure handler factories. The same pattern is appropriate here.
  - React Query key factories and mutation hooks are centralized.
  - SSE events should contain identifiers and invalidation hints, not full configuration payloads.
- **Implications**:
  - Add new API and SSE contracts for capability config rather than reusing MCP event names.
  - Add five UI panel containers that share one base capability panel contract, instead of modifying MCP server cards to understand skills and agents.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Extend MCP modules | Generalize MCP stores, patching, resolver, route handlers, runtime apply, and UI for capabilities | Reuses mature code quickly | MCP server/tool semantics differ from backend-native capabilities; high regression risk to MCP | Rejected as primary pattern |
| Backend-specific implementations | Separate Claude and Codex routes, stores, UI, and runtime flows | Simple local reasoning per backend | Duplicates cascade behavior and scatters backend conditionals | Rejected |
| Dedicated capability domain with reused infrastructure | New `agent-capabilities` domain using MCP patterns and shared low-level infrastructure | Clean boundaries, testable pure core, preserves MCP | More new files and careful naming required | Selected |
| New project-conversation cascade kind | Add a sixth cascade kind for PLC-specific settings | Simple label for PLC-only state | Violates Requirement 20.1 and duplicates conversation-layer behavior | Rejected |
| Project-conversation discriminator on conversation layer | Keep the five cascade kinds and add a session vs project conversation identity where a conversation scope is needed | Preserves existing cascade model, supports PLCs without synthesizing a session layer | Requires careful route, query-key, and fanout updates | Selected for PLC extension |
| Native file mutation | Toggle by editing Claude and Codex native config files | Mirrors backend tooling directly | Violates read-only requirement and risks corrupting user-owned config | Rejected |
| Runtime-only suppression | Do not persist cascades; deny capabilities only at runtime | Smallest storage footprint | Fails persistence, inheritance, discovery, and UI requirements | Rejected |

## Design Decisions

### Decision: Use Five Explicit Cascade Kinds
- **Context**: Skills, plugins, and agents are backend-native resources. Identifiers can collide across backends without meaning the same thing.
- **Alternatives Considered**:
  1. One unified capability map with `backend` and `kind` fields.
  2. One cascade per backend.
  3. Five explicit cascade kinds: `claude-skills`, `claude-plugins`, `claude-agents`, `codex-skills`, `codex-plugins`.
- **Selected Approach**: Store and resolve five explicit cascades.
- **Rationale**: This matches the requirements and prevents accidental cross-backend deduplication.
- **Trade-offs**: Some route and UI code must carry `cascadeKind` everywhere.
- **Follow-up**: Add schema tests that reject unsupported combinations such as `codex-agents`.

### Decision: Model Native Defaults Separately From CC Overrides
- **Context**: Default state must mirror the backend without modifying backend files.
- **Alternatives Considered**:
  1. Copy native defaults into CC state.
  2. Mutate native files directly.
  3. Read native defaults on demand and apply CC overrides as sparse diffs.
- **Selected Approach**: Native defaults are read-only discovery input; CC persists only sparse overrides.
- **Rationale**: This preserves backend ownership and lets external native changes converge after refresh.
- **Trade-offs**: Read paths must handle discovery failures and stale override rows.
- **Follow-up**: Define cache invalidation tests for native source mtime changes and explicit refresh.

### Decision: Resolve Plugin-Forced Disable After Child Cascades
- **Context**: Disabling a plugin must silence contributed children without deleting child-specific override state.
- **Alternatives Considered**:
  1. Write disable overrides into every child.
  2. Hide children from discovery while the plugin is disabled.
  3. Preserve child own effective state and overlay a resolver-level forced disable reason.
- **Selected Approach**: Resolve plugin effective state first, resolve each child own state second, then overlay forced disable for children whose owning plugin is effectively disabled.
- **Rationale**: Re-enabling the parent restores child state exactly.
- **Trade-offs**: View models need both own state and final state fields.
- **Follow-up**: Unit-test broader plugin disables, narrower plugin enables, stale child overrides, and multiple child override layers.

### Decision: Capability Metadata Drives Apply Behavior
- **Context**: Claude and Codex differ by capability kind, and Claude sub-agent suppression has a less certain SDK path than skill/plugin toggles.
- **Alternatives Considered**:
  1. Hard-code backend conditionals at call sites.
  2. Treat every capability kind as live-applicable.
  3. Declare per-backend, per-cascade metadata for discovery, composition, and apply semantics.
- **Selected Approach**: Add an `AgentCapabilityMetadataRegistry` that declares supported cascades, default sources, runtime visibility, apply point, and translator support.
- **Rationale**: The UI and runtime can show accurate status labels without scattered backend checks.
- **Trade-offs**: Metadata must be kept in sync with adapters.
- **Follow-up**: Add metadata tests that assert all five cascade kinds have exactly one backend owner.

### Decision: Keep Codex Capability Emission Behind a Translator Seam
- **Context**: The installed Codex SDK does not type skill/plugin toggles.
- **Alternatives Considered**:
  1. Guess config keys throughout runtime code.
  2. Delay all Codex UI and storage.
  3. Design full storage/UI/resolution now and isolate emission in a translator that returns diagnostics when unsupported.
- **Selected Approach**: Implement `CodexCapabilityTranslator` as the only place that converts effective Codex capabilities into `CodexOptions.config`.
- **Rationale**: This preserves the cascade design while making the uncertain SDK contract explicit and testable.
- **Trade-offs**: Codex runtime effectiveness depends on implementation verification of native config keys.
- **Follow-up**: First implementation task for Codex should verify the concrete config keys against the installed CLI and SDK before wiring user-facing toggles as applied.

### Decision: Share UI Panel Contract, Not MCP Cards
- **Context**: MCP server/tool UI is similar but not semantically identical.
- **Alternatives Considered**:
  1. Reuse MCP card components directly.
  2. Build five unrelated panels.
  3. Build one capability panel contract and five typed panel containers.
- **Selected Approach**: Add capability-specific UI components with a shared base contract and one container per cascade.
- **Rationale**: The panels share layer switching, search, filters, inherited badges, pending state, and stale diagnostics, but plugins and child-forced-disable need capability-specific rendering.
- **Trade-offs**: More component files than direct MCP reuse.
- **Follow-up**: Add Storybook stories for all five panels before page integration.

### Decision: Represent PLC Overrides as Conversation-Layer Overrides Without a Session Layer
- **Context**: PLCs need per-conversation capability overrides but have no owning session. Existing session conversations must keep the current global -> project -> session -> conversation cascade.
- **Alternatives Considered**:
  1. Add a project-conversation cascade kind.
  2. Synthesize a fake session layer in the capability resolver.
  3. Add a conversation-scope discriminator and resolve PLCs as global -> project -> conversation.
- **Selected Approach**: Use a discriminated conversation scope for session conversations and project conversations. PLCs use the existing `conversation` layer and skip `session`.
- **Rationale**: This satisfies Requirements 17 and 20 while preserving the five cascade stores and avoiding hidden session policy.
- **Trade-offs**: Route handlers, query keys, runtime fanout, and UI layer options must carry conversation identity explicitly.
- **Follow-up**: Add tests proving PLC resolution excludes session overrides and session conversation resolution remains unchanged.

### Decision: Keep the PLC Sentinel Private to State and Runtime Adapters
- **Context**: The PLC foundation uses `PROJECT_CONVERSATION_SESSION_SENTINEL` to bridge APIs that are still session-keyed internally.
- **Alternatives Considered**:
  1. Reuse session-conversation capability routes with `session="__project__"`.
  2. Store project conversations under a synthetic session aggregate.
  3. Add project-conversation capability routes and adapt to sentinel only inside persistence/runtime ports.
- **Selected Approach**: Public capability API, React Query keys, UI labels, and diagnostics use project conversation identity without a session name; storage/runtime adapters may use the sentinel only at the boundary where existing state-manager functions require it.
- **Rationale**: This keeps user-facing behavior aligned with PLC routes and prevents accidental policy inheritance from a non-existent session.
- **Trade-offs**: The adapter layer needs explicit tests around sentinel routing.
- **Follow-up**: Add validation that a real session named `__project__` cannot be treated as a normal session-conversation capability scope.

## Risks & Mitigations
- Claude sub-agent disable does not have a typed settings override in the installed SDK. Mitigation: metadata marks direct agent suppression as deferred or permission-gated until a verified SDK path exists; plugin-level disables still remove plugin-contributed agents after reload.
- Codex skill/plugin config keys are not typed in the installed SDK. Mitigation: isolate emission in `CodexCapabilityTranslator`, add verification tests, and surface unsupported diagnostics per cascade kind instead of blocking conversation start.
- Skill names can collide across native sources. Mitigation: persist cascade-local item ids and include native selectors separately; the composer uses the selector that the backend actually accepts.
- Plugin contribution mapping may be incomplete for nonstandard plugins. Mitigation: show source-only and stale states, preserve existing overrides, and surface discovery diagnostics.
- Discovery can read malformed native files. Mitigation: use Zod/permissive parser boundaries, return diagnostics, and keep conversations startable with native defaults for the failed cascade kind.
- Cross-client edits can race. Mitigation: reuse MCP-style effective hashes, checked mutations, write queues, and SSE invalidation.
- Project-conversation support could accidentally inherit session overrides if the sentinel is treated as a real session. Mitigation: model PLC as a discriminated conversation target, skip the session layer in the resolver, and use the sentinel only inside state/runtime adapter calls.
- Capability routes could expose `/sessions/__project__` as a public API shortcut. Mitigation: add first-class project-conversation capability routes and tests that hook URLs never include the sentinel.

## References
- `src/lib/mcp/resolver.ts` - Existing pure cascade merge and view assembly precedent.
- `src/lib/mcp/overrides-patch.ts` - Existing immutable patch operation precedent.
- `src/lib/mcp/runtime-apply.ts` - Existing runtime apply and pending hash precedent.
- `src/lib/mcp-config-route-handlers.ts` - Existing dependency-injected route handler precedent.
- `src/lib/commands.ts` - Existing Claude and Codex command/skill discovery code.
- `src/lib/agent-backends/conversation.ts` - Backend-neutral runtime interface.
- `src/lib/workflows/conversation/actor-implementations.ts` - Conversation runtime creation and turn-start integration point.
- `src/lib/conversations/project-conversation-scope.ts` - PLC sentinel and scope helper used only at internal adapter boundaries.
- `src/lib/project-conversations/prompt-entry.ts` - Project-conversation prompt execution path and repo-root runtime target.
- `src/lib/project-conversations/route-handlers.ts` - Session-less project conversation route precedent.
- `src/lib/project-conversations-client/query-keys.ts` - Project-conversation React Query key precedent.
- `src/features/project-detail/cockpit/ProjectCockpit.tsx` - Active PLC selection, backend locking, composer, and command ownership boundary.
- `src/lib/agent-backends/claude/query-session.ts` - Claude SDK options wrapper.
- `src/lib/agent-backends/codex/conversation-runtime.ts` - Codex next-turn staging precedent.
- `src/lib/agent-capabilities/schemas.ts` - Zod schema and SSE event home.
- `src/components/mcp/` - Existing inherited-config UI patterns.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` - Installed Claude Agent SDK capability-related types.
- `node_modules/@openai/codex-sdk/dist/index.d.ts` - Installed Codex SDK generic config surface.
- `plugins/command-center/command-center/.claude-plugin/plugin.json` - Local plugin manifest example.
