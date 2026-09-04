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

Command Center's memory library replaces the provider's own memory, so every descriptor declares `nativeMemory` (`src/lib/agent-backends/native-memory.ts`) in one of two states and cannot register without deciding: `disabled` with the lever it pulls, applied in every CC-launched environment for that backend, or `none` with the reason no lever exists. There is no third state — "the prompt asks it not to" is not a mechanism. Adapters own the disable (Claude on the SDK `Settings` layer, Codex in the `memories` config table); a new launch path for either backend applies that backend's shared constant, because the claim covers every environment. A payload is not proof: Claude's `Settings` layer is the SDK's *flag* tier and loses to managed policy, so every Claude launch first resolves the policy tier (`assertClaudeNativeMemoryNeutralized`) and refuses to start when the effective value is not off, or when the policy tier names a source whose content the resolver cannot read (`policyHelper`, `forceRemoteSettingsRefresh`). A backend whose lever can be outranked must verify the *effective* value rather than the payload it sent, and must treat a policy source it cannot read as a refusal rather than a pass. Do not hand-survey that source list — `native-memory-policy-surface.test.ts` scans the installed SDK declarations and reds on any untriaged startup-scoped policy key. A `none` declaration is disclosed on both operator surfaces — the `cctl memory index` stderr header and the Memory Library — from the declaration itself, never from a hardcoded backend name.

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

- Claude declares `structuredOutput: "post_validation"`. Its adapters render the complete schema into a deterministic final-message contract appended to the prompt. No schema reaches the Claude SDK's `outputFormat` wire.
- Codex declares `structuredOutput: "backend_native"` and enforces the schema natively on its final response. Its provider accepts only a strict JSON Schema dialect, so `codex/output-schema.ts` owns the whole Codex transport and nothing else may reshape a schema on the Codex path. Both Codex adapters call `resolveCodexStructuredOutput` once per authored schema and use the returned dispatch end-to-end (`prepareInput`, `outputSchema`, `restore`). A schema the dialect can express is projected on dispatch — a `type` beside a primitive `const`, `anyOf` for `oneOf`, and on every object a declared `type`, `additionalProperties: false`, and `required` naming every declared property with authored-optional keys widened to admit `null` — and the induced nulls are dropped from the response so the shared gate sees the authored shape. A schema the dialect cannot express (a free-form or explicitly open object, or a union root) rides the prompt as the neutral rendered contract instead, with the shared gate as the only enforcement — the same path Claude always takes — and the adapter logs `structured_output_prompt_contract` with the reason. A schema that reaches the provider outside this transport is refused with HTTP 400 `invalid_json_schema` at dispatch, identically on every retry, not a degraded turn.
- The shared extractor tries native output, raw response JSON, then the last fenced JSON block. The AgentCall facade validates every candidate through the same post-turn gate regardless of backend capability.
- A failed facade gate gets one bounded repair turn by default. Task runs repair in a fresh isolated one-shot; conversation turns use one corrective turn on the resolved runtime. Callers may explicitly set the repair budget to zero.
- Domain Zod schemas remain authoritative for post-parse acceptance with `safeParse`.

Keep this transport asymmetry below the backend seam. Neutral callers select behavior from declared capabilities and must not branch on provider identity.

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
6. Run `bun run seams:check`; a new provider must not require identity branches or deep provider imports in neutral consumers.

Product policy may intentionally name a provider only at an explicit selection/pairing site. Mark such a survivor in the seam catalog with its policy reason and deletion condition; do not use it as precedent for domain branching.
