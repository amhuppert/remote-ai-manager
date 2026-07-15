# Agent Backend Interface Audit: Claude, Codex, and a Third Backend

**Date:** 2026-07-11

**Scope:** Backend-facing abstractions, their workflow/XState consumers, configuration and UI metadata, continuation, MCP/capability application, transcripts, and tests.

**Evaluation lens:** composability, testability, flexibility, unification, information hiding, change amplification, and module depth.

## Executive verdict

Command Center has a useful backend execution foundation, but it does **not yet have one complete backend abstraction**.

The strongest seams are:

- `ConversationBackendFactory` / `ConversationBackendRuntime` for conversation-shaped execution.
- `AgentTaskRunner` for one-shot execution.
- The registry that resolves those ports by backend ID.
- `AgentCall`, which normalizes workflow-facing requests, results, structured-output validation, and task-versus-conversation dispatch.
- Portable MCP input and capability-aware behavior in several newer modules.

Those seams make Claude and Codex execution more testable and prevent many direct SDK calls. However, they abstract **running a turn**, not the full backend lifecycle. Continuation, forking, provider events, transcript ownership, model/default metadata, capability application, MCP timing, failure/ref retention, and UI discovery are still implemented through Claude/Codex switches outside the adapters.

The result is a partial abstraction with inconsistent adoption:

- A third task-only runner could be added with moderate work.
- A third full conversation backend would be a cross-cutting refactor, not an adapter addition.
- Shared workflow modules frequently encode “Claude or Codex” rather than asking a backend adapter to perform a semantic operation.
- Several concepts have multiple competing sources of truth: backend IDs/session refs, capability descriptions, continuity, model metadata, and transcript handling.

**Overall backend design score: 5/10.** The execution ports and test seams are good; information hiding, consistency, and third-backend extensibility are not yet good enough.

| Goal | Score | Assessment |
|---|---:|---|
| Composability | 5/10 | `AgentCall` and the two execution ports compose, but lifecycle and continuity require provider branches. |
| Testability | 7/10 | Strong DI and extensive adapter tests; missing shared conformance tests and some tests lock in two-provider branching. |
| Flexibility | 4/10 | Backend identity is a closed union used throughout orchestration, schemas, configuration, and UI. |
| One way to solve a problem | 4/10 | Multiple capability models, continuity stacks, type sources, and transcript paths coexist. |
| Information hiding / module depth | 4/10 | Raw Claude SDK messages and provider-specific capability types cross the generic runtime interface. |
| Third-backend readiness | 3/10 | Full support requires changes across backend, workflow, actor, state, config, and UI domains. |

## What the current architecture gets right

### 1. Two execution shapes are a legitimate abstraction

`ConversationBackendRuntime.sendTurn()` and `AgentTaskRunner.run()` represent meaningfully different execution contracts. Keeping both is better than forcing streaming conversations and bounded one-shot work into one oversized method. The split is based on semantics, not on Claude versus Codex.

The shared inputs and results are also mostly useful:

- Conversation turns normalize prompts, images, instructions, model/effort, schema output, cancellation, events, continuation results, usage, and background-task waiting (`src/lib/agent-backends/conversation.ts:93-137`).
- Task runs normalize working directory, prompt, resume ref, schema, timeout, sandbox/approval/network options, cancellation, usage, transcript, and errors (`src/lib/agent-backends/task.ts:7-58`).

This is a deep enough seam to reuse across interactive chat, graph workflows, collaboration, compaction, and other agent work.

### 2. The registry removes direct backend construction from many callers

`registry-core.ts` maps backend identity to a conversation factory and task runner (`src/lib/agent-backends/registry-core.ts:8-47`). Most callers resolve a port rather than importing a concrete runtime. This is the right dependency direction.

### 3. `AgentCall` establishes a useful workflow-facing vocabulary

