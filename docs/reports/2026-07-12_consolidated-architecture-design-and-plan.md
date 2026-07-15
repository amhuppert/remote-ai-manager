# Command Center Architecture: Consolidated Design Review, Target Design, and Implementation Plan

**Date:** 2026-07-12
**Status:** Implemented and verified. This is the canonical architecture, decision log, and historical implementation plan for the composition-units program. The five pre-Phase-1 blockers were resolved by `docs/design/2026-07-12_phase-1-slice-designs.md`; decisions D1–D27 and the current seam-floor table remain authoritative, while audit-time counts and roadmap language below are historical evidence.

1. `2026-07-11_composition-units-design-review.md` (8-agent full-codebase audit, 6.5/10)
2. `2026-07-11_backend-abstraction-audit.md` (backend seam, 6/10)
3. `2026-07-11-composable-modules-architecture-audit.md` (module depth/ownership, 6.0/10)
4. `2026-07-11_xstate-machines-review.md` (XState layer, 4.5/10)
5. `2026-07-11-agent-backend-interface-audit.md` (backend interface + third-backend readiness, 5/10)

The supporting file:line evidence and audit-time counts live in those reports; this document does not repeat their evidence chains. Counts are point-in-time audit estimates unless an enforcement script defines the exact corpus and pattern. Any count promoted into CI must record its reproducible command, exclusions, and source commit. Where the reports proposed competing designs, this document picks one and records the choice in **Appendix A — Decision log**.

---

## 0. Executive summary

Every audit converged on the same diagnosis from a different angle: **the architecture's bones are right, and the dominant failure mode is stopping at partial adoption.** The composable-primitives strategy works where it was driven to completion (conversation-actor spine, merge-machine reuse, MCP cascade, query-key factories, CLI functional core). But across every subsystem the same arc repeats — the right seam is built, proves itself in one or two consumers, and the migration never finishes. The old mechanism is never deleted, so the codebase carries *both*, and "one way of solving a problem" (the weakest axis in every scorecard: 3–4.5/10) erodes with each new feature that has to choose.

Three structural consequences compound this:

- **The backend abstraction is not honored at its edges.** The neutral interface names its implementations, raw Claude SDK frames cross the seam, the session-ref shape forces ~20+ modules to branch on backend identity, and the audit found roughly 183 literal backend-identity sites across 72 files under its broad census. Some are legitimate adapter or product-policy sites; the enforcement baseline is generated later from a narrower, explicit corpus. A third backend today is an adapter *plus* a codebase-wide special case.
- **The XState layer over-declared and under-delivered.** Two of five catalog machines orchestrate nothing; the documented shared tier is dead code that steering still points at; the three real machines duplicate each other's topology, hosting, and persistence; debug mode consumes ~47% of the conversation machine.
- **Invariants are held by comments, not construction.** The store-singleton rule, the focused-write discipline, the publication-path rule, the no-cross-feature-import rule, and the backend seam are all violated in production because nothing structural prevents it.

**The fix is not new architecture.** It is: seal the backend seam behind one registered descriptor; consolidate the XState layer by deletion and fragment-sharing; deepen the two canonical execution doors so their consumers stop smuggling around them; finish or delete every half-adopted seam; and install enforcement (lint rules + a migration ratchet) so completion sticks. Parts 3–4 give the target design and authoritative program roadmap. The program-level decisions become complete after the five pre-Phase-1 blockers in §3.6 are resolved.

---

## Part 1 — Major design issues

### 1.1 The defining failure mode: half-finished migrations

A seam is currently "done" when it works, not when the old way is gone. Each unfinished migration leaves two mechanisms, doubling the decision surface for the next author — and roughly half choose wrong. Verified instances:

| Seam built | Adoption | Legacy left alive |
|---|---|---|
| Route resolve seam (`shared/route-resolution.ts`) | 4 of 61 handler modules | ~40 hand-rolled 404 ladders, 5 result shapes, 9 `jsonError` definitions, 3 same-name `resolveProjectOr404` clones |
| SSE publication / StatusBus (`publishSessionStatus`) | Status events in 10–13 modules | 10+ modules import `events/broadcaster` directly, including non-lifecycle publishers; `subscribeSessionStatus` has zero production subscribers |
| Lane primitive (`LaneService`/`WorkflowAgentCaller`) | Collaboration lanes | Graph implementer/validator lanes on the self-described "legacy graph-only equivalent" (`workflow-continuity-service.ts`, ~1,100 LOC), which round-trips through the Lane primitive via a throwaway in-memory store per call |
| Gate vocabulary (8 gates) | 4 consumed | 4 gates with zero production consumers while 3 features run parallel gate implementations |
| Focused accessors/setters (state-store) | Broad | Broad `readState`/`mutateState` still exported; 5 modules bypass via private store instances; `writeState`/`updateSession` dead but exported |
| `ui/Dialog` | 5 consumers | 12 bespoke `role="dialog"` overlays without focus traps |
| `ui/Tooltip` | **0** consumers | Broad mouse-only `data-tooltip` usage; exact migration count generated by the seam-adoption script |
| AgentCall facade owning the pre-turn pipeline | Dispatch + structured-output gate | MCP apply, continuity, error normalization inline in a 1,355-line `executePromptForMachine` |
| Debug-as-attached-workflow | `debug-adapter.ts` seam exists | 8/17 debug states, 10/22 events still embedded in the conversation machine |
| `GitClient` | Partial | `git/diff.ts` still shells out via raw `node:child_process` |

### 1.2 Dead, catalog-only, and aspirational abstractions — with steering overstating adoption

Verified dead or unadopted: the entire root "shared workflow tier" (`workflows/actions.ts`, `runtime-state.ts`, `setup.ts`, `types.ts` partially, `persistence.ts` — an explicit no-op stub), four gates (`ask-user`, `change-set`, `convergence`, `script-validation` — the last duplicating a live union verbatim), every field of `ConversationBackendCapabilities`, `ui/Tooltip.tsx`, `src/lib/api/sse.ts` (an `export {}`), `RESOURCES_ACQUIRED/FAILED` events, and assorted dead hooks. `retry-machine.ts` and the `optimistic/` XState machine have **zero orchestration consumers but are not import-dead**: the production workflow catalog imports and introspects both. The live optimistic implementation is the imperative `shared/optimistic.ts`; it is not a line-for-line copy of the XState machine. The section-6-3 parity test protects live StatusBus wire shapes, merge dispatch, and AgentCall routing rather than pinning the two implementations together.

The `workflows.md` steering file still directs new workflow authors at the dead tier; `engineering-principles.md` lists it as the primitive set; the workflows-catalog page presents "the 5 XState machines orchestrating Command Center" when two orchestrate nothing; `tech.md` names a replaced dependency. **The steering describes an architecture that was superseded — every new contributor is actively misdirected.**

### 1.3 The backend seam is breached in three escalating ways

1. **The neutral interface names its backends.** `ConversationBackendRuntime` carries `applyClaudeCapabilityConfig?`/`applyCodexCapabilityConfig?` with per-backend result types, `ConversationToolingOverrides` has per-backend config fields, and `agent-backends/types.ts` imports those config types from `agent-capabilities/` — the seam depends on modules outside itself (inverted dependency). This legitimizes `backend ===` checks everywhere downstream.
2. **Consumers reach around the interface.** The `provider_event: { payload: unknown }` escape hatch carries raw `SDKMessage`s into the neutral actor, which imports five Anthropic SDK types, casts, and interprets Claude frames ~4,500 lines deep in `actor-implementations.ts`; `external-turn-handler.ts` hardcodes `backend: "claude"`. Transcript ownership is asymmetric: Claude transcripts are persisted by the *actor* from raw frames, Codex transcripts by the *runtime* from mapped blocks. Elsewhere, `sessions/service.ts` runs a raw SDK `query()` for session naming, `conversations/service.ts` imports `forkSession` directly (the `preciseFork` capability flag exists and is never read), and `mcp/portable-mcp-filter.ts` treats Claude's permission vocabulary as neutral.
3. **The session-ref shape leaks backend vocabulary everywhere.** `{ backend: "claude"; sessionId } | { backend: "codex"; threadId }` forces every consumer of "the opaque resume handle" to branch — UI popovers, lane state, validator continuity, persisted workflow schemas. The knowledge "Codex calls it a thread" is one design decision reflected in dozens of modules, hardened into storage.

Compounding these: four capability descriptor systems with overlapping semantics (`ConversationBackendCapabilities` — dead, `BackendCapabilityView`, `McpBackendCapabilities`, `QueueCapability`); the `agent-capabilities` domain built as parallel per-backend pipelines (cascade kinds literally named `claude-skills`/`codex-plugins`); model/effort catalogs hand-enumerated in three places; a canonical Zod `AgentBackendId` in `shared/schemas.ts` plus a hand-written duplicate, and duplicate `AgentSessionRef` definitions; collaboration's `oppositeBackend()` two-provider arithmetic; `codex-runs` as a backend-branded silo whose executor is fully generic; and a broad audit census of roughly 183 backend-identity sites across 72 non-test files. Some sites are legitimate; the exact outside-adapter migration population is generated by §3.5. Census for a third backend: ~7 healthy edits inside the seam, ~50+ mechanical edits outside it, and 4 forced structural refactors.

### 1.4 The XState layer: duplication where there should be sharing, machines where there is nothing to orchestrate

