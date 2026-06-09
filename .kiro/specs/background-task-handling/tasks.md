# Implementation Plan

> This feature is a layered pipeline following the design's downward dependency direction
> (pure tracker → query session → turn-execution barrier → threading → orchestrator logging → validation).
> Each task depends on the one before it, so no `(P)` parallel markers apply — concurrency would
> create file/contract contention along the single chain.

- [ ] 1. Foundation: background-task lifecycle tracker

- [x] 1.1 Build the pure background-task tracker with classification
  - Write failing unit tests first (red), then implement until green.
  - Reduce the agent backend's background-task lifecycle signals (task started, status updates, task settled) into an immutable in-flight set, ignoring no-op/progress noise.
  - Classify each task as waitable (expected to finish on its own) or excluded (a long-lived watch such as a dev server or file watcher); default an unclassifiable task to waitable.
  - Derive the watch classification from the originating tool result (a persistent monitor) using validated parsing, never unchecked casts.
  - Treat a settled signal of completed, failed, or stopped — and a terminal status update — as removing the task from the in-flight set.
  - Observable completion: unit tests pass demonstrating started→present-and-waitable, settled→removed, persistent-monitor→excluded, unknown-type→waitable, and failed/stopped→settled; the reducer is pure (no I/O, no timers).
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 4.3_
  - _Boundary: BackgroundTaskTracker_

- [ ] 2. Query session: ingestion, state, bounded await, idle-TTL suppression

- [x] 2.1 Ingest lifecycle signals into the tracker and expose live state
  - Feed background-task lifecycle messages into the tracker as they arrive, including between turns (before any idle-message discard), so a backgrounded task started during a turn is recorded even after the agent yields.
  - Expose the current in-flight background-task state from the session for callers to read, without requiring any agent tool call or explicit agent signal.
  - Observable completion: a session-level test where a synthetic "task started" with no matching "task settled" leaves the exposed waitable in-flight set non-empty, and a subsequent "task settled" empties it.
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Boundary: QuerySession_
  - _Depends: 1.1_

- [x] 2.2 Add the bounded settlement-await primitive and suppress idle close during waits
  - Write failing tests first for the await timing, then implement.
  - Provide a session operation that resolves when the waitable in-flight set drains and no turn is active, or when a hard maximum wait duration elapses (reporting whether it timed out); it must never reject on timeout and never wait indefinitely.
  - Treat failed and stopped tasks as settled so a failing background task ends the wait.
  - Prevent the idle close timer from arming while waitable tasks are in flight, so background-task auto-continuations can still arrive past the default idle window.
  - Observable completion: tests show the await resolves promptly when the set drains, resolves with a timed-out result at the configured bound when nothing settles, and that the idle close timer stays disarmed while a waitable task is in flight.
  - _Requirements: 3.3, 4.1, 4.2, 4.3, 4.4_
  - _Boundary: QuerySession_
  - _Depends: 2.1_

- [ ] 3. Turn-execution wait barrier

- [x] 3.1 Insert the bounded wait into the autonomous turn path
  - Write failing tests first using an injected fake session (dependency injection, no module mocking), then implement.
  - After the caller turn yields, when the turn opted into waiting and waitable background tasks remain, hold the turn open by awaiting settlement before completing; otherwise complete immediately.
  - Let the backend's own auto-continuation run during the wait so the agent receives the settled task's outcome and can finish its work within the same iteration.
  - Carry a wait summary (which tasks were waited on, which settled, whether it timed out, duration) out of the turn result.
  - Observable completion: with a fake session reporting one waitable task, the turn does not complete until the fake emits settlement; it completes immediately when the in-flight set is empty or contains only excluded watch tasks; the wait summary is present only when a wait occurred.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 6.1, 6.2_
  - _Boundary: conversation-runtime sendTurn_
  - _Depends: 2.2_

- [ ] 4. Integration: opt-in threading and workflow observability

- [x] 4.1 Thread the opt-in flag down and the wait summary up
  - Pass an explicit "wait for background tasks" option from the graph-workflow implementer turn down through the prompt driver to the turn execution; leave it off for every other turn so interactive turns are unchanged.
  - Surface the wait summary from the turn result back up through the driver result and the implementer runner's return value.
  - Observable completion: the implementer turn requests waiting deterministically (no agent involvement); the prompt-stream result carries the wait summary when a wait occurred and omits it otherwise; a non-opted-in turn never waits.
  - _Requirements: 6.3_
  - _Boundary: prompt driver, implementer runner, turn-result mapping_
  - _Depends: 3.1_

