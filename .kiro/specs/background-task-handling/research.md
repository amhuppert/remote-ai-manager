# Research & Design Decisions

## Summary
- **Feature**: `background-task-handling`
- **Discovery Scope**: Extension (existing graph-workflow + Claude backend turn-execution path)
- **Key Findings**:
  - A single implementer turn resolves when the SDK emits the `result` message (`query-session.ts:898-947`); `waitForTurnCompletion` settles on actor `idle` (`sdk-driver.ts:780-828`). Background work is not awaited.
  - The Claude Agent SDK already emits structured background-task lifecycle messages (`task_started`, `task_updated`, `task_notification`, `task_progress`) on the same stream `processMessage` consumes — and they are currently discarded (`query-session.ts:811-818`, `965-968`).
  - The SDK runs in continuous streaming-input mode with a long-lived subprocess and already auto-continues background-task completions as **virtual turns** (`query-session.ts:768-804` → `machine.ts:299-330`), which are disconnected from the awaited caller turn.

## Research Log

### Where a single turn resolves
- **Context**: Why does the workflow re-prompt an agent that is waiting on a background task?
- **Sources Consulted**: `src/lib/prompt/sdk-driver.ts:695,780-828`; `src/lib/agent-backends/claude/query-session.ts:898-963`; `src/lib/agent-backends/claude/conversation-runtime.ts:221,763`.
- **Findings**: `executePromptStream` awaits the conversation actor returning to `idle`; the actor reaches `idle` when `sendPrompt` resolves on the SDK `result` message. Nothing inspects pending background processes.
- **Implications**: To wait for background work without an orchestrator rewrite, the barrier must keep the actor in `executing` — i.e., live inside `sendTurn` before `sendPrompt`'s result propagates up.

### SDK background-task signals
- **Context**: Can we detect background tasks without any agent action?
- **Sources Consulted**: `node_modules/@anthropic-ai/claude-agent-sdk@0.3.159` — `sdk.d.ts:3298` (`SDKMessage` union), `sdk.d.ts:3627` (`SDKTaskNotificationMessage`: `task_id`, `status: completed|failed|stopped`, `output_file`, `summary`), `SDKTaskStartedMessage`/`SDKTaskUpdatedMessage`/`SDKTaskProgressMessage`; `sdk-tools.d.ts:2418-2428` (`BashOutput.backgroundTaskId`, `assistantAutoBackgrounded`); `MonitorOutput { taskId, persistent, timeoutMs }`; control methods `stopTask`/`backgroundTasks` (`sdk.d.ts:2363-2379`).
- **Findings**: The SDK emits `task_started` → `task_updated`/`task_progress` → `task_notification` (settled). These are `type: "system"` sub-typed messages already in the stream. Long-lived watches are identifiable (`MonitorOutput.persistent`, persistent monitor `timeoutMs: 0`).
- **Implications**: A pure reducer over these messages yields the live in-flight set with no agent cooperation, satisfying Requirement 1 and 2. The exhaustive `task_type` enum is not in the types — default-to-waitable + bounded wait keeps classification safe.

### Idle-TTL hazard
- **Context**: Would waiting let the subprocess close mid-wait?
- **Sources Consulted**: `query-session.ts:212,949-960,112-119`.
- **Findings**: Default idle TTL is 5 minutes and is armed right after the `result` message; `notifyTurnStarting()` cancels it for a new caller turn.
- **Implications**: The idle-TTL timer must be suppressed while waitable tasks are in-flight so virtual turns can still arrive past 5 minutes; MCP keepalive already keeps the pipe alive.

