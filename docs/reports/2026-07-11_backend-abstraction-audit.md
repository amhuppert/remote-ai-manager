# Agent-Backend Abstraction Audit — Claude vs. Codex

**Date:** 2026-07-11
**Scope:** The interface design separating backend-neutral code from backend-specific code (Claude via `@anthropic-ai/claude-agent-sdk`, Codex via the Codex SDK), evaluated against the project goals — composability, testability, flexibility, and one-way-of-solving-a-problem — using the deep-module / information-hiding framework from *A Philosophy of Software Design* (Ousterhout).
**Companion reports:** `2026-07-11_composition-units-design-review.md` (general abstraction audit), `2026-07-11_xstate-machines-review.md`. This report drills into the backend seam those reports touched only in passing.

---

## 1. Executive summary

**Score: 6/10.** The codebase *does* have a proper backend abstraction — and its core is genuinely good. `ConversationBackendRuntime`, `ConversationBackendFactory`, and `AgentTaskRunner` (`src/lib/agent-backends/conversation.ts`, `task.ts`) are deep modules in the Ousterhout sense: `sendTurn()` and `run()` hide process management, streaming, MCP wiring, structured output, and resume semantics behind small neutral signatures. Backends self-register into a registry (`registry-core.ts`), and a capability descriptor (`capabilities-descriptor.ts`) exists as the sanctioned mechanism for behavioral variation.

The problem is that the abstraction is **not honored at its edges**, in three escalating ways:

1. **The neutral interface names its implementations.** `ConversationBackendRuntime` carries `applyClaudeCapabilityConfig?()` and `applyCodexCapabilityConfig?()` methods, and `agent-backends/types.ts` imports backend-specific config types from *outside* its own boundary. Each new backend adds a method to the shared contract.
2. **Consumers reach around the interface.** The conversation actor layer downcasts neutral events to `SDKMessage`, imports Claude helpers unconditionally, and two domain services call the Claude SDK directly — bypassing abstractions that already exist for exactly those jobs.
3. **The session-ref shape leaks backend vocabulary everywhere.** `{ backend: "claude"; sessionId } | { backend: "codex"; threadId }` forces ~20+ call sites (UI, workflows, persistence schemas) to branch on backend identity just to read "the resume handle."

A hypothetical third backend costs roughly: **~7 edits inside the boundary** (where they belong), **~50+ mechanical edits outside it** (enum extensions, label maps, `backend === "codex"` conditionals), and **at least four real refactors** (external-turn handling, the capability-config pipeline, the collaboration binary-toggle, session-ref persistence). For a two-backend system that's survivable; the trend line is the concern — every new feature that branches on `backend ===` instead of a capability adds to the census.

The capability descriptor is the right idea and the existing consumers of it are the cleanest code in this audit. The single highest-leverage change is cultural + structural: **make "add a capability flag or a runtime method, never a `backend ===` branch" the enforced rule**, then burn down the existing branches.

---

## 2. The architecture as built

```
src/lib/agent-backends/
├── types.ts                  AgentBackendId, AgentSessionRef, capability flags   ⚠ imports backend types from agent-capabilities
├── conversation.ts           ConversationBackendRuntime + Factory contracts     ⚠ backend-named apply methods
├── task.ts                   AgentTaskRunner contract (one-shot tasks)          ✓ fully neutral
├── registry-core.ts          Map-based registries, self-registration            ✓ generic, no branching
├── registry.ts               Facade + side-effect imports of both backends      ✓
├── runtime-registry.ts       Live runtime per conversation                      ✓ neutral
├── capabilities-descriptor.ts backendCapabilities(), queueCapabilityForBackend() ✓ exhaustive-checked switch
├── portable-mcp.ts           Backend-neutral MCP config schema                  ✓
├── mcp-translation.ts        Portable → per-SDK translation, capability-driven  ✓ no backend===
├── transcript.ts             Lossless backend-native envelope (seq/backend/raw) ✓
├── schemas.ts                Model & effort catalogs                            ⚠ central if/else, duplicated in UI
├── claude/                   QuerySession, task runner, content mapping, …
└── codex/                    Thread runtime, task runner, output parsing, …
```

Consumers resolve implementations via `getConversationBackendFactory(backend)` / `getTaskRunner(backend)` — used correctly and consistently by the prompt driver (`src/lib/prompt/sdk-driver.ts:826`), the conversation actor (`actor-implementations.ts:1258`), collaboration (`agent-caller-production.ts:143-145`), and graph-workflow validators. **Dispatch itself is clean.** The findings below are about what happens around the dispatch.

