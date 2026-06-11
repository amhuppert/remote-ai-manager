# Implementation Plan

- [ ] 1. Foundation: gate schemas, config cascade, and durability backstop
- [x] 1.1 Define gate configuration, parked-context state, and approval event schemas
  - Add the awaiting-approval context status value to the context status enum and a pending-approval record (conversation id, requested-at, nullable decision union of approved / rejected-with-message) on persisted context state, defaulting to null
  - Add the human-approval-gate config schema ({ enabled }, default disabled) to context definitions, the workflow-level override, and global workflow defaults
  - Add the approval-pending and approval-resolved SSE event schemas to the graph workflow event union
  - Observable: typecheck passes and existing executions/definitions parse unchanged (additive defaults), verified by existing schema tests
  - _Requirements: 1.1, 1.2, 1.3, 2.6_

- [x] 1.2 Resolve the effective gate setting through the config cascade and workflow definition inputs
  - Seed the global default (disabled); resolve per-context as context override → workflow override → global default
  - Expose the per-context gate setting in the workflow create/replace planner inputs so definitions persist it round-trip
  - Unit tests cover the cascade (context wins, workflow fallback, default disabled)
  - Observable: a definition created with gate settings reloads with the same effective per-context setting; tests green
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 1.3 (P) Extend the session durability contract with a parked gated context
  - Maximal fixture gains an awaiting-approval context whose pending record includes a recorded rejected decision (message + decided-at)
  - Observable: round-trip durability contract fails if any pending-approval field is dropped by serialization
  - _Requirements: 7.1_
  - _Boundary: state-store contract test_
  - _Depends: 1.1_

- [ ] 2. Core engine: approval gate service
- [x] 2.1 Implement gate entry and atomic decision recording
  - Draft-level transition places a validated context into awaiting-approval with a fresh pending record inside the caller's mutation
  - Decision recording is an atomic check-and-set guarded by: active execution in running/paused/halted, target context awaiting approval, no prior decision; distinct guard-failure reasons returned
  - First decision wins under concurrent submissions; recording while paused/halted persists the decision for deferred application
  - Structured gate logs for pending entry and decision recording per the logging steering
  - Observable: unit tests cover the full guard matrix and first-decision-wins (red-green TDD)
  - _Requirements: 2.1, 6.2, 7.1, 7.3, 7.5_

- [x] 2.2 Implement decision application and rejection remediation
  - Approved application clears the pending record (completion and merge stay with the loop)
  - Rejected application clears the record, appends a remediation task carrying the operator's message, sets the context running, and updates task counts
  - Remediation task IDs stay unique across repeated rejections; the consecutive-failure count is never touched
  - Observable: unit tests assert remediation task content/uniqueness and the circuit-breaker accounting invariant
  - _Requirements: 4.1, 5.2, 5.5_

- [ ] 3. Core engine: events, push, and finalization routing
- [x] 3.1 (P) Publish approval lifecycle events with push notification parity
  - Publisher methods append approval-pending / approval-resolved to execution history and broadcast over the existing SSE channel
  - Approval-pending also dispatches a phone push through the existing graph-workflow push mapping using the waiting-for-input trigger (exhaustiveness forces the new variant)
  - Observable: unit test asserts the approval-pending push uses the waiting-for-input trigger; publisher tests assert history + broadcast
  - _Requirements: 2.6, 3.3, 4.4, 5.7_
  - _Boundary: EventPublisher, push dispatcher_
  - _Depends: 1.1_

- [x] 3.2 Route gated validator-passed contexts into awaiting-approval at finalization
  - When the resolved gate is enabled and every enabled validator passed, finalization parks the context (status + record in the same mutation as its existing writes) and publishes approval-pending after commit
  - Disabled gate completes the context unchanged; validator failure follows the standard reopen flow and never triggers the gate
  - Observable: integration tests (DI deps) cover gate-on → parked + event, gate-off → completed, validator-failure → standard flow
  - _Requirements: 1.5, 2.1, 2.2, 2.6_
  - _Depends: 1.2, 2.1, 3.1_

