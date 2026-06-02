# Research & Design Decisions

## Summary
- **Feature**: `workflow-continuity`
- **Discovery Scope**: Extension
- **Key Findings**:
  - Graph workflow execution already has the right persistence boundary for this feature: `session.graphWorkflowExecution` survives restart and is scoped to a single execution context.
  - Claude continuity should be built on top of the existing conversation stack because persisted `conversationId`, `claudeSessionId`, `contextTokens`, and `contextWindowMax` are already available and exercised elsewhere in the codebase.
  - Codex continuity can reuse persisted thread IDs through `resumeThread()`, but no context-window metric was found in the local SDK surface or official README, so limit-based rotation must be explicitly disabled for Codex when a context limit is configured.

## Research Log

### Graph Workflow Extension Points
- **Context**: The design needed to fit the current graph workflow runtime rather than introduce a parallel execution stack.
- **Sources Consulted**:
  - `src/lib/workflows/graph-workflow/iteration-orchestrator.ts`
  - `src/lib/workflows/graph-workflow/execution-loop.ts`
  - `src/lib/workflow-graph/execution-repository.ts`
  - `src/lib/workflows/graph-workflow/workflow-manager.ts`
  - `.kiro/specs/workflow-continuity/gap-analysis.md`
- **Findings**:
  - Implementer work already executes inside a well-defined execution-context boundary, and `scheduleNextContext()` is the natural reset point for lane continuity state.
  - `graphWorkflowExecution` already persists mutable runtime state in `state.json`, so continuity metadata can remain within the same aggregate instead of introducing a new store.
  - The iteration orchestrator already reuses one conversation for follow-up turns within a single iteration, which means continuity semantics only need to be extended across iterations and validator invocations.
- **Implications**:
  - The design should extend `graphWorkflowExecution` with lane runtime state rather than create a parallel continuity registry.
  - Context switches should clear lane state in one place inside the workflow manager or continuity service.

### Claude Session Continuity
- **Context**: The design needed to verify whether a new continuity abstraction was required for Claude-backed implementers and validators.
- **Sources Consulted**:
  - `src/lib/prompt/` (prompt domain)
  - `src/lib/conversations/` (conversations domain)
  - `src/lib/workflows/conversation/actor-implementations.ts`
  - `src/lib/agent-backends/claude/query-session.ts`
  - `src/lib/workflows/validation-fix.ts`
  - Anthropic Agent SDK Sessions documentation: <https://platform.claude.com/docs/agent-sdk/sessions>
- **Findings**:
  - `executePromptStream()` already routes prompt execution through the conversation machine, and the machine persists `claudeSessionId`, `contextTokens`, and `contextWindowMax` on the conversation record.
  - `createQuerySession()` already supports `resume`, `forkSession`, and long-lived SDK subprocess reuse.
  - The validation-fix flow demonstrates persisted `claudeSessionId` reuse across retries, which is directly relevant to validator continuity.
- **Implications**:
  - Claude continuity should reuse existing conversation IDs rather than introduce raw SDK session handling in graph workflow modules.
  - Limit evaluation for Claude lanes can be performed from the prompt result metadata already returned by `executePromptStream()`.

### Codex Thread Continuity and Limits
- **Context**: The design needed to confirm whether Codex validators can preserve conversation history and whether configured context limits can be enforced accurately.
- **Sources Consulted**:
  - `src/lib/agent-backends/codex/codex-tool.ts`
  - `node_modules/@openai/codex-sdk/dist/index.d.ts`
  - `node_modules/@openai/codex-sdk/README.md`
  - OpenAI Codex SDK README: <https://github.com/openai/codex/blob/main/sdk/typescript/README.md>
- **Findings**:
  - The SDK supports `startThread()`, repeated `thread.run()`, and `resumeThread(id)`, and threads are persisted in `~/.codex/sessions`.
  - `Thread.id` becomes available after the first turn starts, so the first validation turn must complete before CC can persist a thread ID for reuse.
  - `Turn.usage` and `turn.completed` usage events expose `input_tokens`, `cached_input_tokens`, and `output_tokens`, but no context-window occupancy metric was found.
  - Because the SDK already persists threads on disk, Codex continuity does not require a live in-memory thread registry.
- **Implications**:
  - A small Codex thread runner can start or resume threads on demand per validator invocation and persist only the thread ID plus last turn usage in CC state.
  - Requirement 6.4 should be realized by marking Codex limit evaluation as unsupported instead of approximating with token totals.

