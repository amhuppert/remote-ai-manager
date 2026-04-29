# Gap Analysis: Composable Workflow Primitives

## Analysis Summary

- The codebase already has strong raw ingredients for the proposed primitives: separate backend ports, graph-workflow lane continuity, structured-output validation, reference-document registration, SSE delivery, and several existing workflow machines.
- The largest gap is not missing functionality in one place, but duplicated orchestration spread across conversations, graph workflow, merge/background jobs, focus-mode setup, and optimistic mode.
- The current code strongly supports an extraction strategy rather than a rewrite. The reusable pieces should be pulled out of existing feature paths behind compatibility adapters.
- The main requirement-level blocker was that `Context Limit` existed in the source architecture document and current graph-workflow behavior, but was not explicit in the generated requirements. That has now been corrected in `requirements.md`.
- Collaboration Mode is still absent, and several target primitives remain feature-specific today: Human Approval, Convergence, a shared ArtifactRegistry, a shared StatusBus, and a minimal workflow envelope outside graph workflow.

## Document Status

- Spec: `composable-workflow-primitives`
- Language: `en`
- Current phase: `requirements-generated`
- Requirements generated: yes
- Requirements approved: no
- Design generated: no
- Tasks generated: no
- Validation result: major requirement gap resolved; no remaining blocking requirement-quality issues found for gap analysis
- Analysis approach: reviewed `spec.json`, `requirements.md`, all steering files, `.kiro/settings/rules/gap-analysis.md`, `docs/composable-workflow-primitives.md`, current focus context, and the relevant workflow/backend/state/SSE/artifact modules in `src/lib/`

## Requirement-to-Asset Map

| Requirement | Existing assets | Gap type | Gaps and constraints |
| --- | --- | --- | --- |
| 1. Shared Agent Execution Facade | `src/lib/agent-backends/conversation.ts`, `src/lib/agent-backends/task.ts`, `src/lib/agent-backends/registry.ts`, `src/lib/prompt.ts`, `src/lib/workflow-graph/implementer-runner.ts`, `src/lib/workflow-graph/validator-runner.ts` | Partial | Backend ports already exist and are healthy, but callers still choose execution paths themselves. There is no shared `AgentCall` facade, no normalized result type shared across conversation-style and task-style paths, and no common place to attach continuity, gate handling, status emission, and artifact bookkeeping. |
| 2. Named Lane Continuity | `src/lib/workflows/graph-workflow/workflow-continuity-service.ts`, graph lane schemas in `src/lib/schemas.ts`, conversation totals in `src/lib/workflows/conversation/machine.ts` | Partial | Graph workflow already has the strongest prototype of `Lane`, including backend refs, rotation flags, limit evaluation, and stale-session handling. The abstraction is still graph-specific and not reusable by focus mode, regular conversations, optimistic mode, or future collaboration mode. |
| 3. Reusable Workflow Gates | Structured output in conversation backends and `src/lib/workflow-graph/validator-runner.ts`; Ask User in `src/lib/workflows/conversation/machine.ts` and `src/lib/agent-backends/claude/native-tooling.ts`; script validation in `src/lib/workflow-graph/script-validator-runner.ts`; change detection in `src/lib/git-operations.ts` and `src/lib/diff.ts`; context-limit rotation and circuit breaker in graph workflow | Partial | The ingredients exist, but there is no shared gate vocabulary or reusable gate execution layer. Human Approval does not exist as a first-class primitive, Convergence does not exist yet, and current gate-like behavior is encoded in feature-specific control flow rather than shared pass/fail/pause results. |
| 4. Scoped Status Transport | `src/lib/sse-broadcaster.ts`, `src/lib/workflow-graph/execution-events.ts`, `src/lib/background-jobs.ts`, conversation machine broadcast hooks in `src/lib/workflows/conversation/machine.ts` | Partial | The transport exists, but each feature publishes directly through ad hoc helpers and its own event contracts. There is no explicit shared `StatusBus` API by scope and no single cross-feature entry point for publication and subscription policy. |
| 5. Artifact Writing and Registration | Session reference documents in `src/lib/state.ts`; MCP tools in `src/lib/reference-document-tools.ts`; focus auto-registration in `src/lib/workflows/conversation/actor-implementations.ts`; Codex file output in `src/lib/codex-tool.ts`; graph shared docs in `src/lib/workflow-graph/shared-documents.ts`; validation log writing in `src/lib/workflow-graph/script-validator-runner.ts` | Partial | The codebase already writes several artifact kinds, but each flow owns its own path rules and metadata shape. There is no shared artifact-kind registry, no unified registration path for non-reference artifacts, and no common metadata model spanning user-facing artifacts and internal logs. |
| 6. Minimal Durable Workflow Envelope | Graph execution persistence in session state via `graphWorkflowExecution` and `graphWorkflowExecutionHistory`; graph route handlers in `src/lib/workflow-graph/execution-route-handlers.ts`; active execution discovery in `src/lib/active-conversations-route-handlers.ts` | Partial | Graph workflow already has a durable execution envelope, but it is graph-specific. Optimistic and background workflows do not expose an equivalent shared lifecycle object, and there is no generic workflow envelope reusable across future collaboration and other long-running workflows. |
| 7. Cross-Feature Workflow Composition | Regular conversation machine, focus session creation in `src/lib/sessions.ts`, debug mode inside `src/lib/workflows/conversation/machine.ts`, graph workflow stack, merge/commit machines, optimistic workflow in `src/lib/workflows/optimistic/` | Partial | The relevant workflows already exist, which is good evidence that the target scope is grounded in reality. The downside is that the reusable machinery is still embedded inside feature implementations. Debug mode is still inside the generic conversation machine, and Collaboration Mode does not exist yet. |
| 8. Backend Capability Preservation | `src/lib/agent-backends/types.ts`, Claude and Codex conversation runtimes and task runners, MCP application hooks, structured-output handling in both backends | Partial | Real backend differences are already preserved in practice, but capability modeling is still too coarse. Current capability flags only cover conversation runtime concerns and do not form a shared decision surface for an `AgentCall` facade or for gate behavior across both execution families. |
| 9. Worktree-Safe Concurrency and Pause Semantics | Worktree isolation in `src/lib/sessions.ts`; conversation single-flight/runtime management in `src/lib/prompt.ts` and conversation manager; background-job session locks in `src/lib/background-jobs.ts`; graph iteration serialization and lane rotation in graph workflow | Partial | The system is already conservative about worktree safety, which matches the architecture doc. The missing piece is a shared policy layer that classifies lane turns as write-capable or read-only and preserves both pause shapes across workflows, including a future post-turn Human Approval primitive. |

