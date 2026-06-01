# Gap Analysis — agent-invoked-collaboration

Generated: 2026-05-30. Language: en. Spec status: requirements generated (not yet approved).

## 1. Summary

- The feature composes cleanly on top of three primitives that already exist: the asymmetric collaboration slice (`src/lib/workflows/collaboration/`), the implementer MCP tool registry (`src/lib/workflow-graph/tool-server.ts`), and the per-context/workflow/global config cascade (`src/lib/workflow-graph/resolve-config.ts`). Each one is structurally close to what the requirements ask for.
- Two genuine gaps: (a) every existing collaboration path eventually flows through an `ask_user` decision that pauses for a human via `pauseForHumanApproval()`; there is no envelope variant that turns that decision into a structured failure; (b) the existing circuit-breaker condition enum has a single value (`retry_exhaustion`) — a second condition (or a sibling halt type) needs to be introduced for collaboration failures.
- The recommended approach is **Hybrid (C)**: extend the collaboration policy/envelope to expose a workflow-scoped variant (no `pauseForHumanApproval` reachable by construction), extend `tool-server.ts` to register a new implementer-only `request_collaboration` tool gated by a scope flag, and extend the config-cascade + halt-reason schemas additively. No structural rewrite is warranted.
- Effort estimate **M (3–7 days)**; Risk **Medium** — mostly mechanical extension; the only design call is exactly *where* in the envelope to fork ask-user-handling so the "never reaches `pauseForHumanApproval`" property is verifiable by construction.

## 2. Document Status

Analysis follows `rules/gap-analysis.md` framework. Scope is limited to information and trade-offs; no implementation decisions are made here.

## 3. Current State Investigation

### 3.1 Existing assets

| Concern | File(s) | What it does today |
|---|---|---|
| Asymmetric collaboration slice | `src/lib/workflows/collaboration/envelope.ts` | HTTP-triggered slice that runs negotiation rounds, calls `pauseForHumanApproval()` on `ask_user`, broadcasts SSE status, persists envelope to disk |
| Policy decision | `src/lib/workflows/collaboration/policy.ts` | Pure function `decideCollaborationNextStep(input): { kind: "final" \| "continue_negotiation" \| "ask_user" \| "fail" }`. `ask_user` carries one of four reasons (`explicit_ask_user`, `objective_disagreement`, `rounds_exhausted_above_threshold`, `threshold_none_with_remaining`) |
| Collab manager | `src/lib/workflows/collaboration/manager.ts` | HTTP entry point used by `/collaboration` route handler |
| Implementer tool server | `src/lib/workflow-graph/tool-server.ts` | Registers `complete_task`, `upsert_shared_document`, and (conditionally) `add_task`. Pattern: Zod input schema, `safeParse`, `IterationHaltedError` short-circuit, structured `{ content, isError }` return |
| Config cascade | `src/lib/workflow-graph/resolve-config.ts` | Canonical resolver: `context.X ?? workflow.X ?? defaults.X` over `implementer`, `contextValidator`, `scriptValidator`, `iterationPolicy`, `circuitBreaker`, `mutability` |
| Workflow defaults schema | `src/lib/workflows/schemas.ts` | `workflowConfigOverrideSchema`, `WorkflowDefaults` shapes |
| Circuit-breaker condition | `src/lib/workflows/schemas.ts:121` | `z.enum(["retry_exhaustion"])` — single literal today |
| Halt reasons | `src/lib/workflows/schemas.ts:318-414` | Discriminated union with ~12 `type` variants (`circuit_breaker`, `max_iterations`, `merge_failure`, etc.). `circuit_breaker` carries `condition`, `failureCount?`, `summary` |
| Iteration orchestrator | `src/lib/workflow-graph/iteration-orchestrator.ts` | Owns iteration loop and `IterationHaltedError`; circuit-breaker gate runs after failures |
| Execution event publisher | `src/lib/workflow-graph/execution-events.ts` | Publishes structured events keyed by `(executionId, contextId)` to `ExecutionIndex` + SSE |
| Generic gate primitives | `src/lib/workflows/primitives/human-approval-gate.ts` | `pauseForHumanApproval()` — the single chokepoint for ask-user pauses |

