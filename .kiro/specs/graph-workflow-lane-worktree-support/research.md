# Research & Design Decisions

## Summary
- **Feature**: `graph-workflow-lane-worktree-support`
- **Discovery Scope**: Extension (integration-focused light discovery)
- **Key Findings**:
  - The dev-server service already accepts a `worktreePath` override (`service.ts:54,64,72`; `resolveContext` at `service.ts:324-351` honors `params.worktreePath ?? session.worktreePath`) and the registry is already worktree-keyed (`registry.ts:190-197`), but no HTTP route ever passes the override — this is a regression at the adapter boundary (commit `db2f25c8` passed lane worktrees through the former in-process tools; `3d83e12d` replaced them with `cctl` over session-only routes), not a missing foundation.
  - No port reservation exists anywhere: `port-selection.ts:56-147` scans, but the port is only claimed when the child binds it, so concurrent lane starts can race to the same free port.
  - Validator parity is a plumbing gap, not a contract gap: `session-env.ts:28-46,77-80` already defines `CC_WORKFLOW_EXECUTION_ID`/`CC_WORKFLOW_CONTEXT_ID` injection from `workflowExecutionId`/`workflowContextId`, and implementers thread it (`implementer-runner.ts:120-151`); `dispatchValidatorTurn` (`validator-runner.ts:691-731`) simply never passes `workflowContext`.
  - The CLI help pipeline already forwards workflow IDs (`core.ts:101-124` puts `executionId`/`contextId` in `HelpContextRequest`), but the dev/fixture providers ignore them (`agent-help/providers.ts:103-148`).

## Research Log

