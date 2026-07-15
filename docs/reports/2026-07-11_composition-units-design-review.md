# Composition Units Design Review

**Date:** 2026-07-11
**Scope:** Full codebase (~236k non-test source lines, 898 test files) — abstractions, composable primitives, XState machines, and units of composition, evaluated against: composability, testability, flexibility, and "a single way of solving a problem."
**Method:** Eight parallel subsystem audits (conversation workflows, graph engine, agent execution stack, persistence, API/SSE/client-data, CLI, UI composition, plus a dedicated cross-domain unification sweep), all applying the same rubric from Ousterhout's *A Philosophy of Software Design* (deep vs shallow modules, information hiding vs leakage, general vs special purpose). Calibration baseline: `docs/composable-workflow-primitives.md` (the approved target architecture) and `.kiro/steering/engineering-principles.md`. Delete-driving claims (dead modules, zero-consumer gates, private store instances) were independently re-verified by grep before inclusion.

---

## 1. Executive summary

**Overall: 6.5/10 — good bones, unfinished migrations.**

The composable-primitives strategy is working where it has been driven to completion, and the target architecture in `docs/composable-workflow-primitives.md` is **much further along than its own tone suggests**: the AgentCall facade, Lane, StatusBus, ArtifactRegistry, WorkflowEnvelope, and several gates all exist in `src/lib/workflows/primitives/` with production consumers and parity test suites. Fourteen of seventeen feature entry points funnel agent execution through two shared doors into one conversation actor. The Smart Merge machine is reused wholesale by graph fan-in joins. Query-key factories have 100% adoption. The UI primitive layer enforces information hiding *at the type level*. The CLI is a textbook functional core with an honest single-source-of-truth registry.

**The dominant failure mode is not bad design — it is stopping at partial adoption.** Across every subsystem the same arc repeats: the right seam is built, proves itself in one or two consumers, and the migration wave never completes. The old mechanism is never deleted, so the codebase carries *both* — which is worse for "a single way of solving a problem" than never having built the seam, because every new author now faces a choice, and roughly half choose wrong:

| Seam built | Adoption today | Left behind |
|---|---|---|
| Route resolve seam (`shared/route-resolution.ts`) | 4 of 61 handler modules | ~40 hand-rolled 404 ladders, 5 competing result shapes, 9 `jsonError` definitions |
| StatusBus (`publishSessionStatus`) | 10–13 modules | 10+ modules still import `events/broadcaster` directly; their events invisible to bus subscribers |
| Lane primitive (`LaneService`/`WorkflowAgentCaller`) | Collaboration lanes | Implementer/validator lanes on the self-described "legacy graph-only equivalent" (`workflow-continuity-service.ts`, ~1,100 LOC) |
| Gate vocabulary (8 gates) | 4 gates consumed | 4 gates with **zero** production consumers while 3 features run parallel gate implementations |
| Focused accessors/setters (state-store) | Broad adoption | Broad `readState`/`mutateState` still exported; 5 modules bypass via private store instances |
| `ui/Dialog` (Radix, deep) | 5 consumers + ConfirmDialog | 12 bespoke `role="dialog"` overlays without focus traps (documented deferral) |
| `ui/Tooltip` (a11y-correct) | **0** consumers | Legacy mouse-only `data-tooltip` mechanism in 46 files |
| AgentCall facade owning pre-turn pipeline | Dispatch + structured-output gate absorbed | MCP apply, continuity, error normalization still inline in a 1,355-line `executePromptForMachine` |
| Debug-as-attached-workflow (target doc step 8) | `debug-adapter.ts` seam exists | 7 debug states / 10 debug events still embedded in the generic conversation machine |

Second-order findings that compound this:

- **Dead and aspirational abstraction (~1,500+ LOC):** the entire documented "shared workflow tier" (`workflows/actions.ts`, `runtime-state.ts`, `setup.ts`, `persistence.ts` — an explicit no-op stub, `retry-machine.ts`, the `optimistic/` machine) has zero production consumers — **and `.kiro/steering/workflows.md` still directs new workflow authors at it.** The steering docs describe an architecture that was superseded by `primitives/`, which they barely mention.
- **Invariants held by comments, not construction:** the one-store-instance cache invariant, the "status leaves running only via manager.send" rule, the focused-first write discipline, and the no-cross-feature-import rule are all violated in production today because nothing structural prevents it.
- **God modules at the orchestration centers:** 79 files exceed the project's own ~600-line guideline; the five biggest (`actor-implementations.ts` 2,833, `execution-loop.ts` 2,690, `iteration-orchestrator.ts` 2,546, `workflows/schemas.ts` 2,396, `workflow-manager.ts` 2,150) sit exactly where composition matters most.
- **Concrete bugs born from duplication** (§6): a parsed-row cache staleness hazard, `#`-autocomplete silently excluding project conversations, lane branches hardcoding `csm/` while sessions honor the configurable prefix, and validator thread continuity that silently resets on server restart.

