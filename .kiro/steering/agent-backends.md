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
- Codex declares `structuredOutput: "backend_native"` and enforces the schema natively on its final response. Its provider accepts only a strict JSON Schema dialect, so `codex/output-schema.ts` owns both directions of that adaptation and nothing else may reshape a schema on the Codex path: `projectSchemaForCodex` rewrites the authored schema on dispatch (a `type` beside a primitive `const`; `required` naming every declared property, with authored-optional keys widened to admit `null`), and `restoreCodexOptionalOmissions` drops those induced nulls from the response so the shared gate sees the authored shape. An authored-optional property that reaches the provider outside this projection is refused with HTTP 400 `invalid_json_schema`, not a degraded turn.
- The shared extractor tries native output, raw response JSON, then the last fenced JSON block. The AgentCall facade validates every candidate through the same post-turn gate regardless of backend capability.
- A failed facade gate gets one bounded repair turn by default. Task runs repair in a fresh isolated one-shot; conversation turns use one corrective turn on the resolved runtime. Callers may explicitly set the repair budget to zero.
- Domain Zod schemas remain authoritative for post-parse acceptance with `safeParse`.

Keep this transport asymmetry below the backend seam. Neutral callers select behavior from declared capabilities and must not branch on provider identity.

## Adding or extending a backend

1. Add or extend a descriptor and the required facets under that provider's adapter directory.
2. Declare capability and application-timing differences in descriptor data.
3. Normalize failures and continuation disposition inside the adapter.
4. Preserve native transcript bytes in the lossless envelope; expose only neutral operational events/results above it.
5. Extend the parameterized conformance, consumer-locality, transcript-boundary, and capability-specific structured-output transport tests.
6. Run `bun run seams:check`; a new provider must not require identity branches or deep provider imports in neutral consumers.

Product policy may intentionally name a provider only at an explicit selection/pairing site. Mark such a survivor in the seam catalog with its policy reason and deletion condition; do not use it as precedent for domain branching.
