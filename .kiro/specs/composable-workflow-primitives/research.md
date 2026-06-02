# Research & Design Decisions

## Summary

- **Feature**: `composable-workflow-primitives`
- **Discovery Scope**: Complex Integration (cross-cutting extraction across conversations, graph workflow, smart merge, focus mode, optimistic mode, debug mode, and a future Collaboration Mode)
- **Key Findings**:
  - Backend ports `ConversationBackendRuntime` (`src/lib/agent-backends/conversation.ts`) and `AgentTaskRunner` (`src/lib/agent-backends/task.ts`) are already healthy and capability-typed; the duplication lives one level above them, in feature orchestrators that re-pick backends, re-apply MCP, and re-validate structured output.
  - Graph workflow continuity (`src/lib/workflows/graph-workflow/workflow-continuity-service.ts`) is the strongest existing prototype for `Lane`. It already encodes backend identity, rotation policy, stale-session metadata, and per-engine continuity — but its types are graph-shaped (`implementer` / `context_validator`), so generalization must happen behind a compatibility adapter, not a rewrite.
  - Existing artifact paths are heterogeneous and must be preserved: session-level reference documents (`src/lib/state-store/`), `memory-bank/focus.md` (focus mode), `memory-bank/codex/...` (Codex `run_codex`), `.cc/graph-workflow-docs/` (graph shared documents), and validation logs. A registry that forces one tree would regress all of these. The registry must dispatch on artifact kind to existing paths, not invert them.

## Research Log

### Backend Ports & Capability Model

- **Context**: Requirement 1 needs a single semantic entry point above the two backend ports without merging them. Requirement 8 forbids hiding capability differences.
- **Sources Consulted**:
  - `src/lib/agent-backends/types.ts` — `ConversationBackendCapabilities` already enumerates `queueWhileRunning`, `askUserQuestion`, `preciseFork`, `portableMcpAtStart`, `portableMcpBetweenTurns`, `contextWindowMetrics`.
  - `src/lib/agent-backends/conversation.ts` — `ConversationBackendRuntime.sendTurn`, `queueUserInput`, `applyPortableMcpConfig`.
  - `src/lib/agent-backends/task.ts` — `AgentTaskRunner.run` returns `AgentTaskResult` with optional `structuredOutput`.
  - `src/lib/agent-backends/registry.ts`, `registry-core.ts` — singleton-per-backend registry.
- **Findings**:
  - Conversation runtimes own MCP application; task runners do not. The facade must therefore branch on execution shape, not on backend.
  - Structured output exists on both ports today, but only the task runner returns it as a typed field; the conversation runtime exposes it via the generic content stream and needs a post-validation step.
- **Implications**: AgentCall normalizes structured-output handling but exposes the difference via a `structuredOutputSource: "backend" | "post-validation"` discriminator on the result, so feature code can branch when it matters.

### Graph Workflow Continuity as Lane Seed

- **Context**: Requirement 2 wants Lane as a reusable named-stream primitive. Graph workflow already has the closest behavior in production.
- **Sources Consulted**:
  - `src/lib/workflows/graph-workflow/workflow-continuity-service.ts` — `createWorkflowContinuityService(deps)`, `resolveImplementerCall`, `resolveValidatorCall`, `recordClaudeTurnOutcome`, `recordCodexTurnOutcome`, `clearForNewContext`.
  - `src/lib/workflows/schemas.ts` — `graphWorkflowLaneStateSchema` (discriminated union by engine), `graphWorkflowLaneContinuityPolicySchema`, `graphWorkflowLaneKindSchema`.
- **Findings**:
  - Continuity already tracks Claude conversation IDs, Codex thread IDs, context-window metrics, rotation flags, and stale-session recovery markers.
  - Graph-specific fields (`lane: implementer | context_validator`) are encoded into the schema; rotating into a generalized `Lane` requires renaming `engine` → `backend` at the conceptual layer while keeping graph schemas intact through an adapter.
- **Implications**: The new `Lane` primitive lives in `src/lib/workflow-primitives/lane/` with its own minimal schema; graph workflow continues to use `graphWorkflowLaneStateSchema` and consumes `Lane` through a per-feature adapter. No active executions are migrated in the first pass.

### Gate Vocabulary