- [ ] 4. Core engine: execution-loop gate wait
- [x] 4.1 Park gated contexts in the loop and keep the graph correct around them
  - Inner iteration loop breaks on awaiting-approval exactly as on completed (no extra iteration seeded on park)
  - Injected poll wait (collaboration-wait shape) refreshes execution state until a decision is observed or the execution leaves running; wait exits without resolving on pause/halt/abort with pending state (including a recorded decision) persisting
  - Dependents stay blocked while independent contexts keep running; the runner stays in-flight while parked (the outer-loop completion determination is owned by task 4.3)
  - Observable: loop integration tests cover independent-continues / dependent-blocked / abort-pause exits / no extra iteration on park
  - _Requirements: 2.3, 2.4, 7.4, 7.5_
  - _Depends: 3.2_

- [x] 4.2 Apply recorded decisions under the conversation lock
  - Decision application poll-acquires the conversation single-flight lock (probe on the wait interval, acquire once free) and holds it across application
  - Approved falls through to the existing lane-commit / fan-in merge path; rejected re-enters the inner loop so the next iteration seeds the remediation task and increments the iteration count (limit still halts per standard policy; validators re-run before the gate can trigger again)
  - A decision observed while the conversation is busy defers application until the lock frees
  - Approval-resolved is published (history + SSE) after applying either decision — the resume-application path in task 4.3 publishes the same way — with structured gate logs on application and wait exit
  - Observable: loop integration tests cover approve→merge-under-lock, reject→remediation iteration, busy-conversation deferral, and the approval-resolved history/SSE record after application
  - _Requirements: 4.1, 4.2, 4.4, 5.3, 5.4, 5.6, 5.7, 6.1_
  - _Depends: 2.2, 4.1_

- [x] 4.3 Re-enter parked contexts on resume with a correct completion guard
  - Scheduling re-entry sends awaiting-approval contexts directly into the gate wait (no iteration seeding); a decision recorded while suspended applies on the first wait refresh
  - Restart normalization leaves awaiting-approval contexts untouched; the loop's completion determination counts a parked context as incomplete (execution neither completes nor exits when only a parked context remains)
  - Observable: integration tests resume a persisted parked context into the wait, apply a paused-recorded decision, and assert no completion/exit with only a parked context
  - _Requirements: 2.5, 7.1, 7.5_

- [ ] 5. API: decision endpoint, active-conversations standing, chat guard
- [x] 5.1 (P) Expose the resolve-approval endpoint
  - POST accepts approve / reject-with-message (discriminated union; trimmed non-empty message); thin route re-export; deps extension follows sibling routes
  - 200 returns the execution status payload; 400 invalid body; 404 unknown project/session/execution; 409 with reason for stale/duplicate/ineligible decisions
  - Observable: persistence-fixture integration tests cover approve/reject 200, second decision 409, 404 without execution, and reloaded state showing the recorded decision
  - _Requirements: 5.1, 7.2, 7.3_
  - _Boundary: ResolveApprovalRoute_
  - _Depends: 2.1_

- [x] 5.2 (P) Surface gate standing on active conversations
  - Candidate map built from persisted execution state before row filtering (execution running/paused/halted, context awaiting approval, undecided)
  - Gated rows bypass the iteration/validator role filter and the active-status filter; archived exclusions stay authoritative; non-gated iteration rows stay hidden
  - Payload gains the pending-approval field (context id/title, requested-at); standing disappears the moment a decision is recorded and on abort
  - Observable: assembly integration tests cover the inclusion override, standing independence from conversation-status changes, drop on decision/abort, archived exclusion
  - _Requirements: 3.1, 4.3, 6.3, 7.4_
  - _Boundary: ActiveConversationsAssembly_
  - _Depends: 1.1_

- [x] 5.3 (P) Allow chat with gated conversations through the prompt guard
  - The workflow-managed conversation rejection excepts contexts awaiting approval with no recorded decision; once a decision is recorded the exception closes
  - Observable: guard tests cover accepted chat while undecided and 403 after a decision is recorded
  - _Requirements: 6.1, 6.2_
  - _Boundary: prompt route guard_
  - _Depends: 1.1_

- [ ] 6. Client: mutation and notifications
- [x] 6.1 (P) Add the resolve-approval client mutation
  - Mutation posts the decision; success and 409 both invalidate active conversations and session detail so stale panels refresh
  - Observable: mutation unit tests assert invalidation on success and on 409
  - _Requirements: 3.4, 4.3, 7.2_
  - _Boundary: workflow-graph client mutations_
  - _Depends: 5.1_

- [x] 6.2 (P) Handle approval events in the notification listener
  - Approval-pending triggers toast + browser notification (same client channels as waiting-for-input) and invalidates active conversations + session detail; approval-resolved invalidates only
  - Observable: listener unit coverage shows both event types handled, with notification side effects on pending
  - _Requirements: 3.3, 3.4, 4.3_
  - _Boundary: NotificationListener_
  - _Depends: 1.1_

