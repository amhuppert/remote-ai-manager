# Requirements Document

## Project Description (Input)
Make a graph workflow lane worktree a first-class review and dev-server target: workflow-managed conversations show/copy their actual execution-context worktree on all info surfaces; dev-server controls, cctl dev, and fixture discovery operate on the resolved workflow context worktree for implementer and validator agents; session and parallel lanes run same-named dev servers concurrently on independently reserved ports; the graph execution page shows the resolved worktree per execution context. Extends the existing dev-server subsystem (target refs resolved server-side via durable workflow IDs, atomic port reservation, target-scoped SSE/React Query isolation) without a second process manager or persisted dev-server runtime state. Full implementation plan: memory-bank/graph-workflow-lane-worktree-dev-server-support-implementation-plan.md

## Introduction

This specification makes a graph workflow lane worktree a first-class review and dev-server target. Today, dev-server operations, `cctl dev`, fixture discovery, and every conversation info surface assume the session worktree, even when the open conversation or the calling agent actually executes in a workflow execution-context worktree (a lane). This breaks human review at approval gates (the reviewer sees and serves the wrong worktree) and forces lane agents to operate dev servers against a worktree that does not contain their changes.

The feature extends the existing dev-server subsystem so that: workflow-managed conversations show and copy their actual execution-context worktree on all info surfaces; dev-server controls, `cctl dev`, and fixture discovery operate on the resolved workflow-context worktree for both implementer and validator agents; the session and parallel lanes can run same-named dev servers concurrently on independently assigned ports; and the graph execution page shows the resolved worktree for every execution context. Clients identify workflow targets only by durable workflow IDs — the server is the sole authority that turns those IDs into a filesystem path.

## Boundary Context

- **In scope**: Conversation info surfaces (desktop strip, details popover, mobile info panel), the dev-server panel and its data flow, dev-server HTTP operations and their target resolution, port allocation safety, `cctl dev`/fixture/dynamic-help targeting, validator agent environment parity, execution-page worktree display, shared-lane cleanup state durability, and agent-facing documentation of the above.
- **Out of scope**: Persisting or adopting dev servers across CC restarts; accepting arbitrary worktree paths from UI or CLI; automatically starting dev servers when a lane is provisioned or a gate opens; generated diff summaries or review reports on the approval panel; making the conversation diff pane lane-aware; dev-server controls on graph nodes; operating on archived or removed execution worktrees; changing the `CommandCenter.json` dev-server declaration syntax.
- **Adjacent expectations**: The existing dev-server subsystem (process spawning, liveness, Tailscale exposure, unmanaged-listener handling) remains the single process manager; this feature adds targeting, not a parallel manager. The graph workflow engine continues to own worktree provisioning and cleanup; this feature does not change when lanes are created, but the timing and durable recording of shared-lane cleanup at workflow completion are in scope (Requirement 9). Session deletion, merge completion, and CC shutdown retain their aggregate stop-everything semantics.

## Requirements

### Requirement 1: Conversation Worktree Visibility

**Objective:** As a CC user reviewing a workflow-managed conversation (for example at an approval gate), I want every conversation info surface to show and copy the worktree the conversation actually executes in, so that I inspect the changes that will be committed rather than an unrelated worktree.

#### Acceptance Criteria

1. When a conversation belongs to a workflow execution context, the CC shall display that context's resolved worktree — not the session worktree — in the desktop info strip, the details popover, and the mobile info panel.
2. When a conversation is not workflow-managed, the CC shall continue to display the session worktree on those surfaces.
3. When the user copies the worktree value from any conversation info surface, the CC shall place the full worktree path on the clipboard while the visible value remains the compact shortened form.
4. When a conversation is open at an approval gate for a worktree-isolated context, the CC shall display the worktree containing the uncommitted, validated changes that will be committed after approval.
5. While workflow execution data required to resolve the conversation's worktree is still loading, the CC shall present the worktree as loading and shall not display or operate on the session worktree as a temporary substitute.
6. If the conversation's workflow worktree is not provisioned, being removed, or removed, the CC shall display that state explicitly as a non-copyable value and shall not fall back to the session worktree.
7. When the user activates a copyable worktree value with Enter or Space, the CC shall copy exactly as a mouse click does.
8. While a copyable worktree value has keyboard focus, the CC shall show a visible focus indicator on it.
9. Where a copyable worktree value appears on a touch surface (mobile panels, graph nodes), the CC shall provide a touch target of at least 44px.