### Dev-server subsystem current shape
- **Context**: Requirements 2–5, 10 extend the service, routes, port allocation, SSE, and UI hook.
- **Sources Consulted**: `src/lib/dev-server/{service,registry,schemas,route-handlers,port-selection,reconciliation,liveness}.ts`, `src/lib/workflows/primitives/session-status-bus.ts`, colocated tests.
- **Findings**:
  - Service public methods: `list`, `ensure`, `stop`, `stopUnmanaged` — each takes an optional raw `worktreePath` override; `reconcileSessionDevServers` reconciles by worktree.
  - Registry key: `${projectPath}::${sessionName}::${worktreePath}::${serverName}` (`makeKey`, `registry.ts:190-197`). `stopAllForSession` (`:720-738`) and `stopAllForWorktree` (`:746-773`) both exist; `parallel-worktrees.ts:502-540` already calls stop-for-worktree before lane removal.
  - Routes: GET/START/START_ALL pass raw session identity to the service; STOP (`route-handlers.ts:282-317`) and STOP_ALL (`:319-338`) do their own session lookup and hard-code `session.worktreePath`; STOP_ALL calls session-wide cleanup for a user-level action.
  - Direct `entry.status = ...` assignments occur at ≥8 sites across registry (`414, 447, 594, 621, 635, 716`), liveness (`:110`), reconciliation (`:102, :132`) — any reservation-release logic added to only some of them would leak.
  - Error envelope today: `{ error, code?, output?, details? }` (`route-handlers.ts:94-106`); no `instruction` field yet, while the CLI's `failureFromRequest` (`src/cli/shared.ts:210-236`) already renders `code` + `instruction` when present.
  - SSE event schema (`schemas.ts:36-49`): `worktreePath` and `ownedByThisSession` are optional/defaulted; `projectName` is emitted; scope ID in `session-status-bus.ts:229-241` is `${projectName}/${sessionName}/${serverName}` (no worktree → two lanes' same-named servers collide in one scope).
  - `DevServerRuntimeState` (`schemas.ts:52-65`) has no `localUrl`; `cctl` currently derives local URLs client-side.
- **Implications**: The design threads a resolved target through the existing service seam rather than adding a second manager; port reservation and a single entry-transition seam are genuinely new; STOP/STOP_ALL must be re-routed through the service; `instruction` must be added to the two 409 bodies.

### Workflow-graph resolution and cleanup state
- **Context**: Requirements 1, 2, 6, 9 need a client-safe persisted-state resolver, reverse conversation ownership, and durable shared-lane cleanup.
- **Sources Consulted**: `src/lib/workflow-graph/execution-target-resolver.ts`, `src/lib/workflows/schemas.ts`, `lane-join.ts`, `user-input-gate.ts`, `execution-loop.ts`, `parallel-worktrees.ts`.
- **Findings**:
  - `ExecutionTargetResolver.resolve()` returns `ExecutionTarget { worktreePath, branchName, isolation, laneId }`; resolution order: worktree lane → session lane → legacy per-context worktree → unconditional session fallback (`execution-target-resolver.ts:29-119`). Call sites: `execution-loop.ts:1273` (context startup, status `running`), `lane-tool-context-loader.ts:205` (lane tool config), `execution-route-handlers.ts` resolver instance at `:356`.
  - Context state already persists `cleanupStatus: "not-applicable" | "pending" | "removed" | "failed"` (`schemas.ts:999-1001`) plus `worktreePath`, `laneId`, `isolation`; lane state persists `worktreePath`, `branchName`, `kind`, `includedContextIds`.
  - `laneStates` is `Record<contextId, Record<agentKind, { workflowConversationId?: string, ... }>>`; validator bindings are persisted **before** dispatch (`validator-runner.ts:990-1005`, from `99adc4bc`) and are load-bearing for active cancellation.
  - Forward lookup `resolveLaneConversationId(execution, laneId)` (`lane-join.ts:396-433`): newest-context-first over `includedContextIds`, implementer binding, then task-state fallback by highest order. Reverse lookup exists inline in `user-input-gate.ts:200-212`.
  - `cleanupMergedLanes` (`execution-loop.ts:2035-2074`) runs **after** the terminal `complete` send (`:2331-2333`) and never persists results; `mutateActive` is available in the loop; `loopEpoch` fencing (from `99adc4bc`) means cleanup inside the fenced loop cannot race a superseded loop.
  - Client-import safety precedent: `lifecycle-classifier.ts` is browser-imported and uses `deepEqualJson` from `@/lib/shared/deep-equal` instead of `node:` builtins; only `bun run build` catches a `node:` leak on that path. `shortenWorktreePath` lives in `src/lib/sessions/worktree-path.ts` (client-safe).
- **Implications**: The new pure resolver must be client-safe (no `node:` imports) and the existing `ExecutionTargetResolver` becomes a thin unwrap over it. Cleanup durability reuses `cleanupStatus` — no schema change — but cleanup must move before the `complete` transition to be persistable via `mutateActive`.

### CLI, help, and agent-runtime plumbing
- **Context**: Requirements 7–8.
- **Sources Consulted**: `src/cli/commands/{dev,fixture}.ts`, `src/cli/shared.ts`, `src/cli/core.ts`, `src/cli/commands/dev.help.ts`, `src/lib/agent-help/{providers,provider-deps}.ts`, `src/lib/agent-gateway/session-env.ts`, `src/lib/workflows/conversation/execute-workflow-task-run.ts`, `implementer-runner.ts`, `validator-runner.ts`, `src/lib/prompt/sdk-driver.ts`, `runtime-state.ts`.
- **Findings**:
  - `dev.ts` and `fixture.ts:126` construct the session-only route independently (duplicated URL building). Exit codes: `EXIT_OK=0`, `EXIT_OPERATION_FAILED=1`, `EXIT_USAGE=2`, `EXIT_CONNECTION=3` (`shared.ts:55-60`).
  - `maybeFetchHelpContext` (`core.ts:101-124`) already forwards `executionId`/`contextId` from the ambient env; `HelpContextRequest` already carries them optionally; dev/fixture providers ignore them today.
  - `ConversationRuntimeState.workflowContext?: { executionId, contextId }` exists (`runtime-state.ts:43`); `buildSessionEnvContract` injects both env vars when set and neutralizes inherited `CC_*` (`session-env.ts:49-80`).
  - `ExecuteWorkflowTaskRunInput` has the `worktreePath` actor pin (`executionTarget` rebind, from `0dc38730`) but no `workflowContext`; validator dispatch omits it for both Claude and synthetic Codex conversation IDs.
  - `sdk-driver.ts:200-202` embeds dev-server guidance in `CC_CONTEXT` ("...for THIS session's worktree..."); no test currently pins that text.
- **Implications**: Validator parity is additive input plumbing plus a runtime-state set before `SUBMIT_TASK_RUN`; the CLI needs one shared target/URL helper consumed by `dev.ts`, `fixture.ts`, and help inference so command and help behavior cannot diverge.

### UI surfaces and query plumbing
- **Context**: Requirements 1, 5, 6.
- **Sources Consulted**: `src/features/session/ConversationWorkspace.tsx`, `hooks/use-session-page-view-props.tsx`, `conversation/{SessionContent,SessionInfoStrip,InfoDetailsPopover,DevServersButton}.tsx`, `mobile/MobileInfoPanel.tsx`, `src/components/{CopyableId,DevServerDrawer,NotificationListener}.tsx`, `src/hooks/use-dev-servers.ts`, `src/lib/dev-server/query-keys.ts`, `src/lib/api/fetcher.ts`, `src/components/workflow-graph/{derive-graph,ExecutionContextNode}.tsx`, `src/features/session-workflow/components/{ConnectedGraphWorkflowPanel,ExecutionInspectorPanel}.tsx`.
- **Findings**:
  - `ConversationWorkspace` already fetches the graph execution via `useSessionPageQueries` (`ConversationWorkspace.tsx:84-91`) and derives conversation role (`iteration`/`validator`) at `:112-116`; `useDevServers` is called with session identity only.
  - `devServerKeys.list(projectName, sessionName)` = `["dev-servers","list",projectName,sessionName]`; `NotificationListener` invalidates `devServerKeys.all` on every `dev-server-status` event (`NotificationListener.tsx:723-725`) — global, not session-scoped.
  - `apiFetch` (`fetcher.ts:15-32`) throws `ApiCallError` with only `statusCode`; `mutationFetch` (`:54-81`) preserves `code`/`output`/`details`/`issues`. Typed no-retry handling for GET requires extending `apiFetch` to parity.
  - `CopyableId` (`CopyableId.tsx:26-95`): `role="button"`, `tabIndex={0}`, click-only — no Enter/Space handler, no visible focus outline.
  - `DevServerDrawer`'s `ServerRow` links only via `remoteUrl` (`DevServerDrawer.tsx:200-209`); no `localUrl` fallback (server doesn't send one).
  - `ExecutionContextNodeData` = `{ context, tasks, mode, contextState, taskStates, waitState }` (`derive-graph.ts:24-33`); nodes and the inspector render no worktree today.
  - `ConnectedGraphWorkflowPanel` does not fetch session detail (no session worktree available to the canvas).
