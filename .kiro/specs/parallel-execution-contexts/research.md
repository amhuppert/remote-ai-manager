# Research & Design Decisions

## Summary

- **Feature**: `parallel-execution-contexts`
- **Discovery Scope**: Complex Integration (existing graph engine, merge machine, lock manager, conversation actor, schema)
- **Key Findings**:
  - The merge state machine (`src/lib/workflows/merge/machine.ts`) is already parameterized over `targetBranch` and `targetWorktreePath`; only its default `squashMergeActor` needs replacement to avoid finalizing the session.
  - The execution loop is single-process and keyed by `<projectPath>::<sessionName>` (`src/lib/workflows/graph-workflow/execution-loop.ts:83`); an in-process FIFO mutex is sufficient for merge serialization.
  - The persisted execution schema centralizes the active-context concept on a single field (`activeContextId`) and a flat `laneStates: Record<lane, LaneState>`. Both must be context-scoped to safely fan out.
  - The repository's `update(execution)` writes the whole execution (`workflow-manager.ts:41-46`); two siblings finishing concurrently would lose-update without a load-mutate-write critical section.
  - Worktree provisioning has a working reference at `src/lib/sessions.ts:204-311` (`provisionSession`) — branch prefix, idempotent `existsSync` guard, atomic state write.

## Research Log

### Smart-merge state machine surface

- **Context**: Determine whether the merge machine can be reused unchanged for graph context fan-in into the session branch (not `main`).
- **Sources Consulted**: `src/lib/workflows/merge/machine.ts`, `src/lib/workflows/merge/types.ts`, `src/lib/workflows/merge/actors.ts`, `src/lib/git-operations.ts:316-466`.
- **Findings**:
  - `MergeContext.targetBranch` (default `"main"`) and `MergeContext.targetWorktreePath: string | null` already exist in `types.ts` and are threaded into `mergeMain` (`actors.ts`) and `squashMergeActor`.
  - `mergeMain` calls `mergeTargetIntoFeature(worktreePath, targetBranch)` from `git-operations.ts` — already non-`main`-aware.
  - The default `squashMergeActor` (`actors.ts:236-294`) calls `setSessionFinished`, `stopAllForSession`, and `retargetOrphanedChildren` after squash — these are session-finalization side effects that **must not** fire for graph fan-in.
  - The XState v5 `setup({...}).createMachine(...)` factory exposes `.provide({ actors: { ... } })` for actor binding overrides without forking the machine.
- **Implications**: Graph fan-in must construct a `mergeMachine.provide({ actors: { squashMerge: graphContextSquashMergeActor } })` variant whose squash actor performs only the `squashMerge` git op + project lock acquisition + cleanup signal, omitting the session-finalization calls.

### Execution-loop concurrency scope

- **Context**: Confirm the loop's locking and active-loop registry semantics so the parallel batch model fits without race conditions.
- **Sources Consulted**: `src/lib/workflows/graph-workflow/execution-loop.ts`, `src/lib/lock.ts`.
- **Findings**:
  - `activeLoops: Set<string>` keyed by `<projectPath>::<sessionName>` enforces one execution loop per session per process.
  - The session git lock (`acquireSessionLock`) and project git lock (`acquireProjectLock`) are independent in-process mutexes used by merge/commit jobs.
  - The conversation-level single-flight lock is keyed per conversation, not per session, so concurrent agent turns are already supported when they target distinct conversation ids.
- **Implications**: Layered locking is well-supported. Merge serialization for a session uses a new in-process FIFO mutex keyed by `<projectPath>::<sessionName>` (the same key used by `activeLoops`). The session git lock is acquired inside the merge actor when mutating `session.worktreePath`. The project lock is already acquired by the graph squash actor.

### Repository write semantics and lost-update risk

- **Context**: Two parallel sibling tasks (e.g., implementer turn completion and merge completion in another sibling) may both call `executionRepository.update(...)` concurrently.
- **Sources Consulted**: `src/lib/workflows/graph-workflow/workflow-manager.ts:41-46`, `src/lib/workflow-graph/execution-repository.ts`, `src/lib/state.ts` (mutateSession critical section).
- **Findings**:
  - `update(execution)` writes the whole execution — last write wins.
  - All current callers fetch-mutate-write outside any explicit critical section. Today this is safe because only one context is active at a time.
- **Implications**: A single load-mutate-write primitive (`mutateActive(projectPath, sessionName, fn)`) that funnels through the existing `mutateSession` critical section is required. Every state-mutating call site (workflow-manager transitions, per-task completion writes, lane updates, shared-document registrations, MCP tool updates) routes through it.

### Lane state collision with concurrent siblings