### Configuration and UI Fanout
- **Context**: The feature changes how iteration and validator behavior are configured, so the design needed to identify all configuration surfaces.
- **Sources Consulted**:
  - `src/lib/workflows/schemas.ts`
  - `src/lib/workflow-graph/planner-tools.ts`
  - `src/app/projects/[name]/workflows/WorkflowInspectorPanel.tsx`
  - `src/lib/schemas-workflow-graph.test.ts`
- **Findings**:
  - The current implementer configuration lives in `iterationPolicy`, while validator configuration lives inside `taskValidation` and `contextValidation.agentValidator`.
  - Both the workflow builder UI and the planner MCP tool still expose `contextSoftLimitTokens` and `contextHardLimitTokens`.
  - No existing configuration surface models continuity explicitly, so the feature needs both new fields and new defaults.
- **Implications**:
  - The least disruptive placement is to add a reusable continuity policy object to the places where behavior is already configured:
    - `iterationPolicy.continuity`
    - `taskValidation.continuity`
    - `contextValidation.agentValidator.continuity`
  - Replacing the legacy soft/hard pair is a coordinated schema, planner, UI, and test migration.

### History and Reviewability
- **Context**: The requirements allow session reuse across many tasks and validations, so the design needed to preserve reviewability without requiring a new transcript model.
- **Sources Consulted**:
  - `src/app/projects/[name]/[session]/workflow/GraphWorkflowPanel.tsx`
  - `src/app/projects/[name]/[session]/workflow/ExecutionInspectorPanel.tsx`
  - `src/lib/workflow-graph/execution-events.ts`
  - `src/lib/workflows/schemas.ts`
- **Findings**:
  - Implementer task review already hinges on `taskState.lastConversationId`, which remains valid even if many tasks share the same conversation.
  - Validator history is stored in `GraphWorkflowValidationResultEvent`, but that event currently has no session or thread reference.
  - The execution inspector already renders validation history cards, so enriching that event is enough to surface validator linkage.
- **Implications**:
  - The design should extend validation history events with a session reference object instead of inventing a separate validator transcript store.
  - Claude validator references can open existing transcripts by conversation ID; Codex validator references can expose persisted thread IDs and summaries without adding a new thread viewer in this feature.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Inline extension | Put all continuity policy in `iteration-orchestrator.ts` and `execution-route-handlers.ts` | Minimal new files, fast path to implementation | Orchestration files become policy-heavy; Claude/Codex branching leaks across layers | Acceptable only if the feature stayed very narrow |
| Dedicated continuity subsystem | Build a new graph-workflow continuity manager plus separate engine adapters | Clear boundaries, testable policy, future-friendly | Heavier upfront design, more indirection than the current runtime likely needs | Better than inline if the feature expanded into parallel contexts |
| Hybrid continuity service | Add one focused continuity service, reuse current execution runtime, reuse Claude conversation machinery, add a small Codex thread runner | Fits current codebase, isolates policy, no unnecessary subsystem rewrite | Still touches many files because config, persistence, UI, and history all move together | Selected approach |

## Design Decisions

### Decision: Continuity policy stays near existing lane configuration
- **Context**: The feature introduces three independently configurable lanes but should not make the workflow builder harder to reason about.
- **Alternatives Considered**:
  1. Central top-level continuity config per execution context
  2. Continuity policy embedded where each lane is already configured
- **Selected Approach**: Embed a reusable continuity policy object inside `iterationPolicy` for implementers and inside each agent validator config for validators.
- **Rationale**: The builder UI and planner MCP tool already group settings this way, so the feature can extend existing mental models instead of adding a new cross-cutting config block.
- **Trade-offs**: Slight duplication across implementer and validator schemas, but significantly better locality and clearer defaults.
- **Follow-up**: Validate field naming in design review before implementation.

### Decision: Persist lane runtime state on `graphWorkflowExecution`
- **Context**: Continuity must survive restart and remain scoped to one active execution context.
- **Alternatives Considered**:
  1. Keep runtime state in an in-memory registry
  2. Persist lane runtime state in `graphWorkflowExecution`
- **Selected Approach**: Persist compact lane runtime state inside `graphWorkflowExecution`, keyed by lane.
- **Rationale**: The execution aggregate already owns mutable workflow runtime state and is written atomically to `state.json`.
- **Trade-offs**: The execution schema grows, but restart behavior remains deterministic and easy to inspect.
- **Follow-up**: Keep the model focused on active-lane state only; do not archive stale lane state for completed contexts.

