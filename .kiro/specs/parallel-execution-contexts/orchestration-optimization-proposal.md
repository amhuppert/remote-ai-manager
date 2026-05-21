# Graph Workflow Orchestration Optimization Proposal

## Status

Proposal for the next graph workflow orchestration revision. This document does
not replace the existing parallel execution contexts design. It extends that
design with event-driven scheduling, lane-based worktree reuse, and explicit
terminal convergence.

## Problem Statement

The current graph workflow parallelization model schedules all contexts that are
eligible at a scheduling tick, waits for that whole batch to finish, then
schedules the next batch. That creates two problems.

First, it can leave a downstream context displayed as pending even when all of
its dependencies have completed. In a workflow where `P1 Foundation`, `P2`, and
`P3` start together, `P1 Data Layer` becomes dependency-ready as soon as
`P1 Foundation` lands. It should not wait for unrelated `P3` work. The current
batch barrier makes it wait anyway, and the UI labels every pending context as
"Waiting on upstream" even when the real reason is scheduler idleness or batch
barrier behavior.

Second, the current fan-out/fan-in model creates avoidable worktree and merge
overhead for sequential chains inside a larger parallel workflow. A chain such
as `P1 Foundation -> P1 Data Layer -> P1 Wiring` can run in one branch/worktree.
Merging each link into the session branch before starting the next link adds
latency and increases merge-conflict exposure without adding parallelism.

## Goals

- Schedule newly eligible contexts as soon as their dependencies land, even
  while unrelated contexts are still running.
- Reuse a dependency context's worktree for sequential downstream work when that
  reuse does not reduce useful parallelism.
- Keep independent branches parallel through separate lanes.
- Treat fan-in and terminal publication as explicit join operations over
  distinct lanes, not as per-context session merges.
- Preserve validation, retry, circuit-breaker, and halt semantics at context
  boundaries.
- Make UI state truthful: dependency-blocked, ready, queued for lane, merging,
  validating, running, completed, or halted.
- Keep the implementation incremental and compatible with the existing graph
  workflow modules, merge machine, and structured logging system.

## Non-Goals

- Building a generic distributed workflow engine.
- Replacing the existing graph workflow task model.
- Removing per-context validation.
- Running two contexts in the same worktree concurrently.
- Hiding merge conflicts. Fewer merges should reduce unnecessary conflict
  points, but real cross-branch conflicts must still surface through the
  existing merge failure path.
- Implementing backward compatibility for older persisted execution records
  without an explicit approval decision.

## Core Design

Introduce an orchestration concept called an execution lane.

A lane is a mutable branch/worktree line of development. It may be the session
lane or a per-workflow worktree lane. Contexts assigned to the same lane run
sequentially and see the changes produced by earlier contexts in that lane.

The scheduler no longer reasons only in batches. It maintains active lanes,
ready contexts, blocked contexts, and required joins. Whenever a context
completes, validates, and commits its lane output, the scheduler immediately
recomputes which downstream contexts can run.

### Lane Model

Each lane should have durable execution state:

```typescript
interface GraphWorkflowLaneExecutionState {
  laneId: string;
  kind: "session" | "worktree";
  status: "idle" | "running" | "merging" | "failed" | "disposed";
  worktreePath: string;
  branchName: string;
  headContextId: string | null;
  includedContextIds: string[];
  createdAt: string;
  updatedAt: string;
}
```

Each context state should record the lane that owns its output:

```typescript
interface GraphWorkflowExecutionContextState {
  contextId: string;
  status: "pending" | "ready" | "queued" | "running" | "completed" | "halted";
  waitReason:
    | "blocked_by_dependencies"
    | "waiting_for_lane"
    | "waiting_for_join"
    | "waiting_for_capacity"
    | null;
  laneId: string | null;
  joinId: string | null;
}
```

The exact schemas should be defined in `src/lib/schemas.ts` and types should be
derived with `z.infer`. The interface snippets above describe shape and intent,
not final implementation syntax.

