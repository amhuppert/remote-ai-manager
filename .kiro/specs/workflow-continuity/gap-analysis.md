# Gap Analysis — workflow-continuity

## Status Note

- `requirements.md` exists, but `spec.json` still marks requirements as not yet approved.
- Gap analysis can still proceed and is useful here because this is a brownfield change that cuts across graph workflow schemas, execution persistence, validator orchestration, conversation runtime reuse, and workflow configuration UI.

## Current State Investigation

### Existing Assets

| Asset | File(s) | Purpose |
|-------|---------|---------|
| Graph workflow execution persistence | `src/lib/schemas.ts`, `src/lib/workflow-graph/execution-repository.ts`, `src/lib/workflows/graph-workflow/workflow-manager.ts` | Persists active execution state inside `session.graphWorkflowExecution` and already survives restart/resume flows. |
| Implementer iteration orchestration | `src/lib/workflows/graph-workflow/iteration-orchestrator.ts`, `src/lib/workflows/graph-workflow/execution-loop.ts` | Runs one execution-context iteration at a time, increments iteration counters, and already has the execution-context boundary where continuity must reset. |
| Claude conversation continuity primitives | `src/lib/workflows/conversation/actor-implementations.ts`, `src/lib/query-session.ts`, `src/lib/workflows/conversation/manager.ts`, `src/lib/prompt.ts` | Already supports persisted Claude session IDs, resumed sessions, long-lived SDK subprocesses, and context token/window tracking. |
| Current validator orchestration | `src/lib/workflow-graph/validator-runner.ts`, `src/lib/workflow-graph/execution-validation.ts`, `src/lib/workflow-graph/execution-route-handlers.ts` | Provides task-level and execution-context-level validator prompts and dispatch, but each invocation is currently one-shot. |
| Codex one-shot execution helper | `src/lib/codex-tool.ts` | Runs Codex as a fresh thread per call today. This is the main surface that would need a persistent-thread wrapper for continuity. |
| Workflow builder schema and planner output | `src/lib/schemas.ts`, `src/lib/workflow-graph/planner-tools.ts` | Defines iteration policy and validator config, but still models the old soft/hard token limit pair and exposes no continuity settings. |
| Workflow configuration UI | `src/app/projects/[name]/workflows/WorkflowInspectorPanel.tsx` | Already edits iteration policy and validator config, so it is the natural UI surface for continuity and single-limit settings. |
| Execution history and transcript linkage | `src/app/projects/[name]/[session]/workflow/GraphWorkflowPanel.tsx`, `src/lib/schemas.ts` | Task state already stores `lastConversationId`, and the UI already opens a transcript by conversation ID, which is compatible with reused sessions. |
| Claude session reuse precedent outside graph workflows | `src/lib/validation-fix.ts` | Demonstrates persisted `claudeSessionId` reuse across retries and is a concrete local pattern for resumed Claude work. |

### Architectural Constraints Observed

1. **Implementer iterations are intentionally fresh today**
   - `iteration-orchestrator.ts` creates a new role=`iteration` conversation at the start of every `runIteration()`.
   - That makes continuity impossible until conversation selection becomes lane-aware instead of unconditional.

2. **Validator execution is stateless and lane-agnostic**
   - Claude validators create a fresh role=`validator` conversation per invocation in `execution-route-handlers.ts`.
   - Codex validators call `runCodexDefault()`, which creates a fresh `codex.startThread()` for every invocation.
   - There is no persisted distinction between task-validator and execution-context-validator sessions.

3. **The current context-limit model is split across schema and heuristic runtime logic**
   - `graphWorkflowIterationPolicySchema` still exposes `contextSoftLimitTokens` and `contextHardLimitTokens`.
   - `iteration-prompt.ts` still enforces a hardcoded `0.85` context exhaustion threshold for follow-up prompts inside an iteration.
   - The requested single explicit limit model does not exist anywhere in the current stack.

4. **Execution persistence has no lane continuity state**
   - `graphWorkflowExecutionSchema` persists task state, retry state, shared documents, and history.
   - It does not persist implementer continuity state, task-validator continuity state, or execution-context-validator continuity state.
   - That means continuity cannot survive restart today.

5. **Conversation role granularity is too coarse for validator lanes**
   - `conversationRoleSchema` supports only `initialization`, `iteration`, and `validator`.
   - That is sufficient for transcript grouping, but not enough to identify separate task-validator and context-validator lanes without additional execution-level metadata.

6. **Claude and Codex have materially different telemetry surfaces**
   - Claude already propagates `claudeSessionId`, `contextTokens`, and `contextWindowMax` through the conversation machine.
   - Local Codex SDK docs and types confirm persistent threads and per-turn usage fields, but no Claude-style context-window signal was found.
   - Requirement 6 therefore depends on engine-specific handling rather than one shared implementation path.

### Conventions to Reuse

