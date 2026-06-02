# Gap Analysis — Workflow Graph Builder

## Status Note

- `requirements.md` exists, but `spec.json` still marks requirements as not yet approved.
- Gap analysis can still proceed and is useful here because this is a brownfield feature with significant architectural overlap with Ralph Loop, project state, and the session UI.

## Current State Investigation

### Existing Assets

| Asset | File(s) | Purpose |
|-------|---------|---------|
| Schema-first modeling with Zod | `src/lib/workflows/schemas.ts` (per-domain; types via `z.infer`) | Canonical data modeling pattern for persisted entities and SSE payloads |
| Global persisted state manager | `src/lib/state-store/` | Atomic read/mutate/write over `state.json`; already supports project-level and session-level entities |
| Project-level CRUD precedent | `src/lib/state-store/`, `src/app/api/projects/[name]/roadmap-items/*.ts` | Existing pattern for project-scoped resources with REST routes and client validation |
| Session-scoped workflow runtime | `src/lib/workflows/schemas.ts`, `src/lib/ralph-loop/workflow-route-handlers.ts` | Current Ralph Loop workflow is stored as `session.workflow` with session-local history |
| Generic workflow/XState infrastructure | `src/lib/workflows/types.ts`, `src/lib/workflows/actions.ts`, `src/lib/workflows/persistence.ts` | Reusable actor persistence, SSE broadcasting, runtime registries, and machine conventions |
| Ralph Loop machine/runtime | `src/lib/workflows/ralph-loop/*`, `src/lib/ralph-loop/*` | Iterative autonomous execution engine, circuit breaker, plan generation, per-iteration MCP tools |
| Structured AI planning pattern | `src/lib/ralph-loop/plan-generator.ts`, `src/lib/ralph-loop/init-tool.ts` | Existing pattern for SDK queries that capture structured output via in-process MCP tools |
| Existing workflow UI shell | `src/app/projects/[name]/[session]/workflow/*`, `src/stores/workflow.store.ts` | Session workflow page, config panel, task editor, live iteration stream, SSE-driven client tracking |
| Task editing and drag/reorder pattern | `src/app/projects/[name]/[session]/workflow/TaskPlanEditor.tsx` | Existing ordered-list editing UX for session task plans |
| Read-only diagram rendering | `src/components/MermaidDiagram.tsx`, `package.json` | Mermaid rendering with zoom/pan; useful for display but not editing |
| Script validation entry point | `src/lib/repo-config.ts`, `CommandCenter.json` support in `src/lib/workflows/schemas.ts` | Existing project-configured pre-merge command that can be reused by execution-context validators |
| Session worktree document precedent | `src/lib/sessions.ts`, `src/app/api/projects/[name]/sessions/[session]/focus-doc/route.ts` | Existing pattern for known files inside a session worktree (`memory-bank/focus.md`) |

### Architectural Constraints Observed

1. **Current workflow model is Ralph-specific and flat**
   - `session.workflow` stores one objective, one ordered `fixPlan`, one configuration block, one circuit breaker, and one iteration history.
   - There is no concept of reusable workflow definitions, execution contexts, dependency edges, layout data, or separate execution-state entities.

2. **Persistence boundaries do not match the new requirements**
   - Current workflow persistence is session-scoped inside the global config directory's `state.json`.
   - The new feature requires **project-level reusable workflow definitions** plus **session-scoped execution instances**.

3. **The UI has no graph editor foundation**
   - The repo already ships Mermaid for rendering diagrams, but there is no graph editor library such as React Flow / XYFlow and no existing canvas/node-editor subsystem.
   - Existing drag-and-drop is limited to ordered list items inside `TaskPlanEditor.tsx`.

4. **Validation exists only in narrow forms**
   - Ralph Loop validates progress through `report_status`, exit detection, and circuit breakers.
   - Script validation exists only via `runPreMergeValidation()`.
   - There is no generalized task validator or execution-context validator pipeline, no structured validation-issue model, and no reopen/fix-task workflow outside the flat fix-plan mutations.

5. **Observability is workflow-specific rather than graph-runtime-generic**
   - Existing SSE and Zustand support workflow lifecycle events, iteration completion, fix-plan updates, and circuit-breaker events.
   - There is no event vocabulary for execution-context transitions, task reopen events, validator outcomes, runtime edit rejections, or workflow-definition save errors.