`AgentCallRequest` distinguishes `conversation_turn` and `task_run`, while `AgentCallResult` normalizes backend identity, continuation, capabilities, usage, artifacts, completed/paused/failed outcomes, and errors (`src/lib/workflows/primitives/agent-call-vocabulary.ts:54-184`). The facade applies one structured-output gate across both execution shapes (`src/lib/workflows/primitives/agent-call-facade.ts:112-284`).

This is valuable unification. Workflow code should depend on this semantic vocabulary rather than SDK result shapes.

### 4. Portable MCP demonstrates the intended edge-adapter pattern

The portable MCP schema is backend-neutral, and the Claude/Codex translators own SDK-specific emission. `tool-discovery-runtime.ts` is an especially good example: it chooses behavior from capability metadata rather than backend identity (`src/lib/mcp/tool-discovery-runtime.ts:50-79`).

### 5. Testing practices are strong at the implementation level

The Claude adapter has roughly 197 test cases across eight test files; Codex has roughly 155 across six. Production code generally exposes DI seams rather than mocking internal modules. `AgentCall` also has cross-backend behavioral coverage.

The weakness is not a lack of tests. It is that there is no reusable backend conformance suite proving that every registered backend satisfies the same port-level contract.

## Findings

### P0 — The generic runtime interface contains provider-specific types and methods

The shared `agent-backends` layer imports `ClaudeRuntimeCapabilityConfig` and `CodexRuntimeCapabilityConfig` (`src/lib/agent-backends/types.ts:1-3`, `src/lib/agent-backends/conversation.ts:8-11`). It exposes:

- `ConversationToolingOverrides.claudeCapabilityConfig`
- `ConversationToolingOverrides.codexCapabilityConfig`
- `ConversationBackendRuntime.applyClaudeCapabilityConfig()`
- `ConversationBackendRuntime.applyCodexCapabilityConfig()`

See `src/lib/agent-backends/types.ts:20-29` and `src/lib/agent-backends/conversation.ts:195-215`.

This is direct information leakage. Adding Gemini, OpenCode, or another backend would require widening the supposedly shared port with another optional field and another optional method. Every runtime then presents methods that are meaningless for most implementations.

It also inverts the dependency: the backend port imports feature-domain translator output rather than the capability feature depending on an adapter-owned port.

**Recommendation:** Replace provider-named configuration and apply methods with an adapter-owned capability operation. The shared layer should carry either a genuinely portable capability request or an opaque prepared payload that only the matching adapter can interpret. A third backend must add an adapter implementation, not a method to `ConversationBackendRuntime`.

### P0 — Raw Claude SDK messages cross the backend boundary

`ConversationBackendEvent` includes `{ type: "provider_event"; payload: unknown }` (`src/lib/agent-backends/conversation.ts:63-73`). The Claude runtime emits raw SDK frames through it. The generic conversation actor then imports Anthropic SDK types, casts the payload to `SDKMessage`, maps Claude content, extracts session IDs, persists Claude-native transcript frames, and maps Claude error subtypes (`src/lib/workflows/conversation/actor-implementations.ts:58-83`, `875-990`, `2072-2090`). `external-turn-handler.ts` also imports `SDKMessage` directly.

Codex follows a different route: the adapter emits normalized content and the actor persists “non-Claude” blocks (`src/lib/workflows/conversation/actor-implementations.ts:2051-2069`, `2436-2455`). This means transcript ownership is asymmetric:

- Claude transcript interpretation lives in the shared actor.
- Codex transcript interpretation largely lives in the adapter.
- A third backend silently falls into the “non-Claude” path whether or not that path matches its semantics.

This is the clearest back-door leak in the current design. A caller cannot use `ConversationBackendRuntime` correctly without knowing which provider produced `provider_event`.

**Recommendation:** Backend adapters must translate all provider frames into a complete normalized event/transcript vocabulary. If lossless native frames must be retained, wrap them in an adapter-produced `AgentTranscriptEntry`; generic orchestration may persist the envelope without interpreting it. Remove `provider_event` from the public runtime contract once Claude is migrated.