- **Context**: The current `laneStates: Record<lane, LaneState>` is keyed only by lane kind. Two siblings invoking the implementer concurrently would overwrite each other's continuity (sessionRef, conversation id, rotation flag, last token usage).
- **Sources Consulted**: `src/lib/schemas.ts:1206-1247`, `src/lib/workflows/graph-workflow/workflow-manager.ts:576-583` (rotation flag set on the lane).
- **Implications**: Lane state must be context-scoped: `Record<contextId, Record<lane, LaneState>>` (or canonical key `${contextId}:${lane}`). Rotation flag application becomes per-context. Lane-state cleanup on context completion remains scoped to that context.

### Worktree provisioning reference

- **Context**: We need an idempotent, dependency-injectable worktree primitive; reuse must follow existing `git worktree` patterns.
- **Sources Consulted**: `src/lib/sessions.ts:204-311` (`provisionSession`), `src/lib/git-client.ts` (default git client interface).
- **Findings**: Provisioning pattern is `git worktree add -b <branch> <path> <baseBranch>` with a precheck for `existsSync(path)` and a state record write. `defaultGitClient` injection is the standard.
- **Implications**: A focused `parallel-worktrees.ts` module with `provision({ contextId, sessionBranch, sessionDir, projectPath })` and `dispose({ path, branch })` is sufficient. Branch name derives from `sessionDir` and `contextId` only; no random suffix is required because the contextId is unique within an execution and worktrees are torn down on success.

### Schema-cutover safety

- **Context**: `markActiveContextReady` (workflow-manager.ts:135-148) dereferences `execution.activeContextId`. A passive Zod default would silently fail.
- **Sources Consulted**: `workflow-manager.ts:135-148`, `iteration-orchestrator.ts:215, 1160, 1353`, plus the auto-loaded persisted-execution boundary in the repository.
- **Implications**: Active migration is required. On load: detect a record with the legacy `activeContextId` field or any context state with `status === "running"` → run `schema-cutover normalization` that pauses the execution, resets running contexts to `ready`, sets `activeContextIds = []`, preserves any per-context worktree metadata, and persists the upgraded record before any runtime reader consumes it. Failure to repair must preserve the original record and fail loudly.

### Conversation single-flight key vs concurrent agent turns

- **Context**: Verify that simultaneous parallel implementer turns will not deadlock or queue against each other.
- **Sources Consulted**: `src/lib/lock.ts:228` (`acquireSessionLock`), `src/lib/lock.ts:271` (conversation lock).
- **Findings**: `acquireSessionLock(projectPath, sessionName)` is keyed at the session granularity. Conversation locks are keyed per conversation id. The implementer runner uses `executePromptStream(projectPath, session, ...)` which routes through the conversation actor, ultimately taking a conversation-level lock when each context has its own conversation id.
- **Implications**: Distinct per-context conversation ids are required for concurrent agent turns. The execution loop already creates per-context conversations; no new lock contention is introduced. Only the merge phase needs the session-level git lock, and merges are already serialized by the per-session merge mutex.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Implicit fan-out from DAG eligibility | Run all contexts returned by `getEligibleContextIds` concurrently, no flag | Source of truth is the dependency graph; no surface for workflows to lie about safety | Requires schema generalization (`activeContextIds[]`) and lane scoping | Selected |
| Workflow-level `parallel: true` flag | Opt-in via workflow definition | Minimal schema churn | DAG is already authoritative; flag duplicates information; risk of disagreement between flag and graph | Rejected |
| Sub-worktree per context unconditionally | Always provision a sub-worktree, even for solo contexts | Uniform pipeline | Pays git overhead for the common (serial) case; merge round-trip when no merge is needed | Rejected |
| Always merge in a dedicated "merge worktree" | Never merge into the session worktree | Avoids any possibility of session-worktree contention with concurrent reads | Doubles worktree count; requires synchronizing the merge worktree back to the session worktree; no correctness gain because the session worktree is already quiescent during fan-in | Rejected |

## Design Decisions

### Decision: Reuse `mergeMachine` with a non-finalizing graph squash actor (composition over modification)

- **Context**: Default `squashMergeActor` ends a session by calling `setSessionFinished`, `stopAllForSession`, `retargetOrphanedChildren`. Graph fan-in must not end the session.
- **Alternatives Considered**:
  1. Add a `mode: "session-finalize" | "graph-fan-in"` discriminator to the merge context — bloats `MergeContext` and forks behavior inside the actor.
  2. Provide a non-finalizing `graphContextSquashMergeActor` and bind it via `mergeMachine.provide({ actors: { squashMerge: ... } })`.