### Prior art: collaboration suspend/resume
- **Context**: Is there an existing "suspend pending async result, resume with result delivered" pattern?
- **Sources Consulted**: `tool-server.ts:311-401,453-478`; `workflow-collaboration-coordinator.ts:84-150,238-308`; `iteration-orchestrator.ts:1687-1758`; `execution-loop.ts:695-707,1281-1296`.
- **Findings**: `pendingCollaborations` (suspend marker) + `collaborationContinuations` (delivery queue) implement an orchestrator-level suspend/resume keyed by context. It requires an agent tool call (`request_collaboration`).
- **Implications**: Considered as the template for an agent-triggered design, but rejected in favor of the driver-only approach because the SDK already surfaces the signal and already auto-continues — no agent action needed.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Driver-only barrier (selected) | Track `task_*` in query-session; bounded wait in `sendTurn`; actor stays `executing` | Zero agent action; no orchestrator control-flow change; accounting preserved for free | Holds single-flight lock for the bounded wait; classification depends on SDK metadata | Reuses existing virtual-turn auto-continuation |
| Agent-tool suspend/resume | New `await_background_task` MCP tool + `pendingBackgroundTasks` marker mirroring collaborations | Unambiguous intent; survives arbitrarily long tasks without holding a turn | Requires agent cooperation + prompt change; new persisted state + loop branch | Explicitly out of scope per requirements |
| Blocking mid-turn tool | Tool handler polls task to completion inline | No new orchestrator state | Holds turn + lock unbounded; agent action required | Rejected |

## Design Decisions

### Decision: Place the wait barrier inside `sendTurn`, not the orchestrator
- **Context**: Wait for background tasks without consuming extra iterations or rewriting the loop.
- **Alternatives Considered**:
  1. Suspend at the orchestrator with a `pendingBackgroundTasks` marker (mirrors collaborations).
  2. Bounded await inside `sendTurn` so the actor stays `executing`.
- **Selected Approach**: (2). After `sendPrompt` resolves, if opted in and the waitable set is non-empty, `await querySession.awaitBackgroundTaskSettlement(timeout)`; the actor never goes `idle` until settlement, so the driver and orchestrator see one long turn.
- **Rationale**: Minimal change; satisfies accounting (5.x) without touching iteration/circuit-breaker code; reuses the SDK's own virtual-turn continuation to deliver the result and let the agent call `complete_task`.
- **Trade-offs**: Holds the per-conversation single-flight lock for the bounded wait. Acceptable — equivalent to the agent blocking in-turn.
- **Follow-up**: Confirm virtual turns run while `sendTurn` awaits (they do — pump is independent of the resolved caller turn).

### Decision: Default unknown classification to `waitable`, bounded by a hard timeout
- **Context**: The SDK `task_type` enum is not fully specified.
- **Selected Approach**: Treat unclassifiable tasks as `waitable`; exclude only positively-identified long-lived watches (persistent `Monitor`).
- **Rationale**: Biasing toward waiting fixes the nag in the maximum number of cases; the timeout makes the worst case (a misclassified watch) a one-time bounded delay that then degrades to today's behavior.
- **Trade-offs**: A misclassified watch costs one timeout interval before re-prompting.
- **Follow-up**: Enumerate real `task_type` values for backgrounded `Bash`/`Monitor` during implementation.

### Decision: Opt-in via `waitForBackgroundTasks` from the implementer runner
- **Context**: The mechanism lives at the driver layer but the requirement targets the workflow implementer; interactive turns must be unchanged.
- **Selected Approach**: A `TurnOptions`/`PromptStreamOptions` flag set deterministically by `implementer-runner.ts`; default `false`.
- **Rationale**: Deterministic config (not agent decision); preserves interactive-turn behavior (Requirement 6 spirit).
- **Trade-offs**: One more option threaded through the turn path.
- **Follow-up**: Revisit if interactive turns later want the same behavior.

## Risks & Mitigations
- Incomplete `task_type` classification → default-to-waitable + bounded timeout; verify enum during implementation.
- Subprocess closes mid-wait (idle TTL) → suppress idle-TTL arming while waitable tasks are in-flight.
- Single-flight lock held during wait → bounded by hard timeout; semantically equal to in-turn blocking.
- Behavior change leaking to interactive turns → opt-in flag confines it to the autonomous implementer path.

## References
- `@anthropic-ai/claude-agent-sdk` `sdk.d.ts` (v0.3.159) — `SDKMessage` union and `SDKTask*` message shapes (l.3298, l.3627+).
- `@anthropic-ai/claude-agent-sdk` `sdk-tools.d.ts` — `BashOutput`/`MonitorOutput` background fields (l.2418-2428, MonitorOutput).
- Internal: `query-session.ts`, `sdk-driver.ts`, `conversation-runtime.ts`, `iteration-orchestrator.ts`, `execution-loop.ts` (line references in Research Log).