### 3.2 Patterns and conventions

- Zod is source of truth; all schemas in `src/lib/workflows/schemas.ts` for workflow types, in `src/lib/workflows/collaboration/types.ts` for collab types.
- DI via factory pattern (`createXHandler(context)` in `tool-server.ts`).
- Tool handlers return `{ content: [{ type: "text", text }], isError?: true }`; structured tool returns are wrapped in `text` payloads today.
- Logger module names follow `domain.subdomain.event` (`graph-workflow.tool.complete_task`).
- Config cascade is additive: adding a new key to `WorkflowDefaults` + matching nullable on `WorkflowConfigOverride` + extending per-context override schema is the established extension pattern.
- Halt-reason additions: extend the discriminated union with a new `z.object({ type: literal(...), ... })` branch. Existing UI/log surfaces already iterate via `haltReason.type`.

### 3.3 Integration surfaces

- **Tool invocation → workflow runtime**: handler closures receive a `GraphWorkflowToolServerContext`; new methods are added there for orchestration callbacks (e.g., `startWorkflowCollaboration(brief): Promise<CollaborationToolResult>`).
- **Workflow run → collaboration slice**: today only the `/collaboration` HTTP route reaches the slice. A workflow-scope invocation would call the slice from inside the tool handler context, not via HTTP.
- **Circuit-breaker → halt**: orchestrator inspects breaker state at iteration boundaries; new condition needs to plug into that check.
- **Observability**: structured log events + SSE; transcript entries currently lack a parent-turn linkage field.

## 4. Requirement-to-Asset Map

Tags: **Reuse** (asset matches need), **Extend** (asset present, add fields/branches), **New** (no asset), **Constraint** (existing rule that shapes the solution).