6. **Shared document handling is ad hoc**
   - Ralph Loop supports optional `references` and session focus documents, but there is no explicit shared-document registry with file path, description, and read guidance as first-class runtime state.

### Conventions to Reuse

- New persisted entities should be Zod-first and derived into types.
- Project-scoped resources already use REST routes under `src/app/api/projects/[name]/...`.
- Long-running workflow execution should follow the XState v5 machine pattern already established under `src/lib/workflows/`.
- Non-serializable runtime objects should stay in `runtime-state.ts`-style registries, not in machine context.
- Client API responses are validated with Zod in `src/lib/api-client.ts`.
- Tests should follow the existing DI-heavy style rather than `vi.mock()` for internal modules.

---

## Requirements Feasibility Analysis

## Requirement-to-Asset Map

### 1. Workflow Definition Model and Integrity Validation

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Schema-first workflow definition with stable IDs, semantic/layout/runtime layers, versioning | `src/lib/workflows/schemas.ts` schema-first convention | **Missing** — no workflow-graph schemas, no layered model, no versioned workflow-definition entity |
| Semantic integrity validation for DAGs, ID uniqueness, ownership rules, runtime edit validation | Zod + existing validation helpers patterns | **Missing** — no DAG validator, no topological validation utilities, no runtime edit validator |
| Future-extensible persisted model | Zod + `.passthrough()` precedent on Ralph workflow | **Available pattern** but **Missing implementation** for this domain |

### 2. Execution Contexts, Tasks, Dependencies, Validation Policies, Circuit Breakers

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Execution contexts as first-class entities with model/effort, iteration policy, circuit breaker, validator config | Ralph workflow config + circuit breaker config in `src/lib/workflows/schemas.ts` | **Missing** — current config applies to one whole workflow, not per execution context |
| Ordered tasks owned by exactly one execution context | `fixPlan` tasks and `TaskPlanEditor.tsx` | **Constraint** — current tasks are flat and grouped numerically, not owned by execution-context entities |
| Dependency graph between execution contexts | Ralph task groups imply rough ordering | **Missing** — no graph edges, no entry/terminal context detection, no concurrently-eligible context calculation |
| Task-level and execution-context-level validation with structured issues, reopen, and fix-task creation | `update_fix_plan` tool, `runPreMergeValidation()` | **Missing** — no validator abstraction, no issue schema, no reopen-by-validator behavior, no validator-specific agent config |
| Retry policies targeted at execution contexts | Ralph loop can continue iterations until halt | **Missing** — no retry-target model, no validation-boundary retry orchestration |
| Circuit breakers per execution context | Ralph circuit breaker machine | **Constraint** — only one workflow-wide circuit breaker exists today |

### 3. Runtime Mutability and Editing Rules

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Agent may add tasks only inside current execution context if policy allows | `update_fix_plan` supports adding tasks | **Constraint** — additions are flat workflow tasks, not context-scoped or policy-scoped |
| User runtime editing of incomplete tasks, including move between execution contexts | `TaskPlanEditor.tsx` supports add/edit/remove/reorder pending tasks | **Missing** — no multi-context UI, no move semantics, no runtime edit validation against context status |
| Prevent edits to completed execution contexts and dependency edges at runtime | Ralph workflow terminal checks and task edit limits | **Missing** — no execution-context status model or graph-edit rules |

### 4. Visual Workflow Editor

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Interactive graph editor for contexts and edges | `MermaidDiagram.tsx` | **Constraint** — existing diagram support is render-only |
| Node selection + side-panel editing for context properties and task list | Existing workflow config panel and task editor | **Partial** — side-panel editing patterns exist, but no selected-node model or graph canvas integration |
| Layout persistence separate from semantics | Schema-first persistence conventions | **Missing** — no layout schema or API |
| Unsaved-changes indication | Existing local-edit patterns in workflow UI | **Missing** — not implemented for graph documents |

### 5. Project-Level Workflow Persistence and AI Planning

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Project-scoped CRUD for workflow definitions | Roadmap item CRUD (`src/lib/state-store/`, `/api/projects/[name]/roadmap-items`) | **Partial** — strong pattern exists, but no workflow-definition store or routes |
| Save both semantic definition and layout | State manager and project-scoped routes | **Missing** — no workflow-definition persistence model |
| Unique IDs for definitions | `randomUUID()` pattern in `state.ts` | **Available pattern** |
| AI-generated workflow definitions through structured output | `plan-generator.ts`, `init-tool.ts` | **Partial** — existing structured output covers flat task plans only |
| Validation of agent-generated drafts before save | API boundary validation + Zod | **Missing** — no workflow-definition validator or draft review flow |