### Join Model

A join is a merge operation that makes multiple source lanes visible in one
target lane.

```typescript
interface GraphWorkflowJoinState {
  joinId: string;
  targetLaneId: string;
  sourceLaneIds: string[];
  contextId: string | null;
  status: "pending" | "in-progress" | "completed" | "failed" | "conflicts";
  lastError: string | null;
}
```

There are two kinds of joins:

- Context join: required before a context with dependencies from multiple
  distinct lanes can run.
- Final publish join: required when terminal context outputs live in one or
  more lanes that are not fully published to the session branch.

The existing merge machine remains the merge implementation. The orchestration
change is that merges are scheduled against lane joins instead of being forced
after every worktree-isolated context.

## Scheduling Rules

### Readiness

A context is dependency-ready when all incoming dependency contexts are
completed and their lane outputs are committed.

Readiness is not the same as schedulability:

- A dependency-ready context with one source lane is schedulable when that lane
  is idle or a new fork lane can be provisioned.
- A dependency-ready context with multiple source lanes is schedulable only
  after the required join completes.
- A dependency-ready context that is waiting on a busy lane should display as
  queued or waiting for lane, not waiting on upstream.

### Event-Driven Loop

The execution loop should move from "schedule batch, wait for whole batch" to
"schedule work, wait for next event, reschedule".

Recommended loop shape:

```typescript
while (execution.status === "running") {
  await scheduleAllCurrentlySchedulableWork();

  if (hasPendingHaltReason() && noInFlightWork()) {
    await drainAndHalt();
    break;
  }

  if (isWorkflowComplete()) {
    await completeWorkflow();
    break;
  }

  await waitForNextContextOrJoinEvent();
}
```

The key behavior is that a completed `P1 Foundation` can trigger scheduling of
`P1 Data Layer` while unrelated `P3` work remains in flight.

### Sequential Reuse

A context may reuse its dependency lane when all of these are true:

- The context has exactly one distinct dependency lane.
- The dependency lane is idle.
- No other running context is using that lane.
- Reuse does not prevent a ready sibling from running in parallel unless the
  workflow concurrency policy intentionally chooses to serialize.
- The upstream context has completed validation and its lane output has been
  committed.

This covers the common linear chain case:

```text
P1 Foundation -> P1 Data Layer -> P1 Wiring
```

All three contexts can run in the same lane with zero intermediate merges.

### Fan-Out

When a completed context has multiple ready children, only one child can inherit
the parent lane without serializing all siblings. Other children should fork
from the parent lane's committed head if they need to run concurrently.

The continuation child should be chosen deterministically:

1. Prefer the child on the longest downstream critical path.
2. Prefer the child with the largest estimated work weight when available.
3. Use workflow definition order as the final tie-breaker.

This keeps useful parallelism while minimizing new worktrees.

### Fan-In

When a context depends on multiple upstream contexts, compute the distinct
source lane set from those dependencies.

- If the set has one lane, no merge is needed.
- If the set has `N` lanes and the target is one of those lanes, at least
  `N - 1` merges are needed.
- If the set has `N` lanes and the target is a fresh lane or the session lane
  is not already one of the sources, `N` merges are needed.

The target lane should be chosen to minimize total remaining work:

1. Prefer the session lane for final publish joins if it is already one of the
   source lanes.
2. Prefer the lane that continues along the longest remaining downstream path.
3. Prefer the lane with the largest existing included context set.
4. Use stable lane id order as the final tie-breaker.

After the join completes, the fan-in context runs in the target lane.

### Multiple Terminal Contexts

Normalize every workflow to a single terminal convergence point by adding an
implicit final publish join over all terminal lanes.

If all terminal contexts end in the same lane and that lane is the session lane,
the final publish is a no-op.

If all terminal contexts end in one non-session lane, the final publish is one
merge into the session lane.