| Requirement | Asset(s) | Tag | Notes |
|---|---|---|---|
| **R1.1** brief-only tool invocation | `tool-server.ts` register pattern; `addTaskSchema` precedent for `string().trim().min(1)` validation | Extend | Add 4th tool `request_collaboration` with single-field Zod schema; reuse handler factory pattern |
| **R1.2 / R1.3** implementer-only exposure | Tool server is implementer-side; validator runs in a separate code path | Extend | Today the only scope gate is `allowAgentTaskAdd`. Need an explicit `allowAgentCollaboration` flag (or analogous) carried on `GraphWorkflowToolServerContext` and asserted in the implementer-only entry point. Verify validator runtime does not import `registerGraphWorkflowExecutionTools` |
| **R1.4** no-tool-for-regular-sessions | Regular sessions use a different tool surface (not the graph workflow tool server) | Reuse (boundary) | The tool only appears because `registerGraphWorkflowExecutionTools` is called; verify it is never wired into non-workflow session bootstrap |
| **R1.5** no recursive collab | Collaboration slice has no recursion today; only `/collab` reaches it | New | Need a runtime guard: the collab slice (and so the spawned implementer thereof) must not register `request_collaboration`. Easiest via the same scope flag set to `false` when the slice spawns sub-agents |
| **R1.6 / R1.7** schema rejection | `safeParse` + `createValidationErrorResult` precedent | Reuse | Trim+min(1) covers R1.6. `z.object({brief: ...}).strict()` covers R1.7 (no extra fields). |
| **R2.1–R2.3** config cascade | `resolveContext()` cascade | Extend | Add a `collaboration` block to `WorkflowDefaults` and `WorkflowConfigOverride`; per-context override on `GraphWorkflowExecutionContextDefinition`. Block contains `secondAgent`, `negotiationRounds`, `autonomousResolutionThreshold` |
| **R2.4** ignore agent-supplied settings | `.strict()` Zod schema on tool input | Reuse | Schema forbids extra keys; no runtime check needed if construction is right |
| **R2.5** resolution provenance in log | Existing structured logging pattern (`logger.info` with structured payload) | Extend | New event with `source: { secondAgent: "per-node" \| "workflow" \| "global"; ... }` per setting. Resolver helper needs to return source layer alongside value |
| **R3.1–R3.7** structured result enum | `CollaborationPolicyDecision` + `PolicyAskUserReason` | Extend | The four `ask_user` reasons map cleanly: `objective_disagreement` → `objective_disagreement`; `threshold_none_with_remaining`+`explicit_ask_user` → `requires_user_input`; `rounds_exhausted_above_threshold` → `rounds_exhausted`. `final` → `converged`. `fail` → likely `objective_disagreement` or a new bucket — **Research Needed** |
| **R4.1–R4.4** never pause for user | `pauseForHumanApproval()` is the single chokepoint | New (variant) | Introduce a workflow-scoped envelope variant where the policy interpreter cannot call `pauseForHumanApproval`. Goal: verifiable by construction (e.g., no import of the gate primitive from the workflow-scoped slice file). See §6 research items |
| **R5.1** halt on non-converged | `graphWorkflowCircuitBreakerConditionSchema` (`["retry_exhaustion"]`) + halt reason `circuit_breaker` | Extend | Either (a) extend condition enum with `collaboration_failure` and reuse the existing `circuit_breaker` halt-reason branch, or (b) add a new halt-reason branch `type: "collaboration_failure"`. Trade-off: (a) is smaller, (b) gives operators a distinct top-level halt category per R5.5 |
| **R5.2** record failure in run log | Existing execution-events publisher | Extend | New event type `graph-workflow-collaboration-failed` carrying brief, resolved settings, status, openConflicts summary |
| **R5.3** halt the whole run | Iteration orchestrator already enforces halt on iteration boundaries; `IterationHaltedError` short-circuits in-iteration tool calls | Reuse | Tool handler must throw `IterationHaltedError` (or similar) after returning the structured result — order matters per R5.4 (return result first, then trip breaker) |
| **R5.4** still return result to agent | Existing tool handler returns structured `{content, isError}` | Reuse + Extend | Pattern: build result, then set pending halt before returning. Pending-halt path is already supported via `pendingHaltReason` field |
| **R5.5** distinct halt reason | Halt-reason discriminated union | Extend | Argues for new top-level halt-reason branch over reusing `circuit_breaker` with a new condition |
| **R6.1** invocation log | Existing structured logging | Reuse | Mirror `graph-workflow.tool.add_task` pattern with extra fields |
| **R6.2** transcript linkage | Today: task has `lastConversationId`; conversation has no parent workflow link | New | Add a `parentImplementerTurnId` field on persisted collab envelope + transcript entries; thread the implementer turn ID through the tool context |
| **R6.3** real-time visibility | Execution events + SSE | Extend | Reuse existing channels; new event types for collab lifecycle |
| **R6.4** completion log event | Existing publisher | Extend | New event with resolved settings, status, rounds consumed, conflicts summary |
| **R7.1–R7.3** preserve `/collab` UX | `/collaboration` route + manager + envelope | Constraint | The new variant must be additive — fork at the envelope/manager entry, do not modify the user-triggered path. Existing tests guard regression |

## 5. Implementation Approach Options

### Option A — Extend in place (single envelope, branch on context)

Modify the existing `runAsymmetricCollaborationSlice` to take a `mode: "user" | "workflow"` parameter and branch on it wherever `pauseForHumanApproval()` is reachable, returning a structured result instead.

- ✅ Smallest diff; no duplicated orchestration code.
- ❌ The "no `pauseForHumanApproval` reachable" property becomes a runtime invariant rather than a construction property. Easy to regress later.
- ❌ Mixes two contracts in one function.

### Option B — New workflow-scoped envelope module

Create `src/lib/workflows/collaboration/workflow-envelope.ts` (or a `workflow/` subfolder) that owns the workflow-scoped slice end-to-end. It reuses the **pure** primitives (policy decider, second-agent invocation, conflict tracking) but never imports `pauseForHumanApproval()`. The user-triggered `/collaboration` route continues to use the existing `envelope.ts` unchanged.