### Requirement 2: Server-Authoritative Dev-Server Target Resolution

**Objective:** As a CC operator, I want the server to be the sole authority that maps a dev-server request to a filesystem worktree, so that no client can direct dev-server operations (and the command execution they imply) at an arbitrary path.

#### Acceptance Criteria

1. The CC shall accept exactly two forms of dev-server target from clients: the implicit session target, or a workflow-context target identified by an execution ID and an execution-context ID together.
2. The CC shall never accept a filesystem path as a dev-server target in any query parameter, request body, header, or CLI flag.
3. When a workflow-context target is supplied with only one of the two IDs, or with a blank ID, the CC shall reject the request as an invalid target without performing any dev-server operation.
4. When a dev-server request references a session that does not exist, the CC shall reject the request with a distinct not-found error.
5. When a workflow-context target references an execution that is not the session's active execution, the CC shall reject the request with a distinct error that tells the caller the execution is not active, and shall never serve the request against an archived execution.
6. When a workflow-context target references a context that does not exist in the active execution, the CC shall reject the request with a distinct not-found error.
7. When a workflow-context target resolves to a context that is not provisioned, is being removed, is removed, or whose worktree directory no longer exists, the CC shall reject the request with a distinct unavailable error and shall never fall back to the session worktree.
8. When a workflow-context target resolves successfully, the CC shall resolve a context on a shared execution lane to that lane's worktree, a context recorded with its own per-context worktree to that worktree, and a session-isolated context to the session worktree.
9. When an execution context has never been scheduled (it is still pending or ready and owns no provisioned worktree or lane), the CC shall classify it as not provisioned and shall never resolve it to the session worktree.
10. When two execution contexts share one execution lane, the CC shall resolve both to the same worktree and shall report the same availability/cleanup state for both.
11. The CC shall include the resolved target (kind, worktree path, branch, isolation, and workflow identity when applicable) in every dev-server operation response so clients can display the scope they acted on.

### Requirement 3: Target-Scoped Dev-Server Operations

**Objective:** As a CC user or lane agent, I want every dev-server operation (list, start, start-all, stop, stop-all, stop-unmanaged) to act on the resolved target worktree, so that starting, stopping, and inspecting servers affects the worktree I am working in and no other.

#### Acceptance Criteria

1. The CC shall scope every dev-server operation — list, start, start-all, stop, stop-all, and stop-unmanaged — to the resolved target's worktree.
2. When a dev-server list is requested for a target, the CC shall report the runtime state of servers running in that target's worktree, including each server's local URL.
3. When a dev-server list includes a configured-but-stopped server, the CC shall report the resolved target's worktree path for it.
4. When a dev server is started for a workflow-context target, the CC shall spawn it with the lane worktree as its working directory and shall read dev-server configuration (`CommandCenter.json`) from that worktree, preserving lane-local configuration.
5. When stop-all is requested for a target, the CC shall stop only the servers running in that target's worktree, leaving the session worktree's servers and sibling lanes' servers running.
6. When a server is already running in the target worktree, an ensure/start request for the same server shall reuse it rather than spawning a duplicate.
7. When an implementer starts a dev server in a lane, a validator for the same context and any later context reusing the same execution lane shall see and reuse that running server.
8. When a session is deleted or archived, a merge completes, or CC shuts down, the CC shall stop every dev server it manages beneath that session, including servers running in that session's lane worktrees; the target-scoped stop-all shall not trigger these lifecycle cleanups.
9. When a workflow lane's worktree is torn down (merge/reset/abort/clear), the CC shall stop that worktree's dev servers before removing the directory, affecting only that lane's servers.
10. When a human approval gate is approved, the CC shall not stop the context's dev servers; they remain usable until explicit stop or worktree/session cleanup.
11. The CC shall continue to report unmanaged listeners on a wanted port rather than adopting them, for lane targets exactly as for session targets.