### P0 — Continuity is modeled as a two-provider switch in shared workflow primitives

`WorkflowAgentCaller` is described as the production seam above `AgentCall`, but its dependency interface requires four provider-named methods:

- `createClaudeConversation`
- `validateClaudeConversation`
- `startCodexThread`
- `resumeCodexThread`

See `src/lib/workflows/primitives/workflow-agent-caller.ts:96-133`.

Its implementation switches on `lane.backend`, constructs Claude and Codex refs directly, and creates provider-specific lane states (`src/lib/workflows/primitives/workflow-agent-caller.ts:216-365`, `407-458`). `LaneState` similarly hardcodes Claude `conversationId` versus Codex `threadId`, plus two different metric branches (`src/lib/workflows/primitives/lane-vocabulary.ts:25-109`). `LaneService` repeats the provider split in its outcome vocabulary and update logic (`src/lib/workflows/primitives/lane-service.ts:32-71`, `155-270`).

This is a shallow abstraction: callers still supply and understand the provider algorithms that the module claims to hide. A third backend requires modifying the primitive itself, its public dependency interface, its persistence schema, outcome schema, state service, and all composition roots.

**Recommendation:** Introduce a backend-owned `ContinuityAdapter` with semantic operations such as `create`, `validateOrResume`, `recoverStale`, `retire`, `fork`, and `recordOutcome`. Persist a generic versioned backend-ref envelope such as `{ backend, version, id }`; only the adapter interprets the ID. Store normalized optional metrics rather than provider-named metric branches unless a domain truly consumes a provider-specific value.

### P0 — Graph workflows still have a parallel legacy continuity implementation

`workflow-continuity-service.ts` independently owns Claude conversation creation/validation/retirement and Codex thread start/resume/recovery. Representative branches appear at `src/lib/workflow-graph/workflow-continuity-service.ts:476-630` and `757-940`. `WorkflowAgentCaller` calls this service the “legacy graph-only equivalent” in its own interface documentation.

Therefore the codebase has at least two ways to solve workflow continuity:

1. `WorkflowAgentCaller` + `LaneService`
2. `workflow-continuity-service.ts`

The conversation actor also has a separate one-retry stale-runtime path implemented through a JavaScript `Proxy` (`src/lib/workflows/conversation/actor-implementations.ts:1029-1144`). Its exact correction step differs, but it duplicates the same classify → replace/recover → retry-once policy shape.

**Recommendation:** Migrate graph workflow continuity onto one backend-owned continuity seam, then delete the legacy service. Extract the actor's runtime replacement into a named policy wrapper that uses the same stale/error classification vocabulary. Do not create a generic retry XState machine; the reusable unit is the backend recovery policy, not the state machine ceremony.

### P1 — Capability knowledge is fragmented and often ignored

At least four capability representations coexist:

1. `ConversationBackendCapabilities` in `agent-backends/capabilities-descriptor.ts`
2. `BackendCapabilityView` in `workflows/primitives/backend-capabilities.ts`
3. `McpBackendCapabilities` in `mcp/backend-capabilities.ts`
4. `QueueCapability` in `agent-backends/capabilities-descriptor.ts`

Domain-specific sub-capability shapes are reasonable, but there is no single backend descriptor that owns and registers them. Overlapping semantics can drift:

- `portableMcpBetweenTurns`
- `mcpApplicationBoundary`
- `betweenTurnApply`

The runtime's `ConversationBackendCapabilities` fields are effectively dead: excluding declarations/default objects and tests, `queueWhileRunning`, `preciseFork`, `portableMcpAtStart`, `portableMcpBetweenTurns`, and `contextWindowMetrics` have no production reads. `askUserQuestion` also has no read of that specific field; similarly named workflow configuration accounts for other search hits.

