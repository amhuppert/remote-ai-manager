# Requirements Document

## Project Description (Input)
parallel execution contexts in graph workflow

## Introduction

The Graph Workflow engine already orders execution contexts into a dependency graph and exposes the parallel-eligible set via `getEligibleContextIds`. However, only one context is ever scheduled at a time. This feature makes the engine actually run eligible-in-parallel contexts concurrently, while preventing the conflicts a naive parallel implementation would cause when multiple agents edit the same files.

The approach is fan-out / fan-in: each parallel sibling runs in its own git worktree branched from the session branch; on completion, each sibling's branch is merged back into the **session branch** (not `main`) via the existing smart-merge state machine, with autonomous LLM-driven conflict resolution. Merges are serialized per session, and a single sibling failure drains in-flight siblings before halting the workflow with the original reason.

The change is additive on existing primitives (graph engine, merge machine, git-operations, conversation actor) — no parallel-orchestrator fork. Solo-eligible scheduling is preserved unchanged so workflows that never branch incur zero overhead.

## Requirements

### Requirement 1: Parallel scheduling from graph eligibility
**Objective:** As an autonomous Graph Workflow operator, I want eligible-in-parallel execution contexts to run concurrently, so that wall-clock latency for fan-out workflows is bounded by the longest sibling rather than the sum.

#### Acceptance Criteria
1. When `getEligibleContextIds` returns exactly one context at a scheduling tick, the Graph Workflow Engine shall mark only that context active and run it directly inside the session worktree without provisioning a sub-worktree.
2. When `getEligibleContextIds` returns two or more contexts at a scheduling tick, the Graph Workflow Engine shall mark all of them active simultaneously and run one per-context runner concurrently.
3. While at least one context is in `running` status, the Graph Workflow Engine shall not schedule any context whose dependencies are not yet satisfied.
4. The Graph Workflow Engine shall derive parallelism solely from the dependency graph and shall not require a workflow-level or context-level `parallel` flag.
5. When parallel sibling runners use distinct conversations, the Graph Workflow Engine shall allow their agent turns to execute concurrently and shall serialize only turns that target the same conversation.

### Requirement 2: Per-context worktree isolation for parallel siblings
**Objective:** As an autonomous Graph Workflow operator, I want each parallel sibling to operate in its own git worktree on its own branch, so that concurrent agent edits cannot conflict with each other on the session worktree.

#### Acceptance Criteria
1. When two or more contexts are scheduled in parallel, the Graph Workflow Engine shall provision a per-context worktree at `<projectPath>/.worktrees/<sessionDir>.<contextId>` for each scheduled context.
2. When provisioning a per-context worktree, the Graph Workflow Engine shall create branch `csm/<sessionDir>-<contextId>` from `session.branchName` (not from `main`).
3. While a per-context worktree exists, the Graph Workflow Engine shall route the implementer agent, script validator, and agent validator for that context to the per-context worktree path and branch.
4. If a context-id cannot be safely used as a path or branch component, the Graph Workflow Engine shall fail scheduling for that batch with a clear error before any worktree is created.
5. If provisioning of any worktree in a batch fails, the Graph Workflow Engine shall roll back any worktrees already provisioned for that batch.

### Requirement 3: Solo-eligible behavior preserved
**Objective:** As a workflow author, I want serial workflows to incur no parallelization overhead, so that the common case stays fast and the sub-worktree round-trip is reserved for genuinely concurrent work.

#### Acceptance Criteria
1. When exactly one context is eligible at a scheduling tick, the Graph Workflow Engine shall not provision a sub-worktree, shall not create a new branch, and shall not invoke the merge pipeline on that context's completion.
2. The Graph Workflow Engine shall route a solo-scheduled context's agent invocations to `session.worktreePath` and `session.branchName` exactly as the pre-feature behavior does.

### Requirement 4: Smart-merge fan-in into the session branch
**Objective:** As an autonomous Graph Workflow operator, I want each parallel sibling's completed work to be merged back into the session branch automatically, so that subsequent contexts and the user always see the union of completed work on the session branch.