If terminal contexts end in multiple lanes, the final publish joins all distinct
terminal lanes into the session lane. A final verification context, when
present, should run after this join unless the design intentionally chooses to
verify in a non-session target lane and publish afterward.

## Lane Planning

The scheduler can make lane decisions dynamically, but it should start from a
deterministic lane plan computed at execution seed time. The plan is advisory
and can be recomputed after runtime edits or context reset.

Recommended planning algorithm:

1. Build graph indexes: incoming edges, outgoing edges, roots, terminals.
2. Compute a downstream critical-path score for every context.
3. For every fan-out point, select at most one continuation edge using the
   deterministic selection rules above.
4. Compress selected continuation edges into planned chains.
5. Assign each chain a preferred lane policy:
   - session-preferred for the chain most likely to reach final publication,
     when session-lane execution is enabled and safe.
   - worktree-preferred for other parallel chains.
6. Store the plan in execution metadata for observability and deterministic
   restarts.

This is intentionally simpler than a full minimum path cover solver. A minimum
path cover could reduce lane count in some DAGs, but the greedy critical-path
planner is easier to reason about, easier to test, and sufficient for the
sequential-chain optimization that motivated this change. A full solver can be
added later behind the same lane-plan interface.

## Session Lane Policy

The session worktree can be treated as one lane, but only one active context may
run in it at a time.

Using the session lane for one parallel chain is the most efficient shape:

```text
session lane: P3 -> final
worktree lane A: P1 Foundation -> P1 Data Layer -> P1 Wiring
worktree lane B: P2
```

The final publish then merges lane A and lane B into the session lane. That is
two joins for three branches of work because one branch already lives in the
target lane.

However, session-lane participation has higher operational risk because it
mutates the user's visible session worktree while other lanes are still
running. The safe rollout is:

1. Keep the current all-worktree behavior for parallel roots by default.
2. Add lane reuse for sequential chains inside those worktrees.
3. Add final publish joins.
4. Add session-lane participation only after the lock and dirty-worktree
   preflight behavior is proven.

## Validation and Commit Semantics

Each context still has a hard boundary:

1. Run implementer tasks in its assigned lane.
2. Run script validator in the same lane when enabled.
3. Run context validator in the same lane when enabled.
4. Commit the context output on the lane branch.
5. Mark the context completed and lane output available.

Downstream reuse may start only after step 5. This preserves context-local
validation and prevents downstream work from building on unvalidated output.

The existing solo commit behavior should be generalized into a lane commit
operation. A context finishing in a worktree lane should be committed there but
not immediately merged into the session branch unless a join requires it.

## Failure and Halt Semantics

The existing drain-then-halt semantics should remain.

- First failure records `pendingHaltReason`.
- No new contexts are scheduled after a pending halt reason is recorded.
- Already running contexts may finish and commit their lane output.
- Required cleanup and merge state is persisted.
- When in-flight work settles, the workflow transitions to `halted` with the
  original reason.

Failed lanes should be retained for inspection unless their output was already
successfully joined and published.

Join failures should be recorded on the join state and surfaced as a
`merge_failure` halt reason that includes context id when the join is for a
context, or final publish metadata when the join is terminal-only.

## UI and Status Semantics

The UI should not infer "Waiting on upstream" from `status === "pending"`.

The backend should expose enough state for the UI to distinguish:

- Blocked by dependencies: list unmet upstream context ids.
- Ready: dependencies satisfied, not yet scheduled.
- Queued for lane: dependencies satisfied, lane busy.
- Waiting for join: dependencies satisfied, merge required.
- Running: active implementer or validator turn.
- Validating: task work complete, validators running.
- Merging: join or final publish in progress.
- Completed: context output committed and available in its lane.
- Published: optional display state when output is visible in the session lane.

This directly fixes the incorrect pending-state display. In the motivating
example, `P1 Data Layer` should become ready or queued immediately after
`P1 Foundation` lands, regardless of `P3` still running.