- [ ] 7. UI: approval panel and surfacing
- [x] 7.1 (P) Build the approval gate panel component
  - Approve button and reject flow with required message textarea (submit disabled until trimmed non-empty)
  - Actions disabled while submitting or while a chat turn is in flight, with a hint; suspended execution shows an applies-on-resume hint with actions enabled
  - Styled per design-system tokens in its own stylesheet chained into global styles
  - Observable: component tests cover reject-disabled-until-message, busy disabling, suspended hint
  - _Requirements: 3.5, 5.1_
  - _Boundary: ApprovalGatePanel_

- [x] 7.2 (P) Pin pending approvals to the top of Needs Input
  - Sidebar sectioning gains an approvals bucket checked before questions/finished; the approval section renders first; rows with pending gates expose no archive/dismiss affordance
  - Observable: helper unit tests assert approval rows sort above question/finished rows
  - _Requirements: 3.2_
  - _Boundary: SidebarSectioning_
  - _Depends: 5.2_

- [x] 7.3 Integrate the panel into the conversation view and peek
  - Conversation container derives gate standing from session detail and threads panel props (busy, suspended, decision callbacks)
  - Prompt slot renders the panel above the composer with normal chat enabled while undecided (readonly banner bypassed; pending questions still take precedence below the panel); peek renders the same panel above its reply composer
  - Observable: a gated conversation shows panel + live composer in both surfaces; a decision dismisses the panel and restores the read-only treatment
  - _Requirements: 3.5, 6.1, 6.3_
  - _Depends: 5.2, 5.3, 6.1, 7.1_

- [x] 7.4 (P) Label the awaiting-approval status in workflow UI
  - Execution status bar and inspector render a distinct badge/label for parked contexts
  - Observable: a parked context shows the new label instead of falling through to an unknown-status rendering
  - _Requirements: 2.6_
  - _Boundary: workflow status UI_
  - _Depends: 1.1_

- [ ] 8. Validation: live end-to-end verification
- [x] 8.1 Live approve flow
  - Gated workflow run: validators pass → conversation surfaces at top of Needs Input with panel and notification; approve → merge runs and the dependent context starts
  - Observable: live run (cc-live-feature-test) confirms backend state (execution history events, merged lane) and UI surfacing
  - _Requirements: 2.1, 3.1, 3.2, 3.3, 4.1, 4.2_
- [x] 8.2 Live reject flow
  - Reject with message → the implementer's next iteration carries the feedback task, validators re-run, and the gate re-triggers
  - Observable: transcript shows the remediation task content; execution history records the rejection with its message
  - _Requirements: 5.2, 5.3, 5.7_
- [x] 8.3 Live restart durability
  - Server restart while pending → execution normalizes paused, the panel stays functional, approving while paused records; resume applies the decision and the workflow proceeds
  - Observable: post-restart UI shows the pending review; post-resume history shows application and completion
  - _Requirements: 7.1, 7.5_

## Implementation Notes