Meanwhile, a mechanical scan found **183 literal Claude/Codex identity branches across 72 non-test source files**. Some are legitimate adapter or explicit product-policy branches, but many make decisions already described by capability metadata.

One concrete example is MCP application. `runtime-apply.ts` branches on Codex, assumes every other backend is Claude, then reads an undeclared `isTurnActive` property through an unsafe cast (`src/lib/mcp/runtime-apply.ts:492-519`) instead of using the MCP capability registry or a runtime operation.

**Recommendation:** Create one registered backend descriptor with nested, domain-owned capability sections. Keep domain types separate, but register them together and derive all lookups from the descriptor. Prefer semantic operations over “ask capability then branch” when the adapter can simply perform the operation.

### P1 — `AgentCall` normalizes results but does not yet hide enough execution complexity

`AgentCall` is useful, but its facade requires callers to provide resolver callbacks that return a runtime/runner, capability view, model/effort, continuation, policy settings, artifacts, and event plumbing (`src/lib/workflows/primitives/agent-call-facade.ts:48-93`). It is therefore closer to a normalized dispatcher than a complete backend facade.

The conversation actor exposes the consequence: it wraps the runtime in a `Proxy` to intercept `sendTurn`, capture the underlying result, and retain fields that `AgentCallResult` drops (`numTurns` and `contentBlocks`) (`src/lib/workflows/conversation/actor-implementations.ts:1029-1144`). The task path also injects Codex-only sandbox/approval/network defaults before calling the facade (`src/lib/workflows/conversation/actor-implementations.ts:2589-2624`).

A deep facade would not require its primary consumers to smuggle raw results around it or pre-apply provider policy.

**Recommendation:** Move backend selection, capability lookup, backend policy defaults, and normalized result completeness into the registered backend adapter/facade. Add the result fields real consumers require. Keep conversation lifecycle concerns in the actor, but do not make the actor understand provider error/ref semantics.

### P1 — XState transitions contain backend failure policy

The conversation machine clears or retains backend references by checking `context.agentBackend === "codex"` in two completion paths (`src/lib/workflows/conversation/machine.ts:581-597`, `657-666`). The comment correctly explains a real semantic difference, but the state machine is the wrong owner of it.

Adding a third backend requires deciding whether it behaves like Codex or Claude and editing machine transitions. The machine should receive a normalized result such as `continuationDisposition: "retain" | "replace" | "clear"` from the backend execution layer.

### P1 — Conversation forking bypasses the backend adapter

`conversations/service.ts` imports Anthropic's `forkSession()` directly (`src/lib/conversations/service.ts:1-35`) and implements native Claude fork plus synthetic fallback through backend identity checks (`src/lib/conversations/service.ts:433-535`). This is feature code relying on a backend-specific lifecycle detail.

The existing `preciseFork` capability advertises the distinction but is never consumed. This is a case where an operation is better than a boolean: the conversation service should call `backend.fork(request)` and receive a normalized native/synthetic/unsupported result.

### P1 — Backend model/default/config metadata is not registry-driven

Backend identity is centralized in `shared/schemas.ts`, but provider metadata is spread across server configuration and UI:

- `agent-backends/schemas.ts` contains separate Claude and Codex model schemas, defaults, effort maps, and a two-provider switch (`src/lib/agent-backends/schemas.ts:4-169`).
- Global config has top-level Claude fields (`defaultModel`, `defaultEffort`, `claudeTimeoutMs`) and a nested Codex object (`src/lib/config/schemas.ts:84-100`).
- The actor repeats that asymmetry when resolving model/effort and timeout (`src/lib/workflows/conversation/actor-implementations.ts:771-839`).
- `BackendToggle` hardcodes two backends and their labels/styles (`src/components/BackendToggle.tsx:13-30`).
- `ModelSelector` owns separate hardcoded provider model lists and another two-provider switch (`src/components/ModelSelector.tsx:17-43`).
- New session provisioning hardcodes the initial conversation to Claude (`src/lib/sessions/service.ts:301-337`) rather than using `defaultAgentBackend`.
- Command routes silently coerce every unknown backend to Claude (`src/lib/commands/route-handlers.ts:62-65`, `123-126`).

