# Agent Backends

Claude, Codex, and future providers vary behind one registered composition boundary. Provider identity is data at the edge, not a reason for feature code to grow parallel pipelines.

## Canonical boundary

- `src/lib/agent-backends/descriptor.ts` defines the registered descriptor and its metadata, conversation, task, MCP, and failure-classification facets.
- `registry-core.ts` owns registration and lookup; `registry.ts` bootstraps production descriptors. Neutral consumers import the registry surface, never a provider implementation.
- `conversation.ts` and `task.ts` define the execution ports. Workflow code normally composes them through AgentCall (`src/lib/workflows/primitives/agent-call-facade.ts`).
- `AgentSessionRef` is the opaque continuity handle: `{ backend, ref }`. Outside the owning adapter, never parse `ref`, infer semantics from its shape, or store a provider-specific session/thread field.
- Capability descriptors answer whether and when behavior is supported. Do not branch on `backend === "claude" | "codex"` when a capability, task profile, normalized result, or registered policy can own the decision.

## Ownership rules

Provider adapters own:

- SDK construction, environment, permission/sandbox translation, and native tool configuration
- native frame interpretation and lossless transcript envelopes
- continuity validation, resume/recovery/fork behavior, and stale-reference classification
- provider-specific failure classification and `ContinuationDisposition`
- wire-schema compatibility for native structured output

Neutral callers own:

- domain intent, semantic task profile, timeout, cancellation, and portable inputs
- post-parse domain validation and state transitions
- behavior selected from declared capabilities rather than provider identity

Raw provider payloads may cross the seam only inside the lossless transcript envelope. Code above the seam records the envelope without reading or branching on its `raw` payload.

## Structured output

The caller supplies its authoritative JSON Schema through the neutral conversation/task request. It may be generated from Zod or authored independently; callers do not maintain a second Claude-safe copy.

- Claude's adapter calls `projectSchemaForClaude` immediately before both native SDK handoffs, removing only keywords Claude cannot enforce safely.
- Codex receives the unmodified schema.
- Domain Zod schemas remain authoritative for post-parse acceptance with `safeParse`.
- New Claude-bound schemas must be added to the inventory in `src/lib/agent-backends/claude/structured-output-projection.test.ts`.

Never call a Claude SDK directly with an unprojected application schema, and never move Claude's projection into shared/caller code. The asymmetry is provider knowledge and belongs below the backend seam.

## Adding or extending a backend

1. Add or extend a descriptor and the required facets under that provider's adapter directory.
2. Declare capability and application-timing differences in descriptor data.
3. Normalize failures and continuation disposition inside the adapter.
4. Preserve native transcript bytes in the lossless envelope; expose only neutral operational events/results above it.
5. Extend the parameterized conformance, consumer-locality, transcript-boundary, and structured-output projection tests.
6. Run `bun run seams:check`; a new provider must not require identity branches or deep provider imports in neutral consumers.

Product policy may intentionally name a provider only at an explicit selection/pairing site. Mark such a survivor in the seam catalog with its policy reason and deletion condition; do not use it as precedent for domain branching.