### What is genuinely good (keep and defend)

| Piece | Why it's right |
|---|---|
| `ConversationBackendTurnInput/Result` | Deep: one call hides streaming, images, structured output, abort, background-task waits. Neutral vocabulary throughout. |
| `AgentTaskRunner` | One method, covers jobs, validators, codex-runs, collab lanes. The best interface in the system. |
| Registry + self-registration | Adding a backend implementation is additive; no central switch to edit (`registry-core.ts` is fully generic). |
| `queueCapabilityForBackend()` | The model consumer pattern: `queue.ts:291`, `use-prompt-submission.ts:237`, `queue-route-handlers.ts:223` all vary behavior via `deliveryTiming` without knowing which backend they serve. |
| `mcp-translation.ts` | Routes decisions through injected `McpBackendCapabilities` metadata — capability-driven, zero `backend ===` checks. |
| `transcript.ts` envelope | Correct information-hiding for lossy-vs-lossless tension: neutral `{seq, backend, type, raw}` wrapper preserves native payloads without forcing a common message schema. |
| Exhaustive-`never` switches in `capabilities-descriptor.ts` | A third backend id fails to compile until it declares its capabilities. This is the enum-extension experience you want everywhere. |

---

## 3. Findings

Ranked by structural severity. Every claim below was verified against the source; line numbers are from this worktree.

### F1 — The neutral interface names its backends (severity: HIGH, the root defect)

`ConversationBackendRuntime` — the contract every backend implements — has per-backend methods:

