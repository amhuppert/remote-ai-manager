# 06 — Live Editing of Launched Graph Workflows

Status: **implemented** (all decisions confirmed with Alex, 2026-07-07; revised same day after an
independent design review — findings 1–5 incorporated as D14–D16 + classifier/policy amendments, then implemented behind `cctl workflow live …`).
This document is decision-complete: every open question from the design collaboration has a locked
answer, recorded in §Decisions.

## Problem

Doc 05 gave agents targeted, token-efficient editing of **saved** workflow definitions. Launched
executions are still effectively immutable: the only runtime mutations are a task-only, UI-only
runtime-edit endpoint and the mutability-gated lane-agent `add_task`. When a running workflow needs
a different model on a future context, a bumped iteration cap after a `max_iterations` halt, an
extra verification context appended downstream, or a repaired task list in a paused context, the
operator's only options are the narrow task editor or abort-and-relaunch.

This doc specifies **live editing** of the active execution: per-context config edits, task edits,
and safe structural edits — via one server core exposed to agents (`cctl workflow live …`) and
humans (the execution inspector) with identical semantics. Graph-workflow invariants hold at every
step; the API is optimized for agent ease-of-use and token efficiency.

The governing policy (Alex's rule, mapped onto machine state):

- **Completed contexts are frozen** — never editable.
- **Not-started contexts are fully editable** — prose, config, and task edits land even while the
  workflow runs; edits that change the graph's *shape* (add/remove context or edge) additionally
  require the workflow to be quiescent (see §Structural edit boundaries — an intentional v1
  narrowing of "fully editable").
- **In-progress contexts are editable after pausing** the workflow.

## Current state (what we build on)

- **Runtime task edits exist**: `workflowRuntimeEditRequestSchema` (`src/lib/workflows/schemas.ts:1536-1589`,
  ops `add`/`update`/`remove`/`reorder`/`move`), applied by `src/lib/workflow-graph/runtime-edits.ts`
  through `POST …/graph-workflow/runtime-edits` (`runtime-edit-route-handlers.ts`), with task-lock
  rules in `validateWorkflowRuntimeEdit` (`validation.ts:333-460`). Callers: UI only
  (`useRuntimeEditGraphWorkflowMutation`, `mutations.ts:358`) plus tests.
- **Lane-agent self-add exists**: `POST …/graph-workflow/contexts/[contextId]/tasks`
  (`lane-route-handlers.ts:267-311`) → `applyAgentTaskAdd` (`runtime-edits.ts:203-289`), driven by
  `cctl workflow task add`, gated by `mutability.allowAgentTaskAdd`, allowed while running.
- **Definition editing (doc 05) is the ergonomic template**: outline-by-default reads, stable-id
  addressing, ordered atomic `operations[]`, `--dry-run`, revision guard, `code`-bearing error
  contract.
- **Executions store a resolved working copy**: `workingDefinition`
  (`resolvedWorkflowSemanticDefinitionSchema`, `schemas.ts:513-521`) — the config cascade is already
  flattened per context; no parameters/prerequisites/workflow-tier config exist at runtime.
  `seedDefinitionId`/`seedDefinitionRevision` are audit fields only.
- **The scheduler reads the working copy live**: `getEligibleContextIds` (`validation.ts:281-308`)
  walks `execution.workingDefinition.edges` on every tick (`execution-loop.ts:1801`), so accepted
  edits take effect on the next tick with no extra plumbing.
- **Pause is the unlock mechanism**: pause (`workflow-manager.ts:738-759`) interrupts running tasks
  (→ `interrupted`), demotes active contexts (`running` → `ready`), and aborts in-flight SDK
  conversations. Resume (`workflow-manager.ts:850-969`) accepts `paused`/`halted`, resets failed
  joins, clears failure counters, and re-enters the loop.
- **Two bugs/gaps this design fixes on the way**:
  1. `graphWorkflowResolvedContextSchema` (`schemas.ts:488-509`) omits `collaboration`, so
     `lane-tool-context-loader.ts:209-216` reloads the **mutable saved definition** by
     `seedDefinitionId` at runtime — a saved-definition edit silently leaks into a running
     execution, and a live collaboration edit would be a no-op.
  2. Pause/resume are UI-only; agents cannot script the pause → edit → resume loop.

## Design overview

One pure edit core, three entry points, two guards, one invariant:

```
                       ┌──────────────────────────────┐
  cctl workflow live ──┤                              │
  inspector UI ────────┤  POST …/graph-workflow/      │──▶ applyLiveExecutionEdits (pure)
  lane agent add_task ─┤       runtime-edits          │      │ per-op lifecycle classifier
                       └──────────────────────────────┘      │ frontier invariant + revalidation
                              │ baseLiveRevision guard       │ runtime-map + lanePlan sync
                              ▼                              ▼
                    mutateActiveGraphWorkflowExecution  (serialized, atomic)
                              │
                              ├─▶ graph_workflow_events append (audit)
                              └─▶ graph-workflow-live-edit-applied SSE → UI invalidation
```

- **Working-copy model**: live edits mutate `execution.workingDefinition` + runtime maps. Saved
  definitions are never touched; saved-definition edits never touch running executions.
- **Resolved-value contract**: config edits set **concrete resolved values** (`model: "opus"`,
  `reasoningEffort: "high"`). There is no cascade at runtime; "clear override to inherit" does not
  exist here. Launch-time inputs (`boundInputs`), parameters, and prerequisites are not editable.
- **Two concurrency guards, complementary**: `liveRevision`/`baseLiveRevision` catches
  *edit-vs-edit* lost updates (two operators on one paused execution); the apply-time classifier
  re-check inside the serialized mutation catches *edit-vs-scheduler* races (an unstarted context
  that starts between read and apply).
- **Parity by construction**: the UI and CLI call the same endpoint with the same operation
  vocabulary, so "anything the agent can edit, the human can edit" needs no parallel effort.

## Data model changes

All three are additive and forward-compatible (no SQLite DDL, no `KNOWN_SCHEMA_VERSION` bump — the
fields live inside the existing `runtime_json` / `definition_json` blobs and parse with defaults):

1. **`liveRevision: z.number().int().min(1).default(1)`** on `graphWorkflowExecutionSchema`,
   persisted in the **runtime tier** (`RUNTIME_TIER_KEYS`, `graph-workflow-executions-repo.ts`).
   Incremented **only** by accepted live-edit batches (including lane-agent `add_task`) — never by
   scheduler ticks — so it is a meaningful optimistic-concurrency token. Old rows parse as `1`.
2. **`collaboration`** added to `graphWorkflowResolvedContextSchema` as the resolved collaboration
   config (same shape `resolveContext` computes today), `.optional()` so pre-existing persisted
   executions still parse. `resolveContext` (`resolve-config.ts`) populates it at seed time.
3. **Lane tool context reads the working copy**: `lane-tool-context-loader.ts` uses
   `execution.workingDefinition.executionContexts[i].collaboration` when present. For legacy
   executions where the field is absent, the existing saved-definition reload is retained as an
   explicit fallback (decision D11) so in-flight executions in the shared DB keep today's behavior;
   the fallback is removable once no pre-field executions remain active.

## Editability policy (decision-complete)

### Lifecycle classifier

A pure function in `src/lib/workflow-graph/lifecycle-classifier.ts`, the **single source of truth**
consumed by the edit guard, the live-outline projection, and the UI:

```ts
type ContextLifecycle = "frozen" | "unstarted" | "started";

function classifyContextLifecycle(
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextLifecycle;
```

- **`frozen`** — `contextState.status === "completed"`. No edits to the context's prose, config,
  tasks, or **incoming** edges. (Outgoing edges to unstarted targets remain addable — see
  structural boundaries.)
- **`unstarted`** — defined by **initial-state equivalence**, not field enumeration: the context is
  `unstarted` iff `contextId ∉ execution.activeContextIds` AND its `contextState` deep-equals the
  output of `buildInitialContextState` (`execution-state.ts`) recomputed against the *current*
  definition (so seed-derived fields — `totalTaskCount`, `isolation` — compare correctly after
  in-batch task adds) AND every one of its `taskStates` deep-equals the initial pending task state.
  This automatically covers `iterationCount`, `consecutiveFailureCount`, `laneId`, `worktreePath`,
  `branchName`, `joinId`, `batchId`, `mergeStatus`, `cleanupStatus`, `pendingApproval`,
  `pendingUserInput` — and any runtime-evidence field added later tightens the predicate by
  construction (fail-safe). Fully editable, **including while the execution is running**
  (structural ops still require quiescence).
- **`started`** — any non-completed context that is not `unstarted` (this includes paused-was-running
  contexts, which pause demotes to `ready` with `iterationCount > 0`, and contexts in
  `awaiting_approval`/`awaiting_user_input`/`halted`). Editable only when the execution is quiescent
  (see below). Within a `started` context, `completed` tasks stay frozen; `interrupted`/`failed`/
  `pending` tasks are editable; `running` tasks cannot exist while quiescent.

Task-level lock (unchanged from today's `isRuntimeEditTaskLocked`): a task is locked when
`status ∈ {"completed", "running"}`.

### Execution-level gate and `isResumable`

```ts
type ExecutionEditability =
  | { kind: "editable"; quiescent: boolean }   // quiescent: paused or resumably-halted
  | { kind: "not-editable"; reason: "completed" | "aborted" | "halt-not-resumable" };

function classifyExecutionEditability(execution: GraphWorkflowExecution): ExecutionEditability;

function isResumableHalt(reason: GraphWorkflowHaltReason): boolean;
```

- `running` → editable, **not** quiescent: only ops whose every target is `unstarted` are allowed
  (plus the lane-agent `add_task` entry point under its own `mutability` gate).
- `paused` → editable, quiescent: full policy surface.
- `halted` → editable-and-quiescent **iff** `isResumableHalt(haltReason)`; otherwise
  `not-editable` (`halt-not-resumable`).
- `completed` / `aborted` → not editable (terminal). **This narrows the current runtime-edit
  handler, which today accepts `aborted`** — intentional (D8).
- `pending` (seeded, not started) → treated as quiescent-editable; every context is `unstarted`.

`isResumableHalt` is an allowlist over `graphWorkflowHaltReasonSchema` types
(`schemas.ts:624-733`). Resumable: `circuit_breaker`, `max_iterations`, `merge_failure`,
`join_failure`, `merge_precondition_failed`, `script_validator_missing_command`,
`validator_infra_error`, `agent_turn_failed`, `worktree_creation_dirty`, `execution_loop_failed`,
`collaboration_failure`. Not resumable (fail-safe): `aborted`, `recovery_error`. (`resume()` itself
currently accepts all halted executions; this predicate scopes *editability* and lives next to the
classifier so all consumers share it. Relaxing it later is a one-line allowlist change.)

### Structural edit boundaries (v1 scope — locked)

Allowed:

- **`add-context`** — new context anywhere in the future graph; requires quiescence.
- **`remove-context`** — only an `unstarted` context, and only when it has **no outgoing edges** at
  the time the op applies. Incoming edges (upstream → removed) cascade automatically. Outgoing
  edges must be removed explicitly (earlier in the same batch) so a transitive-dependency drop is
  an explicit operator choice, never a silent side effect. `deleteTasks: true` required when the
  context still has tasks (mirrors doc 05). Requires quiescence.
- **`add-edge`** — target must be `unstarted`; source may be any lifecycle (adding an out-edge from
  a frozen/started source to an unstarted target does not change the source's executed work — it
  only sequences future work). Post-batch DAG check rejects cycles. Requires quiescence.
- **`remove-edge`** — target must be `unstarted` (removing an incoming dependency of a future
  context is an explicit scheduling choice; the scheduler picks it up on the next tick). Edges into
  `started`/`frozen` targets are untouchable. Requires quiescence.

Rejected in v1 (out of scope — accepted by Alex):

- Renaming context/task ids (use add/move/remove for future work).
- Removing or editing a `started`/`frozen` context (except config/prose/task edits on `started`
  while quiescent, per the classifier).
- Adding, removing, or changing **incoming** edges of any `started`/`frozen` target — i.e., no
  inserting work "before" something that already ran, no interior surgery that reshapes an
  already-materialized worktree-isolation lane/join plan.
- Editing `lanePlan`, `executionLanes`, or `joins` directly (derived state; recomputed).
- Live charter edits (embedded per resolved context; needs versioned amendments — future seam).
- Parameters, prerequisites, `boundInputs`, workflow-tier config (no runtime existence).

### The execution-frontier invariant (post-batch safety net)

The classifier decides *what an op may touch*; the frontier invariant guarantees *the whole result
is legal*. After applying a batch to a clone, assert:

1. **Frozen past unchanged** — for every `frozen`/`started` context: its definition entry
   (prose + config, except `started` config/prose edits explicitly permitted while quiescent), its
   completed tasks, and its **incoming** edge set are identical to the pre-batch state.
2. **Graph validity** — `validateWorkflowDefinition(next.workingDefinition)` passes (unique ids,
   no dangling refs, DAG acyclicity, per-context task-order uniqueness — `validation.ts:66-215`).
3. **Resolved-config validity** — a `validateResolvedWorkflow` pass over every touched context:
   complete concrete implementer/validator shapes; Codex reasoning levels model-aware via
   `getCodexReasoningLevelsForModel`; `scriptValidator.enabled` allowed only when the project has a
   `preMergeCommand` (else the existing `script_validator_missing_command` halt would be baked in).
4. **Runtime-map consistency** — `contextStates`/`taskStates` keys map 1:1 to definition
   contexts/tasks; `activeContextIds ⊆ contextIds`; counts (`totalTaskCount`,
   `completedTaskCount`) re-derived for affected contexts.
5. **lanePlan recomputed** — full recompute for batches containing structural ops; subgraph
   recompute (`recomputeLanePlanForSubgraph`) for task-only batches (matches today's `add_task`).

A batch either produces a state indistinguishable from one legally reached by the engine, or
nothing persists.

## Edit API

### Endpoint

`POST /api/projects/[name]/sessions/[session]/graph-workflow/runtime-edits` — the existing route,
with `workflowRuntimeEditRequestSchema` **replaced** by the new request schema below. The old
task-only op names (`add`/`update`/`remove`/`reorder`/`move`) are retired in the same change; the
only caller (the UI mutation) migrates in the same slice. No backward compatibility (D9).

### Request envelope

```jsonc
{
  "executionId": "exec-7",        // required; must match the active execution
  "baseLiveRevision": 4,          // required; must equal current liveRevision
  "source": "cli",                // required; "cli" | "ui" — audit attribution (see below)
  "dryRun": false,                // optional; advisory validation, no write (see route pipeline)
  "operations": [ /* ≥ 1, applied sequentially; later ops see earlier results */ ]
}
```

`source` is a trusted client self-identification for audit/SSE attribution, not a security
boundary: the CLI always sends `"cli"`, the UI mutation always sends `"ui"`. The third value in the
event schema, `"lane-agent"`, is **server-derived only** — the lane `add_task` route sets it
internally and it is not accepted on this endpoint (the request enum is `["cli", "ui"]`).

### Operation vocabulary

Discriminated union `workflowLiveEditOperationSchema` (new, in `src/lib/workflows/schemas.ts`,
alongside the doc-05 union; names deliberately match doc 05 where semantics match):

| `type` | Fields | Preconditions (beyond execution gate) |
|---|---|---|
| `update-context` | `contextId`; optional `title`, `description` (nullable), `acceptanceCriteria`; optional concrete config blocks: `implementer`, `contextValidator` (nullable → disable), `scriptValidator`, `humanApprovalGate`, `askUserQuestions`, `iterationPolicy`, `circuitBreaker`, `mutability`, `collaboration`; ≥ 1 field present | context not `frozen`; if `started`, quiescent |
| `add-context` | `id`, `title`, `acceptanceCriteria`; optional `description`; optional `configFromContextId`; optional explicit config blocks (override the copied/default base) | quiescent; id unique; `configFromContextId` must exist; config seeded from that context's resolved config, else from resolved global defaults |
| `remove-context` | `contextId`; `deleteTasks?: boolean` | quiescent; context `unstarted`; no outgoing edges remain; `deleteTasks: true` if tasks exist; incoming edges + `contextState`/`taskStates` entries cascade |
| `add-task` | `id?` (slug; minted if absent), `contextId`, `title`, `instructions`, `metadata?`, `position?` (`{at:"start"|"end"} \| {after} \| {before}` — doc 05 shape) | context not `frozen`; if `started`, quiescent; id unique |
| `update-task` | `taskId`; optional `title`, `instructions`, `metadata` (nullable clears); ≥ 1 present | task not locked (`completed`/`running`); owning context rules apply |
| `remove-task` | `taskId` | task not locked; context resequenced; `taskStates` entry removed; counts synced |
| `move-task` | `taskId`, `targetContextId`, `position?` | task not locked; target context not `frozen`; while running, **both** source and target must be `unstarted`; both contexts resequenced; counts synced |
| `reorder-tasks` | `contextId`, `orderedTaskIds` | context not `frozen`; in an `unstarted` context: exact permutation of all tasks; in a quiescent `started` context: exact permutation of **editable** tasks, completed tasks keep their positions (today's semantics) |
| `add-edge` | `sourceContextId`, `targetContextId` | quiescent; target `unstarted`; both exist; no duplicate; acyclic post-batch |
| `remove-edge` | `sourceContextId`, `targetContextId` | quiescent; edge exists; target `unstarted` |

Addressing is always by **stable id**, never index. Batches are atomic: the first failing op
rejects the whole batch with its `operationIndex` in the issue locator (doc 05's
`formatDefinitionEditIssue` shape).

`add-context` runtime sync: seeds `contextStates[id]` (`status: "pending"`, zeroed counters,
`isolation` per resolved config) and `taskStates` entries (`status: "pending"`) for any tasks added
to it in the same batch.

### Error contract

HTTP + `code` + exit-code mapping (the doc-05 convention: a `code`-bearing rejection is an
operation failure → exit 1; a codeless 400 is malformed input → exit 2):

| HTTP | `code` | Meaning | CLI exit |
|---|---|---|---|
| 400 | — (none) | malformed body (Zod parse), issues listed | 2 |
| 404 | — | session unknown / no active execution | 2 |
| 409 | `execution_mismatch` | `executionId` ≠ active execution's id | 1 |
| 409 | `revision_conflict` | `baseLiveRevision` ≠ current; body includes `currentLiveRevision` | 1 |
| 409 | `not_editable` | execution `completed`/`aborted`, or halted with non-resumable reason | 1 |
| 400 | `frozen` | an op targets a completed context/task or a protected incoming edge | 1 |
| 400 | `requires_pause` | an op needs quiescence but the execution is running | 1 |
| 400 | `invalid_edit` | semantic/structural violation (unknown id, cycle, permutation mismatch, resolved-config invalid, …) | 1 |

Every rejection carries `issues: [{ path, message }]` with `operations[i]` locators. A
`requires_pause`/`frozen` verdict can also arise at apply time when a context started between the
agent's read and the write — the serialized mutation re-classifies live, so there is no separate
"stale" code (D7).

### Success response

```jsonc
{ "applied": 3, "liveRevision": 5, "affectedContextIds": ["verify", "docs"], "dryRun": false }
```

Deliberately **not** the full execution (token efficiency; the UI refreshes via SSE-driven
invalidation, below). `dryRun: true` responses report `applied` + would-be `affectedContextIds`
without persisting and without incrementing `liveRevision`.

## Read API — live outline

New endpoint `GET /api/projects/[name]/sessions/[session]/graph-workflow/live-outline`
(`?context=<id> | ?task=<id> | ?config=<id> | ?full=true` section selectors), implemented by a
server-side projection module `src/lib/workflow-graph/live-outline.ts`.

Server-side (unlike doc 05's CLI-side outline) because **editability must come from the same
classifier the guard uses** — the CLI stays schema-lean and never re-implements policy. The
projection folds `workingDefinition` (resolved config) + `contextStates`/`taskStates` + the
classifier verdicts into a compact JSON the CLI renders as text:

```text
execution exec-7  status=running  liveRev=4  seed=wf-1@12
contexts:
  plan     completed  frozen         deps=-      tasks=3/3  iter=2/20
  impl     running    pause-to-edit  deps=plan   tasks=1/4  iter=3/20
  verify   pending    editable       deps=impl   tasks=0/2  iter=0/12
tasks:
  impl    1 impl-api    completed  "Wire API"            (812 chars)
          2 impl-ui     running    "Build inspector UI"  (1.8k chars)
          3 impl-tests  pending    "Add tests"           (704 chars)
config:
  plan    claude opus medium; validator claude sonnet medium; script off
  impl    claude opus medium; validator claude sonnet medium; script on; approval on
  verify  codex gpt-5.4 high;  validator off
```

The editability column renders the classifier verdict resolved against the current execution
status: `frozen` · `editable` · `pause-to-edit` (started + running execution) · `not-editable`
(terminal/non-resumable execution — shown in the header line instead). The header always carries
`executionId` and `liveRev` so one read supplies everything an edit file needs. Prose is sized, not
inlined (`--context`/`--task` selectors return full text) — same token discipline as doc 05.

## Server implementation

### `applyLiveExecutionEdits` (pure core)

In `src/lib/workflow-graph/runtime-edits.ts` (broadened, not forked):

```ts
export function applyLiveExecutionEdits(
  execution: GraphWorkflowExecution,
  request: WorkflowLiveEditRequest,          // operations only; revision checked by caller
  deps: LiveEditDeps,                        // createTaskId, resolvedGlobalDefaults, hasPreMergeCommand
):
  | { ok: true; execution: GraphWorkflowExecution; affectedContextIds: string[] }
  | { ok: false; code: LiveEditRejectionCode; issues: WorkflowGraphValidationError[] };
```

Clone → sequential per-op apply (each op: classifier precondition → mutate definition + runtime
maps) → frontier invariant checks (§above) → Zod re-parse of the mutated execution → lanePlan
recompute (full for structural batches, subgraph otherwise). Pure, table-testable, no I/O.
`applyAgentTaskAdd` becomes a thin wrapper that builds a single-`add-task` request and calls the
core with its own entry-point policy (running allowed, `mutability.allowAgentTaskAdd` required,
context must be `running` + active — unchanged semantics), so invariant maintenance lives in
exactly one place.

### Route pipeline (`runtime-edit-route-handlers.ts`)

1. Zod-parse body (`workflowLiveEditRequestSchema`) → 400 codeless on failure.
2. Resolve session + active execution → 404.
3. **Dry-run path — outside the write queue.** `mutateActiveGraphWorkflowExecution` unconditionally
   persists (`setActive` + event append in one transaction; `setters.ts` has no no-write variant),
   so `dryRun: true` never enters it: read the execution via the
   `getActiveGraphWorkflowExecution` accessor, run gates a–d below against that snapshot, and
   respond — no persist, no revision bump, no events. A dry-run verdict is **advisory by nature**
   (the execution may change before the real apply); the authoritative gates re-run at apply time,
   which is exactly what `baseLiveRevision` + apply-time re-classification exist for. This costs
   nothing in safety and avoids inventing a no-write serialized state-store primitive.
4. Apply path — inside `mutateActiveGraphWorkflowExecution` (serialized, atomic):
   a. `executionId` check → 409 `execution_mismatch`.
   b. `baseLiveRevision` check → 409 `revision_conflict` + `currentLiveRevision`.
   c. `classifyExecutionEditability` → 409 `not_editable`.
   d. `applyLiveExecutionEdits` → 400 `frozen`/`requires_pause`/`invalid_edit` + issues.
   e. Increment `liveRevision`; call `eventPublisher.publishLiveEditApplied(…)` (broadcasts AND
      returns the event row — see §SSE); return `{ execution, events }` where events = the
      publisher's diff events plus the returned live-edit event row.
5. Respond `{ applied, liveRevision, affectedContextIds }`.

### SSE + audit

New event (schema in `schemas.ts`, appended to `graphWorkflowSseEventSchema` union at
`schemas.ts:1368` and the global union in `src/lib/api/sse-events.ts`):

```ts
export const graphWorkflowLiveEditAppliedEventSchema = z.object({
  type: z.literal("graph-workflow-live-edit-applied"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  liveRevision: z.number().int().min(1),
  operationCount: z.number().int().min(1),
  affectedContextIds: z.array(z.string()),
  source: z.enum(["cli", "ui", "lane-agent"]),
});
```

This event is **mandatory**, not garnish: every existing `graph-workflow-*` event is
status/diff-driven, so a config-only or future-structure edit produces no status diff and would
leave the UI stale.

Emission is via a new publisher method — **not** via the repository's extra-events path. The
`mutateActive` extra-events mechanism (`execution-repository.ts`) only *appends* returned events to
`graph_workflow_events`; broadcasting happens exclusively inside publisher methods. So the design
requires:

```ts
// execution-events.ts — mirrors publishCharterUpdated / publishApprovalResolved
publishLiveEditApplied(input: {
  projectPath: string; sessionName: string; executionId: string;
  liveRevision: number; operationCount: number;
  affectedContextIds: string[]; source: "cli" | "ui" | "lane-agent";
}): GraphWorkflowExecutionEvent[];   // broadcasts via publishEvents, returns rows for append
```

The route's mutator calls it and includes the returned rows in the mutation's `events`, so the
event is simultaneously broadcast (via `publishSessionStatus` → `broadcaster.ts`) and persisted to
`graph_workflow_events` (audit trail + Events panel).

Client wiring (per the established pattern): import the schema in `NotificationListener.tsx`, add
an `addEventListener("graph-workflow-live-edit-applied", …)` handler that parses via
`parseSseEventData` (strips `_sentAt` — required, `.strict()` schemas otherwise drop the event) and
invalidates `graphWorkflowExecutionKeys.detail` + `graphWorkflowEventsKeys.list`.

Structured logging (per `.kiro/steering/logs.md`): logger module `workflow.live-edit`; events
`live_edit.applied` (executionId, liveRevision, source, operationCount, affectedContextIds) and
`live_edit.rejected` (code, operationIndex, issue count).

### Pause/resume

No server changes — `POST …/graph-workflow/pause` and `…/resume` exist
(`execution-route-handlers.ts:1127-1216`). They gain CLI exposure (below). `resume`'s optional
`conflictGuidance` body stays UI-only in v1 (future CLI seam).

## CLI surface

New session-scoped subgroup (dispatch precedent: `workflow task …`). Identity via
`resolveSessionContext` (`src/cli/shared.ts:377`), i.e. `--project`/`--session` flags or
`CC_PROJECT`/`CC_SESSION` env, like `workflow status`.

```bash
cctl workflow live get [--context <id> | --task <id> | --config <id> | --full] [--json]
cctl workflow live edit --file .cc/temp/live-ops.json [--dry-run] [--json]
cctl workflow live pause [--json]
cctl workflow live resume [--json]
```

- **`live` is the primary documented name**; the dispatcher rewrites `workflow execution …` and
  `workflow exec …` to `live` before dispatch and help lookup (aliases get no separate help
  entries; the group help names them).
- `live get` renders the live-outline endpoint's projection (text) or passes JSON through
  (`--json`). Selectors are mutually exclusive; default is the outline.
- `live edit` reads the ops file (or `-` for stdin), performs deterministic local checks only
  (file exists, JSON parses, `--file` present → exit 2 before any network), posts to the edit
  endpoint, and renders: success `applied N operation(s) · liveRev M`; failures per the error
  contract (issues one per line, `code` in the JSON envelope). `--dry-run` sets body `dryRun`.
- `live pause` / `live resume` call the existing endpoints; a pause of an already-paused execution
  or resume of a running one renders the server's 409 as exit 1 with its message.
- The canonical agent flow is deterministic end-to-end:

```bash
cctl workflow live get                    # outline says impl is pause-to-edit; liveRev=4
cctl workflow live pause
cctl workflow live edit --file .cc/temp/live-ops.json
cctl workflow live resume
```

Integration checklist (per `.kiro/steering/cli.md` — all mandatory):

1. `CommandHelpEntry` nodes in `workflow.help.ts`: group `["workflow","live"]` + leaves
   (`get`/`edit`/`pause`/`resume`), each with summary/usage/flags/≥1 example (the edit example
   teaches the ops-file shape and the `.cc/temp/` location), `related` edges both ways
   (`workflow live` ↔ `workflow status`, `workflow live edit` ↔ `workflow edit` "saved definitions,
   not the running execution"), and a `skills` ref to `graph-workflow-planning`.
2. Flags wired through the registry (no literal allowlists); boolean/value kinds correct.
3. `help-registry.contract.test.ts` `COVERAGE` extended with the new paths.
4. `cc-cli` SKILL.md command reference updated; plugin version bumped
   (`plugins/command-center/command-center/.claude-plugin/plugin.json`, 2.18.0 → 2.19.0).
5. Exit codes honor the shared floor (`EXIT_OK`/`EXIT_OPERATION_FAILED`/`EXIT_USAGE`/
   `EXIT_CONNECTION`); local deterministic checks fail at exit 2 before any round-trip.

## UI plan

### Goal 1 — show the complete configuration (v1)

`ExecutionInspectorPanel` DetailView grows a tabbed layout: **Tasks · Config · History** (Tasks and
History exist today). The Config tab renders, straight from the selected context's entry in
`workingDefinition` (already resolved — zero cascade logic client-side):

- Implementer: backend, model, reasoning effort.
- Context validator: enabled/type, model/effort, continuity, context-limit tokens.
- Script validator; human approval gate; ask-user-questions gate.
- Iteration policy (`maxIterations` next to the live iteration count); circuit-breaker threshold.
- Mutability (`allowAgentTaskAdd`); collaboration (agents, rounds, threshold) once resolved-field
  work lands.
- Runtime facts from `contextState`: isolation, worktree path/branch, merge + cleanup status,
  lane/join/batch ids, last merge error.

The Overview (no selection) gains an execution header line: `liveRev`, seed definition id@revision.

### Goal 2 — everything the agent can edit, the human can edit

- **Shared editors**: the builder already has config controls (`WorkflowInspectorPanel.tsx`,
  `InspectorConfigBlock.tsx`, `InspectorFieldEditors.tsx` in `src/features/workflows-builder/`).
  Features must not import features → extract the reusable field editors to
  `src/components/workflow-config/` and consume from both the builder and the execution inspector.
  (Builder edits authored override blocks; execution inspector edits resolved concrete values — the
  extracted editors take value+onChange and don't know the difference.)
- **Wiring**: all edits — config fields, task CRUD (existing), structural forms — compose
  `operations[]` for the **same** runtime-edits endpoint, via the reshaped
  `useRuntimeEditGraphWorkflowMutation` (new request schema, `source: "ui"`, optimistic update +
  pending indicator per the responsiveness contract; on `revision_conflict` the mutation refetches
  and surfaces "execution changed — review and retry").
- **Editability affordances**: controls disable per the classifier (imported directly from
  `@/lib/workflow-graph/lifecycle-classifier` — same pure function the server uses). `frozen` →
  read-only with a lock glyph; `pause-to-edit` → inline "Pause to edit" button (existing pause
  mutation) with resume offered after a successful save; terminal/non-resumable → banner, all
  read-only.
- **Phasing** (accepted): v1 ships config + prose + task editing in the inspector. **Structural UI
  (phase 2)**: inspector-form add-context dialog (with "copy config from…" mirroring
  `configFromContextId`), remove-context on unstarted contexts, and a Dependencies section listing
  incoming/outgoing edges with add/remove controls. Canvas drag-editing stays out; layout remains
  generated; `nodesDraggable={false}` unchanged. Until phase 2 lands, structural edits are
  CLI-only — an accepted, temporary parity gap.

## Testing plan

TDD throughout (failing test first). No `vi.mock()` of internal modules — everything below is DI or
pure.

1. **Classifier unit tests** (`lifecycle-classifier.test.ts`): table-driven over context/task
   states — completed→frozen; pristine pending→unstarted; paused-was-running (`ready`,
   `iterationCount>0`)→started; interrupted-task context→started; lane-assigned pending→started;
   `isResumableHalt` allowlist including the `aborted`/`recovery_error` denials.
2. **Pure core tests** (`runtime-edits.test.ts`, extended): per-op accept/reject tables; batch
   atomicity (later op failure leaves nothing); sequential visibility (add-context then add-task
   then add-edge in one batch); remove-context outgoing-edge guard + explicit-edge-removal-first
   flow; cycle rejection; reorder permutation rules (unstarted vs started); move-task
   running-execution restriction; `configFromContextId` seeding + explicit-field override;
   resolved-config validation (bad Codex effort for model rejected; scriptValidator without
   preMergeCommand rejected); runtime-map sync (counts, taskStates lifecycle); lanePlan recompute
   split; frontier invariant (frozen subgraph byte-compare) violations.
3. **Route tests** (`runtime-edit-route-handlers.test.ts`, rewritten): malformed → 400 codeless;
   404; `execution_mismatch`; `revision_conflict` (+`currentLiveRevision`); `not_editable` for
   completed/aborted/non-resumable-halt; `requires_pause` while running; dry-run (no persist, no
   revision bump, no events); success (revision bump, SSE event emitted with correct `source`,
   events appended). Use `createPersistenceFixture()` — apply, **reload**, assert on the reloaded
   execution (serialization-drop protection).
4. **Contract round-trip**: extend the graph-workflow-executions repo `*.contract.test.ts` maximal
   fixture with `liveRevision` and resolved `collaboration` (durability backstop — mandatory for
   new persisted fields).
5. **Lane add_task regression**: existing `applyAgentTaskAdd` tests keep passing against the
   wrapper (same preconditions, same lanePlan behavior, now bumps `liveRevision`).
6. **Collaboration-fix tests**: `resolveContext` populates resolved `collaboration`;
   lane-tool-context-loader prefers `workingDefinition`, falls back only when the field is absent.
7. **CLI tests**: dispatch + alias rewrite; local deterministic failures at exit 2 pre-network;
   error-code → exit mapping; outline rendering snapshot; `help-registry.contract.test.ts` green.
8. **UI tests**: Config tab renders all resolved fields; controls disabled per classifier;
   pause-to-edit flow; mutation payload shape; revision-conflict recovery path.
9. **SSE**: `FakeEventSource` test that `graph-workflow-live-edit-applied` passes envelope
   stamping/stripping and triggers both invalidations.

## Implementation plan

### Slice 1 — data model + classifier (foundations)

1. `liveRevision` on `graphWorkflowExecutionSchema` (runtime tier) + repo round-trip contract.
2. Resolved `collaboration` on `graphWorkflowResolvedContextSchema` + `resolveContext` population
   + loader working-copy read with legacy fallback + tests.
3. `lifecycle-classifier.ts` (`classifyContextLifecycle`, `classifyExecutionEditability`,
   `isResumableHalt`) + full test table.

*Green when:* contract tests + classifier tables pass; no behavior change for existing executions.

### Slice 2 — edit core + route + SSE

4. `workflowLiveEditOperationSchema` / `workflowLiveEditRequestSchema` in `schemas.ts`.
5. Broaden `runtime-edits.ts` into `applyLiveExecutionEdits` (per-op appliers, frontier checks,
   map sync, lanePlan split); re-express `applyAgentTaskAdd` on the core. Update the
   `persisted-blob-bounds.contract.test.ts` discharge for `workingDefinition.**` (currently
   "fixed at resolve time, never mutated at runtime" — already inaccurate for agent `add_task`,
   and definitively wrong once live edits land; reword to "written on accepted live edits").
6. Rewrite the runtime-edits route pipeline: dry-run via the `getActiveGraphWorkflowExecution`
   read accessor **outside** the write queue; apply path with revision/mismatch/editability gates,
   `liveRevision` bump, error contract.
7. `graph-workflow-live-edit-applied`: schema, union entries (workflow + global SSE), new
   `publishLiveEditApplied` publisher method (broadcast + returned rows — the repo extra-events
   path does not broadcast), `NotificationListener` handler, audit logging.

*Green when:* pure-core + route + SSE tests pass; lane add_task regression green; old op names gone.

### Slice 3 — CLI

8. `live-outline.ts` projection + `GET …/graph-workflow/live-outline` endpoint + tests.
9. `runWorkflowLive` dispatch (`get`/`edit`/`pause`/`resume`), alias rewrite
   (`execution`/`exec` → `live`), renderers, exit mapping.
10. Help entries + registry COVERAGE + `cc-cli` SKILL.md sync + plugin version bump.

*Green when:* scripted `get → pause → edit → resume` works against a live dev server
(cc-live-feature-test); help contract test green.

### Slice 4 — UI: config display + editing (v1 complete)

11. Extract shared config field editors to `src/components/workflow-config/`; builder consumes the
    extracted components (zero visual change — verify with Storybook parity).
12. Config tab in `ExecutionInspectorPanel` (display) + Overview `liveRev`/seed header.
13. Editable config controls + migrate task editing to the new op schema; classifier-driven
    disable states; pause-to-edit affordance; optimistic/pending per the responsiveness contract;
    revision-conflict recovery.

*Green when:* every resolved field visible; config + task edits round-trip from the UI; CLI edits
appear in the UI without manual refresh (SSE).

### Slice 5 — UI: structural forms (phase 2)

14. Add-context dialog (`configFromContextId` picker), remove-context (unstarted only),
    Dependencies section with edge add/remove. Same endpoint, same policy, classifier-driven
    affordances.

### Estimated risk order

Slice 2 carries the design risk (frontier checks + map sync); slice 1 is small and unblocks it;
slices 3–5 are mechanical against locked contracts. Each slice is independently landable and leaves
the tree green.

## Non-goals / future seams

- **Interior structural surgery** (incoming-edge changes on started/completed targets, removing
  started contexts, reshaping materialized lanes/joins) — out of scope by decision, not deferred by
  difficulty ranking alone; the frontier invariant is where a future relaxation would be proven.
- **Live charter amendments** — needs versioned/append-only design.
- **Write-back to the saved definition** ("promote these live edits to the template") — natural
  follow-on; the op vocabulary was kept name-compatible with doc 05 partly for this.
- **CLI `resume --file guidance.json`** (conflict guidance parity with the UI).
- **Canvas drag-editing / manual layout.**
- **Relaxing `isResumableHalt`** as evidence accumulates (one-line allowlist change).

## Decisions (locked with Alex, 2026-07-07)

| # | Decision |
|---|---|
| D1 | Live edits target the execution's resolved `workingDefinition` (working-copy model); saved definitions and running executions never implicitly affect each other. Config ops set concrete resolved values; no cascade semantics at runtime. |
| D2 | Editability = lifecycle classifier (`frozen`/`unstarted`/`started`) + execution gate; `unstarted` is defined by initial-state equivalence against `buildInitialContextState` + `activeContextIds` exclusion (not field enumeration, not raw status — future runtime fields tighten it automatically); structural ops additionally require quiescence (paused or resumably-halted). |
| D3 | Frontier invariant is the post-batch safety net; batches are atomic; result must be indistinguishable from a legally-reached state. |
| D4 | Concurrency: `liveRevision`/`baseLiveRevision` (edit-vs-edit) + apply-time re-classification inside the serialized mutation (edit-vs-scheduler). `liveRevision` increments only on accepted live edits, including lane-agent `add_task`. |
| D5 | v1 structural scope: `add-context`, `remove-context` (unstarted, no remaining outgoing edges, `deleteTasks` guard), `add-edge` (unstarted target; any source), `remove-edge` (unstarted target). Interior structural updates are **out of scope** (accepted). |
| D6 | Halted executions are editable iff `isResumableHalt(haltReason)`; allowlist = all reasons except `aborted`, `recovery_error` (fail-safe). |
| D7 | Error contract: codes `execution_mismatch`/`revision_conflict`/`not_editable` (409), `frozen`/`requires_pause`/`invalid_edit` (400); code-bearing → exit 1, codeless 400/404 → exit 2. No separate "stale" code — apply-time re-classification reuses `frozen`/`requires_pause`. |
| D8 | The edit endpoint rejects `aborted` executions (narrows current behavior; terminal states are read-only). |
| D9 | The old task-only runtime-edit op schema is replaced wholesale (UI migrates in the same slice); no backward compatibility. |
| D10 | `cctl workflow live` is the primary namespace; `execution`/`exec` are dispatch-rewrite aliases. `pause`/`resume` added to the CLI. Live outline is projected **server-side** so CLI/UI/guard share one classifier. |
| D11 | Resolved `collaboration` added to resolved contexts; lane tool context reads the working copy, with a legacy fallback to the saved-definition reload **only** for pre-field executions (shared-DB safety; removable later). |
| D12 | Mandatory `graph-workflow-live-edit-applied` SSE event + `graph_workflow_events` audit row + structured logs; success response is `{ applied, liveRevision, affectedContextIds }`, not the execution blob. |
| D13 | Live charter edits, params/prereqs/boundInputs, lanePlan/joins direct edits, and definition write-back are out of scope. UI structural forms are phase 2 (slice 5); canvas editing later. |
| D14 | Dry-run runs **outside** the write queue against the `getActiveGraphWorkflowExecution` read accessor (the state-store mutation primitive always persists; no no-write variant is added). Dry-run verdicts are advisory; the authoritative gates re-run at apply time. |
| D15 | `source` is a required request field with enum `["cli", "ui"]` (trusted client self-identification for audit attribution); `"lane-agent"` is server-derived on the lane route only and rejected on the runtime-edits endpoint. |
| D16 | The live-edit SSE event is emitted via a new `publishLiveEditApplied` publisher method (broadcast + returned rows for append), mirroring `publishCharterUpdated` — never via the repository extra-events path, which appends without broadcasting. |
