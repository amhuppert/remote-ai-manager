# Agent Capabilities — Shared Schema & Metadata Contract

Status: Tasks 2.1, 2.2, 2.3 complete. Schemas live in `src/lib/schemas.ts`, metadata in `src/lib/agent-capabilities/metadata.ts`. All downstream tasks (3.x–10.x) MUST import from these modules — do not redeclare any type, enum, or constant covered here.

## Cascade kind enumeration

- `AGENT_CAPABILITY_CASCADE_KINDS` (const tuple) and `agentCapabilityCascadeKindSchema` (z.enum) live in `src/lib/schemas.ts`.
- Five values, fixed order: `claude-skills`, `claude-plugins`, `claude-agents`, `codex-skills`, `codex-plugins`.
- `src/lib/agent-capabilities/metadata.ts` re-exports the constant for legacy callers; new code should import from `@/lib/schemas`.

## Sparse override storage

- `agentCapabilityItemOverrideSchema` — `{ enabled: boolean }`. Item absence in `items` map = inherit; presence with `enabled: false` = explicit disable.
- `agentCapabilityCascadeOverrideSchema` — `{ items: Record<string, ItemOverride> }`.
- `agentCapabilityCascadesOverrideSchema` — **uses `z.partialRecord`** keyed by cascade kind. Required because `z.record(enumSchema, V)` in Zod v4 demands every enum value (closed-key behavior). `z.partialRecord` produces `Partial<Record<K, V>>` — exactly the sparse semantics the cascade layer needs.
- `agentCapabilityOverridesSchema = z.object({ cascades: agentCapabilityCascadesOverrideSchema })` — wrapper added to: `conversationStateSchema`, `sessionStateSchema`, `projectStateSchema`, `projectRowSchema` (all `.optional()`, additive).

## Global state file

- `agentCapabilityGlobalStateSchema` — `{ version: literal(1), overrides, updatedAt: string }`. Use for the global config layer file. Bump the literal when adding migrating fields.

## Conversation runtime apply state

- `agentCapabilityCascadeRuntimeStateSchema` — `{ appliedHash, pendingHash?, pendingItemIds[], lastApplyStatus, lastApplyError? }`. Tracks per-cascade apply progress on a single conversation.
- `agentCapabilityRuntimeApplicationStateSchema` — `{ cascades: Partial<Record<CascadeKind, CascadeRuntimeState>> }`. Added as `agentCapabilitiesRuntime?` on `conversationStateSchema`.

## API view contract (task 2.2)

- `agentCapabilityViewRowSchema` carries: `cascadeKind`, `itemId`, native default, own override (this layer), final effective state, origin layer, source ref, `staleStatus`, `runtimeVisibility`, `runtimeEmittable`, `inheritedDisableReason?`, `lastApplyStatus`, `lastApplyError?`. Refined with `requireAgentCapabilityCascadeBackendOwnership` so any payload pairing the cascadeKind with the wrong backend fails parse.
- `agentCapabilityMetadataSchema` is the canonical capability-metadata shape (cascadeKind, backend, capabilityKind, applySemantics, discoverySupport, runtimeVisibility, compositionSupport). `.strict()` blocks accidental SDK-config leakage and the same ownership refinement is applied.
- `agentCapabilityViewMetadataSchema` is an **alias** of `agentCapabilityMetadataSchema` — there is one canonical metadata shape, used both by the registry (`src/lib/agent-capabilities/metadata.ts`) and by API responses (`metadata` field). Downstream code must not redeclare these fields.
- `agentCapabilityViewResponseSchema` is the API envelope. Two refinements: (1) `requireAgentCapabilityCascadeBackendOwnership` on the response itself; (2) `metadata.cascadeKind` must equal the response's `cascadeKind` when present. `agentCapabilityInventorySchema` is the discovery-only sibling.
- `agentCapabilityDiagnosticSchema` has optional `cascadeKind` and optional `backend`; when both are present the ownership refinement runs, so diagnostics cannot misattribute a Codex cascade to the Claude backend.

## Cascade/backend ownership (boundary invariant)

- `AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP: Readonly<Record<AgentCapabilityCascadeKind, AgentBackendId>>` is the single source of truth.
- `requireAgentCapabilityCascadeBackendOwnership(value, ctx)` is reused across `viewRow`, `metadata`, `viewResponse`, and `diagnostic` schemas. Downstream resolvers, translators, API routes, and UI hooks **MUST NOT** re-check this — Zod parse at the boundary guarantees the invariant.

## Patch contract

- `agentCapabilityPatchRequestSchema` — `{ cascadeKind, operations[], expectedHash }`.
- `agentCapabilityOverrideOperationSchema` — discriminated union: `set-item-enabled` (with `enabled: boolean`) or `reset-item`. Use the discriminator only; do not branch on cascade kind for operation semantics.

## Diagnostics + SSE events

- `agentCapabilityDiagnosticSchema` is `.strict()` — pin: no extra fields allowed. Use the `code` string enum (`codex-skill-config-key-unverified`, `codex-plugins-unavailable`, `claude-plugin-override-stale`, `agent-capability-source-unreadable`, `agent-capability-stale-override`).
- `agentCapabilitiesUpdatedEventSchema` and `agentCapabilitiesDiscoveryUpdatedEventSchema` are both `.strict()` — payloads must never leak raw SDK config or item bodies through SSE. Carry hashes/ids only.
- Both events are members of the `SSEEvent` union in `schemas.ts`. UI subscribers may filter by `type`.

## Source reference discriminator

`agentCapabilitySourceRefSchema` is a `z.discriminatedUnion("kind", ...)` over: `global-file`, `project-file`, `user-file`, `system-file`, `plugin`, `sdk-runtime`. Add a new kind by extending the union — do not stringify origin into a free-form field.

## Metadata registry (task 2.3)

- **Schema-first**: the `AgentCapabilityMetadata` type is `z.infer<typeof agentCapabilityMetadataSchema>` — not a hand-written interface. The registry constructor `createAgentCapabilityMetadataRegistry(entries: readonly unknown[])` calls `agentCapabilityMetadataSchema.safeParse()` on every record at construction. Invalid pairings, missing fields, extra fields, and duplicates all throw at boundary.
- The production array `agentCapabilityMetadata` itself calls `agentCapabilityMetadataSchema.parse({...})` on every record literal — so a typo in a literal fails import-time, not at runtime later.
- `defaultAgentCapabilityMetadataRegistry.get(cascadeKind)` returns the parsed record; `listForBackend(backend)` filters by the `backend` field, **not** by cascade-kind prefix.
- Both Codex cascades are pinned to `compositionSupport: "verification-gated"` until the SDK config keys for skills and the discovery source for plugins are proven. Tests fail if either regresses.
- `claude-agents` is `applySemantics: "next-conversation"` + `compositionSupport: "translator"` + `runtimeVisibility: "sdk-runtime"` — encodes the "visible but deferred" pattern via metadata fields alone. No UI branch on the cascade string.
- `codex-plugins` is `discoverySupport: "unavailable-pending-verification"` + `runtimeVisibility: "unsupported"` — UI must render the placeholder via these fields, not a `cascadeKind === "codex-plugins"` check.

## When to read this

- Implementing any task 3.x–10.x that touches: persistence, API routes, runtime composition, UI panels, or SSE handling for agent capabilities.
- Before adding any new enum value, override shape, view field, diagnostic code, or SSE event to the agent-capability subsystem. Extend the schemas here first; consumers follow.
