# Implementation Plan

- [x] 1. Foundation: configuration toggle and context-state schema
- [x] 1.1 Add the cascading ask-user-questions toggle across all three configuration tiers
  - Boolean block resolvable global → workflow → per-context, with every tier optional and the unset default disabled
  - Seeded global default is disabled; resolution snapshots the value into the execution's working definition at launch so later config edits do not affect running executions
  - One resolved value applies to both implementer and context-validator agents of a context
  - Done when: the cascade resolution unit-test matrix (unset → disabled, workflow override, per-context override, seed-time snapshot) passes
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 1.2 Add the awaiting-user-input context status and pending-user-input record to execution state
  - New context status value plus a nullable pending-user-input record (asking conversation, lane, question batch id, question snapshot, request time, nullable answers) on context state, reusing the conversation domain's question/answer schemas (moving them to shared schemas only if an import cycle appears — never duplicating)
  - Persistence is additive inside the execution JSON blob — no DDL change
  - Done when: the executions-repo contract test round-trips a maximal fixture containing the new status and a populated record (including answers) without loss
  - _Requirements: 3.1, 7.2_

- [x] 2. User-input gate service and workflow events
- [x] 2.1 Publish awaiting-user-input pending/resolved workflow events
  - Server-side event pair carrying execution, context, conversation, and question-batch identity; resolved event distinguishes answered from withdrawn
  - Published after state commits via the existing workflow event publisher so the workflow event log gains corresponding rows
  - Done when: publisher unit tests assert both events' payloads and the event log records them
  - _Requirements: 6.1, 6.2, 6.3_

- [x] 2.2 Implement the user-input gate service owning the parked-question lifecycle
  - Lane resolution answers "may this conversation ask?" by reverse-looking-up the engine-uniform lane conversation id (Claude lanes and Codex implementer lanes qualify; Codex validator lanes and any unresolvable conversation are denied by default)
  - Lifecycle operations: park (snapshot questions, flip status, publish pending; no-op returning answers-ready if answers already recorded), record answers (creates the record pre-park for fast answers; rejects duplicates), consume on resume (returns answers, clears record, flips status back), withdraw on abort (idempotent, publishes resolved-withdrawn)
  - All writes serialized through the existing execution mutation queue; structured logging on every transition
  - Done when: gate unit tests cover the permission matrix (enabled/disabled × implementer/validator/planner/non-lane/unknown × engine), record idempotency, upsert-before-park, and withdraw
  - _Requirements: 2.1, 3.6, 4.3, 5.4, 7.4_
  - _Depends: 1.2, 2.1_

- [x] 3. Conversation-side gating and answer routing
- [x] 3.1 (P) Accept lane ask invocations when the resolved toggle allows
  - Ask endpoint consults the gate's lane permission for lane conversations; allowed asks fall through to the existing registration path unchanged (single-pending-batch rule, turn gates, user notification all reused)
  - Planner, collaboration, and other non-lane conversations keep the existing denial regardless of the toggle; denied lanes get the existing autonomous refusal with a logged reason
  - Done when: route tests show an enabled lane ask registers a batch and notifies, a disabled lane ask gets the existing 403, and planner/non-lane asks stay denied
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - _Boundary: Ask-gate lift_
  - _Depends: 2.2_

- [x] 3.2 (P) Divert lane answers to the gate instead of the conversation queue
  - Lane answers record on the execution's context record with no message queued and no auto-drain; the conversation's pending-question marker is cleared through a machine transition from waiting-for-input back to idle
  - Non-lane answer behavior stays byte-identical; duplicate lane answers get the same already-answered status as today
  - Done when: route tests show a lane answer produces a recorded answer set + cleared marker with an empty queue, and a second submission is rejected as already answered
  - _Requirements: 4.3, 4.4, 5.4, 7.3_
  - _Boundary: Lane answer routing, conversation machine_
  - _Depends: 2.2_