- **Context**: Requirement 3 lists eight gate kinds. Requirement 9 requires preserving the difference between mid-turn and post-turn pauses.
- **Sources Consulted**:
  - `src/lib/workflow-graph/validator-runner.ts` — `parseValidatorResponse`, `extractValidatorResult`, structured-output JSON schema; today's prototype for Structured Output gate.
  - `src/lib/workflow-graph/script-validator-runner.ts` — `ScriptValidatorOutcome` (`pass | fail | infra_error`); today's prototype for Script Validation gate.
  - `src/lib/agent-backends/conversation.ts` `onAskQuestion` callback — mid-turn ask-user shape.
  - `src/lib/workflows/conversation/machine.ts` — uses `waiting_for_input` state for mid-turn pause; post-turn human approval has no current home.
  - `src/lib/workflows/graph-workflow/iteration-orchestrator.ts` — circuit-breaker halt logic at line 840+.
  - `src/lib/git-operations.ts`, `src/lib/diff.ts` — Change Set source signal.
- **Findings**:
  - Existing pass/fail outcomes already exist as bespoke shapes; pause is the under-represented case.
  - Mid-turn pause must remain mechanically distinct: it lives inside an in-flight `sendTurn` and is resolved by feeding the answer back to the same call, while post-turn pause halts the workflow scheduler before the next step.
  - Convergence and Human Approval do not exist anywhere today; they must be designed greenfield but will reuse the same `GateResult` envelope.
- **Implications**: A single discriminated union `GateResult = { status: "pass", details } | { status: "fail", reason } | { status: "pause", pauseKind: "mid_turn" | "post_turn", resume }` suffices. Gates are pure functions over inputs, with the exception of mid-turn pause which is created by AgentCall during a turn rather than evaluated after one.

### StatusBus over Existing SSE

- **Context**: Requirement 4 wants one scoped status transport across features without forcing one payload schema.
- **Sources Consulted**:
  - `src/lib/events/broadcaster.ts` — `addClient`, `removeClient`, `broadcast(event: SSEEvent)`, globalThis-keyed singleton.
  - `src/lib/workflow-graph/execution-events.ts` — `GraphWorkflowExecutionEvent`, dedicated publisher with `dispatchPush`.
  - `src/lib/workflows/conversation/machine.ts` — `broadcastConversationStatus`, `broadcastAskQuestion`, `broadcastDebugModeStatus` actions.
  - `src/lib/background-jobs.ts` — `JobStatusEvent` broadcast directly.
- **Findings**: All four publication paths funnel into `sse-broadcaster.broadcast`. The duplication is at the API surface, not the wire.
- **Implications**: `StatusBus` is a thin pub/sub layer over `sse-broadcaster`. It introduces scope/scope-id keying and a generic typed-payload signature. Existing publishers are migrated to the bus opportunistically; `sse-broadcaster` stays as the wire.

### Artifact Registry Boundaries

- **Context**: Requirement 5 demands one shared writing+registration flow without forcing one directory.
- **Sources Consulted**:
  - `src/lib/state-store/` — `createReferenceDocument`, `getReferenceDocuments`, `deleteReferenceDocument`; reference docs nest under `ConversationState`.
  - `src/lib/reference-documents/schemas.ts` — `referenceDocumentSchema`.
  - `src/lib/reference-documents/tools.ts` — MCP tool surface.
  - `src/lib/agent-backends/codex/codex-tool.ts` — Codex writes its own reference documents into `memory-bank/codex/...` after each `run_codex` call.
  - `src/lib/workflow-graph/shared-documents.ts` — graph shared docs under `.cc/graph-workflow-docs/`.
  - Focus mode writes `memory-bank/focus.md` from a conversation actor.
- **Findings**:
  - Each path uses a different metadata model (reference doc id vs graph shared doc id vs none).
  - The only field common to all is the worktree-relative path. Source metadata (workflow, lane, round) is missing in most cases.
- **Implications**: Registry uses a discriminated `ArtifactKind` union; each kind owns its path-resolver and metadata-mapper. The registry adds source metadata (workflowId, laneId, round, createdAt, userFacing flag) at registration time and writes through to the appropriate underlying storage.

### Minimal Workflow Envelope

- **Context**: Requirement 6 wants minimal durable lifecycle metadata without an event store.
- **Sources Consulted**:
  - `src/lib/workflows/schemas.ts` — `graphWorkflowExecutionSchema` already persists ID, status, history, and lanes inside `SessionState`.
  - `src/lib/workflow-graph/execution-route-handlers.ts` — discovers active executions through session state.
  - `src/lib/active-conversations-route-handlers.ts` — discovers active conversations.