#### Acceptance Criteria
1. When a parallel sibling reaches context-completion (no halt, no remaining tasks) and its worktree contains uncommitted changes, the Graph Workflow Engine shall create a commit on the sibling branch before any merge attempt.
2. When a parallel sibling branch is ready to synchronize with the current session branch, the Graph Workflow Engine shall merge the latest `session.branchName` into the sibling branch and resolve conflicts autonomously when auto-resolve is enabled.
3. When a sibling branch contains the latest session-branch changes and is ready for fan-in, the Graph Workflow Engine shall merge that branch into `session.branchName` using `session.worktreePath` as the target worktree, not `session.targetBranch` or `main`.
4. While invoking the merge pipeline for a graph context, the Graph Workflow Engine shall use a non-finalizing squash actor that does not call `setSessionFinished`, `stopAllForSession`, or `retargetOrphanedChildren`.
5. When the merge pipeline reaches `completed` for a sibling, the Graph Workflow Engine shall mark that context's `mergeStatus = "merged-success"`, remove the per-context worktree, and delete the per-context branch.
6. If the merge pipeline reaches `failed` or `conflicts` after auto-resolve attempts are exhausted, the Graph Workflow Engine shall record `mergeStatus` accordingly, retain the per-context worktree, and surface a `merge_failure` halt reason carrying the contextId, message, and conflict file list.
7. The Graph Workflow Engine shall never merge a sibling that halted before context-completion; partial work shall remain on its branch.

### Requirement 5: Autonomous conflict resolution
**Objective:** As an autonomous Graph Workflow operator, I want merge conflicts between siblings on the session branch to be resolved without human intervention, so that unattended workflows do not stall on routine file conflicts.

#### Acceptance Criteria
1. When the merge pipeline detects conflicts on a graph context merge, the Graph Workflow Engine shall delegate resolution to the existing `resolveConflictsActor` of the merge state machine.
2. While conflict resolution is in progress, the Graph Workflow Engine shall not start another graph context merge for the same session.
3. If `resolveConflictsActor` cannot resolve all conflicts within its configured attempt budget, the Graph Workflow Engine shall treat the merge as failed and emit a `merge_failure` halt reason.

### Requirement 6: Merge serialization per session
**Objective:** As an autonomous Graph Workflow operator, I want concurrent sibling merges to be serialized per session, so that the session worktree's git index is never mutated by two operations at once.

#### Acceptance Criteria
1. While a graph context merge is in progress for a session, the Graph Workflow Engine shall queue any other completing siblings for that session and process them in FIFO order.
2. When a graph context merge needs to mutate `session.worktreePath`, the Graph Workflow Engine shall acquire the existing session-level git lock, waiting/retrying on transient contention.
3. While a graph context merge holds the session-level git lock, user-triggered commit or merge jobs shall not mutate the same session worktree.
4. The Graph Workflow Engine shall acquire the existing project-level git lock inside the squash phase of a graph context merge, in addition to the per-session merge mutex.

### Requirement 7: Failure-drain semantics
**Objective:** As an autonomous Graph Workflow operator, I want a single sibling's failure to halt the workflow gracefully without losing committed work from in-flight siblings, so that a transient failure in one branch does not cost completed work in another.

#### Acceptance Criteria
1. When the first sibling failure occurs (recovery error, circuit-breaker trip, max iterations, or merge failure), the Graph Workflow Engine shall record the failure as the pending halt reason and stop scheduling further batches.
2. While a pending halt reason is recorded, the Graph Workflow Engine shall allow already-running siblings to continue to context-completion and shall execute their merge pipelines normally.
3. If a second sibling failure occurs after a pending halt reason is already recorded, the Graph Workflow Engine shall log the secondary failure but shall not overwrite the original pending halt reason.
4. When all in-flight siblings have settled and a pending halt reason is present, the Graph Workflow Engine shall transition the workflow to `halted` with the original pending halt reason.

### Requirement 8: Halt-reason persistence
**Objective:** As a Graph Workflow operator, I want the pending halt reason to survive a process restart mid-drain, so that resuming the workflow accurately reflects the original cause of the halt.

#### Acceptance Criteria
1. When the Graph Workflow Engine records a pending halt reason, it shall persist that reason on the execution record atomically with the same write that records the failure.
2. While a persisted pending halt reason is present on an execution at process startup, the restart-normalization path shall surface that reason rather than discarding it.
3. The Graph Workflow Engine shall expose the pending halt reason via the existing execution event/SSE channel as soon as it is recorded.