- 1.1: `resolve-config.ts:86` currently passes through `defaults.humanApprovalGate` and ignores `override.humanApprovalGate` (compile-forced placeholder) — task 1.2 MUST replace it with the full context > workflow > default cascade.
- 1.1: sessions-repo.contract.test.ts maximal fixture already carries `pendingApproval` with a rejected decision, but the fixture context status is still `"running"` — task 1.3 must flip it to `"awaiting_approval"` to satisfy the design invariant (`pendingApproval !== null ⇔ awaiting_approval`).
- 2.1: design's `ApprovalGateServiceDeps` block doesn't match the real `mutateActive` signature (no `label` param; mutate fn returns the cloned execution) — service deps mirror reality. `no_active_execution` is detected by matching the exact error string `"Session does not have an active graph workflow execution"` (established sibling-route pattern).
- 2.2: `buildRejectionRemediationTask` gained a 4th `order` param (schema requires `order >= 1`, derivable only from the context's tasks; design's 3-param block was infeasible). `gate.applied` is logged INSIDE the service apply methods — task 4.2's loop must NOT log application again. Apply methods are draft-level and do not rebuild `machineSnapshot` — task 4.2's wrapping mutation owns that (verify at 4.2 review).
- 3.2: CONFIRMED LIVE GAP for 4.1/4.3 — until the loop gains the gate wait, a parked context falls through to `runLaneCommit`/`runFanInMerge` (execution-loop.ts:793-814, premature merge) and the outer loop completes the execution with a context parked (execution-loop.ts:1308). Task 4.1 MUST make the inner loop break treat `awaiting_approval` like `completed` WITHOUT falling into the merge phase, and 4.3 owns the completion guard. Dependents already stay blocked (eligibility requires completed+committed upstream).
- 4.1: gate wait lands as `waitForApprovalResolution` returning `ApprovalWaitOutcome` (`{kind:"decision",decision}` | `{kind:"execution_exited",status}`); the inner-loop call site (execution-loop.ts ~897) currently DISCARDS the outcome and returns with the context parked — 4.2 plugs in there: `execution_exited` → return; approved → apply under conversation lock + break into existing commit/merge; rejected → apply + continue to re-enter iteration loop. Wait checks execution status BEFORE decision (suspension never resolves a decision). The "decision observed while running" unit test pins interim seam behavior and must be UPDATED by 4.2. Max-iterations check precedes the gate stage (pre-existing ordering, matches completed). 4.3 still owns: post-exit completion guard + resume re-entry (scheduling only seeds pending/ready).
- 4.2: round-1 review caught an unguarded busy-deferral window (apply after abort/pause/halt); fixed with an atomic `status !== "running"` guard inside the apply mutation + per-wait execution refresh in `acquireConversationLockWhenFree` (both return discriminated outcomes; call site treats guard failure as execution_exited — no publish/commit/continue). For 4.3: resume re-entry can reuse `waitForApprovalResolution` + the same application block (`applyApprovalDecision` / `publishApprovalResolvedEvent`); approved-while-suspended record persists untouched.
- 4.3: gate-application block relocated to the TOP of the inner per-context loop (execution-loop.ts ~1032-1087) so fresh parks and resume re-entry share one path; outer scheduling loop gained a re-entry pass (~1716-1737, skips contexts already inFlight) and a completion backstop `hasAwaitingApprovalContexts` (~1755-1762). workflow-manager.ts production needed NO change for restart normalization (markActiveContextReady only flips running→ready) — pinned by test.
- 5.3: queue route (queue-route-handlers.ts) still rejects queuing for managed conversations — chat sent while a gated conversation is mid-turn gets the busy 409 and cannot be queued. Intentional per boundary; candidate follow-up if queued chat during gates is desired.
- 6.1: `useResolveApprovalMutation` lives in `src/lib/workflows/mutations.ts` (the pause/resume module — no mutations file exists in workflow-graph/). 409 resolves as `{ status: "conflict", error }` (not thrown, mirrors useAnswerQuestionMutation's 410) so the 7.x panel can render the error; both success and conflict invalidate conversationKeys.active() + sessionKeys.detail().
- 7.3: peek's `executionSuspended` hint is silently false for HALTED executions (`ACTIVE_GW_STATUSES` omits halted from the active payload's `graphWorkflowExecutions`; gate standing itself persists). Cosmetic only — decisions still record and apply on resume; conversation view derives correctly from session detail. Follow-up candidate: carry a suspended flag on the `pendingApproval` standing in the active payload. Peek panel shows `workflowName=null` (payload carries no workflow name).
- 7.4: canvas node (`ExecutionContextNode` via `derive-wait-state.ts`) renders a parked context as "Ready" (no awaiting_approval arm) — not unknown/crash, but mildly misleading; no spec task covers the canvas node. Candidate follow-up; surface at feature validation.
- 8.x live findings (all PASS): session delete leaves lane worktrees + `csm/<session>-*` branches behind (cleanupStatus "not-applicable") — possible cleanup gap, follow-up candidate. GET `/graph-workflow/history` returns empty while the session record's embedded history is populated — observability quirk. Restart normalization is lazy (read-triggered, not at boot). `/projects/<p>/sessions/<s>` (wrong route shape) spins on "Loading session..." with 404 spam instead of not-found.
- validate-impl: feature validation caught that the production orchestrator was constructed WITHOUT the push-wired eventPublisher (execution-route-handlers.ts:222), making the approval-pending phone push a silent no-op in production while tests passed via injected publishers — fixed by passing the module's push-wired `eventPublisher` into the orchestrator deps. Composition-root wiring like this is not unit-pinned; live phone push remains unverified (push infra inactive in dev).