- **Findings**: The graph execution object is the working precedent for durable lifecycle storage in session state; building a parallel registry would fragment state.
- **Implications**: `WorkflowEnvelope` lives inside `SessionState` (or `ManagerState` when a workflow spans sessions), keyed by workflow ID, with a `featureSnapshot: unknown` slot owned by the feature. Collaboration Mode is the first consumer; graph workflow envelope adoption is opportunistic and not part of the first migration.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Extend in place (Option A) | Add helper functions inside conversation, graph, and merge modules without a new domain. | Smallest move; no new boundaries. | Cross-feature concepts keep diverging names; Collaboration Mode duplicates orchestration glue again. | Rejected — gap analysis already calls this out as scattered. |
| New primitive domain up front (Option B) | Build full `src/lib/workflow-primitives/` and migrate all features behind it. | Cleanest conceptual boundary; uniform vocabulary. | High up-front design risk; active flows would need invasive adapters before a second consumer validates the shape. | Rejected — over-abstracts before usage pressure. |
| Hybrid extraction with adapters (Option C) | Stand up a small primitive domain; preserve existing entry points; adapt features incrementally. | Matches gap analysis recommendation; supports red-green TDD; lets Collaboration Mode be the first feature designed against the new abstractions. | Requires discipline to avoid half-extracted abstractions; some duplication persists during migration. | **Selected.** |

## Design Decisions

### Decision: AgentCall request shape

- **Context**: Requirement 1 needs one entry point covering conversation turns, one-shot tasks, and structured variants of each.
- **Alternatives Considered**:
  1. A flat list of named helpers (`runConversationTurn`, `runStructuredConversationTurn`, `runTask`, `runStructuredTask`).
  2. A small discriminated request union with one entry function (`agentCall(request: AgentCallRequest)`).
- **Selected Approach**: Discriminated request union with thin named helpers that build the request and forward to the union. This keeps call sites readable while the underlying dispatch lives in one place.
- **Rationale**: Centralizes structured-output, MCP, lane continuity, and error normalization in one switch; named helpers preserve discoverability.
- **Trade-offs**: Adds one indirection layer. Worth it for the consolidated invariants.
- **Follow-up**: Verify the request union covers debug-mode investigation calls before debug extraction begins.

### Decision: Lane as new primitive with adapter to graph continuity

- **Context**: Requirement 2 wants a reusable Lane; graph workflow is the strongest seed but its schema is graph-shaped.
- **Alternatives Considered**:
  1. Generalize `graphWorkflowLaneStateSchema` in place and have all features adopt it.
  2. Define a fresh minimal Lane schema in `workflow-primitives/lane`; graph workflow keeps its schema and consumes Lane through an adapter.
- **Selected Approach**: Option 2.
- **Rationale**: In-place generalization would require migrating active graph executions, which the source design explicitly forbids without approval. A fresh schema lets Collaboration Mode use the new shape immediately while graph migrates opportunistically.
- **Trade-offs**: Two lane schemas coexist during migration. The adapter is small and tested.
- **Follow-up**: Decide whether the adapter is feature-owned (graph workflow imports `Lane` and converts) or primitive-owned (Lane exposes a graph-compat factory).

### Decision: Single GateResult envelope with explicit pause kinds

- **Context**: Requirement 3 lists eight gate kinds; Requirement 9 requires distinguishing mid-turn from post-turn pauses.
- **Alternatives Considered**:
  1. Per-kind result types (one `StructuredOutputGateResult`, one `AskUserGateResult`, etc.).
  2. One discriminated `GateResult` envelope with `kind`, `status: "pass" | "fail" | "pause"`, and a `pauseKind` discriminator on the pause branch.
- **Selected Approach**: Option 2.
- **Rationale**: Reusable across features and gate types; UI and recovery layers can match on a single envelope; preserves the mid-turn vs post-turn distinction explicitly.
- **Trade-offs**: A few gates carry payload-only metadata that ends up wrapped in the envelope.
- **Follow-up**: Lock the `details` payload schema for each gate kind during implementation, not now.

### Decision: StatusBus is a wrapper, not a replacement

- **Context**: Requirement 4. Existing SSE transport already works.
- **Alternatives Considered**:
  1. Replace `sse-broadcaster` with a new transport.
  2. Keep `sse-broadcaster` as the wire; introduce `StatusBus` as a thin scoped pub/sub above it.
- **Selected Approach**: Option 2.
- **Rationale**: Zero risk to active SSE clients; the duplication is at the publishing API, which is exactly where the wrapper sits.
- **Trade-offs**: One more layer to read when tracing an event end-to-end. Acceptable.

### Decision: ArtifactRegistry dispatches on kind to existing paths