This guarantees change amplification and creates drift risk between validation, defaults, display, and runtime support.

**Recommendation:** Expose a server-side backend catalog derived from registered descriptors: ID, label, enabled state, model catalog, default model, effort options, timeout/default policy, and user-visible capability labels. Let UI selectors render the catalog. Normalize configuration under `backends[backendId]`, while keeping adapter-private extension data below that entry. Any compatibility migration for the current config shape requires Alex's explicit approval before implementation.

### P1 — Backend identity and continuation types have competing sources of truth

`AgentBackendId` and `AgentSessionRef` are hand-written in `src/lib/agent-backends/types.ts:5-9`. Zod-backed versions are separately defined in `src/lib/shared/schemas.ts:7-8` and `src/lib/agent-backends/schemas.ts:12-16`. Production modules import from both locations.

This violates the project's schema-first rule and makes a third backend easy to add incompletely.

**Recommendation:** Keep one Zod-backed source for backend IDs and one Zod-backed persisted continuation envelope. All TypeScript types should be inferred from those schemas.

### P2 — Registry bootstrap is explicit but incomplete as a backend composition root

`registry.ts` imports four modules for side-effect registration (`src/lib/agent-backends/registry.ts:1-6`). `registry-core.ts` maintains separate maps for factories and runners. There is no single registration that proves a backend has supplied all required metadata and operations, and no `listBackends()` for product discovery.

This is acceptable for two adapters but shallow as the long-term integration point.

**Recommendation:** Register one descriptor per backend atomically. The registry should reject duplicate IDs, validate required components, support intentionally partial backends (for example task-only) through explicit capability/operation absence, and expose a list/catalog. Avoid relying on scattered side-effect imports as the completeness mechanism.

### P2 — Collaboration encodes “opposite backend” as exactly two providers

Both collaboration implementations derive the second backend with `claude ? codex : claude` (`src/lib/workflows/collaboration/envelope.ts:263-269`, `src/lib/workflow-graph/workflow-collaborator-caller.ts:136-138`) and seed literal Claude and Codex lanes (`src/lib/workflows/collaboration/envelope.ts:576-610`).

This can be a valid product rule if collaboration intentionally means “Claude versus Codex.” It should be named and configured as that explicit pairing. It should not masquerade as a general backend-selection algorithm. With a third backend, the policy should select an ordered pair from configuration or a backend catalog rather than infer “the opposite.”

## Consistency assessment by area

| Area | Uses the abstraction? | Assessment |
|---|---|---|
| Basic conversation execution | Mostly | Factory/runtime registry is used, but raw Claude frames leak to the actor. |
| One-shot task execution | Yes | `AgentTaskRunner` is the cleanest backend-neutral seam. |
| Workflow dispatch | Partly | `AgentCall` normalizes calls, but callers still resolve backend policy and continuity. |
| Continuity / stale recovery | No single way | `WorkflowAgentCaller`, graph continuity service, and actor replacement retry coexist. |
| Forking | No | Feature service imports Anthropic SDK directly. |
| Transcript mapping | Inconsistent | Claude is interpreted above the adapter; Codex is normalized lower down. |
| MCP translation | Mostly | Portable model and translators are good; apply timing still branches/casts outside the adapter. |
| Agent capability configuration | Partly | Metadata/translation exist, but shared runtime has provider-named apply methods. |
| Model and effort discovery | No | Validation/default/UI metadata are duplicated and two-provider-specific. |
| UI backend discovery | No | Backends and models are hardcoded. |
| XState machine | Partly | Executes through shared actors, but owns Codex-specific ref invalidation policy. |
| Tests | Mostly | Strong implementation tests; missing reusable conformance contract for every descriptor. |