- [x] 4. Workflow orchestration: park, wait, and resume
- [x] 4.1 Park the context when an implementer turn ends with a question pending
  - Post-turn pending-question check on the lane conversation runs before any continue/validate evaluation; a pending question parks the context via the gate and yields a parked outcome that skips validation, failure accounting, and continue-scheduling
  - Answers already recorded at the check (fast answer) skip parking and proceed directly with the answers
  - Done when: orchestrator tests show a question-ending turn leaves the context awaiting user input with iteration and failure counters unchanged, and the fast-answer case proceeds without parking
  - _Requirements: 3.1, 3.3, 5.4_

- [x] 4.2 Treat a validator question as asked-user, never as a validation failure
  - Pre-verdict pending-question check in the validator runner returns a discriminated asked-user outcome mapped to the same park path; the consecutive-failure accounting is never touched by it
  - Done when: a validator turn ending with a pending question and no verdict parks the context with the failure count unchanged and no reopened tasks
  - _Requirements: 3.2, 3.3_
  - _Depends: 4.1_

- [x] 4.3 Wait, re-enter, guard completion, and withdraw in the execution loop
  - Indefinite poll wait on the parked record mirroring the approval gate cadence; answers end the wait, a withdrawn record exits per abort semantics; sibling contexts keep scheduling throughout
  - Loop re-entry restores waiting for parked contexts after pause/halt/restart, applying answers recorded meanwhile immediately without re-waiting; the completion guard refuses to finish the execution while any context is parked; the abort path withdraws all parked questions
  - Done when: loop tests cover wait-until-answer, multiple concurrent parks answered independently, completion refusal while parked, re-entry immediate-apply, and abort withdrawal
  - _Requirements: 3.4, 3.5, 3.6, 3.7, 7.1, 7.2, 7.3, 7.4_

- [x] 4.4 (P) Pin the resume conversation with rotation taking precedence
  - Both lane call resolvers accept a pinned conversation; a matching lane conversation is reused even when continuity is configured off, using the engine-uniform lane conversation id so Codex implementer lanes pin identically
  - A lane flagged for context-window rotation ignores the pin and rotates to a fresh conversation as it does today
  - Done when: continuity tests show pin-forced reuse with continuity off and rotation winning over the pin
  - _Requirements: 5.1, 5.2, 5.3_
  - _Boundary: Resume + pin (continuity service)_

- [x] 4.5 Deliver answers into the resumed turn
  - Resume consumes the parked record and embeds the standard answers block (with one framing line) in the pinned conversation's follow-up prompt, or in the replacement conversation's first prompt when rotation applied — the block carries the original question text so a fresh conversation is self-sufficient
  - The resumed turn runs as an ordinary seeded iteration under normal iteration accounting; a validator resume re-runs the validator and its verdict is processed normally
  - Done when: prompt-builder tests assert the answers block in both pinned and rotated variants, and the record is cleared with status back to running after resume
  - _Requirements: 5.1, 5.3, 5.5_
  - _Depends: 4.1, 4.4_

- [x] 5. Tell lane agents when and how they may ask
  - Effective availability is the resolved toggle AND the lane holding a real conversation (Codex validator lanes never see the tool as available); runners thread this flag into prompt assembly
  - Enabled instructions state the protocol: ask only at consequential/hard-to-reverse/genuinely ambiguous forks, batch related questions, end the turn after asking, answers arrive on resume, skipped means best judgment, and the workflow pauses the context until answered; disabled lanes keep today's autonomous guidance verbatim
  - Done when: prompt snapshot tests cover enabled implementer, enabled validator, Codex-validator-suppressed, and disabled variants
  - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - _Depends: 4.5_