## Current Implementation Assets

### Backend Ports

- `ConversationBackendRuntime` and `AgentTaskRunner` already exist as distinct ports and should remain distinct.
- Both Claude and Codex implementations are registered behind `src/lib/agent-backends/registry.ts`.
- This matches the source design principle of keeping the existing backend ports and building above them instead of replacing them.

### Continuity Prototype

- `src/lib/workflows/graph-workflow/workflow-continuity-service.ts` is the clearest existing prototype for the future `Lane` primitive.
- It already stores backend identity, session references, context-limit evaluation, rotation scheduling, and stale-session recovery metadata.
- The current limitation is scope: it is built specifically for graph workflow lanes (`implementer`, `context_validator`) rather than general workflow participants.

### Gate-Like Behavior

- Structured output already exists in both conversation and task-style paths.
- Ask-user pauses are implemented for conversation execution and preserved as `waiting_for_input`.
- Script validation and circuit-breaker handling already exist in graph workflow.
- Change detection exists in git helpers and merge/commit workflows.
- What is missing is a shared gate contract and shared gate runners, especially for Human Approval and Convergence.

### Artifact Handling

- Session-level reference documents already exist and are discoverable by later turns.
- Focus mode has an explicit special case for `memory-bank/focus.md`.
- Graph workflow has a dedicated shared-document registry under `.cc/graph-workflow-docs/`.
- Script validator failures already produce durable log artifacts.
- Codex already writes detailed outputs into `memory-bank/codex/`.

### Durable Workflow State

- Graph workflow already persists a durable execution object with status, active context, lane states, history, and halt reason.
- This is strong evidence that a minimal workflow envelope is viable.
- The gap is that the same pattern has not been generalized for other workflows.

### Status Delivery

- SSE delivery is already centralized at the transport level.
- Feature publication is still fragmented: graph workflow has a dedicated event publisher, conversations broadcast through machine actions, and background jobs broadcast directly.
- This makes `StatusBus` an extraction opportunity rather than a greenfield subsystem.

## Key Constraints

### Requirements Are Still Draft

The spec remains in `requirements-generated`. Gap analysis can proceed and is useful, but design should still treat the requirements as draft until Alex approves them.

### Extract, Do Not Rewrite

The source architecture document is explicit that this effort should centralize repeated concerns without replacing feature-owned orchestration. That matches the current codebase. A rewrite would be high-risk and would violate the project constraints.

### Graph Workflow Is the Strongest Seed, Not the Final Shape