**The path from 6.5 to 9+ is not new architecture. It is finishing what was started, deleting what lost, and making the remaining conventions structural.** Sections 7–8 give a ranked roadmap.

---

## 2. Subsystem scorecard

| Subsystem | Score | One-line verdict |
|---|---|---|
| CLI (`src/cli/` + agent-help/gateway) | **8.5/10** | Functional core/imperative shell done right; registry-derived surface; debt is hand-mirrored dispatch inventories |
| UI composition (`components/ui`, features, stores) | **7/10** | Primitive layer is excellent and type-enforced; boundary rules and small-pattern unification erode above it |
| Graph workflow engine (`workflow-graph/`) | **7/10** | Genuinely composes shared primitives externally; internally a 27-field god record, stalled Lane migration, two 2.5k-line closure factories |
| Persistence (`state-store/` + repos) | **6.5/10** | Deep mutation core + real durability-contract primitive; three repo idioms and a comment-enforced singleton invariant |
| Agent execution stack (backends/prompt/mcp/capabilities) | **6.5/10** | Deep ports, one MCP cascade, strong funneling; 4 capability descriptor systems, 7 structured-output mechanisms, 111 backend branches |
| API / SSE / client data | **6/10** | Keys 10/10, SSE transport 9/10; route-handler layer is an unfinished unification (seam adoption ~7%) |
| Conversation workflows (`workflows/`) | **6/10** | The actor is a deep, reused spine; but debug mode is still embedded, the shared tier is dead code, and the core keeps accreting |
| Cross-domain unification | — | 4 background-work lifecycle vocabularies; healthy merge/config-dir/polling stories; long tail of utility duplication |

---

## 3. What is genuinely working (keep and imitate)

These are the units that prove the strategy. New work should imitate them, and refactors should not disturb them.

1. **The conversation actor as execution spine.** Every kind of agent turn — interactive chat, queued messages, first-turn dispatch, chat-spawned sessions, project conversations, optimistic mode, debug, graph implementer, graph validator, planner, merge conflict resolution, validation fix, `/commit`//`/merge` generation, compaction — flows through two entry points (`executePromptStream`, `executeWorkflowTaskRun`) into one actor, which routes to the `executeAgentCall` facade. Callers get locking, transcripts, SSE, queueing, and machine transitions for free. The invariant is pinned by parity tests (`section-6-2-graph-debug-parity.test.ts` and siblings) and documented at the call sites (`implementer-runner.ts:23-34`). This is Ousterhout-deep and is the single most valuable composition asset in the codebase.
2. **Smart Merge machine reused as a unit.** `workflow-graph/graph-merge-runner.ts:98-116` runs the same `mergeMachine` as user-facing merges with one input flag (`finalizeSessionOnPublish: false`); both paths record through `merge-intents`, and conflict resolution rides `executeWorkflowTaskRun`. A whole feature composed as a black box — exactly the goal.
3. **The MCP composition cascade.** One production compose call site (`actor-implementations.ts:1711`) → pure composer → per-backend translators that branch on capability metadata, not backend identity (`mcp-translation.ts:66-70`). Transient workflow tooling merges at the same seam, so lanes and validators don't fork it.
4. **The state-store mutation core.** `mutateConversation`/`mutateSession` hide write-queue serialization, Immer draft diffing, per-column prepared-statement caches, session-touch transactions, and telemetry behind one call (`store.ts`, `conversation-row-codec.ts` as single-source column map).
5. **The durability-contract testing primitive.** `assertRoundTripDurability` (schema-driven, walks Zod defs, rejects default-valued fixtures) is consumed by 15 contract tests including file-backed storage — a reusable *testing* primitive that generalizes beyond SQLite. Same family: the persisted-blob-bounds gate and effect-free `parseTrusted` registry.
6. **Query-key factories: 100% adoption, zero ad-hoc keys.** The one client-data pattern that was driven to total adoption — proof that full migration is achievable here.
7. **The SSE transport.** `broadcaster.ts` hides seq numbering, ring-buffer replay, HMR-safe singletons behind `broadcast(event)`; `sse-envelope.ts` is textbook information hiding (stamp/strip co-owned, failure mode documented); one EventSource per tab; 43 event schemas live in their owning domains.
8. **The CLI core.** Pure `runCli(argv, env, host)`; one `process.exit` in 9.1k lines; all 40 flag checks derive from the help registry; zero `vi.mock` in its tests; polling loops instant via injected `host.sleep`.
9. **The UI primitive layer's enforcement.** Every primitive omits `className`/`style` at the type level, exposing only `layoutClassName` — and a strict sweep found zero appearance utilities smuggled through it. `dialog-recipe`/`menu-recipe`/`disclosure-recipe` share appearance across sibling primitives. `useOverlayScope` (17 consumers) is a single overlay/hotkey system even bespoke overlays participate in.
10. **Collaboration Mode as proof-of-primitives.** `collaboration/envelope.ts:33-49` composes AgentCall + Lane + LaneScheduler + StatusBus + WorkflowEnvelope + HumanApprovalGate with a clean production composition root (`deps-factory.ts`) — the first-major-consumer role the target doc assigned it, fulfilled.
11. **Config cascade (graph).** Three tiers resolved once at seed time into a frozen `workingDefinition` (`execution-repository.ts:176`); no runtime consumer re-reads `config.json`. Variation pushed to the edge, as steering prescribes.
12. **DI/testing discipline in the core.** Machine tests with zero `vi.mock`; graph engine: 3 `vi.mock` calls in 64k test lines (all sanctioned logging); method-syntax deps interfaces throughout; real-SQLite persistence fixtures. The exceptions are in UI component tests (§5, T4).