- **Implications**: Target selection composes from data the workspace already holds; the hook refactor is the largest UI change (schema-validated fetchers, target-keyed cache, typed no-retry). The graph page needs session detail threaded in for session-isolated contexts.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Server-side target resolver over durable IDs (selected) | Client sends `{executionId, contextId}` or nothing; server resolves to a worktree via persisted execution state | No path-based command execution authority for clients; one authority for UI/CLI/agents; archived executions excluded structurally | Requires typed 4xx/9 errors + client no-retry discipline | Matches "Agent-Offloading" steering: deterministic resolution in code |
| Client-resolved worktree passed to existing `worktreePath` override | UI/CLI resolve the lane path and pass it to the already-existing service override | Minimal server change | Accepting client paths = command execution authority (lane `CommandCenter.json` runs arbitrary commands); duplicate resolution logic in every client | Rejected on security grounds |
| Second workflow-scoped dev-server manager | Separate process manager for lane servers | No changes to session routes | Violates composability steering; duplicates lifecycle/liveness/Tailscale handling; plan explicitly excludes it | Rejected |

## Design Decisions

### Decision: Discriminated persisted-worktree resolver shared by UI, dev-server authorization, and orchestration
- **Context**: Three consumers need identical lane/legacy/session resolution: conversation surfaces (1.x), dev-server target authorization (2.x), execution-page display (6.x) — and `ExecutionTargetResolver` already implements the algorithm for orchestration with a silent session fallback.
- **Alternatives Considered**:
  1. Keep `ExecutionTargetResolver` as-is and write a parallel UI resolver — two algorithms drift.
  2. Extract one pure, client-safe resolver returning a discriminated availability state; `ExecutionTargetResolver.resolve()` delegates and unwraps.