- **Commit is a ~90% transcription of merge's mid-pipeline** — six states, three verbatim guards, identical actor wiring — and the duplication has already produced a real divergence: the validation-timeout short-circuit was added only to merge, so a commit job whose validation script times out burns LLM fix turns on an unfixable environment limit.
- **Hosting is copy-pasted per machine**: two near-identical actor subscribers and three near-identical dispatchers in `jobs/queue.ts`, plus a third re-implementation of the phase-diff loop in `graph-merge-runner.ts`.
- **Machine-snapshot persistence has six-plus owners**, including four private `buildMachineSnapshot` copies in the graph engine (which aren't XState snapshots at all — a third meaning of "machine snapshot" in one codebase).
- **Retry inverts the framing**: the generic `retry-machine.ts` has zero orchestration consumers and one catalog-only importer while production hand-rolls the shape 14 times — including a JS `Proxy` `get`-trap inside the conversation actor and two lock-poll twins with identical constants written independently. The unit that *did* take hold is a pure policy function (`runCircuitBreakerGate`).
- **The conversation machine**: debug occupies 8/17 states, 10/22 events, 10/11 named guards, 7/9 finalize branches; the machine has zero `final` states so its `output` block, `ConversationOutput` type, and the manager's terminal-flush subscriptions are unreachable dead code; the `SUBMIT_PROMPT` claim transition is triplicated; backend failure policy (`backend === "codex"` ref retention) lives in machine transitions. `manager.ts` (1,633 lines) is four modules in one file with five DI seams.
- **Steering-convention compliance is zero-for-five machines** (final states, `finalStatus`, `onTerminal` — dead in practice everywhere).
- Zero hand-rolled lifecycles should become machines. The graph execution lifecycle already converged on machine-grade guarantees plus persistence-layer fencing XState cannot provide. Two lifecycles need a single transition owner short of XState: graph **context-level** status (9 writer modules, no legality check) and dev-server status (2 modules bypass the existing `transitionTo`).

### 1.5 Split ownership in the workflow execution layer

- **The AgentCall facade is bypassed by its two biggest consumers.** The actor wraps the runtime in a `Proxy` to smuggle retry behavior and raw turn fields (`numTurns`, `contentBlocks`) around the normalized result; the graph validator opts out via an explicit `skipStructuredOutputGate` and runs its own 4-path fallback chain (duplicated near-verbatim in `sessions/conflict-resolution.ts`). A facade whose primary consumers need smuggling has a result type that is too narrow, and it requires callers to construct backend resolutions and pass execution policy back in — a normalized dispatcher, not a deep facade.
- **Scheduling ownership is split across temporal stages.** Write capability and its default are repeated in four modules; collaboration schedules outside `WorkflowAgentCaller` while WAC also schedules internally, forcing production to inject a **no-op inner scheduler** to avoid self-deadlock.
- **Continuity has three parallel stacks** — `WorkflowAgentCaller`, `workflow-continuity-service.ts` (legacy), and the actor's Proxy retry — all implementing the same classify → correct → retry-once policy shape; the graph validator's continuity cache is an in-memory Map that silently resets on restart.
- **Structured output has 7 mechanisms; error classification has 5 schemes.** The ports return bare `error: string | null`, so layers above grep message strings to detect staleness.
- **The generic gates erase type information without owning lifecycle** — they translate already-made domain decisions into a `Record<string, unknown>` envelope. The gates that work (graph approval, user-input, circuit-breaker) own atomic transitions or pure policy.

### 1.6 God modules and knowledge hubs at the orchestration centers

79 files exceed the ~600-line guideline; the ones that matter sit exactly where composition matters most: `actor-implementations.ts` (2,833; `executePromptForMachine` alone ~1,355 lines stacking ~12 concerns behind a 40-method deps grab-bag closed with a forbidden `as unknown as` cast), `execution-loop.ts` (2,690) + `iteration-orchestrator.ts` (2,546) as closure factories, `workflows/schemas.ts` (2,396 lines, 209 exports, 120+ importers — graph schemas living in the sibling domain), `NotificationListener.tsx` (1,295 lines; 43 hand-repeated listener blocks), `session-detail.store.ts` (977 lines, ~16 concerns), and the session workspace's prop-bag hooks (~70-field arg interfaces that remap fields between bags without owning knowledge).

### 1.7 Convention where construction is needed

Load-bearing invariants violated in production today because nothing enforces them: the one-store-instance rule (5 private `createStateManager()` instances → a real stale-cache hazard), focused-first writes, "status leaves running only via the manager," no cross-feature imports (8–13 violating statements), never-`vi.mock`-internal (119 non-infrastructure internal mocks in 31 test files, concentrated in UI tests — evidence of a missing sanctioned client-test seam), and Zod as the wire-schema source (~20 hand-written `*_JSON_SCHEMA` literals vs one `z.toJSONSchema` call).

### 1.8 Multiple owners of canonical representations, lifecycle vocabularies, and utilities

Conversation construction ×5 sites; transcript logical-grouping ×3 (kept aligned by parity tests — proof the rule has several owners); serialization knowledge spread over 5 persistence modules; three repo idioms; MCP and agent-capabilities re-implementing the same scoped-cascade substrate with already-diverged concurrency safety. Four background-work lifecycle vocabularies (`BackgroundJob`, `CodexRunRecord`, `GraphWorkflowExecution`, `WorkflowEnvelope`) plus three abort registries. And the utility long tail: 5 keyed mutexes, 4 atomic JSON writers, 3 validated-JSON-file stores, 2 lock-poll twins, 9 `formatRelativeTime` copies, 8 `truncate`s, 113 inline error-message extractions, ~6 JSONL parse loops, 8+ status-chip implementations, 4 toast containers, twin file-autocompletes.

**Status-chip resolution.** The tone-coded status pill — full-radius, mono, `text-[0.7rem]`, `font-medium`, a border/background/text triple per status — is now the single `ui/StatusChip` primitive (span/button polymorphic, `neutral`/`cyan`/`amber`/`green`/`red`/`violet` tones, `wrap`/`icon` slots, `layoutClassName`-only geometry), consumed by `CompactionStatusChip`, the MCP/agent-capability panels' status and inheritance chips, the ticket active-session marker, and their containers. What the audit's "8+" count conflated with status pills is a set of **genuinely-distinct chip primitives** that share four base Tailwind tokens but are not tone-coded status pills, and are deliberately NOT folded onto `StatusChip` (per P2 "push variation to the edges" — absorbing them would force divergent geometry/interaction into one primitive): the graph **node-status badge** in `ExecutionContextNode` (`rounded-[20px]`, uppercase, 9 lifecycle variants keyed to `waitState.kind`, paired 1:1 with the progress-fill variant map — a node-embedded lifecycle badge, not a free-standing pill); the inspector **`BackendChip`/`GateChip`** in `workflow-config/InspectorChips` (`rounded-sm`, uppercase, catalog-tone-keyed, glyph-carrying); the interactive **MCP info button** (`McpInfoChip`, `data-[overrides]` hover-morph + count badge); the **branch selector** (`BranchChip`, max-width + copy affordance); the topbar **needs-attention nav anchor**; the **`aria-pressed` filter toggle** (`ConversationAutocompleteList`); the **blue interactive plugin link** (`AgentCapabilityPanel`'s `PLUGIN_CHIP`); and two **uppercase override-count badges** (`ConfigField`, `ConfigSubsection`). The `status-chip-pills` seam pins this population: `ui/StatusChip.tsx` is the file-level primitive exclusion; Markdown's numbered source-map overlay is a marked site-level non-status survivor whose file stays in the corpus; and the seven distinct chip primitives sit at a permanent-survivor floor of 7 so any new unmarked hand-authored status pill fails the ratchet.

### 1.9 Concrete bugs (fix independently of any refactor)

1. **Stale-cache hazard (HIGH; failing repro required):** five private `createStateManager()` instances never see the singleton's cache-version bumps. The cache design makes frozen capability-resolution reads credible, but the source audit did not run the production repro; Phase 0 must pin it red before calling the behavior confirmed.
2. `#`-autocomplete excludes project conversations (`cross-project-list.ts` walks only session conversations).
3. Lane branches hardcode `csm/` while sessions honor the configurable prefix.
4. Validator thread continuity resets on restart (in-memory `backendRefCache`).
5. Unshaped framework 500s: `withTracing` rethrows without producing an `ApiError` envelope.
6. Commit machine lacks merge's validation-timeout short-circuit (bug-in-waiting).
7. Message-queue `attemptCount` is uncapped (poison-message loop).
8. Codex runs have no startup sweep — an orphaned `running` row stays running forever and cancel is a silent no-op.
9. Doc bugs: steering points at the dead tier, at empty `api/sse.ts`, and at `@tanstack/react-virtual` (actual: react-virtuoso).

---

## Part 2 — Design principles for Command Center

These are the rules the target design and all future work are evaluated against. They extend (not replace) the existing engineering-principles steering.

**P1 — One owner per decision; a migration is done only when the old path is deleted.** Every design decision (how to resolve a route, classify an error, describe a backend, publish status, schedule a lane) lives in exactly one module. A seam PR is not complete until the superseded mechanism is deleted or its remaining call sites are captured in the ratchet (P6) with a named deletion condition. "Both paths work" is a failure state, not a transition state.

**P2 — Fewer, deeper modules; keep depth, reuse, and variation distinct.** Every module must hide a named design decision and pass the deletion test (removing it would respread complexity into its caller or callers, not just vanish). A **shared** module earns supported status through demonstrated production reuse, tests through the production seam, and an owner; otherwise keep it local or label it `experimental`/`migration-only`. A behavioral seam needs two real adapters; one adapter is a hypothetical seam and does not justify extraction "in case." A single-consumer module can still be deep when it concentrates substantial knowledge and improves locality. Do not force distinct semantics through a generic envelope that erases their types. "Primitive" is reserved for the lowest level; **composable module** is the scale-independent umbrella.

**P3 — Semantic operations over identity branching.** Outside `src/lib/agent-backends/` (and explicitly named product policy), `backend === "claude" | "codex"` is a defect. Callers ask an adapter to *perform an operation* (`fork`, `resumeOrRecover`, `applyRuntimeConfig`) and handle a normalized result (including `unsupported`); capabilities are data for *availability* decisions (UI affordances), operations are behavior. When a backend difference must be expressed, it is a declared capability field or a normalized result field (e.g. `continuationDisposition`), never an identity check.

**P4 — Seams enforce dependency direction.** Provider SDK types, native-ref interpretation, translators, and stale-classification knowledge point only downward into an adapter. No neutral interface names an implementation. No SDK import outside its adapter. Opaque raw provider bytes may cross only inside the lossless forensic transcript envelope; code above the seam must not interpret or branch on `entry.raw`. If that exception cannot be enforced, transcript persistence belongs behind the adapter. Enforced by lint and architecture tests (P6), not review.

**P5 — Variation at the edges.** The config cascade, discriminated validator types, `.provide()`, and the backend descriptor exist so the cores stay small. New workflow features are specified by what makes them different (a new actor, capability, context block) and composed from existing modules; if a feature can't be expressed as composition, that is a signal the abstraction is missing — surface it, don't inline it.

**P6 — Construction over convention.** Every load-bearing invariant gets a structural enforcement: exhaustive-`never` switches for enum extension, type-level omission (as `ui/` primitives do with `className`), lint seam rules, single write choke points with legality checks, and the seam ratchet (checked-in old-way counts CI refuses to let grow). A rule that lives only in a doc will be violated.

**P7 — One door per execution shape; don't unify different shapes.** Conversation-lifecycle execution and one-shot task execution are genuinely different contracts — keep both ports; never merge them. Same for the deterministic graph loop vs XState lifecycles: don't convert the graph engine to XState, don't grow a universal orchestrator or drift into a DSL by generalizing shared machinery. Different shapes get different, *deep* doors; identical shapes get exactly one.

**P8 — Truthful architecture.** Steering, the catalog, and CONTEXT.md describe what exists, with adoption status. Dead code is deleted, not documented. Parity tests exist to protect a contract during migration — a parity test that permanently pins two copies of the same code is a bug.

**P9 — Deterministic scaffolding first (existing agent-offloading principle).** Binary reproducible checks are code; validation of agent output is Zod + deterministic action; the orchestrator owns retries and bookkeeping. Pure policy functions (circuit breaker) beat orchestration ceremony (retry machines).

**P10 — What not to do (standing register).** Do not: merge `ConversationBackendRuntime` and `AgentTaskRunner`; convert the graph loop to XState; merge the commit and merge machine topologies (share fragments/actors instead); build a generic retry machine; unify the two collaboration envelopes (the duplication is a construction guarantee for the no-pause invariant); force a unified cross-backend message schema (the lossless transcript envelope is correct); generalize collaboration to N backends (name the pair as explicit config instead); split modules mechanically on line count; build an open-ended backend plugin framework (a curated static set is the product).

---

## Part 3 — Target design

### 3.1 The backend seam: one registered descriptor as the composition root

The strategic change: **one `AgentBackendDescriptor` per backend, registered atomically, is the single source of backend identity, metadata, capabilities, and operations.** Everything provider-specific lives behind it; everything above it speaks neutral vocabulary.

#### 3.1.1 Identity and the session ref (single Zod source)

```ts
// src/lib/shared/schemas.ts — AgentBackendId already lives here; hand-written duplicate deleted
export const agentBackendSchema = z.enum(["claude", "codex"]);
export type AgentBackendId = z.infer<typeof agentBackendSchema>;

export const agentSessionRefSchema = z.object({
  backend: agentBackendSchema,
  /** Opaque resume handle. Only the owning adapter interprets it. */
  ref: z.string().min(1),
});
export type AgentSessionRef = z.infer<typeof agentSessionRefSchema>;
```

The discriminated `sessionId`/`threadId` union is deleted. No neutral consumer does anything with the handle except display, store, and round-trip it; the ~20+ branch sites collapse to field access. Before implementation, inventory every table and JSON field that persists the union and pin round-trip tests at those storage seams. Do not bundle the ref rewrite with cascade-kind changes unless the migration design proves they share an atomic invariant.

**Migration safety is a pre-Phase-1 approval gate.** The current startup registrar logs an Umzug failure and continues; it must fail startup before actor rehydration, sweeps, or request handling. The rewrite and compatibility-version stamp are atomic where possible and idempotent on replay. Verification covers a worktree-scoped database, fresh and legacy databases, mid-migration failure/replay, older-build reopen behavior, and racing workers. The incompatible readers are older Command Center server/build processes sharing `CC_CONFIG_DIR`, not agent sessions. Before implementation, Alex chooses one rollout policy: (a) intentionally breaking cutover behind `KNOWN_SCHEMA_VERSION`, (b) bounded dual-read/new-write with a named deletion condition (backward compatibility requiring explicit approval), or (c) non-breaking additive/shadow or graceful-quarantine representation. **(2026-07-13) Selected: policy (a).** The on-disk shape is canonical `{backend, ref}`; migration 0005 first publishes the append-only compatibility barrier for version 1, then atomically rewrites legacy/superset rows to canonical and stamps `schema_migrations(version=1)`. `KNOWN_SCHEMA_VERSION` is 1, so a protocol-aware older build opening after publication is refused before constructing SQLite. The marker is not a connection-lifetime lease: every lower-version process already holding a connection must be quiesced for cutover. A scanner staged in a prior non-breaking release protects later opens only, and a pre-protocol binary must be prevented from reopening because it never reads the marker. The codec's legacy/superset arms survive only as transitional read-tolerance for a pre-cutover / dev DB the migration has not yet converged.

#### 3.1.2 The descriptor

```ts
// src/lib/agent-backends/descriptor.ts
export interface BackendModelInfo {
  id: string;
  label: string;
  description: string;
  effortLevels: readonly string[]; // empty = effort not applicable
}

export interface AgentBackendMetadata {
  label: string;                   // "Claude" / "Codex"
  toneToken: string;               // design-token name for UI chips (e.g. "backend-claude")
  skillTriggerPrefix: "/" | "$";
  models: readonly BackendModelInfo[];
  defaultModelId: string;
  defaultTimeoutMs: number | null;
}

export interface BackendConversationCapabilities {
  queue: QueueCapability;                                  // acceptsWhileRunning + deliveryTiming (existing)
  continuationStrength: "precise_session" | "synthetic_thread" | "none";
  fork: "native" | "synthetic" | "unsupported";
  structuredOutput: "backend_native" | "post_validation" | "unsupported";
  contextWindowMetrics: boolean;
  nativeMidTurnAskUser: boolean;
  externalTurns: boolean;                                  // background auto-continuation exists
  runtimeConfigApplyTiming: "live" | "next_turn";          // replaces the two backend-named apply methods' semantics
  capabilityKinds: readonly CapabilityKind[];              // "skills" | "plugins" | "agents" — replaces claude-*/codex-* cascade names
}

export interface AgentBackendConversationFacet {
  factory: ConversationBackendFactory;
  continuity: BackendContinuityAdapter;                    // §3.1.4
  runtimeConfig: BackendRuntimeConfigAdapter;              // §3.1.5
  capabilities: BackendConversationCapabilities;
}

export interface AgentBackendTaskFacet {
  runner: AgentTaskRunner;
  structuredOutput: "backend_native" | "post_validation" | "unsupported";
}

export interface AgentBackendDescriptor {
  id: AgentBackendId;
  metadata: AgentBackendMetadata;
  conversation?: AgentBackendConversationFacet;
  tasks?: AgentBackendTaskFacet;
  mcp: McpBackendCapabilities;                             // existing domain type, registered here
  errors: AgentFailureClassifier;
}
```

Registration (`registry-core.ts` extended): `registerBackend(descriptor)` requires at least one execution facet, validates completeness, rejects duplicate ids, and is the *only* registration call. Bootstrap is explicit and resettable in tests rather than depending on adapter import order. The existing `getConversationBackendFactory()`/`getTaskRunner()` delegate to descriptors only during the ratcheted migration and are deleted when their callers move. New: `getBackendDescriptor(id)`, `listBackends()`. The four existing capability systems converge: `backendCapabilities()`/`queueCapabilityForBackend()` become descriptor lookups; `BackendCapabilityView` (the workflow-layer projection) is *derived* from the descriptor by one function; the dead `ConversationBackendCapabilities` interface is deleted.

A **catalog route** (`src/lib/agent-backends/route-handlers.ts`, `GET /api/agent-backends`) serves `listBackends()` metadata + capability labels. `ModelSelector`, `BackendToggle`, `ComposerModeChip`, the four config pickers, and the skill-trigger logic render from a `useBackendCatalogQuery()` hook; every hardcoded `["claude","codex"]` array and label/tone map is deleted. `getDefaultModelForBackend`/`getEffortLevelsForBackend` become registry lookups; the three hand-copied model catalogs collapse to descriptor metadata. Unknown backend ids in config/commands fail Zod validation loudly (no silent coercion to Claude); new-session provisioning honors `defaultAgentBackend`. The on-disk `config.json` shape is unchanged (Decision D7).

#### 3.1.3 Neutral events; transcript ownership moves into the adapters

`provider_event` is deleted from `ConversationBackendEvent`. Adapters translate every native frame into neutral operational events before it crosses the seam. The only raw-data exception is the lossless forensic transcript envelope:

```ts
export type ConversationBackendEvent =
  | { type: "backend_init"; backendRef: AgentSessionRef }
  | { type: "content"; block: MessageContentBlock }
  | { type: "transcript_entry"; entry: AgentTranscriptEntry }   // lossless {seq, backend, type, raw} envelope (existing transcript.ts)
  | { type: "error"; message: string }
  | { type: "input_accepted" }
  | { type: "external_turn_started" }
  | { type: "external_turn_completed"; result: ConversationBackendTurnResult };
```

`processMessage` and the `SDKMessage` switch move into `agent-backends/claude/` (the fix direction already exists — `map-content-blocks.ts`); the actor and `external-turn-handler.ts` lose their Anthropic SDK imports and persist `transcript_entry` envelopes without interpreting or branching on `entry.raw`. Claude and Codex transcripts become symmetric: **adapters interpret, the actor records.** External turns become a declared capability (`externalTurns`) rather than an implicitly Claude-only feature. An architecture test forbids raw-payload interpretation above the adapter; if that cannot be enforced, the adapter owns transcript persistence instead.

#### 3.1.4 Continuity as an adapter-owned operation set

```ts
// src/lib/agent-backends/continuity.ts
export interface BackendContinuityAdapter {
  readonly backend: AgentBackendId;
  start(input: ContinuityStartInput): Promise<AgentSessionRef>;
  /** Cheap liveness/validity check for a persisted ref. */
  validate(ref: AgentSessionRef, input: ContinuityContext): Promise<
    { status: "valid" } | { status: "stale"; reason: string }>;
  /** Resume if possible, otherwise recover (new session seeded per backend policy). */
  resumeOrRecover(ref: AgentSessionRef, input: ContinuityContext): Promise<
    { ref: AgentSessionRef; recovered: boolean }>;
  fork(ref: AgentSessionRef, input: ForkInput): Promise<
    | { kind: "native"; ref: AgentSessionRef }
    | { kind: "synthetic_seed"; seed: string }
    | { kind: "unsupported" }>;
}
```

Consumers: `WorkflowAgentCaller`'s deps interface replaces its four provider-named methods (`createClaudeConversation`, `validateClaudeConversation`, `startCodexThread`, `resumeCodexThread`) with `descriptor.conversation.continuity`; `LaneState`/`LaneService` store the neutral `{backend, ref}` envelope plus *normalized optional* metrics (no provider-named metric branches); `conversations/service.ts` fork calls the same facet and handles the three normalized outcomes (the direct `forkSession` SDK import and the implicit native-vs-synthetic selection rule die). Each adapter rejects a ref whose `backend` does not match its own id. The Claude adapter's implementation composes the existing conversation-creation service via injected deps — CC-level bookkeeping stays above; SDK lifecycle lives below. No speculative `retire()` operation is introduced until a production caller exists.

Error classification gets one home:

```ts
// src/lib/agent-backends/errors.ts
export const agentFailureKindSchema = z.enum([
  "timeout", "aborted", "schema_validation", "stale_resume_ref",
  "session_died", "capability_unavailable", "backend_error",
]);
export const agentFailureClassificationSchema = z.object({
  kind: agentFailureKindSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export interface AgentFailureClassifier {
  classify(error: unknown): AgentFailureClassification;
}
```

`ConversationBackendTurnResult` replaces `error: string | null` with `failure: AgentFailureClassification | null` and gains `continuationDisposition: "retain" | "clear"` — the machine's `backend === "codex"` ref-retention branches become a read of the normalized result. `getLikelyStaleResumeFailureMessage`-style string grepping is deleted.

#### 3.1.5 Runtime capability config: one adapter-owned apply operation

```ts
export type RuntimeConfigApplyResult =
  | { status: "applied" }
  | { status: "deferred"; reason: "turn_active" }
  | { status: "rejected"; error: string };
```

```ts
// src/lib/agent-backends/runtime-config.ts
export interface BackendRuntimeConfigAdapter {
  readonly backend: AgentBackendId;
  /** Translate and apply below the seam; no provider payload escapes. */
  apply(input: {
    runtime: ConversationBackendRuntime;
    resolved: ResolvedCapabilityCascade;
  }): Promise<RuntimeConfigApplyResult>;
}
```

The per-backend translators (`claude-runtime-translator.ts`, `codex-runtime-translator.ts`) **move into their adapter directories** (`agent-backends/claude/runtime-config.ts`, `codex/runtime-config.ts`) — they are provider knowledge (Decision D9). `agent-capabilities/` keeps neutral cascade resolution and calls `descriptor.conversation.runtimeConfig.apply(...)`; its cascade taxonomy becomes `{ backend: AgentBackendId, kind: "skills" | "plugins" | "agents" }` validated against `capabilityKinds`. No `PreparedRuntimeConfig.payload: unknown` crosses the seam. If later constraints require a prepared token, its payload lives behind a private module/class/closure rather than a visible field or phantom brand. The twin apply ports in `default-deps.ts`, the `backend ===` checks in `apply-planner.ts`/`runtime-composer.ts`, and the timing branches collapse into reads of `runtimeConfigApplyTiming`. `mcp/runtime-apply.ts`'s undeclared `isTurnActive` cast is replaced by the declared apply result. This also removes `agent-backends`' imports from `agent-capabilities/` — dependency direction restored.

#### 3.1.6 Structured output: one policy module, backend-compatible projections

```ts
// src/lib/agent-backends/structured-output.ts
export function extractStructuredOutput(input: { native?: unknown; text: string | null }):
  | { ok: true; value: unknown; source: "native" | "raw_json" | "fenced" }
  | { ok: false; error: string };
export function validateStructuredOutput<T>(schema: z.ZodType<T>, input: ...): ...;
```

Zod remains the authoritative post-parse acceptance schema. Model-facing wire projection is backend-owned because Claude's native structured-output path cannot steer `minLength`, `maxLength`, `minItems`, `maxItems`, numeric ranges, or `pattern`; raw `z.toJSONSchema` would reintroduce a documented failure mode. Claude projections omit unsupported keywords and orchestrator-owned fields while preserving supported types, enums, descriptions, required fields, and `additionalProperties`; Codex may use a different projection. Recursive guardrail tests reject unsupported keywords on every Claude-bound schema, and parity tests prove the projected shape retains the intended contract.

The AgentCall structured-output gate consumes the shared extraction/validation module; collaboration's two-pass repair remains a facade option keyed off the `structuredOutput` capability. Migrated onto shared extraction and post-parse validation: the validator's 4-path chain and its `skipStructuredOutputGate` escape hatch, `sessions/conflict-resolution.ts`'s copy, `codex-output`'s prompt-wrapper parser (agent-runs keeps only the native `outputSchema` path plus the shared extraction fallback), and chat-spawning's named fence. Collaboration's existing projections remain until backend-compatible generated projections prove parity. The completion target is **duplicate schema knowledge to zero while preserving backend-compatible projections**, not hand-written schema literals to zero at any cost.

#### 3.1.7 Enforcement: conformance suite + seam lint + locality test

- **Conformance suite** (`src/lib/agent-backends/conformance.ts`, test-only): `describeBackendConformance(descriptor)` asserts id agreement, model catalog validity + default presence, capability completeness, ref round-trip and mismatched-ref rejection, normalized failure classification, cancellation, explicit `unsupported` outcomes, and capability-data ↔ operation-behavior coherence (for example, declared fork support matches `continuity.fork()`). Runs against Claude, Codex, and a parameterized test descriptor.
- **ESLint seam rule:** outside `src/lib/agent-backends/`, imports from `agent-backends/{claude,codex}/**`, `@anthropic-ai/claude-agent-sdk`, and the Codex SDK are errors; current offenders are allowlisted in a burn-down file the ratchet shrinks.
- **Third-backend locality test:** the production backend id schema remains intentionally closed. A parameterized test registry may register a test-only id to prove that execution consumers depend only on the descriptor interface. Production acceptance for a new supported backend is: edit the canonical id schema, add its descriptor/adapters and bootstrap registration, and make **zero edits** to `AgentCall`, machines, lane modules, transcript consumers, MCP apply, or orchestration. The test measures consumer locality without claiming an open-ended plugin registry.

### 3.2 The workflow execution layer: two deep doors, one owner each for scheduling, continuity, and gates

#### 3.2.1 Deepen AgentCall until nothing smuggles around it

`AgentCallResult` widens so its two biggest consumers stop needing raw results: the `completed` outcome gains `numTurns?`, `contentBlocks?: MessageContentBlock[]`, and `parse?: { source: "native" | "raw_json" | "fenced" }`; `normalizedAgentCallFailureKindSchema` extends with `stale_resume_ref` and `session_died` (fed by `descriptor.errors.classify`); the result carries `continuationDisposition`. The facade absorbs, in order: backend/runner resolution via the registry (callers pass semantic intent, not resolver callbacks), MCP apply, continuity recording, and error normalization — completing the pre-turn pipeline ownership the target doc assigned it. The actor's `Proxy` becomes a named `withRuntimeReplacementRetry(runtime, deps)` wrapper (classify → replace runtime → single reattempt) built on the same descriptor classifier; the validator's `skipStructuredOutputGate` is deleted.

#### 3.2.2 Scheduling has exactly one owner

`LaneScheduler` is acquired in exactly one place: inside `WorkflowAgentCaller`. Collaboration's outer scheduling (`helpers.ts`) and the production no-op inner scheduler are deleted. The `writeCapability` default is declared once in `agent-call-vocabulary.ts` (`DEFAULT_LANE_WRITE_CAPABILITY`) and imported everywhere else.

#### 3.2.3 Graph lanes finish the Lane migration; the legacy service dies

Graph implementer/validator continuity moves onto `WorkflowAgentCaller` + `LaneService` backed by a **durable** `GraphLaneStore` adapter that reads/writes lane state through the execution repository in place (replacing the copy-in/copy-out in-memory projection). This deletes `workflow-continuity-service.ts` (~1,100 LOC), `graph-workflow-lane-adapter.ts`'s round-trip, and the validator's restart-losing `backendRefCache` (bug §1.9.4 fixed by construction). Lane branch naming uses `resolveBranchPrefix` (bug §1.9.3).

#### 3.2.4 Gates: adopt-or-delete

`scriptValidationGateFromOutcome` is adopted at its two real consumers (graph script-validator remediation and merge validation outcomes), killing the duplicated `ScriptValidationOutcome` union. `ask-user-gate`, `change-set-gate`, and `convergence-gate` are deleted with their tests (re-extract only when a second production consumer exists). The deep gates (graph approval, user-input, circuit-breaker, context-limit decision fn, structured-output) are untouched.

#### 3.2.5 The actor decomposes by knowledge

`executePromptForMachine` becomes a named pipeline: pre-turn steps (`resolve-model-effort`, `document-feedback`, `image-persistence`, `capability-cascade`, `alignment-gate`, `notices-drain`, `fork-seed`, `abort-wiring`) and post-turn steps (`queued-delivery-accounting`, `focus-memory`, `failure-fallback`) as individually-tested modules under `conversation/pre-turn/` and `conversation/post-turn/`; MCP apply and continuity recording move down into the facade (§3.2.1). The 40-method `ActorImplementationDeps` splits into narrow method-syntax port groups (`TurnExecutionDeps`, `TranscriptDeps`, `CapabilityDeps`, `QueueDeliveryDeps`, `DebugDeps`); the `as unknown as` cast dies.

#### 3.2.6 `codex-runs` becomes `agent-runs`

The domain renames to `src/lib/agent-runs/` with a `backend: AgentBackendId` parameter (executor already generic); routes move to `/api/agent-runs/*`. Retaining `cctl codex` as UX sugar is backward compatibility and remains an explicit Alex approval gate; absent approval, the generic command replaces it. Terminal vocabulary aligns with `BackgroundJob`'s (one data migration for existing rows). The double structured-output path drops (§3.1.6). A startup sweep adopting jobs' `recoverStaleJobs` pattern fixes bug §1.9.8. One shared abort-handle registry (`src/lib/shared/abort-registry.ts`, keyed by scope: `conversation:*`, `agent-run:*`, `workflow:*`) replaces the three ad-hoc registries. Full four-way lifecycle unification onto WorkflowEnvelope is explicitly deferred (Decision D15).

### 3.3 The XState layer: delete the fiction, share the fragments, single-owner the transitions

1. **Delete the dead and catalog-only tier** — root `setup.ts`, `actions.ts`, `persistence.ts`, `runtime-state.ts`, the catalog-only `optimistic/` XState machine (keep `shared/optimistic.ts`), and catalog-only `retry-machine.ts`. Remove the latter two from `machine-specs.ts`, `MachineId`, the runtime id set, route/static-param generation, metadata, and navigation. Preserve or retarget the section-6-3 wire/dispatch assertions under an accurate contract-test name. Rewrite the workflow steering file around what exists: the conversation-actor spine, `conversation/{persistence,runtime-state}.ts` as the real patterns, and `primitives/`. Fix the catalog page ("the 3 XState machines").
2. **Extract the validation-fix loop once.** `src/lib/workflows/validation-fix/{states,actors}.ts`: `createValidationFixStates({ validateInput, onValidated, onTimeout, maxFixAttempts, commitFixMessage })` returns the 5-state validate → fix → check → commit-fix → revalidate fragment (sibling of `createTerminalStates`); the four shared actors move here from `merge/actors.ts` under a neutral logger. Commit and merge consume the fragment; **commit gains the timeout short-circuit as a side effect** (failing test first). The two machine topologies stay separate (P10).
3. **Unify machine hosting.** `jobs/machine-host.ts`: one generic `createJobActorSubscription<TOutput>(actor, jobId, { phaseOf, mapOutput })` and one `dispatchMachineJob({ jobType, machine, buildInput, mapOutput })` replace the five copies; `graph-merge-runner.ts` reuses the subscription helper. `onTerminal` is deleted from both machines and steering (dead in practice everywhere). The "jobs are ephemeral, non-restart-durable" decision is made explicit in `jobs/queue.ts`'s header and steering (Decision D12).
4. **Evict debug from the conversation machine** via the existing `debug-adapter.ts` seam into an attached workflow module (`src/lib/workflows/debug/`), pinned by the section-6-2 parity suite. Then resolve finality: the machine is long-lived by design — **delete** the unreachable `output` block, `ConversationOutput`, and the manager's terminal-flush subscriptions (Decision D11). Deduplicate the triplicated `SUBMIT_PROMPT` claim transition; delete dead events/guards/fields (`RESOURCES_*`, merge's `ABORT`/`isMergeEntry`/`casRetriesRemaining`/dead context fields).
5. **Split `manager.ts` by knowledge:** actor registry + `.provide()` stays; the queue-drain engine moves to the conversations domain; rehydration policy to `conversation/rehydration.ts`; project-conversation notification policy to `project-conversations/`. Drop the byte-equivalent re-provided wrappers.
6. **Single transition owners where machines aren't warranted:** `workflow-graph/context-transitions.ts` exposes `transitionContextStatus(draft, contextId, next, meta)` with a legality table; it owns `machineSnapshot` upkeep via one `buildLifecycleSnapshot` (absorbing the four private copies) and absorbs the join/mergeStatus writers; all 9 context-status writer modules route through it. Dev-server `liveness.ts`/`reconciliation.ts` route through the existing `registry.transitionTo`. Graph execution-level status stays hand-rolled (post-RCA it is already single-owner + fenced; P10).
7. **Retry consolidation:** delete the dead machine; merge the lock-poll twins into `src/lib/shared/lock-retry.ts`; cap message-queue `attemptCount` (policy constant + refusal reason). The three stale-backend stacks converge per §3.2.1/§3.2.3.

### 3.4 Cross-cutting completion (the adopt-or-delete waves)

- **SSE publication + lifecycle StatusBus:** introduce one typed SSE publication module for every `SSEEvent`, owning tracing and the broadcaster adapter; route `broadcastEvent` through that publication interface while retaining its best-effort mutation policy. StatusBus becomes a projection for explicitly supported lifecycle events only—no fallback that manufactures `conversation / unknown / running` for unrelated events. Convert direct `broadcaster` importers and lint-forbid the raw transport outside the publication module and SSE transport.
- **Route resolution + errors:** delete the three same-name local `resolveProjectOr404` clones (the type system then forces convergence); convert the ~40 hand-rolled ladders domain-by-domain; consolidate the 9 `jsonError`s into the shared module; `withTracing` catches and shapes 500s as `ApiError` envelopes with an optional per-domain error mapper (bug §1.9.5).
- **Client data:** implement `addSseListener(es, type, schema, handler)` in the (currently empty) `src/lib/api/sse.ts` and split `NotificationListener`'s 43 inline blocks into domain-owned reaction modules (one transport, one assembly point); promote sessions' optimistic helpers to `src/lib/api/optimistic.ts` (`createOptimisticMutation`, retiring ~30 of 38 hand-rolls); unify the duplicated prompt-stream SSE parsing into one client transport module.
- **Schemas:** move `GraphWorkflow*` schemas to `workflow-graph/schemas.ts` (mechanical import rewrite across ~59 files); partition the remaining `workflows/schemas.ts` by knowledge (definition/config, runtime execution, events, live edits, collaboration protocol) with no wire changes.
- **State-store:** delete the `createStateManager` alias and repoint the 5 private-instance modules at the singleton (bug §1.9.1), lint-restrict `createStateStore` construction to `state-store/` + tests; converge the six domain repos on the standalone-factory idiom; evict notifications' broadcast/web-push side effects from repo writes into its service; replace jobs' hand-written `INSERT INTO notifications` with the notifications repo; add the missing `project-conversations` durability contract; delete dead `writeState`/`updateSession`.
- **Scoped-cascade substrate:** extract `src/lib/shared/scoped-config-store.ts` from the agent-capabilities implementation (the one with the serialized write tail + preconditions — it already proved why) and re-base MCP's stores on it; domain semantics stay in their domains.
- **Canonical representations:** one conversation builder (`conversations/build-conversation.ts`) with scope-specific policy consumed by all 5 construction sites; one transcript logical-units module consumed by read/render/fork; repos return domain projections (kill the snake_case row leak).
- **UI:** sweep the seam-script-defined `data-tooltip` population onto `ui/Tooltip`; ship the unstyled/edge-anchored `DialogContent`/`PopoverContent` variant and burn down the 12 bespoke overlays; promote the cross-feature violators (`PromptComposer` stack, `ConversationSidebar`, `DiffPanel`, `use-user-input-gate`) to `src/components/`/`src/hooks/`; move `_root/spawn-card` into project-detail; split `session-detail.store` along its visible seams; reorganize the session-workspace prop-bag hooks into knowledge-owning slices; one `StatusChip`, one toast host; merge the twin file-autocompletes; replace `ConfigToggle` with `ui/Switch`.
- **Micro-primitives** (`src/lib/shared/`): `keyed-mutex`, `atomic-write-json`, `sleep`, `format-relative-time`, `truncate`, one `getErrorMessage`, `createVersionedRowCache`; adopt `assertNever`; one JSONL reader.
- **CLI:** registry-driven `dispatchGroup` (deletes the COVERAGE mirror + hand-listed verb strings); promote `instruction` into the shared envelope renderer; shared 404→exit-2 helper; generate SKILL.md's command reference from the registry.

### 3.5 The enforcement layer (what makes completion stick)

1. **Seam ratchet** — `scripts/seam-adoption.ts` + `bun run seams:check` (CI gate), modeled on the CSS migration ratchet. The script defines each seam's exact corpus, syntax patterns, exclusions, justified allowlist, and explicit reviewed ceiling, then generates matching per-seam ceilings in `scripts/seam-baselines.json`; baseline generation refuses to write any observed count that differs from the reviewed catalog, so regenerating a file cannot approve new debt. Tracked seams: direct `broadcaster` imports; backend-identity branches outside `agent-backends/`; deep `agent-backends/{claude,codex}` imports outside the seam; hand-rolled route 404 ladders; `data-tooltip` attributes; hand-rolled `role="dialog"` overlays outside `ui/Dialog`+`ui/Popover`; hand-authored status pills reproducing the `ui/StatusChip` base geometry (permanent-survivor floor of genuinely-distinct chip primitives, see §1.8); internal `vi.mock` calls; `createStateManager`/`createStateStore` call sites; duplicate structured-output projection literals; and hardcoded backend enumeration in UI code. CI requires the generated baseline, reviewed catalog, and observed population to agree exactly. Steering rule: *a seam PR is not done until the superseded mechanism is deleted or ratcheted with a deletion condition.*
2. **ESLint seam rules** — the backend rule (§3.1.7); no raw `events/broadcaster` outside sanctioned publication/transport modules; the cross-feature-import rule as lint (not just steering); `createStateStore` restriction.
3. **Architecture tests** — backend conformance; parameterized consumer-locality; raw transcript payload non-interpretation; backend-compatible structured-output projection; and existing section-parity suites retained through the debug eviction and lane migration, then retired only when they no longer protect a live contract.
4. **Truthful steering** — rewrite `workflows.md` (real machine patterns, adoption matrix per shared concept: canonical module, consumers, status `supported | experimental | migration-only`, competing path, deletion condition); update `engineering-principles.md`'s primitive list to the real one (AgentCall, Lane, SSE publication, StatusBus, ArtifactRegistry, WorkflowEnvelope, gates); adopt "composable modules" as the umbrella term; replace the ~600-line split rule with the depth/locality test; fix `tech.md`/`structure.md` factual errors; expand `CONTEXT.md` with the domain ownership map as decisions stabilize.
5. **Durable decisions (non-gating follow-up)** — the decision log is sufficient for this program. If the repository adopts `docs/adr/`, promote only choices a future review would otherwise re-litigate: graph execution remaining non-XState, the long-lived non-final conversation actor, ephemeral machine jobs, the closed backend registry, and the approved migration compatibility policy. ADR creation does not gate Phase 1.

### 3.6 Pre-Phase-1 approval gates

Phase 1 implementation does not begin until these five bounded blockers are resolved in the reviewed slice designs and their acceptance tests are specified. The implementation steps themselves remain in their owning phases:

1. Backend-compatible structured-output projection replaces raw `z.toJSONSchema` (§3.1.6).
2. Migrations fail startup and the ref rollout policy is explicitly approved (§3.1.1).
3. Descriptor facets are truthful and runtime-config payloads stay below the adapter seam (§3.1.2/§3.1.5).
4. The closed-registry locality criterion measures zero execution-consumer edits (§3.1.7).
5. Typed SSE publication is separated from lifecycle StatusBus projection (§3.4).

### 3.7 Correctness-contract amendment (2026-07-14)

The completed implementation review confirmed the target Modules and seams, but found five places where their interfaces did not state enough of the correctness contract. These rules deepen the existing Modules; they do not introduce parallel abstractions or reopen the program's core direction.

#### 3.7.1 Conversation lifecycle: domain completion, not machine topology

The conversation lifecycle Module owns prompt submission, turn completion, result projection, and attached-workflow cancellation. Its external interface must not expose `ConversationActorRef`, raw XState events, `snapshot.value`, state names, or state matching. A caller submits a domain turn and awaits a domain result; the Module decides which internal state is a between-turn settlement point. `idle`, user-input parking, and debug parking are implementation details behind the same completion guarantee.

Every asynchronous operation that can outlive an attached workflow state carries a lifecycle generation plus an attempt number. Results are accepted only when both match the current workflow instance. Leaving that instance aborts outstanding work through `AbortSignal`; generation validation remains the correctness backstop when cancellation races completion. An active persisted debug state without a generation is normalized and persisted at lifecycle activation so the runtime contract never admits an uncorrelated verifier. This applies to debug cleanup verification and is the template for future attached workflows.

Acceptance is through the lifecycle interface: a debug turn settles and closes its prompt stream without exposing a state name; a verifier result from an exited debug generation cannot mutate a re-entered generation; obsolete verification receives an abort signal.

#### 3.7.2 Continuation: failure evidence determines disposition

`continuationDisposition` remains the neutral result field, with the invariant `clear => backendRef === null`. The adapter that observed the provider outcome owns the decision; callers and the conversation machine only apply it. `ContinuationStrength` may describe the normal continuation mechanism, but it is not sufficient failure policy.

The required matrix is:

- `stale_resume_ref` always clears, for every adapter;
- a graceful provider turn failure that does not invalidate an established continuation retains it;
- a process/transport failure clears only when the adapter has evidence that the continuation cannot be resumed under that provider's semantics;
- abort retains the last known viable continuation unless the adapter observed invalidation.

Tests pin the matrix independently for Claude and Codex and then drive the normalized result through the real conversation persistence seam. Updating a test to accept changed ref behavior is not parity evidence unless the design matrix changed first.

#### 3.7.3 Task execution: semantic policy profiles

`AgentTaskRunner` remains separate from conversation runtimes, but its request gains a neutral semantic execution policy owned by the task Module. Callers select an intent; adapters translate it into provider controls. Provider option names do not cross the seam.

The first required non-default profile is `isolated-one-shot`: exactly one agent turn, no tools, no MCP servers, no user/project/local settings or hooks, and no persisted provider continuation. Session-name generation uses this profile. An adapter either guarantees the entire contract or returns a typed unsupported result before provider invocation; a best-effort subset must not claim support. The default profile preserves existing general task-run behavior. Adapter tests capture either the actual provider invocation or the zero-provider-call unsupported result so an omitted translation cannot silently widen privileges or side effects.

#### 3.7.4 Persistence: preflight, atomic cutover, and linearization

The state-store Module owns compatibility, transaction, and durability decisions end to end:

1. Every breaking version publishes an append-only, version-specific compatibility barrier in the database directory before its SQLite cutover. Protocol-aware open scans those barrier names before constructing a SQLite connection; a future barrier is therefore refused without opening, checkpointing, creating, or removing the database, WAL, SHM, or adjacent files. No barrier is version `0`. The SQLite `schema_migrations` ledger remains a defense-in-depth check for legacy/unmarked databases and is rechecked under each mutation's write lock before persistent startup pragmas, schema work, or data migration. The marker is not a connection-lifetime lease: every lower-version process already holding a connection must be quiesced for cutover. A staged scanner protects only later opens, and pre-protocol binaries must be prevented from reopening.
2. A breaking representation rewrite and its SQLite compatibility-version stamp are one atomic `BEGIN IMMEDIATE` transaction. Either every incompatible database byte and the stamp commit, or neither does. The external barrier deliberately precedes that transaction and is fail-closed: if the database transaction rolls back, current builds retry while protocol-aware older readers remain excluded. Umzug's applied-migration ledger remains the replayable post-`up` record.
3. A migration that probes then changes schema acquires its write lock before the first probe and rechecks under that lock. Idempotence alone does not make an unlocked check-then-act sequence safe across workers.
4. Conditional repository claims linearize side effects: only the worker whose guarded write reports `changes === 1` may publish or persist the corresponding notification.
5. `atomicWriteFile` completes every byte before fsync/rename. After rename it fsyncs the target parent, every recursively created ancestor, and the nearest pre-existing parent in bottom-up order. Only explicitly classified platform "directory fsync unsupported" errors may be tolerated; generic I/O failures at any level propagate.
6. A migration with an irreversible filesystem effect uses a durable capture witness before its irreversible delete. Under one `BEGIN IMMEDIATE` critical section, the legacy-workflow purge renames the live workflow directory beneath a permanent quarantine sentinel, fsyncs destination and source parents, then resets SQLite state and commits pending plus completion markers together. Cleanup removes only captured children after commit and remains retryable. A crash after capture but before SQL commit leaves the sentinel, so retry cannot reinterpret a newly-created live `workflows/` directory as legacy data.

Fault-injection and two-connection tests are part of the interface test surface: byte/hash-identical DB/WAL/SHM sidecars after future-version refusal, a future ledger winner between the first read and locked recheck with no persistent journal-mode mutation by the loser, rollback between every cutover stage, protocol-aware already-open worker rechecks, concurrent migration workers, failure before and after durable filesystem capture, concurrent missing-source finalizers, partial writes, ancestor/directory-fsync `EIO`, and competing stale-job sweepers.

#### 3.7.5 Lifecycle projection: authoritative scope ownership

The lifecycle projection Module may project only events authoritative for the scope it reports. `graph-workflow-status` owns execution-level lifecycle. Context and task events must either use distinct context/task scopes and identifiers or remain wire-only point events; they must never overwrite an execution's lifecycle under `executionId`. Every paused and terminal vocabulary value is classified explicitly—no default-to-running branch for a known status.

#### 3.7.6 Graph validation identity: semantic ownership, not provider handles

Graph lane state and validation events use one provider-neutral session envelope: `{backend, ref, lane, refKind, workflowConversationId?}`. `refKind` declares who owns `ref`. A conversation-owned validator uses the stable Command Center conversation id for both `ref` and `workflowConversationId`; rotation of the provider SDK's private session handle does not change validation identity. A backend-owned task validator uses its opaque backend continuation handle for `ref` and omits `workflowConversationId`. A cleared continuation publishes no session ref.

Review artifacts follow the same ownership rule: `{backend, kind:"conversation", ref}` points to the Command Center conversation, while `{backend, kind:"response", ref, response, usage}` points to the backend-owned response thread. The validator runner constructs these semantic values where the execution strategy is known. Event publication preserves them and must not reconstruct ownership from provider identity or mutable lane state. Legacy provider-shaped payloads normalize only at schema boundaries; UI continuity keys use `workflowConversationId ?? ref` and navigation uses only the explicit conversation id.

#### 3.7.7 Completion impact

Program completion additionally requires these correctness contracts to be green at their public interfaces. A seam ratchet may retain an approved policy floor under D21, but a test that deliberately pins a failed test-backend traversal, a misclassified backend, or another known-broken behavior is not a survivor floor; it is unfinished migration work.

---

## Part 4 — Program implementation roadmap

The roadmap is authoritative at the program-architecture level after §3.6 is resolved. It supplies sequencing and completion constraints; detailed work-item planning remains outside this consolidated document.

### Ground rules

- **TDD throughout:** every behavior change starts with a failing test at the production seam. Refactors that must not change behavior are pinned first (parity/contract test at the external interface), then executed, then the pin is kept or retired per its deletion condition.
- **Definition of done per work item:** new path live in all production consumers → old path deleted (or ratcheted with a written deletion condition) → steering/docs updated → gates green (`bun run typecheck && bun run lint && bun run test && bun run build` + `seams:check` once it exists).
- **Strictly better or ratcheted:** every merged slice deletes an old mechanism or records its exact remaining population and deletion condition. Introducing a descriptor while leaving an unbounded third path is not a valid stopping point.
- **DB safety:** all live verification uses a worktree-scoped dev DB. Breaking migrations additionally satisfy §3.1.1's fail-fast, replay, reader-compatibility, and approved-rollout requirements before touching the shared `command-center.db`.
- **Ordering:** Phase 0 first. Phase 2 can proceed independently. Phase 1 begins only after §3.6. Phase 3 depends on Phase 1 and coordinates its actor changes with Phase 2.3's conversation-machine diet. Phase 4 is a set of dependency-aware waves: schema partitioning coordinates with the ref migration and Phase 3 workflow consumers; state-store work follows migration safety and coordinates with durable graph lanes; UI backend-catalog work follows descriptor delivery; publication adoption follows the SSE/StatusBus decision. Phase 5 remains independently schedulable after Phase 0 except where a listed item consumes a Phase 1–4 module.
- Anything not listed in a phase is intentionally out of scope (see Decision log, especially D15 and P10's standing register).

### Phase 0 — Safety infrastructure, red-test bug fixes, and deletion-only cleanup

**0.1 Bug fixes (each: failing repro test → fix).**
a. Pin the private-store stale-read repro first; then delete the `createStateManager` alias, repoint `agent-capabilities/{route-defaults,default-deps,scope-store}.ts` and `mcp/{default-deps,scope-store}.ts` at the singleton, and lint-restrict `createStateStore`.
b. `#`-autocomplete: include project conversations in `conversations/cross-project-list.ts`.
c. `parallel-worktrees.ts`: use `resolveBranchPrefix` instead of hardcoded `csm/`.
d. `withTracing`: catch → shaped `ApiError` 500 envelope, optional per-domain mapper.
e. Message-queue `attemptCount` cap (policy constant + refusal reason).
f. Codex-runs startup sweep (port jobs' `recoverStaleJobs`).
(Validator-ref durability — §1.9.4 — is fixed structurally in 3.2; no interim patch.)

**0.2 Dead/catalog-only deletion (per Appendix B, first tranche):** root workflow tier; catalog-only `optimistic/` and `retry-machine.ts` plus their complete catalog/type/route metadata; the three unconsumed gates (`script-validation-gate` survives for adoption in 3.4); `ConversationBackendCapabilities` dead fields registry-wide check deferred to 1.2; `ui/Tooltip` **stays** (it gets consumers in Phase 5); and dead hooks/exports (`useRenameProjectConversation`, `useProjectOpenCountQuery`, `use-long-press`, `writeState`/`updateSession`, conversations.store dead delete state, `ArtifactWriteRequest.required`). Preserve/retarget the section-6-3 wire-contract assertions. `RESOURCES_*` remains in Phase 2.3, where its machine surface is removed once.

**0.3 Steering rewrite:** `workflows.md` (real patterns + adoption matrix), `engineering-principles.md` primitive list, `tech.md` (react-virtuoso, sse.ts), `structure.md` (depth/locality test replaces the line rule), vocabulary switch to "composable modules."

**0.4 Enforcement scaffolding:** `scripts/seam-adoption.ts` + script-generated baselines + equal-to-observed CI gate; ESLint seam rules (backend allowlist, SSE publication, cross-feature, `createStateStore`); wire into `bun run lint`/CI.

**0.5 Migration startup safety:** change startup migration failure from log-and-continue to fatal; add failure/replay and racing-worker coverage before any Phase 1 data rewrite.

*Exit criteria:* all six bug repro tests green; deleted machines have zero references including catalog/type/route metadata; retained section-6-3 contract coverage is green; startup aborts on migration failure; `seams:check` runs in CI with generated baselines equal to observed counts; steering contains no claim contradicted by code.

### Phase 1 — Backend seam: descriptor + seam sealing (starts after §3.6)

**1.1 Single Zod sources + ref collapse.**
Keep the existing canonical `AgentBackendId` in `shared/schemas.ts`, delete its hand-written duplicate, and move/collapse `AgentSessionRef` as §3.1.1; mechanical call-site migration (~20+ branch sites become field access). Inventory every persisted ref occurrence and extend the round-trip durability contracts first. Implement only the explicitly approved rollout policy, with its migration/replay/older-reader/racing-worker tests. Cascade-kind migration is a separate work item unless one transaction is proven necessary for a shared invariant.

**1.2 Descriptor + registry + catalog.**
Add facet-shaped `descriptor.ts`, `registerBackend`, `getBackendDescriptor`, `listBackends`, and explicit/resettable bootstrap; register Claude + Codex descriptors composing the existing factories/runners; require at least one execution facet. Delegate existing getters only as a ratcheted migration path and delete them when callers move. Derive `BackendCapabilityView` + `QueueCapability` lookups from descriptors; delete `capabilities-descriptor.ts`'s switches and the dead `ConversationBackendCapabilities`. Add the conformance suite (capability ↔ behavior coherence, mismatch rejection) and run it for both backends plus the parameterized consumer-locality descriptor. Catalog route + `useBackendCatalogQuery`; migrate `ModelSelector`, `BackendToggle`, `ComposerModeChip`, `MobilePromptToolbar`, the 4 config pickers, skill-trigger prefixes, `getDefaultModelForBackend`/`getEffortLevelsForBackend`, `config-helpers.ts`; delete every hardcoded backend array/label map; fail loudly on unknown ids; provisioning honors `defaultAgentBackend`.

**1.3 Neutral runtime config apply.**
Introduce the adapter-owned apply operation + `runtimeConfigApplyTiming`; move translators into adapter dirs; no provider payload crosses the seam. Migrate `default-deps.ts` twin ports, `apply-planner.ts`, `runtime-composer.ts`, `apply/cascade.ts`, `mcp/runtime-apply.ts` (kill the `isTurnActive` cast); generalize cascade taxonomy to `{backend, kind}`. Delete the backend-named methods/fields and `agent-backends`' imports from `agent-capabilities`.

**1.4 Neutral events + transcript symmetry.**
Move `processMessage` + SDK-type handling into `agent-backends/claude/`; runtime emits `content`/`transcript_entry`/`external_turn_*`; delete `provider_event`; actor + `external-turn-handler.ts` lose SDK imports and persist envelopes without interpreting `entry.raw`; `externalTurns` capability declared. *Pin first:* transcript-format contract tests on existing JSONL output (byte-stable frames) plus the no-raw-interpretation architecture test, then migrate.

**1.5 Failure classification + continuation disposition.**
Add `errors.ts`; each descriptor's top-level classifier normalizes failures for both execution facets; turn results carry `failure` + `continuationDisposition`; conversation machine's two `backend === "codex"` completion branches become disposition reads; delete string-grep staleness helpers.

**1.6 Continuity adapter (seam only).**
Add `BackendContinuityAdapter` + Claude/Codex implementations inside the conversation facets (fork included: native for Claude, synthetic-seed for Codex); `conversations/service.ts` fork migrates to `continuity.fork()` (SDK import deleted); `generateSessionName` migrates to `AgentTaskRunner`; `portable-mcp-filter`'s Claude-typed vocabulary gets a neutral home in the backend seam. No `retire()` operation until a production caller exists. (Workflow consumers migrate in Phase 3.)

**1.7 Structured-output module** per §3.1.6: implement shared extraction/post-parse validation and backend-compatible projection guardrails; migrate the facade gate. Downstream consumers (validator chain, conflict-resolution copy, codex-output, chat-spawn fence) migrate in Phase 3 where touched. Collaboration projections remain until generated backend-specific projections prove parity. Ratchet duplicate schema knowledge, not every hand-authored compatibility projection, to zero.

**1.8 Locality proof.** Parameterized test-only descriptor + conformance run + the zero-execution-consumer-edits locality test. The production acceptance contract permits only the canonical id schema, descriptor/adapters, and bootstrap registration to change.

*Exit criteria:* conformance suite green for Claude, Codex, and the parameterized test descriptor; no SDK/provider-deep imports outside `agent-backends/` except the explicit shrinking allowlist; the generated backend-identity ceiling equals the observed in-scope count and every survivor has a justification/deletion condition; UI renders backends/models exclusively from the catalog; the approved ref rollout and recovery paths are tested; consumer-locality test green.

### Phase 2 — XState layer consolidation (the machine focus area; parallel with Phase 1)

**2.1 Validation-fix fragment.** Failing test first: commit machine pins the timeout short-circuit behavior (currently absent — red). Extract `workflows/validation-fix/{states,actors}.ts`; consume from merge (parity-pinned) then commit (test goes green); delete the duplicated states/guards; move actors off the `smart-merge-actors` logger.

**2.2 Machine hosting.** Extract `jobs/machine-host.ts` (generic subscriber + dispatch harness) pinned by existing queue tests; migrate the five copies + `graph-merge-runner.ts`'s observer; delete `onTerminal` from merge/commit types, `queue.ts` stubs, and steering; document the jobs-ephemeral decision in the queue header.

**2.3 Conversation machine diet.** Evict debug into `workflows/debug/` behind `debug-adapter.ts` (section-6-2 parity suite pins externals); delete the dead output/terminal-flush path, `RESOURCES_*` (single scheduled deletion owner), triplicated claim transition (single named transition helper), merge's dead surface; split `manager.ts` by knowledge (queue-drain → conversations domain, rehydration → own module, notification policy → project-conversations); drop byte-equivalent re-provided wrappers.

**2.4 Single transition owners.** `transitionContextStatus` + `buildLifecycleSnapshot` in the graph engine (legality-table unit tests first; then route all 9 writers; delete the 4 snapshot builders); dev-server liveness/reconciliation through `registry.transitionTo` (delete the duplicated broadcast logic).

**2.5 Retry/lock cleanup.** `shared/lock-retry.ts` replaces the twins; inline `sleep`s onto the shared helper as touched.

*Exit criteria:* commit inherits the timeout guard (test green); one subscriber + one dispatcher host all machine jobs; conversation machine ≤ ~9 states / ~12 events with debug external and parity green; zero direct context-status writes outside the transition function (grep-asserted in a test); catalog page truthful.

### Phase 3 — Workflow execution layer: one door per shape (depends on Phases 1–2)

**3.1 Deepen AgentCall.** Widen the result (numTurns, contentBlocks, parse metadata, disposition, extended failureKind — additive, test-first); facade absorbs backend resolution / MCP apply / continuity recording / error normalization; replace the actor Proxy with `withRuntimeReplacementRetry` (unit-tested policy fn using the descriptor's failure classifier); delete `skipStructuredOutputGate` + the validator's chain + conflict-resolution's copy (both onto §3.1.6).

**3.2 Lane migration + legacy deletion.** `GraphLaneStore` durable adapter over the execution repository (contract test: lane state survives restart — this is the red test for bug §1.9.4); `WorkflowAgentCaller` deps swap the four provider-named methods for `BackendContinuityAdapter`; migrate implementer/validator continuity; delete `workflow-continuity-service.ts` and the in-memory projection; `LaneState` stores `{backend, ref}` + normalized metrics.

**3.3 Scheduling single-owner.** Move scheduling wholly inside WAC; delete collab's outer scheduling + the no-op inner scheduler; single `DEFAULT_LANE_WRITE_CAPABILITY`. *Pin first:* collab integration test asserting no double-acquisition deadlock and unchanged round behavior.

**3.4 Gates adopt-or-delete.** Wire `scriptValidationGateFromOutcome` into graph script-validator remediation + merge validation outcome mapping (deleting the duplicated union); confirm the other three gates died in 0.2.

**3.5 Actor decomposition.** Extract the pre-/post-turn pipeline steps as named, individually-tested modules; split `ActorImplementationDeps` into narrow port groups; delete the `as unknown as` cast. Mechanical, behavior-pinned by the existing section-parity suites.

**3.6 `agent-runs`.** Rename domain + routes + CLI plumbing; backend parameter; terminal-vocabulary migration; shared abort registry; drop the wrap/parse output path. Retain the `cctl codex` alias only after Alex explicitly approves that backward-compatibility surface.

*Exit criteria:* no production consumer touches a raw runtime result around the facade (grep + ratchet); one continuity stack (grep: zero `startCodexThread`/`createClaudeConversation` outside adapters); one scheduler acquisition point; structured-output mechanisms count 7 → 2 (native + shared post-validation, with two-pass as an option); `agent-runs` generic with green migration test.

### Phase 4 — Cross-cutting adoption completion (dependency-aware waves)

**4.1 SSE publication/StatusBus wave** (introduce typed publication; restrict StatusBus to lifecycle projection; convert direct transport importers; lint rule flips from warn to error).
**4.2 Route-resolution wave** (delete 3 clones → convert ladders domain-by-domain, starting `conversations/*` and `sessions/route-handlers.ts` → one `jsonError`).
**4.3 Client wave** (`addSseListener` in `api/sse.ts` + NotificationListener split into domain reaction modules; `createOptimisticMutation` promotion; unified prompt-stream transport; sanctioned client-test seam — MSW-style fetch fakes/injectable query client — and burn the internal `vi.mock` ratchet down).
**4.4 Schema partition wave** (GraphWorkflow* → `workflow-graph/schemas.ts`; partition the remainder by knowledge; no wire changes; typecheck is the safety net).
**4.5 State-store wave** (repo idiom convergence; notifications side-effect eviction; jobs→notifications repo call; project-conversations durability contract; shared `scoped-config-store` under MCP + agent-capabilities).
**4.6 Git wave** (diff.ts onto `GitClient`; git route handlers onto the resolve seam; drop the mutable dep override).

*Exit criteria per wave:* ratchet ceiling for that seam reaches zero (or the reviewed allowlist contains only intentional policy sites with deletion conditions), the lint rule where applicable flips to error, and superseded helpers are deleted.

### Phase 5 — Long tail (schedulable continuously)

**5.1 UI unification** (Tooltip sweep over the generated `data-tooltip` baseline; Dialog variant + 12 overlays; StatusChip; single toast host; twin autocompletes; ConfigToggle→Switch; cross-feature promotions + spawn-card move; `session-detail.store` split; workspace knowledge-slices).
**5.2 Canonical representations** (conversation builder ×5 sites; transcript logical-units module ×3 consumers; repo projections).
**5.3 Micro-primitives sweep** (good first-contributor work; each item: add shared module + migrate + delete copies).
**5.4 CLI items** (dispatchGroup; `instruction` in the shared renderer; shared 404 helper; SKILL.md generation).
**5.5 Collaboration containment** (replace `oppositeBackend()` arithmetic + hardcoded lane seeding with an explicit ordered backend-pair config literal; envelopes stay duplicated per D5).

### Program completion criteria (merged from all five reports)

- Every supported module hides a named decision and passes the deletion test; shared modules demonstrate production reuse; behavioral seams have at least two real adapters; no test-only module is presented as canonical.
- One composition door per execution shape; scheduling acquired exactly once; one continuity owner; one structured-output policy module with backend-compatible projections; one failure taxonomy.
- No provider-named member on any neutral interface; no SDK import outside adapters; persisted refs opaque and mismatch-rejected; UI/catalog registry-driven; the parameterized consumer-locality test green.
- Machines: shared validation-fix fragment; one hosting harness; debug external; single guarded owner for graph context status and dev-server status.
- One typed SSE publication path; one lifecycle StatusBus projection; one route-resolution/error contract; one scoped-cascade substrate; one conversation builder; one transcript-grouping owner.
- Conversation callers consume domain completion/results rather than actor topology; continuation disposition is failure-kind-aware; isolated one-shot tasks cannot inherit tools/settings/persistence; persistence preflight/cutover/claims have explicit linearization tests; lifecycle projection reports only authoritative scopes.
- Cross-feature imports zero (lint-enforced). Every seam ratchet either reaches zero and is retired, OR carries an approved P2/policy survivor floor with per-site deletion conditions recorded in `scripts/seam-adoption.ts` (per §3.5.1 and Phase 4's exit criterion). Internal non-infrastructure `vi.mock` is on this footing too: its target is zero (D20), but it may hold an approved migration-only survivor floor with a deletion condition until the last test is moved onto the sanctioned client-test seam. (See D21 for the reconciliation and the current per-seam floor table.)
- Steering, catalog, and CONTEXT.md agree with the code.

---

## Appendix A — Decision log

| # | Decision | Rejected alternative(s) |
|---|---|---|
| D1 | `AgentSessionRef` = `{ backend, ref }`, plain Zod object | Keeping the union + a `refValue()` accessor (leaves the leak in storage); adding a `version` field now (YAGNI — additive later) |
| D2 | Delete catalog-only `optimistic/` + `retry-machine.ts`; production procedural code is canonical; remove their complete catalog/type/route metadata while retaining/retargeting live wire-contract tests | Migrating production onto the machines (they are shallow and have zero orchestration consumers) |
| D3 | Commit and merge stay separate machines sharing `createValidationFixStates` + neutral actors | Merging topologies (terminal/CAS/finalization invariants genuinely differ) |
| D4 | Graph execution stays hand-rolled; invest in `transitionContextStatus` one level down | XState conversion (post-RCA design already machine-grade + fencing XState can't provide) |
| D5 | Keep the two collaboration envelopes (controlled duplication = construction guarantee) | Pause-neutral shared core (rejected until it can make no-pause structural; revisit only then) |
| D6 | Keep both execution ports; never merge | One universal execution interface |
| D7 | `config.json` disk shape unchanged; catalog derived at load; disk normalization is a separate future decision requiring Alex's explicit approval | Normalizing to `backends[backendId]` now (shared config dir = live-instance risk + back-compat approval rule) |
| D8 | Adopt `scriptValidationGateFromOutcome` (2 real consumers); delete the other 3 gates | Deleting all four; keeping all four "for the vocabulary" |
| D9 | Capability translators move into adapter directories; `agent-capabilities` keeps neutral cascade resolution and calls the conversation facet's adapter-owned apply operation; no provider payload crosses the seam | Translators stay in `agent-capabilities` with adapters registered at a composition root (leaves provider knowledge above the seam) |
| D10 | `codex-runs` → `agent-runs`, backend param, no legacy API route alias; retaining `cctl codex` is pending Alex's explicit backward-compatibility approval | Deferring until a second sub-agent backend ships (change is cheapest now; F8) |
| D11 | Conversation machine keeps zero final states; dead `output`/terminal-flush path deleted | Adding final states to satisfy the steering convention (the actor is long-lived by design; the convention is being rewritten) |
| D12 | Commit/merge jobs are ephemeral by decision (documented; stale sweep retained) | Adding snapshot persistence + rehydration to job machines (no product pull) |
| D13 | Debug evicted as attached workflow via the existing `debug-adapter.ts` seam | In-machine reorganization (contradicts the target doc's own flagship example) |
| D14 | Enforcement = script-generated seam ratchet + ESLint seam rules + conformance/locality tests | Review-time discipline alone (empirically failed — that is theme T1) |
| D15 | Background-work lifecycle: align `agent-runs` vocabulary + one abort registry now; full four-way WorkflowEnvelope convergence deferred | Converging jobs/graph/envelope now (large, riskier than its current cost) |
| D16 | Scheduling owned solely inside `WorkflowAgentCaller` | Scheduler as caller-visible decorator (perpetuates split ownership + the no-op hack) |
| D17 | **Approval gate:** ref rollout uses one explicitly selected policy—breaking version-gated cutover, approved bounded dual-read/new-write, or additive/shadow/quarantine; migration failure is fatal in every case. Cascade migration stays separate absent a proven shared invariant. **(2026-07-13) Alex selected policy (a): breaking version-gated cutover.** `KNOWN_SCHEMA_VERSION` bumped to 1; migration 0005 stamps `schema_migrations(version=1)`; the on-disk shape is canonical `{backend, ref}`; protocol-aware older builds opening after publication are refused by the forward-only gate. Every lower-version process already holding a connection is quiesced for cutover; a staged scanner protects later opens only, and pre-protocol binaries are prevented from reopening. The shadow-superset representation and its retirement follow-up are removed; the codec's legacy/superset arms remain only as transitional read-tolerance | Treating merge-time startup as sufficient rollout safety; selecting backward compatibility without Alex's approval |
| D18 | External turns become a declared capability with neutral operational events; Claude interpretation moves into the adapter; raw bytes cross only in the uninterpreted forensic transcript envelope | Keeping `provider_event: unknown` documented as Claude-only |
| D19 | Collaboration remains an explicit Claude×Codex pair expressed as one config literal | Generalizing collab to N backends (not the product) |
| D20 | UI client-test seam = fetch-level fakes + injectable query client, driving internal `vi.mock` to zero | Blanket `vi.mock` ban with no sanctioned alternative (the 119 sites signal a missing seam, not sloppiness) |
| D21 (2026-07-13) | **Completion criterion reconciled with the survivor-floor policy.** The program is complete when every seam ratchet EITHER reaches zero and is retired OR carries an approved P2/policy survivor floor with per-site deletion conditions in `scripts/seam-adoption.ts`. Supersedes the earlier unconditional "all seam ratchets at zero and retired." | The literal unconditional-zero reading (self-contradictory: §3.5.1, P2, Phase 4's exit criterion, and D19/D20 all already sanction justified nonzero floors — forcing them to zero would violate P2/P3/P4 by absorbing genuinely-distinct semantics into a single primitive or dissolving a sanctioned adapter boundary) |
| D22 (2026-07-14) | Conversation lifecycle interface owns completion projection and attached-workflow cancellation/generation; actor refs, events, and state topology stay private | Teaching each caller the current XState settlement states; adding another state-name predicate after every topology change |
| D23 (2026-07-14) | Continuation disposition is adapter-owned and failure-kind-aware; stale refs always clear, while graceful failures retain a continuation unless invalidation is observed | Deriving all failure behavior from continuation strength; clearing every Codex failure; retaining every Claude failure |
| D24 (2026-07-14) | Agent tasks expose semantic execution profiles; `isolated-one-shot` maps to one turn, no tools/MCP/settings, and no persistence, or fails as explicitly unsupported before provider invocation | Leaking Claude/Codex option bags into callers; silently approximating a profile the provider cannot guarantee |
| D25 (2026-07-14, amended) | State-store compatibility uses an append-only pre-open barrier plus an under-lock SQLite recheck before persistent startup mutation; every already-open lower-version process is quiesced because the barrier is not a lifetime lease, while staged scanners protect later opens and pre-protocol binaries are prevented from reopening; breaking DB rewrite+stamp is atomic and fail-closed behind the barrier; irreversible filesystem work uses durable capture before atomic SQL reset/completion and retryable cleanup; winner-only side effects share explicit linearization points; atomic file writes report incomplete/durability failures | Opening SQLite to discover a future WAL version; claiming compatibility with an active lower-version connection; deleting a live directory after a separately committed SQL claim; treating replay idempotence as concurrency control; best-effort durability under a crash-durable interface |
| D26 (2026-07-14) | Lifecycle projection reports only authoritative scopes; graph task/context point events cannot mutate execution lifecycle | Reusing `executionId` for every graph event and inferring whole-execution status from child activity |
| D27 (2026-07-14) | Graph validation identity is strategy-owned and provider-neutral: conversation refs are stable Command Center conversation ids, backend-task refs are opaque provider handles, review artifacts name the same owner, and publishers never infer ownership from backend identity | Stamping a rotating SDK session id as a conversation ref; reconstructing event meaning from provider-specific branches or mutable lane state |

**D21 rationale (2026-07-13).** The completion-criteria bullet (this document, "Cross-feature imports zero … internal non-infrastructure `vi.mock` zero; all seam ratchets at zero and retired") read the seam ratchets as an unconditional zero-and-retire. That conflicts with the plan's own enforcement design: §3.5.1's seam-ratchet paragraph names the `status-chip-pills` floor a *permanent-survivor floor of genuinely-distinct chip primitives*; Phase 4's per-wave exit criterion (line 488) already says a wave passes when "the reviewed allowlist contains only intentional policy sites with deletion conditions"; and principles P2 (fewer, deeper modules — do not force distinct semantics through one generic shape), P3 (semantic operations over identity branching *outside explicitly named product policy*), and P4 (SDK/provider knowledge points only downward, behind the adapter seam) each define a class of sanctioned nonzero site. D19 (curated Claude×Codex pair) and D20 (internal `vi.mock` migration-only debt) are two such classes already in the log. Retiring those floors to a hard zero would be a *regression* against the same principles, not completion. The reconciled criterion keeps the ratchet honest — a green `seams:check` now means "no drift above/below a reviewed population, and every survivor carries a written deletion condition," and program completion additionally requires that every nonzero floor be one of the approved classes with its per-site deletion condition recorded — rather than pretending the target is a literal zero the design never intended.

**Sign-off — APPROVED by Alex (2026-07-13).** D21 is the program's definition of done: every seam ratchet reaches zero and is retired, OR carries an approved P2/policy survivor floor with per-site deletion conditions. The earlier unconditional "all seam ratchets at zero and retired" reading is superseded. Also approved the same day: the per-kind `capabilityKinds[].applyTiming` amendment to §3.1.2 (replacing the single per-backend `runtimeConfigApplyTiming`, required for truthful Claude agents=next_conversation) and the single sanctioned `as AgentBackendId` narrowing minting `TESTFAKE_BACKEND_ID` in the test-support module. Ref rollout: Alex selected policy (a) breaking version-gated cutover (see D17).

**Current per-seam floor table (2026-07-15, from `scripts/seam-baselines.json`; every nonzero floor carries a reviewed ceiling and deletion condition in `scripts/seam-adoption.ts`).**

| Seam | Floor | Status | Deletion condition (summary) |
|---|---|---|---|
| `broadcaster-direct-imports` | 0 | retired-eligible | at zero |
| `bespoke-dialog-overlays` | 0 | at zero (2 sanctioned survivors marked per-site, subtracted) | drops per site when the hover-intent Popover / morphing-surface Dialog variants ship |
| `hardcoded-backend-enumeration` | 0 | at zero (collab dir allowlisted per D19) | n/a — D19 pair config is the feature |
| `state-store-construction` | 0 | at zero | at zero |
| `backend-deep-imports` | 1 | shrinking allowlist (P4) | site drops when its provider work moves behind the neutral backend seam (Phase 1.3/1.6); floor → 0 at last migration |
| `route-404-ladders` | 2 | permanent-survivor floor | drops only if a per-entity resolution seam preserving the nested structured-error body subsumes the two agent-capabilities not-founds |
| `status-chip-pills` | 7 | permanent-survivor floor (P2); one marked source-line annotation is subtracted per-site | floor drops if one of the seven distinct chip primitives adopts `StatusChip`; the marked annotation drops when a dedicated numbered-marker primitive ships |
| `structured-output-schema-literals` | 25 | bounded non-zero target (§3.1.6) | duplicate-knowledge literals → 0 when derived from Zod; Claude compatibility remains adapter-owned and intentional projections survive until a generated equivalent proves parity |
| `internal-vi-mocks` | 74 | migration-only floor (D20) | drops per test file rewritten onto the sanctioned fetch-fixture client-test seam; floor → 0 (seam retires) at last migration |
| `backend-identity-branches` | 26 | adapter-boundary / product-policy floor (P3) | drops per site when its distinction becomes a declared capability field or normalized result field, or the descriptor classifier subsumes it |

## Appendix B — Deletion inventory (legacy removal checklist)

**Phase 0:** `workflows/{actions,runtime-state,setup,persistence,retry-machine}.ts` (+ dead parts of `types.ts`), `workflows/optimistic/` and both machines' complete catalog/type/route metadata (retain/retarget section-6-3 live contract assertions), `primitives/{ask-user-gate,change-set-gate,convergence-gate}.ts` + tests, `useRenameProjectConversation`, `useProjectOpenCountQuery`, `use-long-press`, `writeState`/`updateSession` exports, conversations.store dead delete state, `ArtifactWriteRequest.required`, `createStateManager` alias.
**Phase 1:** hand-written `AgentBackendId` duplicate + duplicate `AgentSessionRef` definitions/enums (`context-artifacts/schemas.ts`), `ConversationBackendCapabilities` + `backendCapabilities()` switch, `applyClaudeCapabilityConfig`/`applyCodexCapabilityConfig` + result types + `ConversationToolingOverrides` backend fields + twin ports in `default-deps.ts`, `provider_event` + actor/external-turn-handler SDK imports, `getLikelyStaleResumeFailureMessage`-family string greps, hardcoded model catalogs (`ModelSelector`, `config-helpers`), hardcoded backend arrays/label maps ×~8 files, direct `forkSession` import + `SdkForkSession`, raw `query()` in `sessions/service.ts`, and duplicate structured-output projections after backend-compatible parity is proven.
**Phase 2:** duplicated commit fix-loop states + 3 guards, `subscribeMergeActor`/`subscribeCommitActor`/3 dispatchers (→ host), `graph-merge-runner` observer copy, `onTerminal` (both machines + steering), conversation `output`/`ConversationOutput`/terminal-flush, `RESOURCES_ACQUIRED/FAILED`, merge dead surface (`ABORT`, 2 guards, 3 context fields, vestigial `jobType`), 4 × `buildMachineSnapshot`, `project-lock-retry.ts`/`session-git-lock.ts` twins (→ shared), manager's byte-equivalent re-provides.
**Phase 3:** conversation-actor `Proxy` retry, `skipStructuredOutputGate` + validator 4-path chain + `conflict-resolution.ts` copy, `workflow-continuity-service.ts` (~1,100 LOC) + `graph-workflow-lane-adapter` round-trip + validator `backendRefCache`, collab outer scheduling + no-op inner scheduler, `startCodexThread`/`resumeCodexThread`/`createClaudeConversation`/`validateClaudeConversation` deps, duplicated `ScriptValidationOutcome` union, `codex-runs/` naming + wrap/parse output path + per-domain abort maps.
**Phase 4:** 3 local `resolveProjectOr404` clones, ~40 404 ladders, 9→1 `jsonError`, direct broadcaster imports (~10), NotificationListener inline blocks (43), ~30 optimistic hand-rolls, duplicated SSE prompt parsing, jobs' hand-written notifications INSERT, MCP unguarded global-store patch (→ shared substrate), raw `child_process` in `git/diff.ts`.
**Phase 5:** script-generated `data-tooltip` population, 12 bespoke overlays, tone-coded status pills → one `ui/StatusChip` (the audit's "8+" count folded onto the primitive except the genuinely-distinct chip primitives kept per §1.8 and pinned by the `status-chip-pills` seam floor), 4 toast containers → 1, twin file-autocomplete + `FileExtBadge` copy, manual `ConfigToggle`, 9 × `formatRelativeTime`, 8 × `truncate`, 5 × keyed mutex, 4 × atomic JSON writer, 3 × validated-JSON store, ~113 inline error extractions, ~6 JSONL loops, 7 hand-rolled `never` assignments, CLI COVERAGE mirror + 4 × 404 forms.

## Appendix C — Relationship to the source reports

Where reports disagreed, this document's resolution: the **descriptor** design follows report 5 (interface audit) as the superset of report 2's `BackendDescriptor`, with report 2's UI metadata fields folded in and the optional execution facets corrected here. The **gate** question resolves per report 3's "don't force one generic gate interface," narrowed by report 1's adopt-or-delete list (D8). The **retry** question follows report 4's inversion (delete the catalog-only machine, keep policy functions). The **collab envelope** question follows report 4's construction-guarantee argument over report 3's exploration (D5). The **graph-lifecycle** question follows report 4's single-transition-owner verdict over any XState conversion (D4). Scoring context: reports rated the codebase 4.5–6.5/10 with "one way per problem" the weakest axis everywhere; this plan is the completion-deletion-enforcement program the five reports collectively converged on.