### Requirement 9: Schema generalization
**Objective:** As a maintainer, I want the persisted execution model to represent multiple active contexts and per-context worktree state, so that the in-memory and on-disk shapes match the actual fan-out semantics.

#### Acceptance Criteria
1. The Graph Workflow Engine shall represent the active context set as `activeContextIds: string[]` instead of `activeContextId: string | null`.
2. The Graph Workflow Engine shall extend per-context state with `worktreePath`, `branchName`, `isolation` ("session" | "worktree"), `batchId`, `mergeStatus`, `cleanupStatus`, and `lastMergeError` fields.
3. The Graph Workflow Engine shall extend the halt-reason discriminated union with a `merge_failure` variant carrying `contextId`, `message`, and `conflictFiles`.
4. The Graph Workflow Engine shall persist `pendingHaltReason` on the execution record.
5. The Graph Workflow Engine shall not introduce a backwards-compatibility shim for the legacy `activeContextId` field; all readers shall consume `activeContextIds`.

### Requirement 10: Active schema cutover and restart recovery
**Objective:** As a maintainer cutting over from the single-active-context schema, I want legacy and interrupted executions repaired explicitly before use, so that no execution is stranded outside the active context set.

#### Acceptance Criteria
1. When the Graph Workflow Engine loads a persisted execution containing the legacy `activeContextId` field or any context state with `status === "running"`, it shall run schema-cutover normalization before the execution can resume.
2. When schema-cutover normalization runs, the Graph Workflow Engine shall transition the execution to `paused`, set `activeContextIds` to the empty array, reset every `running` context to `ready`, and preserve any per-context worktree metadata already present.
3. When schema-cutover normalization succeeds for an execution containing the legacy `activeContextId` field, the Graph Workflow Engine shall persist the upgraded execution without the legacy field before any runtime reader consumes it.
4. When schema-cutover normalization modifies an execution, the Graph Workflow Engine shall emit a structured migration event identifying the executionId and repaired fields.
5. If schema-cutover normalization cannot repair an execution cleanly, the Graph Workflow Engine shall preserve the original persisted record and fail loudly rather than silently dropping data.

### Requirement 11: Atomic context-scoped state mutations
**Objective:** As a maintainer, I want all execution-state writes to be applied atomically, so that two concurrent siblings completing tasks cannot lose each other's updates.

#### Acceptance Criteria
1. When two or more sibling runners write to the execution record concurrently, the Graph Workflow Engine shall apply each write inside a single load-mutate-write critical section, preserving the other writers' updates.
2. The Graph Workflow Engine shall route every state-mutating call site (workflow-manager transitions, per-task completion writes, lane updates, shared-document registrations, MCP tool updates) through this atomic mutation primitive.
3. While an atomic mutation is in flight for a session, other mutators for that session shall queue rather than read stale state.

### Requirement 12: Context-scoped lane state
**Objective:** As a maintainer, I want lane-state to be scoped per execution context, so that sibling implementer or validator turns cannot overwrite each other's continuity records.

#### Acceptance Criteria
1. The Graph Workflow Engine shall key lane state by both `contextId` and lane kind (e.g., `Record<contextId, Record<lane, LaneState>>` or canonical `${contextId}:${lane}`).
2. When a sibling implementer turn updates lane state, the Graph Workflow Engine shall not overwrite the lane state of any other concurrently active context.
3. While retrying a retryable iteration error in one context, the Graph Workflow Engine shall apply the lane-rotation flag only to that context's lane.

### Requirement 13: Worktree lifecycle on success and failure
**Objective:** As an autonomous Graph Workflow operator, I want successful sibling worktrees cleaned up automatically and failed worktrees retained for inspection, so that disk space is reclaimed without losing recovery surfaces.

#### Acceptance Criteria
1. When `mergeStatus` transitions to `merged-success` for a context, the Graph Workflow Engine shall remove the per-context worktree and delete the per-context branch.
2. While `mergeStatus` is `merged-failed` or `conflicts`, the Graph Workflow Engine shall retain the per-context worktree and branch.
3. If worktree cleanup fails after a successful merge, the Graph Workflow Engine shall log a `cleanup_failed` warning, set `cleanupStatus = "failed"`, and continue execution; cleanup failure shall not halt the workflow.
4. The Graph Workflow Engine shall not delete failed sibling worktrees automatically as part of any startup or scheduling sweep.