---

## 4. Cross-cutting themes

### T1 — The half-finished migration is the system's defining pattern

Every subsystem audit independently converged on this. The table in §1 lists nine instances. The consequences compound: each unfinished migration leaves *two* mechanisms, doubling the decision surface for the next feature; steering docs describe the intended end state as if it were current, so contributors can't tell which mechanism is winning; and the abandoned half accumulates its own consumers (e.g., three domains re-implemented `resolveProjectOr404` **under the same name** with different result shapes — `dev-server/route-handlers.ts:147`, `workflows/definition-route-handlers.ts:57`, `workflow-graph/template-library-route-handlers.ts:75`).

The root cause is process, not design: **a seam is currently "done" when it works, not when the old way is gone.** The CSS migration ratchet (`scripts/css-migration-progress.ts` — per-owner selector counts vs committed floors) solved exactly this problem for stylesheets; nothing equivalent exists for architectural seams. §8 proposes the fix.

### T2 — Dead and aspirational abstractions, with steering pointing at the corpses

Verified dead (zero production importers):

| Dead unit | LOC | Status |
|---|---|---|
| `workflows/actions.ts` + `runtime-state.ts` + `setup.ts` + `types.ts` | ~310 | Superseded by `conversation/`-scoped forks; **steering `workflows.md` §"Adding a new workflow" still directs steps 5–7 at them** |
| `workflows/persistence.ts` | 47 | Explicit no-op stub referencing a removed 2025 workflow ("Ralph Loop") |
| `workflows/retry-machine.ts`, `workflows/optimistic/` machine | ~540 | Consumed only by the workflows-catalog *display page*, which presents them as "the 5 XState machines orchestrating Command Center" — two of the five orchestrate nothing; live optimistic mode is `shared/optimistic.ts` |
| `primitives/ask-user-gate.ts`, `change-set-gate.ts`, `convergence-gate.ts`, `script-validation-gate.ts` | ~270 + ~500 test | Zero consumers; `convergence-gate.ts:5-7` calls itself "the canonical Collaboration Mode condition" — Collaboration Mode never calls it; `script-validation-gate.ts:25-38` duplicates `ScriptValidationOutcome` verbatim from the live graph runner |
| `agent-backends/capabilities-descriptor.ts` `ConversationBackendCapabilities` | — | Stamped on every runtime, **no field ever read** (verified: `preciseFork`, `queueWhileRunning`, `portableMcpBetweenTurns`, `contextWindowMetrics`, `askUserQuestion` have zero non-test reads) |
| `ui/Tooltip.tsx` | 87 | 0 consumers; legacy `data-tooltip` in 46 files |
| `src/lib/api/sse.ts` | 1 | `export {}` — still listed by structure.md/tech.md as the SSE plumbing module |
| Misc | — | `RESOURCES_ACQUIRED/FAILED` events (declared, never sent), `useRenameProjectConversation` (never called), `use-long-press` (test-only) |