- New persisted execution data should remain Zod-first in `src/lib/schemas.ts`.
- Graph workflow runtime state should continue living inside `session.graphWorkflowExecution`, not in an external store.
- Claude continuity should reuse the existing conversation stack instead of introducing raw SDK session handling directly into graph workflow code.
- Internal modules should continue following the project's DI-heavy testable factory pattern.
- UI changes should extend the existing workflow inspector rather than introducing a separate configuration surface.

---

## Requirements Feasibility Analysis

### Requirement-to-Asset Map

| Requirement | Existing Asset | Gap |
|-------------|---------------|-----|
| **Req 1: Continuity configuration per lane with defaults enabled** | `graphWorkflowIterationPolicySchema`, validator schemas, `WorkflowInspectorPanel.tsx`, `planner-tools.ts` | **Missing** — no continuity fields for implementer, task validator, or execution-context validator; current defaults do not express continuity at all. |
| **Req 2: Implementer continuity within one execution context** | `iteration-orchestrator.ts`, `executePromptStream()`, Claude conversation runtime | **Partial** — execution-context boundaries already exist, and Claude resume support exists, but implementer iterations always allocate a fresh conversation and do not persist lane session identity. |
| **Req 3: Task-level validator continuity with independent lane state** | `validator-runner.ts`, `execution-validation.ts` | **Missing** — task validators are one-shot and there is no persisted task-validator lane state, conversation ID, Claude session ID, Codex thread ID, or per-lane limit bookkeeping. |
| **Req 4: Execution-context validator continuity with independent lane state** | `validator-runner.ts`, `execution-validation.ts` | **Missing** — same gap as task validators, plus there is currently no separation between the two validator lanes beyond which function built the prompt. |
| **Req 5: Execution-context boundaries and lane isolation** | `activeContextId`, `scheduleNextContext()`, per-context task state | **Partial** — execution-context scheduling already exists, so the reset boundary is well-defined, but lane-scoped continuity state is not modeled and cannot yet be cleared or rotated intentionally. |
| **Req 6: Single context-limit model with no fallback heuristic** | Claude context telemetry in conversation runtime; current `isContextExhausted()` heuristic | **Missing / Constraint** — Claude can likely support explicit limit checks, but the schema and runtime still encode soft/hard or 85% behavior, and Codex lacks confirmed context-window telemetry needed for comparable limit evaluation. |
| **Req 7: Persistence and reviewable history across reused sessions** | `graphWorkflowExecutionSchema`, `history`, `taskState.lastConversationId`, transcript viewer | **Partial** — execution persistence and transcript viewing already exist, but there is no continuity state persistence and no explicit execution-level linkage for validator lane conversations. |

### Additional Gaps and Constraints

1. **Schema migration fanout is broad**
   - `src/lib/schemas.ts`, `src/lib/workflow-graph/planner-tools.ts`, `src/app/projects/[name]/workflows/WorkflowInspectorPanel.tsx`, and `src/lib/schemas-workflow-graph.test.ts` all encode the old iteration-policy shape.
   - Replacing soft/hard limits is not just a runtime change.

2. **Implementer continuity likely needs execution-owned conversation identity**
   - Reusing the same implementer session across iterations implies the next iteration must know which conversation to resume.
   - That state is not currently stored anywhere in `graphWorkflowExecution`.

3. **Validator continuity needs an engine-neutral lane state abstraction**
   - Claude continuity wants conversation ID plus Claude session/context metrics.
   - Codex continuity wants at least a persisted thread ID and likely per-turn usage capture.
   - Putting this branching directly into route handlers would work, but it would mix policy, persistence, and engine-specific runtime code in one place.

4. **Current transcript linkage is task-centric, not lane-centric**
   - `taskState.lastConversationId` is enough to keep task logs reviewable when a reused implementer session touches multiple tasks.
   - There is no equivalent field for task-validator or execution-context-validator transcript linkage today.

5. **Codex limit-based rotation is likely unavailable without further SDK support**
   - Local Codex SDK docs show `startThread()`, repeated `thread.run()`, and `resumeThread()` support.
   - The exposed usage fields are per-turn token counts, not session window occupancy.
   - Requirement 6.4 already allows disabling limit-based rotation for such engines, which fits the current evidence.

### Complexity Signals

- **Cross-cutting configuration change**: schema, planner tool output, editor UI, and tests must all move together.
- **Execution-state expansion**: continuity only works if lane state is persisted in the execution object and updated after each turn.
- **Engine divergence**: Claude and Codex continuity can share policy concepts, but not the exact runtime implementation.
- **Behavioral migration risk**: the old 85% heuristic currently influences implementer follow-up behavior; removing or replacing it changes runtime behavior, not just configuration.

---

## Implementation Approach Options

### Option A: Extend Existing Graph Workflow Runtime Directly

Add continuity fields to the existing graph workflow schemas and implement the policy inline inside `iteration-orchestrator.ts` and `execution-route-handlers.ts`.

- Store per-lane continuity state directly on `graphWorkflowExecution`.
- Reuse `createConversation()` and `executePromptStream()` for Claude lanes.
- Add minimal Codex thread persistence directly in the validator route handler path.

