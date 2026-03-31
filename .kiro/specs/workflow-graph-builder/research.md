# Research & Design Decisions

## Summary
- **Feature**: `workflow-graph-builder`
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  - Existing long-running workflow patterns already provide the right lifecycle primitives: XState actors, external runtime registries, debounced snapshot persistence, SSE broadcasting, and startup rehydration.
  - The updated requirements materially simplify the graph problem by moving from task-node DAGs to execution-context DAGs with ordered task lists, but they introduce richer runtime contracts for validation remediation, runtime editing, and shared documents.
  - The repository does not currently include a graph-editing library. Official React Flow guidance for v12 uses `@xyflow/react`, which aligns with the current React 19 / Next 16 stack and is sufficient now that nested group containers are out of scope.

## Research Log

### Existing Workflow Runtime Patterns
- **Context**: The new feature must coexist with Ralph Loop and follow existing CC workflow conventions.
- **Sources Consulted**:
  - `.kiro/steering/workflows.md`
  - `.kiro/steering/ralph-loop.md`
  - `src/lib/workflows/ralph-loop/workflow-manager.ts`
  - `src/lib/workflows/persistence.ts`
  - `src/instrumentation.node.ts`
- **Findings**:
  - CC already standardizes on XState v5 actors for long-running workflows, with `.provide()`-based production injection and snapshot persistence through `getPersistedSnapshot()`.
  - Non-serializable runtime data already lives outside machine context in global registries, which fits abort controllers and active tool/session handles for this feature.
  - Startup recovery already rehydrates workflow/conversation actors and can be extended with a graph-workflow rehydration pass.
- **Implications**:
  - The new workflow should reuse the same `src/lib/workflows/<name>/` structure rather than invent a parallel orchestration style.
  - The machine should own lifecycle only, while the canonical execution aggregate lives in session state to avoid duplicated mutable state.