Two failure modes here, both worth naming: **speculative generality** (the four gates were built before repeated use — against the target doc's own open question at line 713, which asked which gates should be "extracted only after repeated use") and **abandoned origin** (the shared tier was forked into `conversation/` equivalents and the originals left in place). Dead abstractions are not neutral: they cost test maintenance (~500 lines for the gates alone), mislead steering readers, and — worst — make grep lie about what the architecture is.

### T3 — God modules at the orchestration centers

79 files exceed the project's ~600-line guideline. The ones that matter are the orchestration hearts, because their size is *why* new features get inlined rather than composed:

- `workflows/conversation/actor-implementations.ts` (2,833) — `executePromptForMachine` alone is ~1,355 lines stacking ~12 feature concerns (model/effort resolution, document feedback, image persistence, queued-delivery accounting, MCP apply, capability cascades ×2 scopes, alignment gating, notices drain, focus-memory registration, fork seeding, abort wiring, backend error fallbacks). Its deps interface is a 40-method grab-bag closed with an `as unknown as` cast (`actor-implementations.ts:616`) — the exact cast the engineering principles forbid. This function is the pre-turn pipeline the AgentCall facade was designed to own.
- `workflow-graph/execution-loop.ts` (2,690) + `iteration-orchestrator.ts` (2,546) — closure factories whose ~25 nested functions communicate through closure-mutable state; the 6,085/6,680-line test files they require are the smell made visible. The extraction pattern already exists in-file (`joinRunner` is injected).
- `workflows/schemas.ts` (2,396) — graph-workflow domain schemas living in the *sibling* domain; 59 `workflow-graph/` files import their own types from `workflows/`, hard-coupling the two directories and violating structure.md's domain-schema rule.
- `NotificationListener.tsx` (1,295) — 43 hand-repeated `parse → safeParse → guard` listener blocks with inconsistent try/catch hardening.
- `stores/session-detail.store.ts` (977) — ~16 concerns in one store; the other 12 stores average ~90 lines.

### T4 — Convention where construction is needed

Load-bearing invariants currently enforced only by comments or docs, all violated in production today:

1. **One state-store instance per process** (the parsed-row cache invariant, documented in `state-store/index.ts:7-14`): five modules construct private instances via the exported `createStateManager` alias (`agent-capabilities/{route-defaults,default-deps,scope-store}.ts`, `mcp/{default-deps,scope-store}.ts`) → potential stale-read bug (§6.1).
2. **Focused-first writes**: the lint gate restricts import *names* only; the factory and DI hand-offs bypass it — 5 of 10 production `mutateState` sites are outside the allowlist. The deprecated `writeState`/`updateSession` are still exported with zero callers.
3. **Execution status transitions via the manager**: `execution.status =` is written by 7 different modules; 4 duplicate `buildMachineSnapshot` implementations exist because there is no single owner.
4. **No cross-feature imports**: violated in 8 production files — `features/session` (26k lines) is an undeclared shared library for project-detail and session-workflow (composer, sidebar, diff panel, input gate).
5. **Never `vi.mock()` internal modules**: ~40+ internal-module mock call sites, concentrated in UI component tests mocking domain `queries`/`mutations`/stores — evidence the client hook layer lacks a sanctioned test seam (MSW-style fetch fakes or injectable query client), not that authors ignore the rule.
6. **Zod as source of truth for wire schemas**: ~20 hand-written `*_JSON_SCHEMA` literals in collaboration + validator + codex-output, while `z.toJSONSchema` is used in exactly one place (`context-artifacts/generation.ts:94`).

### T5 — Backend variation is branched, not encapsulated

Four capability descriptor systems coexist (`ConversationBackendCapabilities` — dead; `BackendCapabilityView`; `McpBackendCapabilities`; `QueueCapability`), with overlapping semantics (`portableMcpBetweenTurns` vs `mcpApplicationBoundary` vs `betweenTurnApply`; `contextWindowMetrics` vs `contextMetricsAvailable`; …). Meanwhile **111 literal `backend === "claude"|"codex"` branch sites across 50 files** do the work the descriptors were built for. Worst leak: the conversation fork path branches on backend and calls the Anthropic SDK's `forkSession` directly from feature code (`conversations/service.ts:452-524` + direct SDK import at line 2) — precisely the decision the dead `preciseFork` field was designed to encode. The port itself leaks the other way: the generic `ConversationBackendRuntime` interface carries `applyClaudeCapabilityConfig?`/`applyCodexCapabilityConfig?` methods and imports types from the `agent-capabilities` feature domain (`conversation.ts:10-11, 203, 213`) — a dependency inversion; a third backend would widen the shared port. And `{ type: "provider_event"; payload: unknown }` is a Claude-only escape hatch: raw `SDKMessage`s flow through the generic port into the actor, so Claude transcripts are persisted by the *actor* from raw frames while Codex transcripts are persisted by the *runtime* from mapped blocks — asymmetric responsibility through one interface.

Same story at smaller scale for **structured output** (7 mechanisms: backend-native, facade gate, validator's own 4-path chain behind an explicit `skipStructuredOutputGate` escape hatch, collab two-pass, codex-runs prompt-wrapper parser, chat-spawning named fence, per-consumer safeParse — with the validator's fallback chain duplicated near-verbatim in `sessions/conflict-resolution.ts:283-336`) and **error classification** (5 schemes; the ports return bare `error: string | null`, so every layer above re-parses strings — e.g. `getLikelyStaleResumeFailureMessage` greps `error.message` for "resume|session|thread" + "not found|expired" to detect what a `stale_resume_ref` failureKind should carry).

### T6 — Background-work lifecycle: four vocabularies for one concept

"Durable long-running agent work with status/cancel/history/recovery" exists four times: `BackgroundJob` (`running/completed/failed/...`), `CodexRunRecord` (`running/succeeded/failed/timed_out` — a self-described copy of the jobs convention with a gratuitously different terminal vocabulary), `GraphWorkflowExecution` (own halt/fencing/rehydration), `WorkflowEnvelope` (the designed unifier, with startup recovery). Plus three abort registries (conversations, codex-runs' globalThis map, graph signal-halt). Each new dashboard, recovery sweep, or cancel button special-cases all four.

### T7 — The utility long tail

Mechanical duplication that keyed-primitive extraction would retire: 5 hand-rolled keyed promise-chain mutexes; 4 atomic temp-then-rename JSON writers; 3 near-identical validated-JSON-file override stores (mcp ×2, agent-capabilities — one doc comment literally re-describes the other's contract); 2 lock poll-retry wrappers with identical constants; ~10 inline `sleep`s; 9 byte-identical `formatRelativeTime` copies; 8 private `truncate`s; 3 `deepEqual`s; 113 inline `err instanceof Error ? err.message : String(err)` sites alongside two exported helpers; `assertNever` bypassed by 7 hand-rolled `never` assignments; ~6 JSONL parse loops; duplicated `parseJsonColumn` and `parseJsonBody`. Also 8+ local status-chip implementations and 4 toast containers over 2 stores in the UI, and twin file-autocomplete components with a byte-identical `FileExtBadge`.

---

## 5. Notable subsystem findings (condensed)

Full details live in the per-subsystem audit outputs; this section keeps the items that drive the recommendations.

**Conversation workflows (6/10).** Debug mode still occupies 7 of 17 machine states and 10 of 22 events (`machine.ts:1081-1366` etc.), contradicting the target doc's flagship "wrong place to abstract" example; `debug-adapter.ts:4-6` admits it. `executePromptForMachine` god function (T3). Dead shared tier (T2). The AgentCall facade is bypassed by its two biggest consumers: the actor wraps the runtime in a JS `Proxy` to smuggle retry + raw turn results around the normalized result (`actor-implementations.ts:1034-1145`), and the graph validator opts out via `skipStructuredOutputGate` — a facade whose primary consumers need smuggling is telling you its result type is too narrow. Good: snapshot persistence discipline, section-parity tests, `.provide()` wiring.

**Graph engine (7/10).** Externally composes primitives correctly (implementer/validator/planner/collab/merge all through shared doors; StatusBus + ArtifactRegistry consumed; scheduler eligibility is pure functions; `loop-fence.ts` is a model deep module — 112 lines, two functions, enforced at the single write choke point). Internally: stalled Lane migration (legacy `workflow-continuity-service.ts` round-trips through the Lane primitive via a throwaway in-memory store per call); 27-field execution record with status writes in 7 modules; composition root embedded in a 1,465-line route-handlers file, including a phantom `startCodexThread: async () => ({ threadId: crypto.randomUUID() })` whose real thread id is patched in later; graph schemas in the wrong domain (T3).

**Agent execution stack (6.5/10).** T5 in full. Also: 5 execution doors (2 canonical + collab's direct runtime create/close per turn with no transcript/lock/queue/MCP, codex-runs' direct `getTaskRunner`, and raw SDK `query()` for session naming in `sessions/service.ts:217`); validator `backendRefCache` is an in-memory module-level Map (`validator-runner.ts:501`) — continuity silently resets on restart while conversations and lanes persist theirs. Good: deep ports (one-method `AgentTaskRunner`; `sendTurn` hiding the 1,275-line QuerySession lifecycle), the `agent-capabilities` domain itself is well-factored (pure resolver, no cascade-kind branching, schema-enforced backend ownership) — its 10.3k LOC is inherent domain size, though its name collides with three other "capabilities" modules.

**Persistence (6.5/10).** T4 items 1–2. Three repo idioms (in-store factory / standalone factory / module functions over `getStateDb()`); `notifications/repo.ts` performs SSE broadcast + web-push *inside* repo writes and re-exports test helpers from production; `jobs/repo.ts:395-432` hand-writes an `INSERT INTO notifications (…)` — a second copy of another domain's column list; 4 hand-rolled versioned parsed-row caches; adding one focused setter costs a 4-file pass-through chain (repo → setters.ts → store surface → index re-export), steadily shallowing the facade; `project-conversations-repo` lacks the durability contract the project claims is universal.

**API/SSE/client data (6/10).** §1 table rows 1–2 in full. No response-side error seam: `withTracing` rethrows without shaping, so unguarded handlers leak framework 500s; 44 hand-rolled 500 sites; 38 hand-rolled optimistic `onMutate` dances (sessions' domain-local helpers prove the abstraction; it was never promoted); NotificationListener's 43 repeated listener blocks. Good: 153/153 App Router shells are thin re-exports; 48/61 handler modules use DI factories; 312 `satisfies ApiError` sites.

**CLI (8.5/10).** Command-path inventory hand-mirrored in 4 places (dispatch if-chains, registry, contract-test COVERAGE list, "requires a subcommand" strings) — the registry already knows the children; a `dispatchGroup` helper would close the one-way drift hole. Tier-3 `instruction` key unowned by the shared renderer (two envelope keys: `instruction` vs `stopInstruction`). 404→exit-2 policy in 4 byte-equivalent forms. 931-line SKILL.md manually synced when the registry could generate its command reference.

**UI (7/10).** §1 table rows 6–7; T4 item 4; T7 UI items. Also: `_root/spawn-card` has a circular feature dependency and belongs in project-detail; 3 markdown renderer voices with one seam leak (session-workflow briefs render via chat-voiced `MarkdownContent` while context-artifacts renders the same content class via `ArtifactMarkdown`); steering `tech.md` still claims `@tanstack/react-virtual` — the actual dependency is `react-virtuoso`.

**Unification sweep.** T6–T7 in full. Additional structural notes: the collaboration envelope is *deliberately* duplicated (user-invoked `envelope.ts` vs graph-lane `workflow-envelope.ts`, "controlled duplication" enforced by eslint forbidden-imports — documented-intentional, but a full second copy of the round loop to maintain); two parallel "charter" mechanisms (session-alignment charter vs workflow charter — parallel render/hash/mirror/register/inject machinery for the same governing-document concept at two scopes); three write+register paths bypass ArtifactRegistry (`session-alignment/mirror.ts`, the cctl register-document endpoint, collab's own path builder — the doc's intended `collaboration_design` kind was never added); merge paths and dev-server polling are *already unified* (the healthy examples).

---

## 6. Bugs found (verify and fix independently of any refactor)

These fall out of the duplication directly and are cheap to confirm:

1. **Stale-cache hazard (HIGH, needs live verification).** The five private `createStateManager()` instances never see the singleton's cache-version bumps; `findAll`/`findBySession` short-circuit with **no SQL** on version match, so `agent-capabilities/route-defaults.ts:155`'s `readState()` (backing capability-resolution routes) can serve sessions/conversations frozen at first read in a production build. Dev HMR masks it by resetting module state. Verify with a prod build: PATCH a capability override, then read the resolution route.
2. **`#`-autocomplete excludes project conversations.** `conversations/cross-project-list.ts:109-114` walks only session conversations, while the sidebar's rich list includes project conversations — divergence born of two list assemblies.
3. **Lane branches ignore the configurable branch prefix.** `parallel-worktrees.ts:171` hardcodes `csm/`; sessions use `resolveBranchPrefix(globalConfig, repoConfig)` (`sessions/service.ts:290-292`). A project with a custom prefix gets mismatched lane branch names.
4. **Validator thread continuity resets on restart.** `validator-runner.ts:501`'s in-memory `backendRefCache` is the only continuity mechanism that isn't persisted.
5. **Unshaped 500s.** Any route handler without its own try/catch returns a framework-default 500 (no `ApiError` envelope) because `withTracing` rethrows — e.g. `sessions/route-handlers.ts:50`.
6. **Doc bugs:** steering points at the dead workflow tier (`workflows.md` §Adding a new workflow), at `src/lib/api/sse.ts` (empty), and at `@tanstack/react-virtual` (replaced by react-virtuoso).

---

## 7. Ranked recommendations

Ordered by leverage ÷ risk. The unifying principle: **every item either finishes a started migration, deletes a loser, or converts a convention into construction.** No new grand abstractions are proposed — the target architecture is already right.

### P0 — Bugs and truth-telling (days, near-zero risk)

1. Verify + fix §6.1 (private store instances): delete the `createStateManager` alias, repoint the 5 modules at the singleton, lint-restrict `createStateStore` outside `state-store/`+tests. Fixes the staleness hazard *and* closes the factory bypass of the focused-first lint in one move.
2. Fix §6.2–6.5 (autocomplete coverage, `csm/` prefix, validator ref durability via lane state, fold 500-shaping into `withTracing` with an optional domain error-mapper).
3. **Delete the dead tier and rewrite the steering.** Remove `workflows/{actions,runtime-state,setup,types,persistence,retry-machine}.ts`, `workflows/optimistic/`, the 4 unconsumed gates (or adopt script-validation-gate first, see P1.4), dead `ConversationBackendCapabilities` (or make it the source, see P2.3), `api/sse.ts`, dead events/hooks. Rewrite `.kiro/steering/workflows.md` around what actually exists: the conversation-actor spine + `primitives/`. Update `engineering-principles.md`'s primitive list ("actions.ts, runtime-state.ts, persistence.ts" → AgentCall, Lane, gates, StatusBus, ArtifactRegistry, envelope). Until this lands, every new contributor is being actively misdirected.

### P1 — Finish the started migrations (the core of this review)

4. **Adopt-or-delete sweep for each half-adopted seam, as mechanical waves:**
   - *StatusBus:* convert the ~10 direct `broadcaster` importers to `publishSessionStatus`/`broadcastEvent`; route `broadcastEvent`'s default through the bus. Near-zero risk, completes target-doc step 4.
   - *Route resolve seam:* delete the 4 same-name local clones first (type system then forces convergence), then convert the ~40 hand-rolled ladders. Start with `conversations/*` (the adapter lives in-domain) and `sessions/route-handlers.ts` (12 ladders).
   - *Gates:* map merge + graph script-validation outcomes through `scriptValidationGateFromOutcome` (pure, drop-in — kills the duplicated outcome union), express graph approval/user-input results in the shared `GateResult` vocabulary; delete `ask-user`/`change-set`/`convergence` gates until a second consumer exists.
   - *Lane:* migrate implementer/validator continuity from `workflow-continuity-service.ts` onto `WorkflowAgentCaller`/`LaneService` (collab already proves the path), persisting through one adapter write instead of the per-call in-memory round-trip. Deletes/shrinks ~1,100 LOC and the self-described "legacy equivalent."
   - *UI:* ship the already-designed §6.1 unstyled/edge-anchored `DialogContent`/`PopoverContent` variant and burn down the 12 bespoke overlays; sweep the 46 `data-tooltip` files onto `ui/Tooltip`.
5. **Extract debug mode from the conversation machine (target-doc step 8).** Removes ~45% of the machine's states/events, five `finalizingTurn` branches, and the machine→debug coupling; `debug-adapter.ts` is the seam and the section-6-2 parity suite already pins the external contract — the safest big cut available.
6. **Institute a migration ratchet.** The reason these stall is structural: adopt the CSS-migration-ratchet pattern for seams — a checked-in count of "old-way" call sites per seam (`grep`-derived, like `css:progress`) that CI refuses to let grow, plus a rule in steering: *a seam PR is not done until the superseded mechanism is deleted or ratcheted.* This is the single highest-leverage process change; without it, this review's fixes will themselves stall at 80%.

### P2 — Decompose the orchestration centers (enables future composition)

7. **`executePromptForMachine` → named pre-turn/post-turn pipeline.** Extract the ~12 inline concerns into individually-testable steps with narrow port groups (split the 40-method `ActorImplementationDeps`; kill the `as unknown as` cast). Move MCP-apply + continuity-recording + error-normalization down into the facade layer per the target doc, then widen `AgentCallResult` with the fields consumers currently smuggle (numTurns, raw content blocks) so the Proxy hack and the collab bypass stack collapse into one pipeline.
8. **Graph engine interior:** extract the loop's commit phase + gate-wait machines into injected collaborators (the in-file `joinRunner` pattern); move the composition root out of `execution-route-handlers.ts` into `setup.ts`; funnel all `execution.status` writes through the manager's transition function; one shared `buildLifecycleSnapshot`; move `GraphWorkflow*` schemas to `workflow-graph/schemas.ts` (mechanical import rewrite).
9. **Client layer:** `addSseListener(es, type, schema, handler)` (43 sites, makes the documented silent-drop footgun unrepresentable) and `createOptimisticMutation` generalizing sessions' helpers (retires ~30 of 38 hand-rolls). Split `session-detail.store` along its visible seams. Promote the cross-feature violators (`PromptComposer` stack, `ConversationSidebar`, `DiffPanel`, `use-user-input-gate`) to `src/components/`/`src/hooks/`.

### P3 — Unify the vocabularies (larger, schedule deliberately)

10. **One backend-capability registry** keyed by `AgentBackendId` (the `mcp/backend-capabilities.ts` registry shape is the template), with queue/MCP/facade views derived; route behavioral `backend ===` branches through it (target: 111 sites → translator boundaries + ref narrowing); move `forkSession` behind the Claude factory; remove the backend-named methods + feature-domain imports from the generic port.
11. **One structured-output module** owning extraction (native → raw JSON → fenced, with parse-path metadata) + Zod validation + `z.toJSONSchema` wire derivation, with collab's two-pass as a facade option keyed off `structuredOutputEnforcement`; migrate validator (delete `skipStructuredOutputGate`), conflict-resolution's copy, collab literals, codex-output. Extend `failureKind` (`stale_resume_ref`, `session_died`) so string-grep classification dies.
12. **Converge background-work lifecycle** on the WorkflowEnvelope: start with codex-runs (newest, smallest, self-described copy; needs a cctl enum-compat decision), align terminal vocabulary, one abort-handle registry keyed by scope. Evaluate folding the two charter mechanisms into one scoped implementation while there.
13. **Micro-primitives sweep** (mechanical, good first-contributor work): `createKeyedMutex`, `acquireWithRetry`, `atomicWriteJson`, `createValidatedJsonFileStore`, `sleep`, `formatRelativeTime`, `truncate`, one `getErrorMessage`, `createVersionedRowCache` for the 4 repo caches; UI `StatusChip` + single toast host; merge the twin file-autocompletes; converge the 6 domain repos on the standalone-factory shape and evict notifications' broadcast/push side effects to a service.

### CLI (independent, small)

14. Registry-driven `dispatchGroup` (deletes the COVERAGE mirror + 12 hand-listed verb strings); promote `instruction` into the shared envelope/renderer; swap the 9 bespoke 404 sites to the shared helper; generate SKILL.md's command reference from the registry.

---

## 8. Evaluation against the stated goals

**Composability: 7/10.** The wins are real and load-bearing (actor spine, merge-machine reuse, MCP cascade, primitives layer with a genuine proof-consumer). What blocks 10: the god modules at the centers mean *new* variation still tends to be inlined (12 concerns in `executePromptForMachine` is the counter-evidence to "features compose"), and several primitives exist but aren't composed by the features they target (gates, Lane for graph lanes).

**Testability: 8/10.** The strongest axis. DI discipline in the core is exemplary (zero-mock machine tests, real-DB fixtures, the durability harness as a reusable testing primitive, injected sleep in the CLI). Deductions: the 40-method deps grab-bag + `as unknown as` cast, 5.2k/6.7k-line test files forced by closure-factory design, and the client hook layer lacking a sanctioned seam (hence the ~40 internal `vi.mock` sites in UI tests).

**Flexibility: 6/10.** Variation is pushed to the edges where the config cascade and validator discriminators exist, and a third backend is *ports-wise* two implementations — but *practically* it's also 111 branch sites, 4 descriptor registrations, a widened port interface, and 7 structured-output paths. Flexibility is the axis the unfinished unifications tax most.

**A single way of solving a problem: 4/10.** The weakest axis, and the review's central finding. Counted competing mechanisms: 5 route-resolution shapes, 9 jsonError definitions, 7 structured-output mechanisms, 5 error taxonomies, 4 capability descriptor systems, 4 background-work lifecycles, 4 continuity mechanisms, 3 repo idioms, 3 command matchers, 3 store-acquisition patterns, 2 lane-continuity services, 2 broadcast idioms, 2 pause stacks, 2 tooltip/toast/status-chip/modal families, plus the utility long tail. Nearly all have an already-designated winner; the work is finishing.

**Ousterhout lens.** The deep modules are genuinely deep (QuerySession behind `sendTurn`; `mutateConversation`; `broadcaster`; `loop-fence`; `Dialog`). The recurring red flags are *information leakage through partial adoption* (the same decision — how to resolve a route, classify an error, describe a backend — living in N places) and *conjoined generality* (a general mechanism plus its special-cased predecessors both alive). Per the skill's scoring mandate: current 6.5/10; the specific improvements to reach 9–10 are exactly P0–P2 — no redesign, just completion, deletion, and enforcement.

---

## 9. Appendix: verification notes

Independently re-verified before publication (grep, non-test sources): dead tier importers (`actions`/`runtime-state`/`setup` = none; `persistence` imported only by dead `actions.ts`; `retry-machine` + `optimistic` only by the catalog display page); gate consumers (ask-user/change-set/convergence/script-validation = none; human-approval = collab ×2; circuit-breaker = graph ×2; context-limit = graph; structured-output = facade via relative import); `createStateManager()` = exactly the 5 claimed sites; `ConversationBackendCapabilities` field reads = none. File-size and `vi.mock` counts measured directly. Subsystem-internal claims (line references, adoption tables) are from the respective audit agents; each showed both sites for duplication claims.

*Report produced by an 8-agent parallel audit; subsystem scores are each agent's assessment against the composability goal, sanity-checked against one another during synthesis.*