Graph workflow contains the best existing examples of lanes, validation, shared documents, and durable execution state. Design should treat graph workflow as the main extraction source, but should not let graph-specific terminology become the final cross-feature API.

### Debug Mode Is Still Embedded in the Conversation Machine

The target architecture expects debug mode to become a workflow attached to a conversation. Today it is still a compound state inside `src/lib/workflows/conversation/machine.ts`. Extracting it will require careful compatibility planning.

### Worktree Safety Must Stay Conservative

Current code assumes conservative locking and serialized write-capable work. Any shared primitive layer must preserve that default and require explicit proof before allowing parallel lane turns in one session worktree.

### Artifact Registration Is Session-Centric Today

Reference-document registration lives on session state. Graph shared documents live on graph execution state. A future `ArtifactRegistry` must reconcile those storage patterns without forcing all artifacts into one directory or one metadata schema.

## Implementation Options

### Option A: Extend Existing Feature Stacks In Place

Add shared-looking helpers inside the current conversation, graph workflow, and merge modules without creating a dedicated primitive domain.

**Pros**

- Lowest immediate code movement.
- Fastest to begin.
- Reuses existing tests with minimal relocation.

**Cons**

- Cross-feature logic stays scattered.
- The same concepts would keep different names in different subsystems.
- Collaboration Mode would likely need to duplicate orchestration glue again.

### Option B: Build a New Primitive Domain Up Front

Create a dedicated `src/lib/workflow-primitives/` domain for AgentCall, Lane, Gate, StatusBus, ArtifactRegistry, and Workflow Envelope, then adapt features onto it.

**Pros**

- Clear conceptual boundary.
- Good long-term maintainability.
- Easiest way to keep collaboration mode clean once implemented.

**Cons**

- Highest upfront design risk.
- Easy to over-abstract before enough usage pressure exists.
- Active graph/debug/conversation flows would need careful adapters to avoid regressions.

### Option C: Hybrid Extraction with Compatibility Adapters

Extract the most reusable parts into a small primitive domain, but preserve existing feature entry points. Graph workflow continuity, reference-document registration, and SSE publication become the first adapter-backed extractions.

**Pros**

- Best fit for the current codebase and the source design doc.
- Supports red-green TDD around the extracted pure logic and adapter boundaries.
- Minimizes regression risk while still creating real reusable primitives.
- Leaves room for Collaboration Mode to be the first feature designed against the new abstractions rather than retrofitted afterward.

**Cons**

- Requires discipline to avoid half-extracted abstractions.
- Some duplication will persist temporarily during migration.

**Recommendation:** Option C.

## Effort and Risk

- Effort: `XL`
- Risk: `High`

### Why

- This touches the most central orchestration code in the repository.
- The work spans conversations, graph workflow, merge/background workflows, session state, SSE delivery, artifact handling, and future collaboration behavior.
- Several target primitives already exist in feature-specific form, which lowers conceptual risk but raises migration risk.
- The project explicitly forbids rewriting existing working systems without approval, so the extraction path must be incremental and adapter-driven.

## Design Phase Recommendations

1. Start with the thinnest useful `AgentCall` contract above the existing backend ports.
2. Extract `Lane` from graph workflow continuity before attempting multi-lane collaboration orchestration.
3. Define a shared gate result model early, even if the first concrete gate runners are only Structured Output and Script Validation.
4. Treat `StatusBus` as a publication/subscription API over the existing SSE transport, not as a replacement transport.
5. Define artifact kinds and metadata separately from storage locations so existing special paths such as `memory-bank/focus.md` remain valid.
6. Model the first generic workflow envelope on the graph execution object, but keep it intentionally smaller than graph workflow state.
7. Plan debug-mode extraction as a compatibility migration, not as a prerequisite for all other primitive work.

## Research Needed

- Exact first API shape for `AgentCall`: named helper methods versus a small discriminated request union.
- Whether workflow envelopes should live in session state, a parallel workflow registry, or a hybrid model.
- How `ArtifactRegistry` should represent artifacts that are not session reference documents.
- How to express read-only versus write-capable lane turns so future collaboration can parallelize safely.
- Which gate kinds must be extracted before Collaboration Mode versus which can stay feature-local until a second consumer exists.

## Validation Outcome

Gap validation found one major requirements-quality issue and resolved it during this pass:

- Added an explicit `Context Limit` gate acceptance criterion to `requirements.md` so the requirements match both the source architecture document and the existing graph-workflow continuity behavior.

After that remediation, the spec has enough clarity to move into design, with the normal caveat that the requirements are still awaiting Alex's approval.