## How hard is a third backend today?

### Task-only backend

Moderate difficulty. An implementer would need to:

1. Add the ID to the shared schema and remove/update the duplicate type.
2. Implement/register `AgentTaskRunner`.
3. Add models/defaults/config and UI metadata.
4. Add capability-view and MCP/capability decisions.
5. Audit every two-provider fallback that currently treats “not Codex” as Claude.
6. Update workflow schemas and collaboration policies that assume exactly two providers.

The runner itself is straightforward; integration is not localized.

### Full conversation backend

High difficulty and risk. In addition to the task-only work, it requires:

1. A runtime/factory implementation.
2. A new `AgentSessionRef` branch and persistence migration.
3. New lane state/metrics/outcome branches.
4. New continuity create/resume/validate/recovery wiring in at least two systems.
5. Fork semantics.
6. Transcript/event normalization, including deciding whether the actor's “non-Claude” path is valid.
7. Failure-to-continuation policy in XState.
8. Capability config discovery, translation, seeding, live/staged apply, and runtime methods.
9. MCP application timing and tool discovery.
10. Model/effort/timeout defaults throughout server and UI code.

The practical extension unit today is “adapter plus edits across many core modules.” The target should be “adapter plus one catalog registration, with optional feature-specific UI/config work.”

## Recommended target design

Do not build an open-ended plugin framework. A curated static set of backends is sufficient. The strategic change is to make **one backend descriptor the composition root** and push provider knowledge behind it.

```ts
interface AgentBackendDescriptor {
  id: AgentBackendId;
  metadata: BackendMetadata;
  conversation?: ConversationBackendFactory;
  tasks?: AgentTaskRunner;
  continuity: BackendContinuityAdapter;
  capabilities: {
    conversation: ConversationCapabilities;
    workflow: WorkflowCapabilities;
    mcp: McpBackendCapabilities;
  };
  runtimeConfiguration: BackendRuntimeConfigurationAdapter;
}
```

The exact names are less important than these ownership rules:

1. **One registration per backend.** Factory, runner, metadata, capabilities, continuation, and config adapter are registered together.
2. **Generic callers issue semantic operations.** They call `fork`, `resumeOrRecover`, `applyRuntimeConfiguration`, or `sendTurn`; they do not inspect session/thread internals.
3. **Adapters translate provider events completely.** No SDK type crosses the boundary.
4. **Persisted references are opaque outside the adapter.** Generic code can compare backend ID and persist/version the envelope but cannot read `sessionId` versus `threadId`.
5. **Capabilities are data, operations are behavior.** UI availability can read capability metadata; runtime code should usually call the operation and handle a normalized `unsupported` result.
6. **The backend catalog drives product metadata.** Models, effort options, defaults, labels, and enabled state have one server-side source.
7. **AgentCall is the canonical workflow entry.** Its result contains everything workflow and actor consumers need, so they do not capture raw results around the facade.

### Desired dependency direction

```text
UI / routes / workflows / XState
              |
              v
     AgentCall + semantic services
              |
              v
       Backend registry/catalog
              |
       +------+------+
       |             |
       v             v
 Claude adapter   Codex adapter   ...third adapter
       |             |
       v             v
 Anthropic SDK    OpenAI SDK
```

Provider SDK types, native refs, event frames, model validation details, apply timing, and stale-session classification should only point downward into an adapter.

## Incremental refactor plan

This should be a migration, not a rewrite.

### Phase 1 — Establish one descriptor and conformance contract

1. Add `AgentBackendDescriptor` and atomic registration beside the existing registry.
2. Register Claude and Codex descriptors using the existing factories/runners.
3. Make current `getConversationBackendFactory()` and `getTaskRunner()` delegate to descriptors so callers need not migrate immediately.
4. Add a shared conformance suite run against every registered descriptor: ID agreement, model validation/default presence, capability completeness, ref round-trip, normalized errors, cancellation, and unsupported-operation behavior.
5. Collapse duplicate `AgentBackendId` and `AgentSessionRef` definitions to Zod-backed sources.