- [x] 6. Cross-component integration verification
- [x] 6.1 Prove the full ask → park → answer → resume cycle against real persistence
  - Persistence-fixture integration tests (real repos, reloaded-state assertions): implementer ask parks with no validation run, answer resumes the same conversation, consume clears the record; validator ask parks without failure movement and its resume verdict is processed normally; a park+resume cycle costs exactly two seeded turns
  - Done when: the cycle suite passes against the real store with assertions made on reloaded state
  - _Requirements: 3.1, 3.2, 3.3, 5.1, 5.5_
  - _Depends: 3.2, 4.5_

- [x] 6.2 Prove lifecycle durability and edge flows against real persistence
  - Completion guard refuses while parked; two contexts park concurrently and answer independently; fast answer skips the park; answers recorded while paused apply on resume without re-waiting; abort withdraws the record and clears the conversation marker
  - Done when: the lifecycle suite passes against the real store, including a restart-shaped reload of a parked execution resuming its wait
  - _Requirements: 3.5, 3.6, 5.4, 7.1, 7.2, 7.3, 7.4_
  - _Depends: 6.1_

- [x] 7. Operator UI: visibility, answering, configuration
- [x] 7.1 (P) Propagate the awaiting state to open UI surfaces in real time
  - Client event union gains the pending/resolved pair; the notification listener invalidates execution, event, and conversation queries and raises a toast when a workflow question registers
  - Done when: with the graph page open, a park updates the UI without manual refresh and resolution clears it
  - _Requirements: 6.1, 6.2_
  - _Boundary: SSE client + NotificationListener_
  - _Depends: 2.1_

- [x] 7.2 (P) Show a distinct awaiting-user-input state on the graph node
  - Wait-state derivation gains the awaiting-user-input kind driven by the context status + record; node styling is design-system compliant and visually distinct from the approval gate's state
  - This task owns only the node-side wait-state kind and styling; the parked-context standing derivation hook belongs to task 7.3
  - Done when: a Storybook/unit render of a parked context shows the distinct badge/styling
  - _Requirements: 6.1_
  - _Boundary: Graph node styling_
  - _Depends: 1.2_