### 6. Execution Lifecycle, Scheduling, Persistence, and Observability

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Start/pause/resume/abort session-scoped execution instance from a saved definition | Ralph workflow routes + workflow manager | **Constraint** — runtime is tied to session-owned workflow state rather than a saved definition reference |
| Persist execution state across server restarts | `src/lib/workflows/persistence.ts` | **Available pattern** but **Missing implementation** for graph execution instances |
| Schedule execution contexts by dependency order, sequential in MVP, concurrency-aware in schema | Ralph loop iteration engine | **Constraint** — existing scheduler iterates one flat task list, not DAG contexts |
| Fresh conversation per execution-context iteration | Ralph loop already creates fresh iteration conversations | **Strong reusable pattern** |
| Tool-enforced task completion | `update_fix_plan` and `report_status` tools | **Constraint** — tools are workflow-global and flat-task-based, not per-context task-completion validators |
| Real-time status updates, history, validator results, retry/circuit-breaker events | Workflow SSE + Zustand store | **Partial** — transport exists, but event vocabulary and store model are too narrow |

### 7. Persistent Shared Documents

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Known directory in session worktree for shared agent-authored documents | `memory-bank/focus.md`, optional Ralph references | **Partial** — known file patterns exist, but no dedicated shared-documents directory contract |
| Explicit shared-document registry with path, description, and read guidance | `workflow.references` | **Constraint** — references are static input, not a mutable registry of agent-authored docs |
| Registry included in new execution-context conversations | `prompt-builder.ts` includes static references | **Missing** — no session-scoped shared-document registry hydrated into every context iteration |

---

## Complexity Signals

- **Architectural breadth**: The feature cuts across schemas, persistence, API routes, planner output, runtime execution, SSE, client stores, and new UI/editor infrastructure.
- **New domain model**: Execution contexts and edges are not a small extension of Ralph's grouped flat tasks; they are a different abstraction.
- **Brownfield overlap**: The new system must coexist with Ralph Loop in the same product without corrupting current session workflow semantics.
- **UI infrastructure gap**: The codebase does not yet contain a graph editor foundation, only list editing and read-only Mermaid display.
- **Validation orchestration**: Validator-directed reopen and fix-task insertion introduce non-trivial runtime state transitions and boundary rules.

---

## Implementation Approach Options

### Option A: Extend Ralph Loop In Place

Use `session.workflow` as the primary storage model, evolve `fixPlan` into execution-context/task structures, and retrofit the existing workflow page and routes.

**Trade-offs**
- ✅ Minimizes initial surface area and may reuse more current UI and route code
- ✅ Keeps all autonomous execution under the Ralph umbrella
- ❌ Forces a fundamentally different model into a schema designed for one objective + one flat task list
- ❌ Risks making `session.workflow` polymorphic and difficult to reason about
- ❌ Complicates backward compatibility and recovery logic for current Ralph sessions
- ❌ Makes project-level reusable definitions awkward because current storage is session-owned

**Assessment**
- Viable only if the scope were reduced to "Ralph with DAG groups." It does not fit the approved requirement set cleanly.

### Option B: Create a Separate Workflow-Graph Subsystem

Introduce a new domain alongside Ralph Loop:
- project-level workflow-definition entities
- session-level workflow-execution entities
- dedicated graph schemas, validators, routes, stores, planner, and execution machine

**Trade-offs**
- ✅ Clean separation between existing Ralph semantics and the new graph model
- ✅ Natural fit for project-scoped definitions plus session-scoped executions
- ✅ Easier to reason about schema evolution and future parallel execution
- ✅ Keeps existing Ralph functionality stable during rollout
- ❌ More files and integration seams
- ❌ Requires new UI/editor infrastructure from scratch
- ❌ Requires explicit bridge points where existing generic workflow infrastructure is reused

**Assessment**
- Strong architectural fit, but expensive. Best when correctness and long-term maintainability matter more than minimizing file count.

### Option C: Hybrid Approach

