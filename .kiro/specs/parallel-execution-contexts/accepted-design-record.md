# Accepted Design Record — Graph Workflow Orchestration Optimization

## Status

Accepted implementation decisions for the orchestration optimization proposed in
`orchestration-optimization-proposal.md`, scoped against the existing
`requirements.md` and `design.md` for parallel execution contexts. This record
is the authoritative reference for downstream tasks; the proposal and the
existing design remain as background context.

## Scope

This document records what is being built and why each decision was made. It
does not duplicate scheduling-rule prose from the proposal; it pins the
decisions that govern how new schemas, modules, and tests should be shaped.

## Accepted Decisions

### 1. Execution lanes are branch/worktree lines of development

- A graph workflow execution lane is a mutable branch + worktree pair that
  carries one or more execution contexts in sequence.
- A lane has the kind `"session"` (the shared session worktree) or
  `"worktree"` (an isolated graph worktree under `.worktrees/`).
- Contexts assigned to the same lane run strictly sequentially and inherit the
  prior context's committed lane head.
- Lanes are independent of the agent-session "lane" concept used by the
  workflow continuity service. The two concepts must be named distinctly in
  code (see decision 2).

### 2. Existing agent-session lane state must be renamed

- The existing `graphWorkflowLaneStateSchema` / `GraphWorkflowLaneState`
  represents Claude/Codex agent-session rotation state. It is **not** the new
  execution-lane state.
- Before any execution-lane work lands, the existing agent-session schema and
  type are mechanically renamed to an agent-session-specific name such as
  `graphWorkflowAgentSessionStateSchema` / `GraphWorkflowAgentSessionState`.
- The persisted JSON shape is preserved unless a deliberate migration is
  approved.
- The `GraphWorkflowLaneKind` enum (e.g. `"implementer"`, `"context_validator"`)
  is an agent-role discriminator. The name remains because the values are
  unambiguous about which lane kind they describe.

### 3. Context status remains lifecycle-only

- `GraphWorkflowExecutionContextState.status` continues to carry context
  lifecycle (`pending`, `ready`, `queued`, `running`, `completed`, `halted`,
  ...). It does not encode wait reasons.
- Wait reasons live in a separate `waitReason` field on the context state with
  values such as `blocked_by_dependencies`, `waiting_for_lane`,
  `waiting_for_join`, `waiting_for_capacity`, or `null`.
- The UI is not allowed to derive wait reasons from `status === "pending"`
  alone; it must use the explicit `waitReason` field.

### 4. Wait state is derived from durable state

- Wait reasons are recomputed from persisted lane, join, and dependency state.
  They are not stored as opaque enum flags by the scheduler.
- Restart recovery loads lanes, joins, and contexts and rederives every
  context's `waitReason` deterministically before resuming the loop.
- This keeps SSE projections and UI status surfaces truthful without the
  scheduler needing to remember intermediate wait reasons.

### 5. Event-driven scheduling needs a temporary worktree-isolation guard

- The scheduler moves from "schedule batch, wait for whole batch" to "schedule
  every currently schedulable context, wait for next settle, reschedule".
- Until lane-aware execution-target routing lands end-to-end, the loop must
  retain the existing per-context worktree provisioning so concurrent contexts
  cannot edit the session worktree simultaneously.
- This guard is intentionally temporary. Once the `ExecutionTargetResolver`
  consumes lane assignments and routes implementer/validator turns through the
  lane's worktree, the guard is removed and lane reuse becomes safe across
  fan-out.

### 6. Lane commits remain per-context validation boundaries

- Each context still runs implementer → script validator → context validator →
  lane commit, in that order, on its assigned lane.
- The lane commit is generalized from "solo commit on the session branch" to
  "commit on the lane branch". Downstream lane reuse is gated on the lane head
  matching the just-committed output.
- A context must not begin running on a downstream lane until its upstream
  context's lane commit is durable.

### 7. Joins are first-class persisted state

- Multi-source-lane fan-in is modeled as a join with its own persisted state
  (`joinId`, `targetLaneId`, `sourceLaneIds`, `status`, `lastError`).
- Joins are not synthesized inline by the scheduler; they are produced by the
  lane planner (or by event-driven scheduling when dependencies fan in across
  lanes) and survive restart.
- The smart-merge state machine remains the merge implementation. Joins simply
  parameterize the merge machine with source and target lanes.

### 8. Final publish is a planner-produced join

- Workflow completion is normalized to a single terminal convergence point.
- When terminal contexts end in more than one lane, the planner produces an
  explicit final-publish join over those terminal lanes. The scheduler does
  not synthesize the final merge as a side effect.
- When all terminal contexts already share the session lane, the planner
  marks the final publish a no-op rather than skipping it implicitly.

### 9. Final verification runs after publish

- Final verification contexts (when present) execute against the post-publish
  session lane.
- Running verification on a non-session lane and merging afterward is rejected
  for the default rollout. Future workflows can opt into pre-publish
  verification if and only if the design captures the trade-off explicitly.

### 10. Session-lane participation is opt-in only

- The session worktree may eventually act as one execution lane, but this is
  not enabled by default in the initial rollout.
- The default rollout keeps all parallel chains on isolated worktree lanes and
  merges into the session branch at final publish.
- Session-lane participation is gated behind an explicit configuration flag
  and additional preflight checks (dirty worktree guard, blocking of user
  commit/merge jobs during graph activity).

## Schema Impact Summary

These changes land in `src/lib/schemas.ts` and propagate to `src/types/index.ts`
via `z.infer`-derived exports.

- Rename `graphWorkflowLaneStateSchema` → `graphWorkflowAgentSessionStateSchema`
  and `GraphWorkflowLaneState` → `GraphWorkflowAgentSessionState`. The
  persisted JSON layout under `execution.laneStates` is preserved.
- Introduce `GraphWorkflowLaneExecutionState` for branch/worktree lanes (new
  name; not a rename of the agent-session schema).
- Introduce `GraphWorkflowJoinState` for first-class joins (context joins and
  final publish joins).
- Extend `GraphWorkflowExecutionContextState` with `laneId`, `joinId`, and
  `waitReason` fields. Status remains lifecycle-only.

## Implementation Order

1. Rename the agent-session schema/type so the term "lane state" is free for
   execution lanes (this record's task `rename-agent-session-lane-state`).
2. Land the execution-lane and join schemas behind the current behavior.
3. Convert scheduling to event-driven with the temporary worktree-isolation
   guard from decision 5.
4. Introduce sequential lane reuse for single-dependency chains inside
   worktree lanes.
5. Make final publish an explicit planner-produced join.
6. Add fan-out continuation planning.
7. Evaluate session-lane participation behind an opt-in flag.

## Out of Scope for This Record

- Concrete Zod schema bodies for the new execution-lane and join shapes.
  Those land in their dedicated implementation tasks.
- UI label copy for the new wait reasons and merge states.
- Migration of historical executions to the new lane/join shape; the existing
  legacy-migration path covers the `activeContextIds` cutover only.