### Session, Conversation, and MCP Tool Patterns
- **Context**: Execution contexts iterate through fresh conversations and need tool-mediated task state changes and document registration.
- **Sources Consulted**:
  - `src/lib/conversations.ts`
  - `src/lib/query-session.ts`
  - `src/lib/ralph-loop/mcp-tools.ts`
  - `src/lib/ralph-loop/orchestrator.ts`
  - [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
  - [Work with sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)
- **Findings**:
  - CC already creates per-purpose conversations with explicit `role` tagging and uses `persistSession: false` for isolated autonomous runs.
  - Ralph Loop's MCP tool pattern (`createSdkMcpServer` + `tool()`) is already the project's accepted way to constrain autonomous workflows to structured state mutations.
  - Official SDK docs confirm that sessions persist conversation history, not filesystem state, which matches the new requirement that partial worktree changes remain after pause and resume.
- **Implications**:
  - Each execution-context iteration should use a fresh conversation with role tagging such as `graph_workflow_iteration`.
  - Task status, document registration, and iteration summaries should be exposed as explicit tools rather than inferred from prose.

### Validation Command Integration
- **Context**: Execution-context-level validators retain script validation in MVP.
- **Sources Consulted**:
  - `.kiro/steering/project-configuration.md`
  - `src/lib/repo-config.ts`
- **Findings**:
  - The current `runPreMergeValidation()` helper is optimized for merge workflows and auto-commits any file changes produced by the validation script.
  - For workflow validation, auto-committing formatter or fixer output would couple validation to merge behavior and create hidden state changes during autonomous execution.
- **Implications**:
  - The design should introduce a lower-level repo validation executor that runs `preMergeCommand`, captures stdout/stderr/exit code, and does not auto-commit.
  - The merge workflow can keep using the existing higher-level helper or a thin wrapper over the new lower-level executor.

### State, Events, and UI Synchronization
- **Context**: The feature needs live status, runtime task edits, reopened tasks, fix-task insertion, and shared-document visibility.
- **Sources Consulted**:
  - `src/stores/workflow.store.ts`
  - `src/components/NotificationListener.tsx`
  - `.kiro/steering/logs.md`
- **Findings**:
  - The current Ralph workflow store pattern is a thin SSE summary cache with React Query invalidation; it is appropriate as a model, but the graph workflow needs richer per-task/per-context patching than the current Ralph store.
  - CC already validates SSE event payloads with Zod on the client and uses targeted query invalidation as a recovery mechanism after reconnects.
- **Implications**:
  - The new graph-workflow client store should patch execution state by task/context/document ID and avoid full refetch on every event.
  - Event schemas must explicitly cover task reopening, auto-created fix tasks, and shared-document registry updates.

### Graph Editing Dependency Verification
- **Context**: The builder requires an interactive node-and-edge editor, and the updated requirements no longer need nested group containers.
- **Sources Consulted**:
  - `package.json`
  - [React Flow migrate to v12](https://reactflow.dev/learn/troubleshooting/migrate-to-v12)
  - [React Flow building a flow](https://reactflow.dev/learn/concepts/building-a-flow)
- **Findings**:
  - The repo does not currently depend on React Flow.
  - Official docs show that React Flow v12 uses the renamed `@xyflow/react` package and requires explicit stylesheet import.
  - The simplified execution-context graph removes the previous need for nested parent/child container behavior, making a standard controlled flow setup sufficient.
- **Implications**:
  - The builder can adopt `@xyflow/react` without also taking on nested-node or subflow complexity.
  - Layout concerns reduce to execution-context node placement and edge routing only; task ordering stays in inspector/list UI rather than on the graph canvas.

### Parallelism Constraints and Query Budget
- **Context**: The requirements say the planner should represent parallelizable execution contexts even though MVP runtime execution remains sequential.
- **Sources Consulted**:
  - `.kiro/steering/tech.md`
  - `src/lib/query-semaphore.ts`
  - `.kiro/steering/ralph-loop.md`
- **Findings**:
  - CC already limits concurrent autonomous SDK queries through a global semaphore.
  - A single session worktree remains the mutable filesystem target for autonomous execution.
- **Implications**:
  - The definition graph should preserve concurrent eligibility, but the scheduler should still select one execution context at a time in MVP.
  - Future parallel execution will require more than scheduler changes; it will need safe filesystem isolation and likely context-level worktree strategy.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Task-node DAG runtime | Every task is a graph node with arbitrary edges and validator gates | Maximum modeling flexibility | Runtime mutation, validation, and pause semantics become too complex for MVP | Rejected by updated requirements |
| Execution-context DAG with ordered task lists | Graph encodes context dependencies; tasks are ordered lists inside each context | Matches updated requirements, simpler runtime edits, cleaner pause semantics | Requires richer context tool contract and task/state coordination | Selected |
| Reuse Ralph Loop directly per context | Treat each execution context as a thin wrapper around Ralph fix plans | Reuses current MCP tools and iteration model | Ralph task groups and semantics do not match explicit task lists, validators, or runtime user edits | Useful reference, not the feature model |

## Design Decisions

### Decision: Use an execution-context DAG with flat task records
- **Context**: Requirements now define dependencies between execution contexts, not between tasks.
- **Alternatives Considered**:
  1. Nested task arrays inside each execution context
  2. Flat `tasks[]` collection keyed by `contextId` and `order`
- **Selected Approach**: Use flat task records with `contextId` and `order` in the canonical schema while presenting them as ordered task lists in the UI.
- **Rationale**: This preserves structured-output friendliness for planner generation, keeps IDs explicit, and simplifies moving tasks between execution contexts.
- **Trade-offs**: The model is slightly less ergonomic to read directly than nested arrays, but it is easier to validate, diff, and mutate.
- **Follow-up**: Verify that planner prompts and validation errors remain understandable with flat task collections.

### Decision: Make `WorkflowExecution` the canonical runtime aggregate
- **Context**: Earlier design review identified duplicate mutable runtime state as a primary architecture risk.
- **Alternatives Considered**:
  1. Store full execution state in both machine context and session aggregate
  2. Keep execution aggregate canonical and limit machine context to lifecycle/control data
- **Selected Approach**: Persist the full `WorkflowExecution` aggregate in session state; keep machine context minimal and persist XState snapshot only for lifecycle restoration.
- **Rationale**: This follows the steering preference for simple, inspectable state and removes drift between runtime copies.
- **Trade-offs**: Actors must read/write through the repository more often, but the contracts stay clearer.
- **Follow-up**: Ensure runtime patches are efficient enough for node/task-level SSE updates.

### Decision: Run one execution-context iteration per actor invocation
- **Context**: Pause now aborts active work immediately and must record an interrupted task.
- **Alternatives Considered**:
  1. One long-running engine actor for the whole workflow
  2. One actor invocation per execution-context iteration
- **Selected Approach**: The machine dispatches exactly one iteration at a time for the active execution context, then reevaluates lifecycle, remaining work, validation, and scheduling.
- **Rationale**: This gives the machine a clean pause/resume boundary and makes interrupted-task handling deterministic.
- **Trade-offs**: More actor transitions and repository writes than a monolithic loop.
- **Follow-up**: Confirm that iteration-level persistence frequency remains acceptable under rapid retries.

### Decision: Use explicit task-state and document tools inside each iteration
- **Context**: The runtime must know the active task, validate task completion, allow scoped task addition, and manage shared documents across fresh conversations.
- **Alternatives Considered**:
  1. Infer task progress from assistant prose
  2. Require explicit MCP tools for task and document state changes
- **Selected Approach**: Each iteration uses a dedicated MCP tool server exposing structured task and document operations.
- **Rationale**: This matches Ralph Loop patterns, keeps mutation deterministic, and provides the visibility needed for pause, validation, and history.
- **Trade-offs**: Prompt/tool guidance must be strong enough that agents use the tools consistently.
- **Follow-up**: Add tool-usage assertions to integration tests.

### Decision: Treat validator output as remediation instructions, not direct mutations
- **Context**: Validators must reopen completed tasks and optionally cause deterministic fix-task creation.
- **Alternatives Considered**:
  1. Let validator agents mutate workflow state directly
  2. Let validator agents return structured remediation output that Command Center applies
- **Selected Approach**: Validator agents return structured JSON; Command Center reopens tasks and creates fix tasks deterministically.
- **Rationale**: This keeps validation auditable, idempotent, and compatible with script validators.
- **Trade-offs**: The response schema is stricter and must be validated aggressively.
- **Follow-up**: Define deduplication for repeated validation issues so fix-task creation remains deterministic across retries.

### Decision: Use a session-worktree shared-document directory with explicit registry entries
- **Context**: Agents need durable cross-iteration and cross-context communication without shared conversation state.
- **Alternatives Considered**:
  1. Scan arbitrary files in the worktree
  2. Use a known directory plus explicit registry tool
- **Selected Approach**: Reserve a known directory in the session worktree and require explicit registration/upsert with description and read guidance.
- **Rationale**: Explicit registry entries are more predictable than filesystem scanning and align with the requirement to tell later agents when to read a document.
- **Trade-offs**: Agents must remember to register documents they create.
- **Follow-up**: Decide whether the registry should surface document size/hash for debugging and stale-file cleanup.

## Risks & Mitigations
- Validator-driven fix-task creation may produce duplicate or low-value tasks — use deterministic issue hashing and suppress duplicate open fix tasks for the same validator issue.
- Runtime user edits can destabilize active execution-context planning — validate edits against current task/context states and reject moves into running or completed contexts.
- Pause/resume correctness depends on explicit active-task tracking — require a task-start tool before meaningful work begins on a task and treat missing task ownership as an iteration error.
- Shared documents may become stale or noisy — store explicit read guidance, update timestamps, and registry ownership metadata so later agents can judge relevance.

## References
- [React Flow: Migrate to v12](https://reactflow.dev/learn/troubleshooting/migrate-to-v12) — package name, style import, and current major-version guidance
- [React Flow: Building a Flow](https://reactflow.dev/learn/concepts/building-a-flow) — controlled flow concepts relevant to the builder UI
- [Stately XState Actors](https://stately.ai/docs/actors) — persisted snapshot and `createActor(..., { snapshot })` restore pattern
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) — SDK capabilities and custom tool integration context
- [Claude Agent SDK Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions) — session persistence behavior and `persistSession: false` implications
