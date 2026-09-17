# Agent Backends

Claude, Codex, and future providers vary behind one registered composition boundary. Provider identity is data at the edge, not a reason for feature code to grow parallel pipelines.

## Canonical boundary

- `src/lib/agent-backends/descriptor.ts` defines the registered descriptor and its metadata, conversation, task, MCP, and failure-classification facets.
- `registry-core.ts` owns registration and lookup; `registry.ts` bootstraps production descriptors. Neutral consumers import the registry surface, never a provider implementation.
- `conversation.ts` and `task.ts` define the execution ports. Workflow code normally composes them through AgentCall (`src/lib/workflows/primitives/agent-call-facade.ts`).
- `AgentSessionRef` is the opaque continuity handle: `{ backend, ref }`. Outside the owning adapter, never parse `ref`, infer semantics from its shape, or store a provider-specific session/thread field.
- Capability descriptors answer whether and when behavior is supported. Do not branch on `backend === "claude" | "codex"` when a capability, task profile, normalized result, or registered policy can own the decision.

## Managed skills

Command Center's own skills (the bundled `plugins/command-center` plugin) are host environment, not user capabilities: they are published at startup as an immutable content-addressed bundle (`src/lib/managed-skills/`) and attached to every normal launch below the seam. Every descriptor declares `managedSkills` per execution facet (`bundled` or an explicit `hermetic`); a backend cannot register without deciding. Delivery is adapter-owned: Claude attaches the published bundle as an SDK-local plugin (suppressing a non-equivalent user-installed copy via the flag layer only); Codex reconciles one `info/exclude`-hidden `.agents/skills/command-center` link in the launch checkout before each turn (`codex/managed-skills-bridge.ts`) because the exec transport has no skill-root injection — replace the bridge with native process-scoped roots if that changes. Isolated one-shot profiles stay hermetic. Managed skills never enter the user capability cascade and never write backend-owned user configuration.

## Native provider memory

Command Center's memory library replaces the provider's own memory, so every descriptor declares `nativeMemory` (`src/lib/agent-backends/native-memory.ts`) in one of two states and cannot register without deciding: `disabled` with the lever it pulls, applied in every CC-launched environment for that backend, or `none` with the reason no lever exists. There is no third state — "the prompt asks it not to" is not a mechanism. Adapters own the disable (Claude on the SDK `Settings` layer, Codex in the `memories` config table); a new launch path for either backend applies that backend's shared constant, because the claim covers every environment. CC runs on unmanaged hosts; Claude checks its shared flag-tier memory settings once per server process and refuses launches if those flags are unreadable. A `none` declaration is disclosed on both operator surfaces — the `cctl memory index` stderr header and the Memory Library — from the declaration itself, never from a hardcoded backend name.

## Ownership rules

Provider adapters own:

- SDK construction, environment, permission/sandbox translation, and native tool configuration
- native frame interpretation and lossless transcript envelopes
- continuity validation, resume/recovery/fork behavior, and stale-reference classification
- provider-specific failure classification and `ContinuationDisposition`
- structured-output transport and provider-native enforcement

Neutral callers own:

- domain intent, semantic task profile, timeout, cancellation, and portable inputs
- **declaring conversation scope**: `ConversationBackendCreateInput.conversationTarget`
  is a `ConversationTarget`, so the caller states whether this is a session or a
  project conversation. A runtime passes it to `buildSessionEnvContract` and never
  re-derives scope from a session name, the `__project__` sentinel, or a worktree
  path — see the conversation scope contract in `CONTEXT.md`.
- post-parse domain validation and state transitions
- behavior selected from declared capabilities rather than provider identity

Raw provider payloads may cross the seam only inside the lossless transcript envelope. Code above the seam records the envelope without reading or branching on its `raw` payload.

## Structured output

The caller supplies its authoritative JSON Schema through the neutral conversation/task request. It may be generated from Zod or authored independently; callers do not maintain provider-specific copies.

- Claude and Codex declare `structuredOutput: "post_validation"` on both task and conversation facets. Their adapters append the authored schema as a deterministic final-message contract using `structured-output-prompt.ts`, including on image-bearing prompts and repair turns. No schema reaches the Claude SDK's `outputFormat` or the Codex SDK's `outputSchema` wire.
- Adapters return final-response text without projecting schemas or rewriting payloads. Optional properties remain optional, and provider-emitted nulls are judged against the authored schema by the shared gate.
- The shared extractor tries native output, raw response JSON, then the last fenced JSON block. The AgentCall facade validates every candidate through the same post-turn gate regardless of backend capability.
- A failed facade gate gets one bounded repair turn by default. Task runs repair in a fresh isolated one-shot; conversation turns use one corrective turn on the resolved runtime. Callers may explicitly set the repair budget to zero.
- Domain Zod schemas remain authoritative for post-parse acceptance with `safeParse`.

Keep structured-output transport below the backend seam. Neutral callers select behavior from declared capabilities and must not branch on provider identity.

## Model selection

Every backend descriptor exposes a model-catalog facet, and conversation factories validate complete atomic selections against the project-effective catalog:

- `modelCatalog.getCatalog({ projectPath, configuredSelection })` returns complete model definitions, parameter definitions, exact valid variants, provenance, and one atomic default.
- `validateModelSelection` accepts a whole `{ modelId, parameters }` value and returns the canonical complete selection. Cursor applies `CommandCenter.json`'s `agentBackends.cursor.supportedModels` while resolving its effective catalog. A configured default outside the project's list remains an invalid applied selection and is never substituted, but the filtered catalog stays available so an explicit complete allowed selection can recover.

`GET /api/projects/[name]/model-options` projects every descriptor's effective catalog, atomic default, provenance, and diagnostics. Conversation-creation surfaces render those definitions directly. A selection outside the projection remains visible with a diagnostic and blocks submission; it is never substituted.

Neutral callers carry complete selections and do not interpret provider parameter names or branch on backend identity.

## Adding or extending a backend

1. Add or extend a descriptor and the required facets under that provider's adapter directory, including the `nativeMemory` declaration.
2. Declare capability and application-timing differences in descriptor data.
3. Normalize failures and continuation disposition inside the adapter.
4. Preserve native transcript bytes in the lossless envelope; expose only neutral operational events/results above it.
5. Extend the parameterized conformance, consumer-locality, transcript-boundary, and capability-specific structured-output transport tests.
6. Run the registered `seams` and `typecheck` validators through `cctl validate run`; a new provider must not require identity branches or deep provider imports in neutral consumers.

Product policy may intentionally name a provider only at an explicit selection/pairing site. Mark such a survivor in the seam catalog with its policy reason and deletion condition; do not use it as precedent for domain branching.