- **Selected Approach**: Option 2 — `resolvePersistedExecutionWorktree(execution, contextId, session)` in `src/lib/workflow-graph/execution-worktree-target.ts` returning `available | not-provisioned | removing | removed`.
- **Rationale**: One algorithm, three consumers; the discriminated union makes unavailable states first-class instead of silent fallbacks.
- **Trade-offs**: Deliberate behavior change — `resolve()` now throws for unscheduled (`pending`/`ready`) contexts instead of returning the session worktree. All three call sites resolve contexts that are already scheduled, but each gets a pinned test so the change cannot land silently.
- **Follow-up**: `bun run build` is the only gate that catches a `node:` dependency leak on the client bundle path.

### Decision: Reuse `cleanupStatus` and move shared-lane cleanup before the terminal `complete` transition
- **Context**: 9.x requires durable cleanup records; today `cleanupMergedLanes` runs after `complete` and persists nothing.
- **Alternatives Considered**:
  1. New persisted per-lane cleanup field — schema change, contradicts 10.2.
  2. Reuse per-context `cleanupStatus`, aggregate across lane siblings on read (`removed` wins, then `pending`), and reorder cleanup before `complete` so `mutateActive` can persist results.
- **Selected Approach**: Option 2.
- **Rationale**: The field already exists for legacy per-context disposal; aggregation on read tolerates malformed/partial legacy records (9.5); reordering makes the write possible without new machinery.
- **Trade-offs**: Completion latency now includes worktree removal; a crash between cleanup and `complete` leaves `pending`/`removed` contexts on an active execution — the resolver already reports them unavailable, and the recovering loop re-runs cleanup idempotently (9.4). `loopEpoch` fencing prevents a superseded loop racing the window.

### Decision: Process-local atomic port reservation with a single entry-transition seam
- **Context**: 4.x — no reservation exists; the selection scan races between `selectPort` and child bind. Release must be guaranteed on every terminal transition, but `entry.status` is assigned directly at 8+ sites.
- **Alternatives Considered**:
  1. Reservation map only, releases added at each existing transition site — guaranteed to leak when a new transition site is added.
  2. Reservation service (`globalThis`-backed, serialized allocation critical section) plus one entry-state transition seam that owns status mutation, terminal release, and event broadcast; registry/reconciliation/liveness are injected with it.
- **Selected Approach**: Option 2 (`port-reservation.ts` + `entry-state.ts`).
- **Rationale**: Matches the registry's own `globalThis` pattern (survives HMR, empty after restart per 10.1); the seam makes "stopped/error ⇒ reservation released" a structural property instead of a convention.
- **Trade-offs**: Touches every transition site once; initialization remains the only direct status assignment outside the seam.

### Decision: Opaque `targetKey` for client cache identity; session-prefix SSE invalidation
- **Context**: 5.x — cache keys must never contain raw paths (2.2 spirit); two contexts can share one lane worktree; `NotificationListener` currently invalidates globally.
- **Selected Approach**: `targetKey` = `"session"` or `"workflow:<executionId>:<contextId>"`; `devServerKeys` gains `session(project, session)` prefix and `list(project, session, targetKey)` leaf; SSE handler parses the event and invalidates the session prefix only.
- **Rationale**: Session-prefix invalidation refreshes all mounted targets that may share a lane without refetching unrelated projects (5.2); path-free keys keep the browser ignorant of filesystem layout.
- **Trade-offs**: Slightly broader than per-target invalidation, deliberately — a lane-shared worktree change must refresh sibling context views whose targetKeys differ.

### Decision: `apiFetch` envelope parity before hook refactor
- **Context**: 5.4 typed no-retry needs `code` on GET failures; `apiFetch` currently drops everything but `statusCode`.
- **Selected Approach**: Extend `apiFetch` to preserve `status`, `code`, `output`, `details`, `issues` exactly as `mutationFetch` does, then key retry policy on typed codes.
- **Rationale**: Shared plumbing fix benefits every domain; the alternative (hook-local raw fetch) is what the refactor removes.