- **Selected Approach**: (2). Two squash-actor variants share the underlying `squashMerge` git op + project lock; the graph variant omits session-finalization side effects.
- **Rationale**: Per `engineering-principles.md` ("Composable primitives, not feature silos"), the change is additive — the merge machine surface is unchanged for existing callers, the graph engine simply constructs a `.provide()`'d actor for fan-in.
- **Trade-offs**: Two near-identical squash actor implementations; mitigated by extracting the shared core (squash + project lock) into a small helper.
- **Follow-up**: Verify `setSessionFinished`, `stopAllForSession`, and `retargetOrphanedChildren` are not invoked by graph fan-in via integration test; verify `acquireProjectLock` is acquired by the graph variant.

### Decision: Atomic `mutateActive(projectPath, sessionName, fn)` primitive

- **Context**: Two sibling completions (or sibling completion + merge completion) writing to the execution record race in `executionRepository.update(...)`.
- **Alternatives Considered**:
  1. Optimistic concurrency control (compare-and-swap on a `revision` field) — adds schema and retry surface; doesn't compose with sequential XState transitions cleanly.
  2. Centralized load-mutate-write critical section keyed per session (matches the existing `mutateSession` pattern in `state.ts`).
- **Selected Approach**: (2). Add `mutateActive(projectPath, sessionName, fn: (execution) => execution): Promise<execution>` to the workflow manager / repository surface; route every state-mutating call site through it; queue concurrent mutators via the existing per-session in-memory critical section.
- **Rationale**: Reuses the project's existing single-process serialization primitive. Functional mutation closure (`fn`) keeps callers' intent explicit and atomic.
- **Trade-offs**: Higher contention on the critical section under heavy fan-out; mitigated by the loop's natural batching (one batch at a time, completions are short).
- **Follow-up**: Audit every existing `executionRepository.update(...)` call site and replace with `mutateActive`. Add a lint or a type-level fence to prevent future direct `update(...)` calls outside the primitive.

### Decision: Context-scoped lane state (`Record<contextId, Record<lane, LaneState>>`)

- **Context**: Two sibling implementer turns running concurrently must not overwrite each other's lane continuity, rotation flag, or last-used timestamp.
- **Alternatives Considered**:
  1. Keep flat `Record<lane, LaneState>` and serialize sibling turns via the session lock (defeats parallelism).
  2. Promote to `Record<contextId, Record<lane, LaneState>>`.
- **Selected Approach**: (2). The lane schema already carries `contextId`, but is keyed by lane only at the map level. Promote the keying.
- **Rationale**: Smallest schema change that makes per-context turn continuity safe without serializing turns.
- **Trade-offs**: Storage/memory grows linearly with active context count; trivial in practice.
- **Follow-up**: Update `workflow-manager.ts:576-583` rotation flag application to look up `laneStates[contextId][lane]`; update lane writers in implementer-runner / validator-runner; clear lane state for a context when its merge succeeds (or it halts) to bound memory.

### Decision: Per-context worktree only when ≥ 2 contexts are eligible at once

- **Context**: Solo workflows must not pay worktree round-trip overhead.
- **Alternatives Considered**:
  1. Always sub-worktree (uniform but wasteful).
  2. Sub-worktree only when the schedule batch size > 1 (current decision).