## Observability

Add structured events and execution log entries for lane decisions:

- `graph-workflow.scheduler.ready_set_computed`
- `graph-workflow.scheduler.context_queued`
- `graph-workflow.scheduler.context_scheduled`
- `graph-workflow.lane.created`
- `graph-workflow.lane.reused`
- `graph-workflow.lane.forked`
- `graph-workflow.join.queued`
- `graph-workflow.join.started`
- `graph-workflow.join.completed`
- `graph-workflow.join.failed`
- `graph-workflow.final_publish.started`
- `graph-workflow.final_publish.completed`

Every event should include `executionId`, `contextId` when applicable,
`laneId`, `sourceLaneIds`, `targetLaneId`, `branchName`, and `worktreePath`
when those fields exist.

## Implementation Impact

Expected modules to change:

- `src/lib/workflows/graph-workflow/execution-loop.ts`
  - Remove the scheduled-batch barrier.
  - Track in-flight context and join promises.
  - Reschedule after any context or join settles.

- `src/lib/workflows/graph-workflow/workflow-manager.ts`
  - Replace batch-only scheduling with lane-aware scheduling.
  - Persist ready, queued, lane, and join state atomically.

- `src/lib/workflow-graph/validation.ts`
  - Keep dependency eligibility logic, but stop treating "landed" as only
    "visible in the session branch".
  - Add lane-aware output availability helpers.

- `src/lib/workflow-graph/parallel-worktrees.ts`
  - Generalize from per-context worktrees to lane worktrees.
  - Preserve deterministic naming and validation.

- `src/lib/workflow-graph/graph-merge-runner.ts`
  - Support lane-to-lane and lane-to-session joins.

- `src/lib/workflow-graph/execution-target-resolver.ts`
  - Resolve context execution target from assigned lane.

- `src/components/workflow-graph/derive-graph.ts`
  - Derive display phase from explicit wait reasons and merge/join state.

- `src/components/workflow-graph/ExecutionContextNode.tsx`
  - Replace pending-only footer copy with reason-specific copy.

- `src/lib/schemas.ts`
  - Add lane, join, wait reason, and final publish state schemas.

## Testing Strategy

Use red-green TDD for each behavior. Do not use `vi.mock()` for internal
project modules; use dependency injection and test fixtures.

High-value tests:

- A completed context schedules its single dependent while unrelated sibling
  work remains in flight.
- A pending context with all dependencies landed is displayed as ready or
  queued, not waiting on upstream.
- A linear chain reuses one lane and creates zero intermediate joins.
- At fan-out, exactly one child inherits the parent lane and other concurrent
  children fork.
- A fan-in context with two distinct source lanes creates one join before
  running.
- A fan-in context whose dependencies already share a lane creates no join.
- Multiple terminal lanes create a final publish join before workflow
  completion.
- A join failure records the original pending halt reason and drains in-flight
  contexts.
- Restart recovery reloads lane and join state without scheduling duplicate
  contexts.

## Rollout Plan

1. Fix readiness display and batch-barrier scheduling first. This is the
   correctness issue and has value independent of lane reuse.
2. Introduce lane and join schemas behind the current behavior, with one lane
   per existing scheduled worktree.
3. Add sequential reuse for single-dependency chains inside worktree lanes.
4. Add explicit final publish join for multiple terminal lanes.
5. Add fan-out continuation planning and fork behavior.
6. Evaluate session-lane participation after the lane model is stable.

## Open Questions

- Should session-lane participation be enabled by default after the lane model
  lands, or should it remain opt-in until manual session interactions are
  blocked more explicitly during graph workflow execution?
- Should final verification run in the session lane after final publish, or in
  the chosen convergence lane before final publish?
- Do runtime-added tasks ever invalidate the seeded lane plan, or should they
  always remain inside the active context's assigned lane?
- Should the UI expose lane identity directly, or only use it for status and
  event-log detail?