- `conversation.ts:203-215` — `applyClaudeCapabilityConfig?(config: ClaudeRuntimeCapabilityConfig)` and `applyCodexCapabilityConfig?(config: CodexRuntimeCapabilityConfig)`, with per-backend result types (`ClaudeCapabilityApplyResult` includes `skipped-turn-active`; the Codex one doesn't).
- `types.ts:20-30` — `ConversationToolingOverrides` has `claudeCapabilityConfig?` / `codexCapabilityConfig?` fields.
- `types.ts:2-3`, `conversation.ts:10-11` — the boundary module imports these config types **from `@/lib/agent-capabilities/{claude,codex}-runtime-translator`** — the abstraction depends on modules outside itself, inverting the dependency direction the boundary is supposed to enforce.

Downstream, this forces the exact ceremony Ousterhout calls information leakage. `src/lib/agent-capabilities/default-deps.ts:850-890` contains `defaultApplyClaudeRuntime` and `defaultApplyCodexRuntime` — two near-identical ports whose bodies are: check `runtime.backend !== "x"` → check the x-named method exists → call it. A third backend adds a third config type, third interface method, third result type, third port, and a third branch in every dispatcher.

The variation the two methods actually encode is small and *already expressible* in neutral terms: Claude applies live-or-defers-when-turn-active; Codex stages for next turn. That's one method — `applyCapabilityConfig?(config: unknown): Promise<{status: "applied" | "rejected" | "deferred", …}>` — with the payload treated as opaque (translated per-backend *before* it reaches the runtime, which already happens) and the timing difference expressed as a capability (`capabilityApplyTiming: "live" | "next_turn"`, sibling to the existing `deliveryTiming`).

**Why this is the root defect:** the backend-named methods legitimize `backend ===` checks everywhere else. Once the core interface says "callers must know which backend they hold to apply config," the apply-planner (`apply-planner.ts:219,255`), the runtime composer (`runtime-composer.ts:225`), and the cascade layer (`apply/cascade.ts:607`) all follow suit.

### F2 — External-turn processing is Claude-typed inside the neutral layer (severity: HIGH)

The neutral event union has an escape hatch: `provider_event: { payload: unknown }` (`conversation.ts:66`). The workflow layer immediately un-erases it:

- `actor-implementations.ts:2074` — `const msg = event.payload as SDKMessage;` then feeds `processMessage()`.
- `actor-implementations.ts:59-64` — imports `SDKMessage`, `SDKAssistantMessage`, `SDKResultSuccess`, `SDKResultError`, `SDKSystemMessage` from `@anthropic-ai/claude-agent-sdk`; `processMessage()` (`:878-979`) switches on Claude message types and casts.
- `external-turn-handler.ts:1` — same import; its deps interface hardcodes `backend: "claude"` (`external-turn-handler.ts:40`).
- `actor-implementations.ts:82-83` — unconditional imports of `agent-backends/claude/query-session-errors` and `agent-backends/claude/map-content-blocks`; `mapAssistantContentBlocks` is called at `:912` on the assumption the payload is Claude-shaped.

The effect: external/background turns — a real product feature (background-task auto-continuation, wake markers) — exist only for Claude, and the code that would need to change for backend #3 lives in the *neutral* orchestration layer, ~4,500 lines deep in `actor-implementations.ts`. A `provider_event: unknown` contract that consumers must downcast is not an abstraction; it's a trapdoor with a comment.

The fix direction already exists in the codebase: `map-content-blocks.ts` maps Claude content → neutral `MessageContentBlock[]`, and the turn result already returns neutral blocks for caller-initiated turns. External turns should cross the boundary the same way: the *backend* translates its native messages into neutral events (`content`, `external_turn_completed` already exist) plus a `transcript_entry`-grade envelope, and `processMessage` moves into `agent-backends/claude/`.

### F3 — `AgentSessionRef` leaks backend vocabulary through its field names (severity: HIGH, widest blast radius)

```ts
type AgentSessionRef =
  | { backend: "claude"; sessionId: string }
  | { backend: "codex"; threadId: string };
```

Because the *field name* differs per backend, every consumer that wants "the opaque resume handle" must branch. Verified sites include UI (`InfoDetailsPopover.tsx:26-28`, `PromptEditorConversationMentionPopup.tsx:75-76`, `MobileInfoPanel.tsx:91-94`, `ExecutionInspectorPanel.tsx:440-447`), workflow logic (`envelope.ts:646-650`, `agent-caller-production.ts:153-224`, `validator-runner.ts:1077-1153`, `lane-service.ts:160-242`, `workflow-agent-caller.ts:239-414`), and persisted schemas (`workflows/schemas.ts:1168,1185` store `threadId` fields; lane `backendState` unions in the primitives layer).

None of these sites care that Codex calls it a "thread." They need: the string, and the backend tag for round-tripping. The knowledge "Codex's handle is named threadId" is a single design decision reflected in dozens of modules — the textbook definition of leakage.

Two structural deps make it worse:

- `workflow-graph/workflow-continuity-service.ts:62-63` — the graph engine's dependency interface declares `startCodexThread(): Promise<{threadId}>` / `resumeCodexThread(threadId)`. The *neutral orchestrator* names one backend's lifecycle verbs in its own contract, while Claude-lane continuity flows through a different path. Two mechanisms for "give this lane a fresh/resumed agent session," split by backend.
- Persisted workflow state embeds the per-backend shape, so changing the union shape now requires a data migration — leakage that has hardened into storage.

Fix direction: `{ backend: AgentBackendId; ref: string }` (or keep the union but add `refValue(ref): string` as the only sanctioned accessor, then mechanically migrate call sites). The discriminated union buys type safety exactly nowhere outside the two backend directories — no neutral consumer does anything different with a sessionId vs a threadId except display and store it.

### F4 — The agent-capabilities domain is backend-forked end to end (severity: HIGH)

`src/lib/agent-capabilities/` is structured as parallel per-backend pipelines rather than a neutral pipeline with per-backend edges:

- Cascade taxonomy is backend-prefixed: `"claude-skills" | "claude-plugins" | "claude-agents" | "codex-skills" | "codex-plugins"` (`agent-capabilities/schemas.ts:18-22`), with a validity map pairing cascade kind to backend (`:39-43`). Consumers pick cascades by branching (`PromptEditorSlashCommandPopup.tsx:165-166`).
- Per-backend translators (`claude-runtime-translator.ts`, `codex-runtime-translator.ts`) export per-backend config types that flow through the planner, composer, cascade, ports, and — per F1 — into the core runtime interface itself. The backend distinction is never erased; it rides the entire pipeline.
- Behavioral branching where a capability flag belongs: `apply-planner.ts:219,255` (`backend === "codex"` → stage-for-turn-start vs. applied), `runtime-composer.ts:225`, `default-deps.ts:213,797,805,857,879,1021`.

Meanwhile `ConversationBackendCapabilities` — the sanctioned variation mechanism — sits mostly idle: of its six flags, only the queue pair is actually consumed (§2). `preciseFork`, `contextWindowMetrics`, `askUserQuestion` are declared and never read; fork instead calls the Claude SDK directly (F5), and the context-limit gate checks `metrics.backend === "codex"` (`context-limit-gate.ts:99`).

This is a "two competing ways" violation at the mechanism level: the capability descriptor and `backend ===` branching solve the same problem, and the codebase uses both — with branching winning by usage count.

The generalization is not speculative. The taxonomy is `(backend) × (skills | plugins | agents)`; a `{ backend, kind }` pair with per-backend *supported-kinds* metadata collapses five cascade names into one concept and makes "does this backend support plugins?" a capability query instead of a name-mangling convention.

### F5 — Domain services call the Claude SDK directly, bypassing abstractions that already exist (severity: MEDIUM-HIGH)

- `sessions/service.ts:7,207-236` — `generateSessionName()` runs a raw `query()` call and downcasts to `SDKAssistantMessage`. This is precisely the job of `AgentTaskRunner` (one-shot prompt → text, already handles model selection, timeout, abort). Second mechanism for "run a one-shot agent task."
- `conversations/service.ts:2,30-36` — fork creation imports `forkSession` from the Claude SDK, with a local `SdkForkSession` interface. The `preciseFork` capability flag exists (`capabilities-descriptor.ts:36`) but nothing reads it; the fork feature is Claude-only by construction rather than by declared capability. Codex conversations presumably fall back to the synthetic-fork seed path — meaning fork has *two* implementations selected by an implicit rule instead of one seam.
- `mcp/portable-mcp-filter.ts:24` — imports `McpFilterLookup` from `agent-backends/claude/native-tooling`; the MCP permission-callback vocabulary (`CanUseTool`, `PermissionResult`) is Claude's, used as if neutral.

Each is small, but they establish the precedent that the boundary is optional. These are also the cheapest fixes in this report.

### F6 — Model/effort catalogs are hand-enumerated in two places, dispatched by if/else (severity: MEDIUM)

- `agent-backends/schemas.ts:152-169` — `getDefaultModelForBackend()` / `getEffortLevelsForBackend()` are `backend === "codex" ? … : …` ternaries with hardcoded fallback literals (`"gpt-5.4"`, `"opus"`).
- `components/ModelSelector.tsx:17-42` — UI re-declares both catalogs (ids + labels + descriptions) and its own `getModelsForBackend()` ternary. `config-helpers.ts:103` enumerates a third time.

There is no model-catalog registry; a backend cannot declare its own models the way it declares its runtime. Adding a model (which happens far more often than adding a backend) touches schemas.ts + ModelSelector.tsx + config-helpers.ts and silently drifts if one is missed. The registry pattern from `registry-core.ts` fits exactly: a `BackendDescriptor` carrying `{ id, label, models: [{id, label, description, effortLevels}], defaultModel }`, registered alongside the factory, consumed by schema-derivation and UI alike.

### F7 — Binary-backend assumptions in collaboration (severity: MEDIUM, contained)

- `workflow-graph/workflow-collaborator-caller.ts:137` — `oppositeBackend()`: `backend === "claude" ? "codex" : "claude"`. The concept "the other agent" only exists in a two-backend world.
- `collaboration/envelope.ts:581-616` — `initializeLanes()` constructs exactly one hardcoded Claude lane and one hardcoded Codex lane, with lane ids that *are* backend ids.
- `collaboration/manager.ts:322,486-489,716,941` — `resolveCodexModelConfig()` resolves one backend's model by name; the Claude lane's model resolves via a different path.

This is a product-shape assumption (collab = Claude × Codex) baked into structure. Acceptable today under YAGNI *if quarantined*, but the lane primitives underneath (`lane-service`, `LaneState`) are supposed to be general — the binary assumption should live only at the top-level collab config ("these N lanes, with these backends"), not in `oppositeBackend()` arithmetic.

### F8 — `codex-runs` is a backend-specific silo over a neutral engine (severity: MEDIUM)

The `cctl codex` one-shot sub-agent feature (`src/lib/codex-runs/`, three `/codex-runs/*` API routes, `cli/commands/codex.ts`) is Codex-branded top to bottom, yet its executor is a thin wrapper over the neutral runner — `getTaskRunner("codex")` with fully generic inputs (`service.ts:376-394`). ~95% of the domain (run records, registry, cancel, status polling, route handlers) is backend-agnostic.

Two extra smells:

- It reaches under the boundary: `service.ts:30-32` imports `wrapCodexPrompt` / `CODEX_OUTPUT_SCHEMA` / `parseCodexStructuredResponse` from `agent-backends/codex/codex-output`.
- Dual structured-output mechanisms: `service.ts:204-237` wraps the prompt in its own output-envelope protocol and parses the response *while also* passing a native `outputSchema` to the runner — belt-and-suspenders across two different mechanisms for the same guarantee.

If a third backend arrives, the obvious ask is "cctl gemini run" — and the current shape forces a copy of the whole domain. Renaming the domain to `agent-runs` with a `backend` parameter is nearly free now (the service already takes generic inputs) and eliminates a whole future silo. The CLI command can stay `cctl codex` as UX sugar.

### F9 — Miscellaneous mechanical leakage (severity: LOW, listed for the census)

- UI label/tone maps: `ComposerModeChip.tsx:11-14,50-53` (`AGENT_LABEL`, cyan-vs-violet ternary), `MobilePromptToolbar.tsx:81-84,275` (hardcoded `["claude","codex"]` iteration), `PromptComposer.tsx:277-284`.
- Backend pickers hardcode `options={["claude","codex"] as const}` in 4 config files (`DefaultsSection.tsx:65`, `CompactionSection.tsx`, `AgentConfigFields.tsx`, `ContextValidatorFields.tsx`).
- Skill-trigger char branching: `MobilePromptToolbar.tsx:254`, `PromptEditorSlashCommandPopup.tsx:176,188` (`$` vs `/` prefixes — should be a descriptor field like `skillTriggerPrefix`).
- `context-artifacts/schemas.ts` — `z.enum(["claude","codex"])` duplicate of `agentBackendSchema`.
- `execution-events.ts:143`, `actor-implementations.ts:781,835,2038,2440` — assorted `backend ===` conditionals.

Individually trivial; collectively they are the "~50 mechanical edits" a third backend pays. Most would evaporate if a registered `BackendDescriptor` carried `label`, `tone`, `skillTriggerPrefix`, and the UI iterated registered backends instead of literal arrays.

---

## 4. "How hard is a third backend?" — census

| Class | Count | Examples |
|---|---|---|
| **A — inside the boundary** (expected, healthy) | ~7 | `agent-backends/gemini/` runtime + task-runner, registration imports in `registry.ts`, model schema, capability switch cases (compiler-enforced via `never` checks) |
| **B — mechanical edits outside the boundary** | ~50+ | `agentBackendSchema` enum, `AgentSessionRef` variant, label/tone maps, 4 config pickers, hardcoded `["claude","codex"]` arrays, `getDefaultModelForBackend` ternaries, ~25 scattered `backend ===` conditionals in workflows/capabilities, test fixtures |
| **C — real refactors forced first** | 4 | (1) F2: external-turn/`processMessage` Claude typing; (2) F1+F4: capability-config pipeline needs a third parallel type/method/port chain; (3) F7: collaboration binary toggle; (4) F3: persisted session-ref/lane shapes (data migration) |

The A-class experience is genuinely good — the registry means a new backend *implementation* is additive, and the exhaustive switches turn forgotten capability declarations into compile errors. The B-class volume is the tax on `backend ===` culture. The C-class items are the ones that would actually hurt.

---

## 5. Evaluation against the project goals

| Goal | Verdict | Evidence |
|---|---|---|
| **Composability** | Mixed | Core contracts compose beautifully (codex-runs, validators, collab lanes, and jobs all reuse `AgentTaskRunner`). But the capability-config pipeline and external-turn handling are *not* composition — they're parallel per-backend structures threaded through neutral code. |
| **Testability** | Good | Method-syntax deps interfaces, factory/setter DI throughout; a fake `ConversationBackendRuntime` slots in cleanly (the contract is small). Weak spot: nothing *enforces* neutrality — a fake-backend conformance suite would catch Claude-typed assumptions structurally. |
| **Flexibility** | Moderate | New backend implementation: easy. New backend *integration*: ~50 mechanical + 4 structural edits. Flexibility degrades with distance from `agent-backends/`. |
| **One way of solving a problem** | Weakest axis | Capability descriptor vs. `backend ===` branching (F4); `AgentTaskRunner` vs. raw `query()` (F5); native `outputSchema` vs. wrap/parse envelope (F8); SDK fork vs. synthetic fork chosen implicitly (F5); Claude-lane vs. Codex-lane continuity split (F3); three hand-copies of the model catalog (F6). |

---

## 6. Recommendations, by leverage

Ordered by (leakage removed) / (effort). Items 1–3 are the structural core; 4–7 are cleanup that items 1–3 make natural.

1. **Neutralize the runtime capability-apply seam (F1).** Replace `applyClaudeCapabilityConfig`/`applyCodexCapabilityConfig` with one `applyCapabilityConfig?(config)` taking the already-translated payload as opaque data; move apply-timing (`live` vs `next_turn`) into `ConversationBackendCapabilities`; delete the twin ports in `default-deps.ts` and the `backend ===` checks in `apply-planner.ts`/`runtime-composer.ts` in favor of the flag. This also removes the boundary's imports from `agent-capabilities/*-runtime-translator` — restoring the dependency direction. *Everything else in F4 gets easier after this.*
2. **Make external-turn processing cross the boundary in neutral form (F2).** `processMessage` + the `SDKMessage` switch move into `agent-backends/claude/`; the runtime emits typed neutral events (content blocks + transcript envelopes) instead of `provider_event: unknown` payloads that consumers downcast. Kill the unconditional Claude imports in `actor-implementations.ts:82-83`.
3. **Collapse `AgentSessionRef` to `{ backend, ref }`** (or gate all access through one accessor) **(F3)** and give the continuity service a neutral `startAgentSession`/`resumeAgentSession` pair implemented per-backend. This is the widest mechanical cleanup (~20+ branch sites deleted) and needs a small data migration for persisted workflow state — do it before more state hardens.
4. **Introduce a registered `BackendDescriptor`** — `{ id, label, tone, skillTriggerPrefix, models, defaultModel, effortLevelsForModel }` — registered next to the factory, consumed by `ModelSelector`, config pickers, composer labels, and `getDefaultModelForBackend` (F6, F9). UI iterates registered backends; the hardcoded `["claude","codex"]` arrays disappear.
5. **Route the remaining behavioral branches through capabilities** and start *reading* the flags already declared: `preciseFork` gates the fork path (with the synthetic fork as the declared fallback), `contextWindowMetrics` replaces `metrics.backend === "codex"` in the context-limit gate (F4, F5).
6. **Move `generateSessionName` onto `AgentTaskRunner`; move the fork SDK call behind the Claude factory (F5).** Small, high-symbolism: the boundary stops being optional.
7. **Rename `codex-runs` → `agent-runs` with a backend parameter; drop the double structured-output path (F8).** Keep `cctl codex` as an alias. Defer only if no second sub-agent backend is plausible — but the change is cheapest now.

Deliberately *not* recommended: generalizing collaboration to N backends (F7). Binary collab is the product today; just replace `oppositeBackend()` arithmetic with explicit lane configuration so the assumption lives in one config literal instead of control flow. Likewise, no unified cross-backend message schema — the `transcript.ts` lossless-envelope approach is the right call; forcing Claude and Codex payloads into one shape would be over-generalization.

**Guardrail worth adding:** an ESLint boundary rule — outside `src/lib/agent-backends/`, imports from `agent-backends/{claude,codex}/**` and from `@anthropic-ai/claude-agent-sdk` are errors (allowlist the current offenders, burn the list down). That converts this report's findings from review-time knowledge into compile-time enforcement, which is the only way the census stops growing.

---

## 7. Score detail

| Area | Score | Note |
|---|---|---|
| Core contracts (`conversation.ts`, `task.ts`) | 8/10 | Deep, neutral vocabulary; docked for backend-named methods and the `provider_event: unknown` trapdoor |
| Registry & lifecycle | 9/10 | Generic, self-registering, well-logged |
| Capability mechanism | 5/10 | Right design, ~⅓ adopted; loses to `backend ===` branching by usage count |
| Session-ref / resume handling | 4/10 | Field-name leakage across UI, workflows, and persisted state |
| Capability-config pipeline (`agent-capabilities/`) | 4/10 | Parallel per-backend structures end to end; inverted dependency into the boundary |
| Model/effort catalogs | 5/10 | Single conceptual source, three hand-copies, if/else dispatch |
| Consumer discipline (prompt driver, queue, MCP translation) | 8/10 | The clean consumers show the pattern works when followed |
| **Overall** | **6/10** | A real abstraction with a strong core, eroding at the edges; enforcement, not redesign, is what's missing |