### Requirement 4: Concurrent Multi-Lane Port Safety

**Objective:** As a CC user running parallel workflow lanes, I want the session and every lane to run same-named dev servers concurrently, so that each worktree's changes can be reviewed on its own port without collisions.

#### Acceptance Criteria

1. When the session and one or more lanes start dev servers with the same name and base port concurrently, the CC shall assign each a distinct free port.
2. When two starts race for ports, the CC shall guarantee they cannot select the same free port before either child process binds it.
3. When multiple concurrent ensure/start requests arrive for the same target and server, the CC shall spawn at most one process and let all callers observe that single start.
4. While a CC-started server is still starting, the CC shall already report its assigned port so users and reservation logic never observe a CC-started process without a port.
5. When a server stops, errors, times out, exits unexpectedly, or fails to spawn, the CC shall release its port reservation so the port becomes available again.
6. When a worktree, session, or CC-wide cleanup runs, the CC shall cancel matching port reservations, and a start that lost the race against teardown shall not spawn a process in a removed worktree.
7. The CC shall treat a port reserved by a known CC-managed start as managed, not as an unmanaged listener requiring a prompt.

### Requirement 5: Per-Target Data Isolation in the UI

**Objective:** As a CC user with multiple conversations and lanes open, I want dev-server status, actions, and errors to be isolated per target, so that acting on one lane never corrupts or misrepresents another target's panel.

#### Acceptance Criteria

1. When two open conversations reference different targets — including targets that share a server name — dev-server status, pending actions, and unmanaged-conflict prompts displayed for one shall not appear on or be altered by actions on the other.
2. When a dev-server status change occurs in one worktree, the CC shall refresh the affected session's mounted dev-server views without refetching unrelated projects.
3. When the selected conversation switches to a different target, the CC shall clear target-local pending/conflict state and ignore stale action callbacks from the previous target.
4. If a dev-server request fails because the target is invalid, not active, not found, or unavailable, the CC shall not retry the request and shall not reissue it as a session-target request; it shall refresh workflow state once and present the target as unavailable until fresh state resolves it.
5. While a workflow conversation's target is loading or unavailable, the CC shall not issue dev-server requests for the session worktree in its place, and the dev-server controls shall be hidden or disabled.
6. The dev-server panel shall display the resolved target's shortened worktree path in its header with full-path copy, so the scope of every action is explicit.
7. While a dev server is running for the selected target, the panel shall present the server name as a link preferring the remote URL and falling back to the server-reported local URL.
8. When the user starts a server, the CC shall show an optimistic starting state immediately; when the user stops a server, the CC shall show a visible stop-pending state until the stop resolves.

### Requirement 6: Graph Execution Page Worktree Display

**Objective:** As a CC user monitoring a graph execution, I want every execution context to show its resolved worktree, so that I can locate and copy the working directory of any context at a glance.

#### Acceptance Criteria

1. When the graph execution page renders an execution context in execution mode, the context node shall display a compact worktree row with the resolved worktree state.
2. When the resolved worktree is available, the node and the selected-context inspector shall show the shortened path with full-path tooltip and copy, and copying from a graph node shall not select, drag, or pan the canvas.
3. If a context is not provisioned, being removed, or removed, the node and inspector shall display `Not provisioned`, `Removing`, or `Removed` respectively as non-interactive values.
4. When a session-isolated context is running or completed, the CC shall show the session worktree for it; a pending context that may later fork shall not pre-claim the session path.
5. The execution page shall display worktrees only; it shall not add dev-server controls to graph nodes.

### Requirement 7: `cctl dev` and Fixture Workflow-Context Targeting

**Objective:** As a lane agent (implementer or validator), I want `cctl dev` and fixture discovery to automatically operate on my workflow context's worktree, so that I obtain URLs and manage servers for the worktree containing my changes without new flags.

#### Acceptance Criteria