- [x] 4.2 Log the wait lifecycle and confirm iteration accounting is preserved
  - Emit structured log entries when a wait begins (affected context and tasks), when it resolves and the iteration resumes (outcome), and when it ends on timeout (still in-flight tasks).
  - Verify that because the wait happens inside one iteration, no extra iteration is consumed, the consecutive-failure count is not increased, and neither the maximum-iteration limit nor the circuit breaker is tripped by the wait.
  - Observable completion: a test drives a waiting implementer turn and asserts exactly one iteration is consumed with no follow-up prompt sent during the wait, and the begin/resume/timeout log entries are emitted from the threaded summary.
  - _Requirements: 5.1, 5.2, 5.3, 7.1, 7.2, 7.3_
  - _Boundary: iteration-orchestrator_
  - _Depends: 4.1_

- [ ] 5. Validation: no-regression and end-to-end behavior

- [x] 5.1 Verify no behavior change when no waitable background tasks are present
  - Assert the integrated turn path behaves identically to today when an iteration ends with no in-flight background tasks (completes immediately, no wait summary) and when only excluded long-lived watch tasks remain (proceeds without waiting).
  - Assert the implementer prompts are unchanged by this feature and that non-opted-in (interactive) turns never enter the wait barrier.
  - Observable completion: regression tests pass covering the no-task path, the watch-only path, and prompt invariance; the end-to-end path from implementer runner through the wait barrier resumes the iteration after a simulated settled background task.
  - _Requirements: 6.1, 6.2, 6.3_
  - _Depends: 4.2_

- [ ] 6. Follow-up: wire watch-classification (resolve the Req 2.2 deferral)

- [x] 6.1 Classify long-lived watches by originating tool name so Req 2.2 bites end-to-end
  - Replace the deferred/dead tool-result classification with classification by the originating tool name, correlating a `task_started` to its tool via `tool_use_id` and the per-turn tool-name map.
  - Treat tasks started by the `Monitor` tool as excluded long-lived watches (the Monitor tool is fire-and-forget streaming by design — the agent observes events, it does not await completion); treat backgrounded `Bash` and subagent `Task`/`Agent` runs as waitable.
  - Default to waitable when the originating tool name is unknown/unavailable (preserves Req 2.3).
  - Remove the now-superseded dead `applyToolResultClassification` path and its tool-output schemas/tests rather than leaving dead code.
  - Observable completion: a query-session-level test shows a `Monitor`-originated background task is absent from the waitable set (the wait barrier ignores it) while a backgrounded `Bash` task is present; an end-to-end test shows the wait barrier does NOT hold the turn open for a Monitor-only in-flight set.
  - Known residual (documented, not a gap): a never-ending process started via backgrounded `Bash` (e.g. a dev server) cannot be distinguished a priori from a settle-able one and remains `waitable`, bounded by the wait timeout (Req 4).
  - _Requirements: 2.1, 2.2, 2.3, 6.2_
  - _Boundary: BackgroundTaskTracker, QuerySession_
  - _Depends: 5.1_

## Implementation Notes

- **Task 2.1 → RESOLVED in task 6.1 — watch classification by originating tool name.** Originally the tool-result classification was dead: the SDK tool_result block (`SdkToolResultBlock`: `{ type, tool_use_id, is_error?, content?: string | Array }`) carries the structured `MonitorOutput`/`BashOutput` payload *inside* `content`, not at top level, so safe-parsing the raw block never matched — that wiring (and later the whole `applyToolResultClassification` path) was removed. Task 6.1 replaced it: classification is now by the **originating tool name**, correlated via `task_started.tool_use_id` + the per-turn `toolNamesById` map. `Monitor`-originated tasks are `excluded` (the Monitor tool is fire-and-forget streaming — observed, never awaited); backgrounded `Bash` and subagent `Task`/`Agent` are `waitable`; unknown/missing tool name defaults to `waitable` (Req 2.3). Verified that `SDKTaskStartedMessage.task_type` is NOT a reliable discriminator (only `local_workflow` is documented; the compiled SDK exposes no usable enum), hence the tool-name signal. **Documented residual:** a never-ending process launched via backgrounded `Bash` (e.g. a dev server) cannot be distinguished a priori from a settle-able one and stays `waitable`, bounded by the wait timeout (Req 4).

- **Task 2.2 — pump-death waiter resolution (fold into task 3.1).** `awaitBackgroundTaskSettlement` waiters are resolved promptly on explicit `close()`, but the internal `runPump` death paths (clean exit / `pump_error`) currently call `markDead()` + `rejectPendingTurn()` without resolving `backgroundWaiters`, so a waiter pending during a pump-internal death resolves at the timeout (`timedOut: true`) rather than promptly (`timedOut: false`). This is bounded (no hang; Req 4.4 holds) and the runtime's real teardown goes through `close()`. Folding the 2-line fix into task 3.1: resolve `backgroundWaiters` inside `markDead()` so pump-internal deaths also yield the prompt `timedOut: false` resolution design.md "Error Handling" specifies.