### Requirement 14: Single-process execution-loop scope
**Objective:** As a maintainer, I want the parallel execution machinery to assume the single-process loop scope of the existing engine, so that the design does not over-generalize to multi-process orchestration that the rest of the codebase does not support.

#### Acceptance Criteria
1. The Graph Workflow Engine shall serialize merges per session via an in-process FIFO mutex keyed by `<projectPath>::<sessionName>`.
2. The Graph Workflow Engine shall enforce one execution loop per `<projectPath>::<sessionName>` consistent with the existing `activeLoops` registry.

### Requirement 15: Composability with existing primitives
**Objective:** As a maintainer, I want the implementation to extend existing primitives rather than fork them, so that the engine remains a single, evolvable system rather than a parallel branch.

#### Acceptance Criteria
1. The Graph Workflow Engine shall reuse the existing graph dependency resolver (`getEligibleContextIds`) without modification to its public contract.
2. The Graph Workflow Engine shall reuse the existing smart-merge state machine (`mergeMachine`) for graph context fan-in, varying only its squash actor binding via `.provide()`.
3. The Graph Workflow Engine shall reuse the existing conversation/agent-invocation boundary (`executePromptStream` via the implementer runner) for parallel sibling agent calls; it shall not introduce a parallel agent-invocation pathway.
4. The Graph Workflow Engine shall not introduce a parallel-orchestrator that duplicates the workflow manager, execution loop, or iteration orchestrator.

### Requirement 16: Type safety and validation
**Objective:** As a maintainer, I want all schema and runtime data to be type-safe and Zod-validated end-to-end, so that the parallel-execution surface does not become a refuge for `any` or unchecked casts.

#### Acceptance Criteria
1. The Graph Workflow Engine shall define every new persisted shape (active set, per-context worktree fields, halt-reason variant, pending halt reason) via Zod schemas in `src/lib/schemas.ts`.
2. The Graph Workflow Engine shall derive every new TypeScript type from `z.infer` of the corresponding schema.
3. The Graph Workflow Engine shall not use `any`, `as unknown as T`, `@ts-ignore`, or `@ts-expect-error` to satisfy the type checker for any new code introduced by this feature.
4. The Graph Workflow Engine shall use `safeParse` for any persisted execution loaded from disk (untrusted boundary) and `parse` for in-process internal data.

### Requirement 17: Observability and structured logging
**Objective:** As an operator debugging a parallel run, I want every fan-out, merge, and drain event to be uniquely tagged and structured, so that post-mortem can reconstruct which siblings ran concurrently and how each merged.

#### Acceptance Criteria
1. When the Graph Workflow Engine schedules a parallel batch, it shall assign a `batchId` and write it to every per-context state in that batch.
2. The Graph Workflow Engine shall emit structured events under `graph-workflow.parallel.*` for batch scheduling, context start/finish, drain initiation/completion, and cleanup, each tagged with `batchId` where applicable.
3. The Graph Workflow Engine shall emit structured events under `graph-workflow.merge.*` for merge queued, started, completed, failed, and conflict-resolved phases, each tagged with `contextId` and `branchName`.
4. While a workflow is halted with a `merge_failure` reason, the Graph Workflow Engine shall expose the contextId, message, and conflict file list through the existing execution-event channel for UI consumption.

### Requirement 18: Test discipline
**Objective:** As a maintainer, I want every behavior introduced by this feature to be backed by red-green TDD, so that the engine remains regression-resistant under future change.

#### Acceptance Criteria
1. The Graph Workflow Engine shall ship a failing test pinning each new behavior before the implementing code lands; bug fixes shall include a failing repro test before the fix.
2. The Graph Workflow Engine shall not use `vi.mock()` for any internal project module introduced or modified by this feature; dependency injection (factory, setter, or XState `.provide()`) shall be used instead.
3. The test suite shall include integration tests proving: two siblings finishing in either order both merge successfully; the late-merger conflict path invokes `resolveConflictsActor`; one sibling halting allows the other to merge before the workflow halts with the original reason; a process crash mid-drain restarts cleanly with the persisted halt reason.