- ✅ R4 "never pause" guarantee holds by construction (verifiable via import graph).
- ✅ Cleanly preserves user-triggered behavior (R7).
- ✅ Aligns with engineering-principles steering: "Push variation to the edges. … New actors/validator types/context blocks, not a parallel orchestrator." Variation is genuinely at the edge here (the post-decision handler) so a sibling file is justified.
- ❌ Some round-loop scaffolding repeats between envelopes; needs disciplined factoring into shared helpers.
- ❌ Two entry points to keep in sync if the underlying round loop evolves.

### Option C — Hybrid (recommended)

Extract the inner round loop + policy interpretation into pure helpers (`runNegotiationRound`, `interpretPolicyDecision`) inside `src/lib/workflows/collaboration/`. Keep `envelope.ts` as today (composes helpers + `pauseForHumanApproval`). Add `workflow-envelope.ts` (composes the same helpers + a `decisionToWorkflowResult()` translator that never pauses). Add the new tool, halt-reason branch, and config-cascade fields additively.

- ✅ Reuses primitives per the engineering-principles checklist; net new code is small and well-bounded.
- ✅ R4 verifiable by construction (the workflow envelope simply doesn't import the gate).
- ✅ R7 untouched at the entry-point level; user-triggered path code path is identical post-refactor.
- ❌ Requires a small upfront refactor in `envelope.ts` to expose the shared helpers — moderate test churn.
- ❌ Naming care needed to keep the two envelopes from drifting in subtle ways.

**Recommended: Option C.**

## 6. Research Needed (carry to design phase)

1. **`fail` decision mapping** — `policy.ts` returns `fail` when Agent One explicitly chose `fail`. R3's status enum has no `failed` value. Decision needed: map to `objective_disagreement`, to `requires_user_input`, or introduce a fifth status. Spec language ("any non-`converged` status … trips the breaker") suggests the *halt* behavior is the same, but the *granular reason* matters for operators.
2. **Halt-reason shape** — choose between extending `graphWorkflowCircuitBreakerConditionSchema` (smaller change) and adding a new top-level `type: "collaboration_failure"` branch (matches R5.5 "distinct halt reason" more literally). UI/log surfaces that iterate on `haltReason.type` need to be enumerated.
3. **Validator runtime tool surface** — confirm by code that the validator runtime never invokes `registerGraphWorkflowExecutionTools` (R1.3). If it does, the scope gate must be at registration site, not only at handler invocation.
4. **Recursive guard wiring** — when the workflow-scoped slice spawns its two collaborator agents, those agents must not see `request_collaboration` in their tool surface (R1.5). Determine whether collaborator agents are spawned through the same `tool-server.ts` registration path or a separate one; choose the smallest gate.
5. **Pending-halt ordering (open design risk)** — R5.4 requires the tool to return the structured failure result to the calling agent; R5.3 requires that *no further tool calls in the current iteration* be processed after the halt trips. A next-iteration-boundary halt alone is too weak: it leaves a window in the current turn where the agent could issue more tool calls between receiving the failure result and the next iteration. The design must (a) record the collaboration-failure halt atomically before the tool returns its structured result, and (b) prove that subsequent tool handlers in the same iteration are rejected immediately — likely by having the orchestrator's tool dispatcher observe the pending halt and short-circuit via `IterationHaltedError`, the same mechanism already used in `tool-server.ts`. The `pendingHaltReason` field at `src/lib/workflows/schemas.ts:576` is one piece of the answer but not sufficient on its own; design must wire same-turn rejection explicitly.
6. **Provenance tracking in resolver** — `resolveContext()` returns merged values without source-layer labels. Decide whether to extend the resolver to return `{ value, source }` or to compute source post-hoc by re-checking which layer was non-null at log-event emission time. The former is more honest; the latter is a smaller diff.
7. **`secondAgent` default origin** — what is the documented global default today? The existing collaboration manager currently reads it from per-conversation drafts (user-triggered context). Identify the source of truth that R2.3 calls "documented global defaults" — likely a new constant or a new `WorkflowDefaults.collaboration` block.
8. **Transcript linkage shape** — the brief calls for "transcript linkage from implementer to collab envelope". The current collab envelope persists its own transcript-equivalent artifacts; decide whether linkage is (a) a `parentImplementerTurnId` field stored on collab envelope/artifacts, (b) a back-reference on the implementer's `lastConversationId` task state, or (c) both.

## 7. Effort & Risk

- **Effort: M–L (3–10 days).** Mechanical extension of multiple small surfaces (tool registration, config cascade schema, halt-reason schema, new envelope sibling). The only non-mechanical work is the policy-result translator and ensuring the user-triggered path is untouched. No new external dependencies; no new architectural pattern. **Tiebreaker for M vs L**: count `haltReason.type` consumer sites at the start of design; >5 sites with meaningful per-branch handling ⇒ L, otherwise M. The discriminated union is consumed widely but most consumers are exhaustiveness-checked by TypeScript, so the cost is largely mechanical.
- **Risk: Medium.** Three risk drivers, none structural:
  - Construction-level guarantee for R4 needs careful module boundaries (mitigated by Option C).
  - Halt-reason schema is consumed by UI / logs / persisted state — every consumer must handle the new branch. Discoverable by typecheck once the discriminated union is extended.
  - Collaboration envelope already has subtle pause/resume semantics; refactoring to extract shared helpers carries regression risk against the existing `/collab` test suite (mitigated by keeping the refactor minimal and adding tests before extraction).

## 8. Recommendations for Design Phase

- Adopt **Option C** as the working approach pending design-phase scrutiny.
- Resolve Research Items #1 (status enum coverage of `fail`) and #2 (halt-reason shape) before writing the schema diff — both have ripple effects.
- Treat the workflow-scoped envelope as a sibling primitive; do not add a `mode` parameter to the existing slice.
- Add the config-cascade fields and the halt-reason branch as additive, nullable extensions — no breaking changes to existing workflows.
- Plan tests at three layers: (a) pure policy-to-result translator (table-driven over all `PolicyAskUserReason` values), (b) tool-server scope filter (implementer sees tool; validator and regular sessions do not; recursive sub-agents do not), (c) end-to-end: tool call → policy `ask_user` → structured failure returned to caller AND breaker tripped AND next iteration refuses tool calls.
- Carry forward Research Items #3–#8 to the design discovery phase rather than blocking spec progression on them — none requires resolution to commit to a high-level design.

## 9. Next Steps

- Review this gap analysis alongside `requirements.md`.
- Approve requirements (or revise based on gap-analysis findings).
- Run `/kiro-spec-design agent-invoked-collaboration` to begin the design phase, taking the Research Needed list as the design-discovery agenda.

---

## 10. Design-Phase Discovery Resolution (2026-05-30)

Light discovery focused on integration points. Each item below resolves a §6 Research-Needed bullet.

### 10.1 — `fail` and `explicit_ask_user` policy mapping (resolves §6.1)

- `policy.ts` `kind: "fail"` is set when Agent One **explicitly chose `fail`** — an intentional agent decision, not a system error. `kind: "ask_user"` with `reason: "explicit_ask_user"` is Agent One's explicit pause request.
- Agent-invoked flow has no actionable distinction between "agent asked to pause" and "agent chose to fail" — both indicate non-autonomous convergence with no useful operator hook beyond that.
- **Decision**: map both → `requires_user_input`. The four-value status enum (`converged | rounds_exhausted | requires_user_input | objective_disagreement`) is preserved exactly as the requirements specify; no fifth status introduced.
- Complete mapping table:

| Policy decision | Status |
|---|---|
| `final` | `converged` |
| `continue_negotiation` | (cannot occur as terminal — loop) |
| `ask_user`, `objective_disagreement` | `objective_disagreement` |
| `ask_user`, `rounds_exhausted_above_threshold` | `rounds_exhausted` |
| `ask_user`, `threshold_none_with_remaining` | `requires_user_input` |
| `ask_user`, `explicit_ask_user` | `requires_user_input` |
| `fail` | `requires_user_input` |

### 10.2 — Halt-reason shape (resolves §6.2)

- `graphWorkflowHaltReasonSchema` has ~12 branches; new branch is the established additive extension. Existing UI/log surfaces iterate by `haltReason.type`.
- **Decision**: add new top-level branch `{ type: "collaboration_failure", status: CollaborationStatus, brief, executionContextId, conversationId, summary }`. Do NOT extend `graphWorkflowCircuitBreakerConditionSchema`. Rationale: R5.5 ("distinct halt reason") is literal; reusing `circuit_breaker.condition` would conflate retry-exhaustion and collaboration-failure for operators reading logs/UI.
- Consumer audit during implementation: TypeScript exhaustiveness will surface every consumer site; per §7 tiebreaker, the discriminated union is consumed by ≤5 sites with meaningful per-branch handling.

### 10.3 — Validator runtime tool surface (resolves §6.3)

- `registerGraphWorkflowExecutionTools` is called only from `src/lib/mcp-gateway/workflow-execution-server.ts`, which is the **implementer-side** MCP server.
- The **context validator** runs through a separate path (`validator-runner.ts`) and receives a task-run request via the conversation actor — it never gets the implementer MCP context.
- **Decision**: validator never sees `request_collaboration` by construction (no MCP). Still add an explicit `allowAgentCollaboration` flag on `GraphWorkflowToolServerContext` (mirroring `allowAgentTaskAdd`) so the registration intent is documented and the contract is enforceable if validator surfaces change later.

### 10.4 — Recursive collab guard (resolves §6.4)

- Collab slice spawns its two agents via `WorkflowAgentCaller` → `executeAgentCall` → `executeWorkflowTaskRun` (task-run path). Inner collaboration agents do not register `GraphWorkflowExecutionTools` at all.
- **Decision**: recursive guard is satisfied by construction (collab-slice agents never enter the implementer MCP registration path). The workflow-envelope module will be free of `request_collaboration` registration; no explicit runtime guard needed. Documented in design as a boundary commitment.

### 10.5 — Pending-halt ordering (resolves §6.5; CRITICAL)

- `IterationHaltedError` is defined at `src/lib/workflow-graph/iteration-orchestrator.ts:194-202` and is currently thrown by tool handlers when caught mid-handler.
- Current code does NOT block subsequent tool calls in the same iteration after a halt is recorded — `pendingHaltReason` exists on the schema but is not consulted by the tool dispatcher.
- **Decision**: introduce a pre-dispatch halt check in the iteration orchestrator's tool dispatch loop. Algorithm:
  1. `request_collaboration` handler runs collaboration, gets policy decision, translates to status.
  2. If status ≠ `converged`: record `pendingHaltReason = { type: "collaboration_failure", ... }` on execution state atomically, then return structured result to agent.
  3. Iteration orchestrator's tool dispatcher checks `pendingHaltReason` BEFORE handing each next tool call to its handler. If set, raise `IterationHaltedError` immediately — handler is never invoked.
  4. R5.4 holds: the agent receives the structured failure result for `request_collaboration` itself; only subsequent tool calls in the same turn are rejected.
- This requires a small, contained change to the iteration orchestrator's dispatch loop (new pre-dispatch check) — not a refactor.

### 10.6 — Provenance tracking in resolver (resolves §6.6)

- No existing provenance-aware resolvers; current `resolveContext` uses `??` cascade and drops source layer.
- **Decision**: extend resolver to return per-field provenance for the `collaboration` block only (do not retrofit existing blocks — out of scope). New type `ResolvedCollaborationConfig` carries `{ secondAgent: { value, source }, negotiationRounds: { value, source }, autonomousResolutionThreshold: { value, source } }` where `source ∈ "per-node" | "workflow" | "global"`. Emit provenance in the structured log event at invocation time (R2.5).
- Existing config blocks unchanged; the provenance shape is local to the new collaboration block.

### 10.7 — `secondAgent` default origin (resolves §6.7)

- Precedent: `contextValidator.agent` at `src/lib/workflows/schemas.ts:79` carries `{ backend, model, reasoningEffort }`.
- **Decision**: add `collaboration: { secondAgent: graphWorkflowAgentConfigSchema, negotiationRounds: z.number().int().positive(), autonomousResolutionThreshold: collaborationAutonomousResolutionThresholdSchema }` to `WorkflowDefaults`. Seeded defaults: `secondAgent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" }` (opposite of Opus-implementer default), `negotiationRounds: 3`, `autonomousResolutionThreshold: "minor"`.

### 10.8 — Transcript linkage shape (resolves §6.8)

- Implementer iteration transcript: `execution.history[]` with discriminated event types; tasks carry `lastConversationId`.
- Collaboration envelope persists its own artifacts (round messages, decisions, conflict trace) via `WorkflowEnvelope` store. No back-reference to the calling implementer turn today.
- **Decision**: add `parentImplementerTurnId` field (the implementer's conversation iteration ID) to the persisted workflow-collab envelope record. Thread it through `GraphWorkflowToolServerContext` → `startWorkflowCollaboration(brief, parentImplementerTurnId)`. Also emit a `graph-workflow-collaboration-started` event from the implementer side carrying the collab envelope ID. Two-way linkage: implementer→envelope via event; envelope→implementer via persisted field.

---

## 11. Design Synthesis

Applying the three lenses from `rules/design-synthesis.md`:

### 11.1 — Generalization

- The same `pendingHaltReason` + pre-dispatch check mechanism designed for R5.3 generalizes to any future tool that needs to halt the iteration. Worth noting but not extracting prematurely (YAGNI).
- The `ResolvedX` + per-field `{ value, source }` provenance shape is a candidate generalization but applying it to all existing config blocks is out of scope and would inflate the diff. Keep local to `collaboration` block.

### 11.2 — Build vs Adopt

- Existing primitives reused (build-on, not rebuild): policy decider, second-agent invocation, conflict tracking, structured log emitter, SSE channel, halt-reason union, `IterationHaltedError`.
- Net-new code:
  1. `workflow-envelope.ts` (sibling to `envelope.ts`) — composes shared helpers without `pauseForHumanApproval`.
  2. `decisionToWorkflowResult()` translator — pure function over the policy decision → status enum mapping table (§10.1).
  3. `request_collaboration` MCP tool registration (mirrors `complete_task` pattern).
  4. `collaboration` block in `WorkflowDefaults` / `WorkflowConfigOverride` / per-context override.
  5. `collaboration_failure` halt-reason branch.
  6. Pre-dispatch halt check in iteration orchestrator's tool dispatcher.
  7. Provenance-aware resolver helper for collaboration block (scoped narrowly).
  8. `parentImplementerTurnId` plumbing through tool context → envelope persistence.

No third-party adoption needed.

### 11.3 — Simplification

- Merging `fail` and `explicit_ask_user` to a single status (`requires_user_input`) avoids a fifth status that operators would have no way to act on differently.
- Scoping provenance to the new collaboration block only avoids touching the existing resolver shape (and so the diff stays auditable).
- Pre-dispatch halt check is a small, mechanical addition; no orchestrator restructuring.

---

## 12. Open Risks Carried into Design

1. **Iteration orchestrator pre-dispatch check** — adding the pre-dispatch `pendingHaltReason` check is the only invasive change to the orchestrator core. Risk is regression of existing tool dispatch paths. Mitigation: add unit test for orchestrator that asserts halt behavior in the iteration before touching production code (TDD).
2. **Halt-reason branch consumer count** — adding `collaboration_failure` will surface TS errors at all `haltReason.type` consumer sites. Per §7 tiebreaker, expected to be ≤5 with meaningful per-branch handling. Confirmed mechanical.
3. **Refactor of `envelope.ts`** — extracting `runNegotiationRound` and `interpretPolicyDecision` helpers is moderate test churn. Mitigation: tests-first extraction, no behavior change in user-triggered path.