- **Context**: Requirement 5 plus the constraint that `memory-bank/focus.md`, `memory-bank/codex/...`, `.cc/graph-workflow-docs/`, and reference documents must remain at their current paths.
- **Alternatives Considered**:
  1. Force all artifacts under `memory-bank/<workflow-id>/`.
  2. Dispatch on a discriminated `ArtifactKind` to per-kind path resolvers and metadata mappers.
- **Selected Approach**: Option 2.
- **Rationale**: Preserves established paths and existing MCP tooling; keeps the registry's responsibility to metadata + write coordination, not directory layout.
- **Trade-offs**: Adding a new artifact kind requires registering a path resolver. That is the right amount of friction for an architectural seam.

### Decision: WorkflowEnvelope lives in session state for the first consumer

- **Context**: Requirement 6 plus the rule against immediate persistence migrations.
- **Alternatives Considered**:
  1. Parallel registry (separate JSON file or SQLite table).
  2. Keep envelopes in `SessionState` (or `ManagerState` for cross-session workflows), keyed by workflow ID.
- **Selected Approach**: Option 2.
- **Rationale**: Matches the working pattern (`graphWorkflowExecution` already lives there); reuses `withStateLock` and atomic writes; defers the parallel-registry decision until a workflow needs it.
- **Trade-offs**: `SessionState` grows; mitigated by keeping envelope fields minimal and offloading large feature snapshots when needed.
- **Follow-up**: Re-evaluate if a workflow needs to span all sessions in a project or all projects.

### Decision: Worktree concurrency policy as a Lane field, not a new primitive

- **Context**: Requirement 9 wants serialization of write-capable lane turns and parallelism only when read-only is provable.
- **Alternatives Considered**:
  1. New scheduler primitive that reasons about lane writes.
  2. Annotate each `Lane` with `writeCapability: "read_only" | "write_capable"` (default `write_capable`); reuse the existing session lock (`acquireSessionLock` in `src/lib/lock.ts`) for write-capable execution.
- **Selected Approach**: Option 2.
- **Rationale**: The locking model is already conservative and proven; encoding the bit on the lane lets AgentCall decide whether to take the session lock or run unlocked. No new primitive needed.
- **Trade-offs**: Read-only parallelism is opt-in; default stays safe.

## Risks & Mitigations

- **Risk**: Half-extracted abstractions during migration (e.g., a feature uses AgentCall but bypasses Lane). **Mitigation**: Each migration step ships with adapter tests that prove the feature still produces the same observable outputs; reviews enforce that AgentCall consumers always pass through a Lane when continuity matters.
- **Risk**: Schema drift between `graphWorkflowLaneStateSchema` and the new `Lane` schema. **Mitigation**: Adapter is a single function with a property-based test against representative graph executions; CI fails on round-trip mismatch.
- **Risk**: `SessionState` bloat as more workflow envelopes accumulate. **Mitigation**: Envelope fields are minimal by design; feature snapshot can be a reference (artifact id) rather than inline data when it grows large.
- **Risk**: StatusBus drift toward a generic event store. **Mitigation**: The bus type signature explicitly forbids persistence; the wire is `sse-broadcaster.broadcast` only.
- **Risk**: Circular dependency between AgentCall, Lane, and Gate. **Mitigation**: Dependency direction is fixed: AgentCall → Lane (reads continuity) and AgentCall → Gate (runs validation); Lane and Gate never import AgentCall.

## References

- `docs/composable-workflow-primitives.md` — source architecture document driving this spec.
- `.kiro/specs/composable-workflow-primitives/requirements.md` — approved requirements.
- `.kiro/specs/composable-workflow-primitives/gap-analysis.md` — existing-asset map and Option A/B/C evaluation.
- `src/lib/agent-backends/{types.ts, conversation.ts, task.ts, registry.ts}` — backend port surfaces.
- `src/lib/workflows/graph-workflow/workflow-continuity-service.ts` — Lane prototype.
- `src/lib/workflow-graph/{validator-runner.ts, script-validator-runner.ts, shared-documents.ts}` — gate and artifact prototypes.
- `src/lib/events/broadcaster.ts`, `src/lib/workflow-graph/execution-events.ts` — current SSE publishing surfaces.
- `src/lib/state-store/`, `src/lib/state-mutex.ts`, `src/lib/lock.ts` — durable state and locking.
- `src/lib/agent-backends/codex/codex-tool.ts`, `src/lib/reference-documents/tools.ts` — existing artifact write paths.