- [x] 7.3 (P) Answer workflow questions inline on the graph page
  - Owns the parked-context standing derivation (the client hook deriving a context's pending question standing from execution state, mirroring the approval-gate hook pattern) consumed by the inspector mount
  - Selecting a parked context mounts the existing question panel fed from the pending record; submission reuses the existing answer mutation against the asking conversation with visible pending state per the responsiveness contract
  - Done when: answering from the inspector panel records the answer set and the panel reflects submission state; the lane conversation view keeps working with no changes
  - _Requirements: 4.1, 4.3_
  - _Boundary: Graph inline answering_
  - _Depends: 3.2_

- [x] 7.4 (P) Edit the toggle at the global and workflow/context tiers
  - Global config section gains a boolean editor for the block; the workflow builder inspector shows the cascade block summary and per-workflow/per-context boolean editor
  - Done when: toggling at each tier persists and the resolved value is visible in the builder summary
  - _Requirements: 1.1, 1.2_
  - _Boundary: Config editors_
  - _Depends: 1.1_

- [x] 8. Live end-to-end validation
- [x] 8.1 Verify the enabled interactive path against the running app
  - Live test (real LLM, Playwright): an enabled workflow's agent asks; the graph node parks in real time; the operator answers inline on the graph page; the workflow resumes the same conversation and completes; workflow status readouts (including the status command output) reflect the awaiting state while parked; registration notifies like ordinary conversations
  - Done when: the live run completes end-to-end with backend state (execution record, transcripts) confirming park, answer, resume
  - _Requirements: 2.4, 4.1, 5.1, 6.1, 6.2, 6.3_
  - _Depends: 6.2, 7.3_
  - _Verified live end-to-end (real LLM Opus, Playwright, isolated :3071 worktree dev instance), execution `1662d0bc`: toggle-enabled gate allowed the lane ask (`gate.permission_allowed`), the agent's `cctl ask` registered a batch (`ask.registered`, HTTP 200) and the context parked (`gate.parked` → `parked_awaiting_user_input`); the graph node showed "Awaiting Input" / "Awaiting your answer" in real time on the already-open page (no reload) and `cctl workflow status` printed `context-decide awaiting_user_input` (Req 6.3); the operator selected forest-green inline on the graph page's `AskQuestionPanel` (task 7.3 mount); the workflow resumed the SAME conversation (`user_input.resumed`, one further seeded turn), the resumed prompt carried the `<cc-question-answers batch="q_6944…">` block with `"selected":["forest-green"]` + the original question text, the agent wrote `DECISION.md` = `theme: forest-green`, and the execution `completed` with iterationCount=1, consecutiveFailureCount=0, completedTaskCount=1 (Req 3.3/5.5). DB confirmed the parked record's answers cleared after consume._
  - _Fix history (integration bugs invisible to the DI/fake suite, all fixed): (1) commit afe213b5 — `waitForTurnCompletion`/`isSettled` treats `waitingForInput` as a settled turn-end so the workflow turn-await does not hang; (2) commit 0e1da9fd — the orchestrator runs the park check in its catch block before failure classification so a pending question wins over a transient `sessionDiedMidTurn`; (3) commit 1c9cdaef — the follow-up-loop wipe (true root cause, pinned from the preserved live logs at `.config/logs/sessions/plc-test-lab__asklive-verify/`): an ask-ended turn completes cleanly, and the orchestrator's follow-up loop dispatched a follow-up prompt onto the asking conversation whose `waitingForInput` state accepts `SUBMIT_PROMPT` and wipes `pendingQuestion`, so the post-loop park check found nothing; fixed by parking before every follow-up dispatch + guarding the post-loop check with `parkedResult === null`. Harness note: `recordServerBaseUrl` derives `CC_SERVER_URL` from `PORT` (defaults :3000); `next dev -p 3071` does not export `PORT`, so an isolated instance injects the wrong URL into agents — worked around by launching the dev server with an explicit `CC_SERVER_URL` env for the live run. Not a feature defect._

- [x] 8.2 Verify conversation-view answering and the disabled path live
  - Answering the same kind of parked question from the lane conversation view resumes the workflow; a workflow with the toggle disabled has its agent's ask refused and proceeds autonomously
  - Done when: both live runs confirm the expected behavior with backend evidence
  - _Requirements: 2.2, 4.2_
  - _Depends: 8.1_
  - _Verified live (real Opus LLM, Playwright, isolated :3071 instance). (1) Conversation-view answering, execution `72ece4d6`: the parked lane conversation opened on the `/conversations` route surfaced the `Agent question` panel (dialog), the operator selected crimson-red and submitted, the workflow resumed the SAME conversation (`user_input.resumed`), the resumed transcript carried the `<cc-question-answers batch="q_f643…">` block with `"selected":["crimson-red"]`, the agent wrote `DECISION.md` = `theme: crimson-red`, and the execution completed with iterationCount=1/consecutiveFailureCount=0 (Req 4.2). (2) Disabled path, execution `3f9270fb` (workflowConfig `askUserQuestions.enabled=false`): the lane agent's `cctl ask` was refused — `gate.permission_denied reason=toggle_disabled` → `ask.denied_lane_gate` HTTP 403, and the agent received the existing "autonomous conversation — proceed with best judgment" message (transcript); it then proceeded autonomously, chose a theme itself, wrote `DECISION.md` (merge commit `5f4de4a`), and the execution completed in a single turn with NO park (status completed, context never entered awaiting_user_input) (Req 2.2)._
  - _Fix (found by this live verification): the lane conversation view suppressed the question panel. `resolvePromptSlotView` (src/features/session/prompt/PromptInputSlot.tsx) returned the read-only treatment for any workflow-managed conversation BEFORE checking for a pending question, so a parked lane's `AskQuestionPanel` never rendered on the conversation view — the design's traceability assumed "Existing PromptInputSlot panel (free — no role gating)" but the pre-existing read-only gating (from the human-review-gate work) hid it. Fixed so a pending question bypasses the read-only treatment exactly as the approval gate already does; safe because a workflow-managed conversation only ever holds a pending question via this feature's ask gate (task_run / smart-merge turns cannot ask). Pinned by updated unit + render tests in PromptInputSlot.test.tsx (Req 4.2)._

## Implementation Notes

- **Live verification (task 8) exposed that the ask-in-workflow-lane turn path was never exercised end-to-end.** The whole DI/fake-based suite passes (the integration tests 6.1/6.2 inject actor implementations and bypass the real conversation machine + turn-await), so three real integration bugs only surfaced under a live run with a real LLM agent driving `cctl ask`:
  1. **Turn-await hang (FIXED, afe213b5).** `waitForTurnCompletion`/`isSettled` in `sdk-driver.ts` only recognized `idle`/`debug.*` as a completed turn, not the top-level `waitingForInput` state an ask-ended turn settles into. `executePromptStream` (awaited by the implementer runner + optimistic actors) never returned → the execution stalled silently. Fix: treat `waitingForInput` as a settled turn-end (it is one of the machine's three documented between-turn boundaries). Reachable only because this feature lifted the autonomous-ask denial (3.1).
  2. **sessionDiedMidTurn misclassified as failure (FIXED, 0e1da9fd).** The implementer runner unconditionally opts into `waitForBackgroundTasks` (implementer-runner.ts:144); its settlement barrier holds the claude query pump open past the `result` message, so an ask-ended turn's subprocess exit rejects the pending turn with `"QuerySession ended before the turn completed"` (query-session.ts:610), thrown out of `runAgentIteration` before the post-turn park check. Fix: run `parkContextIfQuestionPending()` in the orchestrator catch block before failure classification (design "Park detection" ordering) — a pending question parks; a genuine failure still propagates.
  3. **Pending question lost to a follow-up dispatch (FIXED during feature validation).** Even with (1)+(2), a live ask-ended turn ended with the lane conversation `running` and no pending question, so the park check found nothing and the loop retried/halted. The preserved live-run logs (`.config/logs/sessions/plc-test-lab__asklive-verify/`, conversation 1b029604 at 01:51:04–01:51:17Z) pinned the true root cause: the asking turn completes CLEANLY (fix 1 working; no barrier error on that turn), and the orchestrator's follow-up loop — its break conditions covered halt, collaboration, non-running execution, completed tasks, and rotation, but not a pending question — dispatched a follow-up onto the asking conversation. The machine's `waitingForInput` state accepts `SUBMIT_PROMPT` by design ("any claimed turn supersedes the question") and wipes `pendingQuestion`, destroying the batch before the post-loop park check ran. The earlier `waitForBackgroundTasks` hypothesis was a downstream symptom: the `sessionDiedMidTurn` errors came from follow-up turns #2/#3 hitting the dying subprocess after the wipe. Fix: `parkContextIfQuestionPending()` now runs before every follow-up dispatch inside the loop and the post-loop check is guarded by `parkedResult === null` (iteration-orchestrator.ts); pinned by the orchestrator test "parks after the asking turn without dispatching a follow-up" (one agent turn, park committed, counters untouched). The gap escaped the suite because every prior park test used an agent that completed all tasks, so the follow-up loop never engaged alongside a pending question.
- **Dev-harness gotcha for live testing on a non-:3000 port.** `recordServerBaseUrl` derives the agent-facing `CC_SERVER_URL` from `process.env.PORT` (defaulting to :3000 — correct for the real main server). `next dev -p <port>` does NOT put `PORT` into the runtime, so an isolated dev instance on e.g. :3071 injects `CC_SERVER_URL=http://127.0.0.1:3000` into every spawned agent, and the agent's `cctl ask` fights the wrong server/token. Workaround used for live testing: give the agent an explicit `CC_SERVER_URL=http://localhost:<port>` prefix in the task instruction. This is a test-harness limitation, not a feature defect.