### Phase 2 — Close the highest-risk leaks

1. Normalize Claude provider events inside the Claude adapter; remove Anthropic SDK imports from the conversation actor and external-turn handler.
2. Move native/synthetic fork selection into the backend continuity adapter.
3. Replace `applyClaudeCapabilityConfig` / `applyCodexCapabilityConfig` and provider-named tooling fields with the runtime-configuration adapter.
4. Replace the MCP `isTurnActive` cast and identity switch with a declared semantic runtime operation.

### Phase 3 — Unify continuity

1. Refactor `WorkflowAgentCaller` to depend on `BackendContinuityAdapter`, not four provider-named functions.
2. Make lane persistence store an opaque ref plus normalized metrics/capability availability.
3. Migrate `workflow-continuity-service.ts` consumers to `WorkflowAgentCaller` and delete the legacy service.
4. Move continuation retain/clear/replace disposition out of XState transitions and into normalized turn results.
5. Replace the actor's `Proxy` with a named runtime-replacement wrapper using backend stale classification.

### Phase 4 — Make product metadata catalog-driven

1. Serve enabled backend descriptors/model catalogs to the UI.
2. Render `BackendToggle`, `ModelSelector`, and effort selectors from that data.
3. Normalize backend configuration without silently coercing unknown IDs to Claude.
4. Make initial conversations honor the configured default backend.
5. Replace two-provider “opposite” logic with an explicit collaboration backend-pair policy.

### Phase 5 — Prove third-backend locality

Add a deliberately small fake third adapter in tests only. The acceptance criterion is not feature parity; it is architectural locality:

- No changes to `AgentCall`, XState machines, lane service, transcript consumers, MCP apply service, or generic workflow orchestration.
- One backend ID/catalog registration plus the fake adapter and its tests.
- Unsupported features return explicit normalized outcomes.
- UI/catalog schemas can list it without adding a provider-specific branch.

That test is more valuable than another Claude/Codex branch test because it directly measures change amplification.

## What would make this 10/10?

The design reaches 10/10 when all of the following are true:

- A new curated backend is added by implementing one descriptor and adding one catalog entry.
- No generic interface contains Claude-, Codex-, Gemini-, or other provider-named methods or fields.
- No provider SDK type is imported outside its adapter or a clearly provider-specific feature.
- `AgentCall` callers do not branch on backend to prepare execution policy or recover dropped result data.
- One continuity service owns create/resume/validate/stale recovery/fork/retire behavior.
- One registered descriptor is the source of all capability lookups; domain-specific capability views are derived from it.
- One Zod-backed schema owns backend identity and persisted continuation envelopes.
- Backend/model/effort UI is catalog-driven.
- XState machines transition on normalized semantic outcomes, not backend identity.
- Every registered backend runs the same conformance suite, with additional adapter-specific tests for native behavior.

## Bottom line

The project should keep the existing conversation and task ports; they are worthwhile. The architectural mistake would be to add a third backend by extending the current pattern of provider-named optional fields and `if (backend === ...)` branches.

The next strategic move is to deepen the backend module: make it own lifecycle, continuation, configuration application, event translation, and catalog metadata behind one registered descriptor. Then migrate the graph workflow, conversation actor, and capability/MCP consumers onto that descriptor and delete the parallel paths. That investment will make a third backend an additive adapter instead of a codebase-wide special case.

## Audit notes

- This was a static architecture audit of the current worktree; no implementation code was changed.
- Counts exclude test and Storybook files unless stated otherwise.
- Three pre-existing untracked reports in `docs/reports/` were preserved and not modified.
- The configured `memory-bank/focus.md` session-focus file was absent from this worktree; repository steering, specs, documentation, and production code were used as the evidence base.