- **Selected Approach**: (2). When eligible-set size is 1, the context runs in `session.worktreePath` and skips the merge pipeline on completion. When size ≥ 2, all eligible contexts get sub-worktrees and run their fan-in merges on completion.
- **Rationale**: Preserves zero-overhead serial execution; the merge round-trip is reserved for cases that genuinely need it.
- **Trade-offs**: Two scheduling paths inside `scheduleEligibleContexts` (1-eligible vs N-eligible). Minor branching cost; mirrored in tests.
- **Follow-up**: Confirm that a context that becomes solo after a sibling halts continues to use its already-provisioned worktree (it does; provisioning is sticky for the context's lifetime).

### Decision: Drain-then-halt with persisted `pendingHaltReason`

- **Context**: A sibling's failure (recovery error, circuit breaker, max iterations, merge failure) should halt the workflow without losing committed work in flight.
- **Alternatives Considered**:
  1. Cancel in-flight siblings on first failure (loses committed work).
  2. Record a pending halt reason (first-failure-wins), keep scheduling no further batches, allow in-flight siblings to drain through completion + merge, then halt.
- **Selected Approach**: (2). Persist `pendingHaltReason` on the execution record alongside the failure write; on every batch-scheduling tick, refuse to schedule further batches if the reason is set; once all in-flight siblings settle, transition execution to `halted` with the original reason.
- **Rationale**: Matches the spirit of the existing circuit breaker (halt is observable, not destructive); persistence ensures restart-mid-drain reaches the same terminal state.
- **Trade-offs**: A second sibling failure after the first is logged but does not overwrite the original reason; this is intentional (first-failure-wins) but must be documented and tested.
- **Follow-up**: Add `pendingHaltReason` to the schema; ensure `normalizeAfterRestart` surfaces it; emit it via the SSE channel on first set.

### Decision: Active schema cutover, not Zod default

- **Context**: Persisted executions exist with the legacy `activeContextId` field (and possibly `running` context states from process crashes). Passive defaulting in Zod would surface a partially-corrupt runtime.
- **Alternatives Considered**:
  1. `activeContextIds: z.array(z.string()).default([])` — silently drops the legacy active context when it was running.
  2. Active normalization on load.
- **Selected Approach**: (2). On load via the persisted-execution boundary, detect legacy/interrupted shape, run schema-cutover normalization (pause + reset running → ready + initialize empty active set + preserve worktree metadata), persist the upgraded record before any runtime reader consumes it, and emit a structured migration event. If repair fails, preserve the original record and fail loudly.
- **Rationale**: Avoids a class of stranded-state bugs where the loop never re-schedules an "orphan running" context. Loud failure is preferred to silent data loss.
- **Trade-offs**: Modestly more code in the load path; well-bounded by a single `safeParse` + repair function.
- **Follow-up**: Cover all four legacy shapes (legacy field present + no running, legacy field present + running context, no legacy field + interrupted running, neither) in a parameterized cutover test.

### Decision: Fail-but-retain on merge failure; auto-clean only on success

- **Context**: A failed sibling worktree must remain inspectable for recovery; a successful one should reclaim disk.
- **Alternatives Considered**:
  1. Always clean up; recovery via `git reflog` only.
  2. Retain on failure, clean on `merge-success`.
- **Selected Approach**: (2). `mergeStatus` distinguishes `merged-success` (clean up) from `merged-failed` / `conflicts` (retain). `cleanupStatus` records cleanup outcome and is non-fatal on failure.
- **Rationale**: Matches user expectation that a failure leaves debug surface intact; the workflow halts with `merge_failure` carrying the conflict file list, so the user can hand-resolve in the retained worktree.
- **Trade-offs**: Disk accumulation if the user ignores failed worktrees; mitigated by the explicit retention being the "recovery surface" by design.
- **Follow-up**: Add a UI affordance later (out of scope for this feature) to list and prune retained failed worktrees.

## Risks & Mitigations

- **Risk**: Hidden mutators of `executionRepository.update(...)` outside `mutateActive` re-introduce lost-update races.
  - **Mitigation**: Audit + grep gate; consider narrowing the repository's `update` visibility (export only `mutateActive` from the workflow manager surface).
- **Risk**: A sibling's per-context worktree directory contains uncommitted changes the agent never saved (e.g., abrupt halt mid-edit), and the fan-in merge tries to commit garbage.
  - **Mitigation**: Reuse the merge machine's existing `committingUncommitted` step (with skipHooks) so partial work is captured as a "WIP" commit before the sibling-branch merge of session changes runs; the smart-merge pipeline already handles this.
- **Risk**: Concurrent agent turns blow past per-conversation rate limits in a backend.
  - **Mitigation**: Out of scope for this feature; the existing per-conversation locking already serializes within a conversation. If rate limits become an issue in practice, a global "max concurrent agent turns" knob can be added later.
- **Risk**: A test runs leaks per-context worktrees on the developer machine.
  - **Mitigation**: Tests must place sub-worktrees inside the session's tmp fixture under this worktree's tree (`<projectPath>/.worktrees/<sessionDir>.<contextId>` resolves into the test session's path); a teardown hook removes any residual `.worktrees/<sessionDir>.*` directories.

## References

- `src/lib/workflows/merge/machine.ts` — XState v5 merge machine (squash actor binding via `.provide()`).
- `src/lib/workflows/merge/actors.ts` — default `squashMergeActor` (session-finalizing); reference for the new graph variant.
- `src/lib/workflows/merge/types.ts` — `MergeContext.targetBranch`, `MergeContext.targetWorktreePath`.
- `src/lib/workflows/graph-workflow/workflow-manager.ts` — `scheduleNextContext`, `markActiveContextReady`, `recoverRetryableIterationError`.
- `src/lib/workflows/graph-workflow/execution-loop.ts` — `activeLoops` registry, `loopKey`.
- `src/lib/sessions.ts:204-311` — `provisionSession` reference for `git worktree add -b`.
- `src/lib/git-operations.ts:316-466` — `mergeTargetIntoFeature(worktreePath, targetBranch)` underlying primitive.
- `src/lib/lock.ts` — session, project, conversation single-flight locks.
- `src/lib/schemas.ts:1206-1256` — `graphWorkflowLaneStateSchema`, `graphWorkflowExecutionSchema`.
- `.kiro/steering/engineering-principles.md` — composable primitives; agent-offloading; TDD.
- `.kiro/steering/structure.md` — schemas-first; colocated tests; lib module conventions.