Create a new workflow-graph domain model and runtime, but reuse shared infrastructure wherever the abstractions already fit:
- reuse `state.ts` mutation patterns
- reuse project-scoped CRUD route/query conventions from roadmap items
- reuse generic XState persistence/actions/runtime-state patterns
- reuse session conversation creation and transcript infrastructure
- reuse `runPreMergeValidation()` for execution-context script validators
- reuse task-editor and config-panel UI patterns where they remain valid

**Trade-offs**
- ✅ Preserves clean domain boundaries without rewriting useful shared plumbing
- ✅ Limits risk by reusing proven state, route, and runtime patterns
- ✅ Makes coexistence with Ralph Loop practical
- ❌ Requires discipline to avoid leaking Ralph assumptions into the new model
- ❌ Still requires a real graph editor decision and new event/store vocabulary

**Assessment**
- Best overall fit for the current codebase and requirement set.

---

## Effort and Risk

**Effort: XL (2+ weeks)**

One-line justification: this feature introduces a new persisted domain model, a new interactive editor class, a new execution runtime abstraction, and several integration layers rather than extending a single module.

**Risk: High**

One-line justification: the hardest parts are not individual files but the boundary decisions: project-vs-session persistence, graph editor choice, validator/retry semantics, and how much of Ralph infrastructure can be reused without inheriting the wrong model.

---

## Recommendations for Design Phase

### Preferred Approach

Prefer **Option C (Hybrid)**:

- build a **new workflow-graph domain** rather than mutating Ralph's flat workflow schema into something it is not
- keep **workflow definitions project-scoped**
- keep **workflow executions session-scoped**
- reuse existing **XState workflow infrastructure**, **state mutation patterns**, **project route conventions**, and **script-validation hook** where the abstraction is already generic

### Key Design Decisions Needed

1. **Persistence shape**
   - Decide whether workflow definitions live inside `state.json` as new project-level entities or in repo-local files under the project root.
   - The current codebase strongly supports `state.json`, but repo-local files may better satisfy portability/review needs.

2. **Execution data model**
   - Define the boundary between immutable saved definition, mutable visual layout, and mutable execution instance.
   - Avoid storing runtime-only counters or conversation IDs inside the reusable definition object.

3. **Graph editor implementation**
   - Choose whether to add a dedicated editor library or build a custom MVP editor.
   - Current repo assets support rendering and list editing, not node-edge editing.

4. **Validator contract**
   - Define the shared response schema for task validators and execution-context validators.
   - Specify how reopen requests, structured issues, and auto-created fix tasks are represented.

5. **Shared-document contract**
   - Define the session worktree directory, registry shape, and how agents register/update documents.
   - Decide whether this is managed through tools, API routes, or both.

6. **Coexistence strategy with Ralph Loop**
   - Decide whether the graph runtime will reuse Ralph iteration execution internals directly or wrap them behind a new execution-context actor boundary.
   - The design should avoid making `session.workflow` ambiguous.

### Research Needed

1. **Graph editor choice**
   - Evaluate whether to introduce a node/edge editor dependency or implement an internal MVP.

2. **Project-level persistence location**
   - Compare storing workflow definitions in global `state.json` versus repo-local project files.

3. **Execution-context validator schema**
   - Design the structured payload for validation issues, reopened tasks, retry targets, and auto-fix task creation.

4. **Shared-document registry UX**
   - Determine whether document registration is agent-driven via MCP tool calls, user-driven in UI, or both.

5. **Scheduling model for MVP**
   - Define the exact state machine shape for sequential execution of a DAG while preserving future concurrency metadata.

6. **Event model**
   - Define the SSE/Zustand vocabulary for definition saves, execution-context transitions, task reopen events, validation failures, retry attempts, and graph-runtime edits.

---

## Analysis Summary

- The repo already has strong reusable infrastructure for schema-first modeling, project/session state mutation, XState workflow persistence, SSE broadcasting, and structured AI tool output.
- The current Ralph Loop implementation is a useful runtime reference, but it is structurally a flat session workflow, not a reusable graph-definition system.
- The biggest gaps are project-level workflow-definition persistence, graph editor infrastructure, execution-context runtime semantics, validator/retry orchestration, and shared-document registry support.
- Reusing generic infrastructure is realistic; reusing Ralph's data model as-is is not.
- The design phase should treat this as a new workflow-graph subsystem that coexists with Ralph Loop rather than a small extension of the existing fix-plan engine.