1. While both workflow environment variables (`CC_WORKFLOW_EXECUTION_ID` and `CC_WORKFLOW_CONTEXT_ID`) are present and neither `--project` nor `--session` is explicit, `cctl dev` and fixture server discovery shall target that workflow context.
2. When `--project` or `--session` is explicitly provided, `cctl` shall target that session's worktree and ignore ambient workflow environment variables.
3. If exactly one workflow environment variable is present, `cctl dev` shall exit with code 2 naming the missing variable and shall not issue any server request.
4. When `cctl dev` reports servers, its text output shall include a `worktree: <path>` line and its JSON output shall include the server-returned target and each server's local URL without deriving either client-side.
5. When an ensure operation polls for readiness, every polling request shall retain the workflow target.
6. If the server rejects the target as invalid, not active, not found, or unavailable, `cctl dev` shall exit with the operation-failed code, render the server-provided recovery instruction verbatim, and shall never retry against the session target or rewrite the target itself.
7. When the rejected target is a superseded execution (stale lane environment after an execution restart), the rendered instruction shall direct the agent to read the live execution state and stop dev-server work rather than retry.
8. Where dynamic CLI help is available, the dev and fixture help shall reflect the same target the command would use — ambient workflow IDs are omitted when an explicit `--project`/`--session` flag is present, and a partial workflow environment yields static help rather than data for the wrong target.
9. The CC shall document in agent-facing help and skills that `cctl dev` targets the current workflow context inside a lane, that explicit flags select a session, that parallel lanes receive independent ports, and that unmanaged listeners are reported rather than adopted.

### Requirement 8: Validator Agent Environment Parity

**Objective:** As a workflow author, I want validator agents to receive the same workflow identity environment as implementers, so that validator `cctl dev` and fixture commands resolve the lane worktree exactly as implementer commands do.

#### Acceptance Criteria

1. When a validator task run is dispatched (Claude or Codex), the CC shall provide both `CC_WORKFLOW_EXECUTION_ID` and `CC_WORKFLOW_CONTEXT_ID` in the child agent environment.
2. When a validator runs `cctl dev list`, it shall report the same context worktree that the implementer for that context reports.
3. The environment change shall not alter the validator's working directory, its transcript provenance, or its lane conversation binding behavior.
4. When a conversation is not a workflow lane run, the CC shall not inject workflow identity variables into its environment.
5. The agent runtime guidance embedded in prompts shall state that `cctl dev` targets the current dev-server worktree (a lane when workflow IDs are present, otherwise the session worktree) and that parallel sessions and lanes receive independent ports.

### Requirement 9: Lane Cleanup State Durability

**Objective:** As a CC user, I want removed lane worktrees to be reported as removed everywhere, so that no surface offers me a worktree path or dev-server action that points at a deleted directory.

#### Acceptance Criteria

1. When shared execution-lane worktrees are cleaned up at workflow completion, the CC shall record the cleanup result durably for every context on that lane, so that a completed workflow's contexts report removed rather than available.
2. While lane cleanup is in progress, affected contexts shall report a removing state on every surface that displays worktrees.
3. If cleanup fails for a lane, the CC shall record the failure without blocking workflow completion, and affected contexts shall not report the worktree as available.
4. If the CC crashes between lane cleanup and workflow completion, a recovering workflow shall re-run cleanup idempotently for lane contexts not yet recorded as removed before completing.
5. When contexts share a lane, all of them shall report the same cleanup state; partial or legacy per-context records shall not cause siblings to disagree.
6. The CC shall treat recorded cleanup state as authoritative for what clients see, with filesystem existence as a server-side backstop; neither shall infer availability from a stale lane path alone.

### Requirement 10: Runtime State Boundaries

**Objective:** As a CC operator, I want dev-server runtime state to remain process-local, so that a CC restart yields a clean slate with no stale process claims.

#### Acceptance Criteria

1. The CC shall keep dev-server registry state and port reservations in memory only; after a CC restart both shall be empty.
2. The CC shall not persist dev-server runtime state and shall not add new persistent schema or new environment variables for this feature; lane cleanup records (Requirement 9) use the existing workflow execution persistence.
3. The CC shall log target resolution outcomes, port reservation grants/releases, and coalesced starts with enough identity (target kind, workflow IDs, worktree, port) to diagnose multi-lane behavior, without logging tokens, child environment values, or request bodies.