### Decision: Reuse Claude conversations, do not build raw SDK session plumbing
- **Context**: Graph workflows need continuity for both implementers and Claude validators.
- **Alternatives Considered**:
  1. Call the Anthropic SDK directly from graph workflow modules
  2. Reuse `createConversation()` plus `executePromptStream()`
- **Selected Approach**: Reuse CC conversations as the continuity anchor for all Claude lanes.
- **Rationale**: Existing transcripts, session resume, context metrics, locking, and SSE behavior are already implemented and tested there.
- **Trade-offs**: Validator continuity still uses the generic `validator` role metadata unless a future feature expands role granularity.
- **Follow-up**: Flow validator session references through validation events so reused validator conversations remain reviewable.

### Decision: Codex continuity is thread-ID based, not process-registry based
- **Context**: Codex validators need continuity, but the current code only supports one-shot turns.
- **Alternatives Considered**:
  1. Keep a live `Thread` registry in memory
  2. Persist thread IDs and start or resume per invocation
- **Selected Approach**: Persist the thread ID after the first turn and use `resumeThread()` on later invocations.
- **Rationale**: The SDK already persists threads in `~/.codex/sessions`, so keeping extra in-memory process state would add complexity without improving correctness.
- **Trade-offs**: Each invocation still reconstructs a thread object, but validator calls are already discrete and this approach survives restarts cleanly.
- **Follow-up**: Capture `turn.usage` so the execution state tracks Codex usage even though limit evaluation remains unsupported.

### Decision: Replace the 85 percent heuristic with explicit post-turn lane evaluation
- **Context**: The feature requires one explicit context limit and prohibits fallback heuristics when no limit is configured.
- **Alternatives Considered**:
  1. Keep `isContextExhausted()` as a hidden fallback
  2. Evaluate configured limits only after completed turns and only for engines that expose the necessary signals
- **Selected Approach**: Remove the implicit 85 percent rule and move all rotation decisions into post-turn continuity recording.
- **Rationale**: This exactly matches the requirement language and keeps behavior explainable.
- **Trade-offs**: Implementer follow-up behavior changes when no limit is configured because follow-up turns can no longer be cut short by a hidden heuristic.
- **Follow-up**: When a fresh implementer session is created mid-context, reseed it with the full iteration prompt rather than a delta-only follow-up prompt.

### Decision: Validator history gets explicit session references
- **Context**: Reviewable linkage is required when validators reuse the same session across multiple invocations.
- **Alternatives Considered**:
  1. Leave validator history unchanged and rely on logs only
  2. Extend validation history events with session references
- **Selected Approach**: Add a session reference object to validation result events and render it in the execution inspector.
- **Rationale**: The execution inspector already renders validation history, so that is the cheapest review surface that satisfies the requirement.
- **Trade-offs**: Codex references will expose thread IDs but not a full CC-native transcript viewer in this feature.
- **Follow-up**: Keep the session reference schema engine-aware so future viewer support can be added without redesigning the event contract.

## Risks & Mitigations
- Legacy soft/hard limit fields appear in schemas, UI, planner output, and tests — mitigate by changing all configuration surfaces in one pass and treating the old heuristic removal as part of the same migration.
- Codex limit evaluation may remain unsupported — mitigate by persisting thread IDs and usage while explicitly flagging limit evaluation as unavailable instead of guessing.
- Validator continuity could become hard to inspect if history is not enriched — mitigate by adding engine-aware session references to validation events and inspector cards.
- Mid-context implementer rotation could lose conversational scaffolding — mitigate by reseeding fresh conversations with the full iteration prompt built from current execution state.

## References
- [Anthropic Agent SDK Sessions](https://platform.claude.com/docs/agent-sdk/sessions) — Confirms persisted session IDs and `resume` behavior.
- [OpenAI Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) — Confirms repeated `thread.run()`, persisted threads, and `resumeThread()`.
- `node_modules/@openai/codex-sdk/dist/index.d.ts` — Confirms `Thread.id`, `Turn.usage`, and the available thread lifecycle API for the installed SDK version.
- `src/lib/workflows/conversation/actor-implementations.ts` — Current Claude session reuse integration point.
- `src/lib/workflow-graph/execution-route-handlers.ts` — Current implementer and validator execution entry points.