**Trade-offs**
- ✅ Smallest number of new modules
- ✅ Reuses the current graph execution flow with minimal routing changes
- ✅ Easy to keep behavior close to today's orchestration
- ❌ Risks bloating already busy orchestration files with engine-specific branching
- ❌ Makes task-validator and execution-context-validator logic harder to reason about
- ❌ Harder to test continuity policy independently from routing and execution

**Assessment**
- Viable for a narrow implementation, but it pushes too much policy into orchestration code that already handles execution flow, streaming, and validation outcomes.

### Option B: Create a Dedicated Workflow Continuity Manager

Introduce a new continuity-focused module that owns lane selection, persistence updates, session rotation rules, and engine-specific resume behavior.

- Graph runtime asks the continuity manager for the active lane session before each implementer or validator turn.
- The continuity manager decides whether to reuse, rotate, or create a fresh lane session.
- Claude and Codex engine differences live behind that abstraction.

**Trade-offs**
- ✅ Clear separation between execution flow and continuity policy
- ✅ Easier to test lane rotation, boundary resets, and engine-specific fallbacks
- ✅ Natural place to keep Codex-specific constraints without polluting route handlers
- ❌ More new files and interfaces
- ❌ Requires careful design so it does not become a generic abstraction with unclear ownership

**Assessment**
- Architecturally clean, but potentially heavier than necessary if it grows beyond the concrete needs of graph workflows.

### Option C: Hybrid Approach

Keep graph workflow orchestration where it is, but introduce one focused continuity service plus narrowly scoped execution-state additions.

- Extend graph workflow schemas with lane continuity config and persisted lane runtime state.
- Reuse existing Claude conversation machinery for Claude lanes.
- Add a small Codex persistent-thread wrapper for validator lanes.
- Let `iteration-orchestrator.ts` and validator dispatch ask the continuity service for "which lane session/thread should this turn use right now?"

**Trade-offs**
- ✅ Reuses the strongest existing assets instead of replacing them
- ✅ Keeps continuity policy centralized without building a whole new workflow subsystem
- ✅ Matches the asymmetric Claude/Codex reality cleanly
- ❌ Still requires touching many files because config, persistence, runtime, and UI all change together
- ❌ Requires disciplined boundaries so the continuity service stays specific and concrete

**Assessment**
- Best overall fit for the current codebase and requirement set.

---

## Effort and Risk

**Effort: L (1–2 weeks)**

One-line justification: this is a medium-large brownfield change touching schemas, UI, planner output, execution persistence, validator orchestration, Codex integration, and a broad test surface, but it reuses strong existing execution and Claude continuity primitives.

**Risk: Medium**

One-line justification: the main architecture is clear and local patterns exist, but Codex limit handling remains constrained by SDK telemetry and the behavior shift away from the 85% heuristic must be applied consistently.

---

## Recommendations for Design Phase

### Preferred Approach

Prefer **Option C (Hybrid)**:

- add explicit continuity configuration and persisted lane state to the graph workflow model
- reuse the existing Claude conversation runtime for all Claude continuity behavior
- add a dedicated, small continuity service to keep lane selection and rotation rules out of orchestration code
- treat Codex continuity as persistent-thread reuse plus engine-specific fallback when explicit context-limit evaluation is unavailable

### Key Design Decisions Needed

1. **Persisted lane state shape**
   - Decide exactly what each lane stores in `graphWorkflowExecution`.
   - Likely fields include lane type, conversation ID or thread ID, engine type, last-known context metrics, and whether limit-based rotation is supported.

2. **Configuration placement**
   - Decide whether implementer continuity belongs inside `iterationPolicy` or a new sibling config object.
   - Decide whether validator continuity belongs inside each validator config or a shared validator policy wrapper.
   - The design should optimize for clarity in the builder UI and planner tool output.

3. **Rotation timing contract**
   - The requirement is "rotate only after the agent concludes and is over limit."
   - The design must specify exactly where that post-turn evaluation lives for implementer iterations, task validators, and execution-context validators.

4. **Validator transcript linkage**
   - Decide how task-validator and execution-context-validator conversations or threads are surfaced in execution history.
   - Current task transcript linkage is adequate for implementer reuse, but validator linkage needs an explicit runtime representation.

5. **Codex thread lifecycle**
   - Decide where Codex thread IDs are stored, when `resumeThread()` is used, and whether a dedicated helper should replace `runCodexDefault()` for continuity-enabled validator lanes.

### Research Needed

1. **Codex context-limit telemetry**
   - Confirm whether any usable context-window metric exists beyond the currently visible per-turn usage fields.

2. **UI wording and config ergonomics**
   - Validate the least confusing way to expose continuity and single context-limit settings for three different lanes without making the workflow inspector noisy.

3. **Validator history shape**
   - Decide whether execution history needs new event payload fields to expose reused validator sessions clearly, or whether lane state plus existing history is sufficient.
