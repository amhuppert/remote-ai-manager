# Brief: agent-invoked-collaboration

## Problem
Graph workflow implementer agents have no escape hatch for hard judgment calls. They must either succeed unilaterally, hit the circuit breaker after wasted iterations, or — worse — silently produce a low-confidence answer. Today's collaboration mode (`/collab`) is gated to **user-typed invocation**, so it cannot be reached from inside an autonomous workflow run.

## Current State
- `src/lib/workflows/collaboration/` already implements asymmetric two-agent negotiation with autonomy thresholds, rounds, and an `ask-user-gate` for unresolved disagreements.
- `src/lib/workflow-graph/tool-server.ts` registers three implementer-facing MCP tools (`complete_task`, `add_task`, `upsert_shared_document`) via `registerGraphWorkflowExecutionTools`. There is no agent-callable collaboration tool.
- `src/lib/workflows/collaboration/policy.ts` decides between `continue_negotiation`, `final`, and `ask_user` — the `ask_user` branch is incompatible with autonomous workflow execution.
- No agent-initiated session/sub-workflow spawning exists anywhere in the codebase yet.

## Desired Outcome
- Graph workflow implementer agents can invoke a new MCP tool (working name: `request_collaboration`) with **only a `brief` argument**.
- All other collab settings (`secondAgent`, `negotiationRounds`, `autonomousResolutionThreshold`) come from the standard CC config cascade: per-node graph config → workflow-level config → global defaults.
- Successful convergence returns `{ status: "converged", finalAnswer }` inline to the calling agent's tool result.
- Any non-convergence path — `rounds_exhausted`, `requires_user_input`, `objective_disagreement` — returns a structured failure AND **trips a new workflow-halting circuit breaker condition that stops the entire workflow run**, not just the current iteration.

## Approach
Add a new tool to `registerGraphWorkflowExecutionTools` that spawns a **workflow-scoped variant** of the collab envelope. In that variant, every policy decision that would normally be `ask_user` is remapped to a convergence failure with the appropriate granular reason. Settings are resolved through the existing CC cascade pattern (matching iteration policy / validator config). The orchestrator wires non-`converged` results into a new circuit breaker condition that halts the workflow run.

## Scope
- **In**:
  - MCP tool registration in graph workflow tool server (handler, Zod schema, scoping check)
  - Workflow-scoped collab variant in `src/lib/workflows/collaboration/` (no `ask_user` paths reachable)
  - Config cascade plumbing for `secondAgent`, `negotiationRounds`, `autonomousResolutionThreshold` (per-node → workflow → global)
  - Granular result enum: `converged | rounds_exhausted | requires_user_input | objective_disagreement`
  - New circuit breaker condition + wiring to halt workflow run on non-`converged` result
  - Logging/observability for spawned collab (transcript linkage from implementer to collab envelope)
- **Out**:
  - Tool availability in regular (non-workflow) sessions
  - Tool availability for validators
  - Recursive collab inside collab
  - Per-call agent override of `secondAgent` / rounds / threshold
  - UI changes for surfacing workflow-spawned collab (deferred)
  - Changes to user-triggered `/collab` UX

## Boundary Candidates
- **MCP tool surface** — registration, schema, scope check, result shape
- **Workflow-scoped collab variant** — policy remapping (ask_user → failure), envelope entry point
- **Config cascade** — per-node + workflow + global resolution, schemas for each layer
- **Circuit breaker condition** — new condition type, halt semantics, integration with existing breaker
- **Observability** — transcript linkage, SSE events, logs for spawned collab

## Out of Boundary
- Agent-initiated session spawning generally (this is collab-specific only)
- Cross-session collab (collaborators always run in the same project/session context)
- New collab agents beyond claude/codex
- Telemetry/cost accounting changes (existing instrumentation should suffice)

## Upstream / Downstream
- **Upstream**:
  - `src/lib/workflows/collaboration/` (envelope, policy, types)
  - `src/lib/workflow-graph/tool-server.ts` and iteration orchestrator
  - Existing CC config cascade patterns (e.g., iteration policy, validator config)
  - Existing circuit breaker infrastructure
- **Downstream**:
  - Future "agent capability cascade" extensions could reuse the same config pattern
  - Could later inform a parallel feature exposing collab to validators or to regular session agents

## Existing Spec Touchpoints
- **Extends**: none directly (this adds a new capability rather than modifying an existing spec)
- **Adjacent**:
  - `composable-workflow-primitives` — collab envelope is one of those primitives
  - `parallel-execution-contexts` — circuit breaker semantics
  - `workflow-graph-builder` — graph definition schema where per-node config lives
  - `agent-capabilities-configuration` — config cascade pattern reference

## Constraints
- TypeScript `strict`, `noUncheckedIndexedAccess`; no `any` / `as unknown as`.
- Zod schemas as source of truth; types via `z.infer`.
- MCP tool format (Zod input schema, structured return) per existing `tool-server.ts` pattern.
- Must not regress user-triggered `/collab` flow or its pause-for-user behavior.
- Must integrate cleanly with existing circuit breaker semantics rather than introducing a parallel halt mechanism.
- Workflow agent invocations must never reach `ask-user-gate` — verified by construction, not just by runtime check.