### Decision: Ambient-env CLI target inference with explicit-flag suppression, shared by command and help paths
- **Context**: 7.x — `cctl dev` must auto-target lanes with no new flags; explicit `--project`/`--session` must never leak ambient lane identity; help must match command behavior.
- **Selected Approach**: One helper (`src/cli/commands/dev-target.ts`) exporting target inference + URL building, consumed by `dev.ts`, `fixture.ts`, and help-context inference. Both-or-neither env rule: partial env → `EXIT_USAGE` (2) naming the missing variable, no request.
- **Rationale**: A single inference function is the only way to guarantee 7.8 (help reflects what the command would do); exit-2-on-partial surfaces broken lane provisioning instead of silently operating on the wrong worktree.
- **Trade-offs**: None material; the helper is pure and unit-testable.

### Decision: Validator parity via `ExecuteWorkflowTaskRunInput.workflowContext`
- **Context**: 8.x — the env contract and injection already exist; only validator dispatch omits identity.
- **Selected Approach**: Optional `workflowContext: { executionId, contextId }` on the task-run input; a runtime helper sets `ConversationRuntimeState.workflowContext` after `ensureConversationActor` and before `SUBMIT_TASK_RUN`; `validator-runner.ts` passes it for Claude and Codex dispatches.
- **Rationale**: Composes with (does not reorder) the pre-dispatch `workflowConversationId` persistence that active cancellation depends on; orthogonal to the `worktreePath` actor pin.
- **Trade-offs**: None; provenance (`origin.workflow`) stays separate from identity.

## Synthesis Outcomes

- **Generalization**: One discriminated worktree resolver serves display, authorization, and orchestration; one reverse conversation-ownership module (`conversation-owner.ts`) generalizes the `user-input-gate` inline lookup and is the round-trip complement of `resolveLaneConversationId` — divergent tie-breaking between the two is specified as a defect and pinned by a consistency test.
- **Build vs adopt**: Nothing external is added. Reused: registry worktree keying, the service's dormant `worktreePath` override seam (made internal), `stopAllForWorktree`, `cleanupStatus`, the session-env workflow-ID contract, help-context ID forwarding, `CopyableId` + `shortenWorktreePath`. Built new (no existing solution in-repo): dev-server target resolver, port reservation, entry-transition seam, CLI dev-target helper, conversation-owner module.
- **Simplification**: No persisted dev-server runtime state; no new schema fields (reuse `cleanupStatus`); `DevServerTargetRef` has exactly two variants; no per-node dev-server controls; no alias for the `ownedByThisSession` → `ownedByTargetWorktree` rename (all in-repo consumers change atomically per project no-backward-compat policy).

## Risks & Mitigations
- `resolve()` throw-on-unscheduled breaks a hidden caller — audit all three call sites, pin each caller's context status at call time with a test before the behavior change lands.
- `node:` import leak in the client-imported resolver — `bun run build` in the same slice as the resolver (jsdom tests do not catch it).
- Reservation leak on a missed transition path — single transition seam + tests that every direct terminal transition releases; reset/shutdown cancellation tested with a reservation but no registry entry.
- Crash between reordered cleanup and `complete` — idempotent cleanup re-run for non-`removed` lane contexts on recovery; resolver reports affected contexts unavailable meanwhile.
- Atomic rename (`ownedByTargetWorktree`) misses a consumer — rename lands in one slice with registry, service, SSE schema, API schema, UI/CLI fixtures, and tests updated together; typecheck enforces.
- Stale lane env after execution restart (observed in production) — 409 `WORKFLOW_EXECUTION_NOT_ACTIVE` carries a server-authored `instruction`; CLI renders it and never retries (7.6/7.7).

## References
- `memory-bank/graph-workflow-lane-worktree-dev-server-support-implementation-plan.md` — approved implementation plan (research baseline re-verified 2026-07-10 post-`99adc4bc`).
- `.kiro/steering/cli.md` — three-tier output contract (`hint`/`reminders`/`instruction`) governing the 409 instruction bodies.
- `.kiro/steering/data-fetching-and-sse.md` — perceived-responsiveness contract preserved by 5.8.
- `.kiro/specs/dev-server-automation/` — parent spec for the dev-server subsystem being extended.
- `.kiro/specs/human-review-gate/` — approval-gate behavior this feature makes reviewable per-lane.
