# Implementation Plan

- [ ] 1. Conversation command domain primitives
- [x] 1.1 Command parser with hint extraction
  - Recognize `/commit` and `/merge` as whole-message commands with optional trailing hint text; trim hint; return nothing for non-command text (including near-misses like `/committed` or mid-message occurrences)
  - Domain schemas define the parsed-command discriminated union (Zod-first, inferred types)
  - Observable: unit tests (written first) cover exact command, command+hint, leading whitespace, and negative cases — all green
  - _Requirements: 1.1, 1.2, 2.1, 2.4_
- [x] 1.2 Message generation module
  - Build the narrow generation prompt: embeds the change summary, branch/target identification, and optional hint; instructs the agent its only task is producing the commit message
  - Define the structured-output contract (message string) as Zod schema + JSON schema payload; validate returned results — only a structured result with a non-empty trimmed message is acceptable; classify text/error/timeout results as fallback-worthy with loggable reasons
  - Provide default messages: merge identifies source and target branch; commit identifies the session
  - Observable: unit tests cover all task-run result kinds (structured-valid, structured-empty, text, error) and both defaults — all green
  - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3_

- [ ] 2. Shared prerequisites outside the domain
- [x] 2.1 (P) System notice transcript entries
  - Extend the transcript schema with a CC-authored notice entry kind; appending a notice broadcasts it on the existing conversation SSE channel
  - Sweep transcript consumers that assume only user/assistant entries and keep them safe
  - Observable: a notice appended to a conversation is read back from the transcript and appears in the broadcast payload (unit test)
  - _Requirements: 1.4, 1.5, 1.6, 1.7, 2.6, 4.4_
  - _Boundary: System notice support (transcript)_
- [x] 2.2 (P) Merge target resolution extraction
  - Extract target branch/worktree resolution from the merge route handler into a shared resolver usable by the command service; cover normal and child-branch sessions
  - Observable: merge route behavior unchanged — existing route tests pass and an equivalence test covers both session shapes
  - _Requirements: 2.5, 5.1_
  - _Boundary: Merge target resolver_
- [x] 2.3 (P) Change summary collector
  - Deterministic git-domain helper that summarizes the worktree's current changes (file status plus per-file change magnitude) as agent-readable text for message generation
  - Observable: unit test against a dirty worktree fixture returns a summary naming changed files; clean worktree returns an empty summary
  - _Requirements: 3.4_
  - _Boundary: Git helpers_

- [ ] 3. Command orchestration service
- [x] 3.1 Eligibility checks and rejection notices
  - Factory-built service with method-syntax deps (no vi.mock of internal modules); deterministic pre-checks in order: session present → session not finished → no active commit/merge/conflict-resolution job → (commit only) worktree has uncommitted changes
  - Every rejection appends exactly one explanatory notice to the conversation and never starts a generation turn or job
  - Observable: eligibility-matrix unit tests (written first) prove the task-run dep is never invoked on any rejection path — all green
  - _Requirements: 1.4, 1.5, 1.6, 1.7, 2.6_
- [x] 3.2 Generation, fallback, and dispatch
  - Eligible commands collect the change summary via the shared collector, run the generation turn in the same conversation via the existing workflow task-run primitive with the structured-output contract, and validate the result
  - Invalid/failed generation falls back to the default message, logs the failure, and appends a fallback notice — the flow never aborts because of generation failure
  - Dispatch through the existing commit/merge job entry points: commit carries the generated/fallback message; merge always carries auto-resolve enabled plus the resolved target; a dispatch-time busy race appends a notice and reports rejection
  - Structured logging on every outcome (detection, rejection reason, generation duration/result kind, fallback engagement, dispatch with job id) per the project logging conventions
  - Observable: unit tests cover dispatched-with-generated-message, fallback-dispatch with notice, merge auto-resolve flag, and dispatch-race rejection — all green
  - _Requirements: 1.3, 2.2, 2.3, 2.5, 3.1, 3.4, 3.6, 3.7, 4.1, 4.4, 4.5_

- [ ] 4. Entry-point hooks
- [x] 4.1 (P) Direct-path interception in the prompt stream
  - Detect commands beside the existing /collab check; persist the user's command message to the transcript; delegate to the command service; return without entering the normal turn flow
  - The /collab flow and normal prompts remain unaffected
  - Observable: integration test proves a `/commit` submission invokes the service, never starts a normal turn, completes while the route awaits (lock interplay), and emits done — all green
  - _Requirements: 1.1, 2.1, 3.1, 3.2_
  - _Boundary: Prompt interception hook_
  - _Depends: 1.1, 3.2_
- [x] 4.2 (P) Queued commands never reach the agent
  - Command messages queued during an active turn skip live in-turn delivery regardless of backend capability and remain pending for next-turn handling
  - Observable: test proves a command queued mid-turn is never delivered into the running turn and is still pending when the turn ends
  - _Requirements: 8.1, 8.2_
  - _Boundary: Queue command handling_
  - _Depends: 1.1_
- [x] 4.3 Command-aware claiming and drain routing
  - Batch claiming yields either the maximal prefix of non-command messages (coalesced as today) or a single command entry at the head; drain routes command entries to the command service and marks them delivered only after the run resolves
  - Ordering preserved across mixed batches; queued commands get identical semantics to direct submissions
  - Observable: integration test with the real-store queue fixture drains text→command→text as turn, command run, turn — in order, with the command producing the same outcome shape as the direct path
  - _Requirements: 8.1, 8.3_

- [ ] 5. UI changes
- [x] 5.1 (P) Autocomplete built-in entries
  - `/commit` and `/merge` appear as built-in commands with descriptions and argument hints; selection inserts the command ready for optional hint text
  - Observable: UI test shows both commands listed in the slash popup and insertable
  - _Requirements: 6.1, 6.2_
  - _Boundary: Autocomplete built-ins_
- [x] 5.2 (P) Notice rendering in the conversation
  - Notice entries render as a distinct system-style row (not a user/agent bubble) in the message list
  - Observable: renderer test (or story) shows a notice entry rendered distinctly from user/assistant messages
  - _Requirements: 1.4, 4.4_
  - _Boundary: System notice support (renderer)_
  - _Depends: 2.1_
- [x] 5.3 (P) Remove legacy commit/merge triggers
  - Remove the Commit/Merge buttons and their props from the session git panel, both trigger dialogs, their mutations, and parent dialog wiring; conflict-review and ready-to-land land/discard affordances remain
  - Observable: session page renders without the buttons/dialogs, land/discard still renders for ready-to-land jobs, and typecheck passes with the mutations deleted
  - _Requirements: 7.1, 7.2, 7.3_
  - _Boundary: Legacy trigger removal_

- [ ] 6. Validation
- [x] 6.1 Live end-to-end verification
  - Live `/commit` in a real session conversation: generation turn visible in the conversation, commit job completes, branch history carries the agent-written message
  - Live `/merge` on a session with changes: squash commit on the target carries the agent message; intermediate WIP commit message unchanged; job status, notifications, and job history behave exactly as before
  - Fallback drill: forced generation failure still commits with the default message and surfaces the notice
  - Observable: recorded live evidence (git log of target/session branches, notice visible, job history entries) matches all three scenarios
  - _Requirements: 1.1, 1.3, 2.1, 2.3, 3.1, 3.2, 4.1, 5.1, 5.2, 5.3_

## Implementation Notes

- 6.1: live-verified all three scenarios (worktree-local config, scratch project). (1) /commit: agent message "Add clamp helper to calc and introduce unit tests" reflecting the hint; pipeline logs command_detected→generation_complete(structured)→dispatched→command_complete; job completed. (2) /merge: squash on main "Add clamp and percentage utilities…" (agent, hint-aware); WIP commit kept fixed message "WIP: uncommitted changes"; notifications commit-completed/merge-completed recorded as before. Codex backend also produced a structured message live (3.7 positive). Rejection: clean-tree /commit → no-changes notice rendered as System row, no job. Fallback (unreachable backend via ANTHROPIC_BASE_URL poison): 180s timeout → generation_fallback logged, dispatched usedFallback=true, commit "Changes from session pebble-run", fallback notice durable + rendered. MINOR FINDING: the conversation /abort endpoint returns 409 "No running prompt to abort" during a command generation turn — the UI Stop control cannot abort task-run turns (pre-existing executeWorkflowTaskRun behavior, not introduced by this spec; consider a follow-up).

- 5.3: validate-impl follow-ups — DONE at validation: (a) dead `useMergeMutation` + its SessionPage.test.tsx mock deleted; (b) project-detail's never-wired no-op "Merge to target" kebab stub removed (presented a merge trigger that did nothing — req 7.1/7.2).
- 4.3: follow-up — DONE at validation: shared `dispatchConversationCommand` helper extracted to `src/lib/conversation-commands/dispatch.ts`; both default deps (sdk-driver, manager) now delegate to it. Failure semantics: service throw → `markFailed` (terminal, error recorded) to avoid infinite redelivery; delivered only after run resolves.

- 3.1: no-session rejection notice uses `sessionName: ""` — SSE event becomes session-scoped with empty name, so project-scoped clients miss the live broadcast; task 4.1 (entry hook) must pass the project sentinel / correct scope addressing. Also: getSession dep typed nullable (real accessor returns SessionState | null; design's non-null signature was idealized).
- 2.1: transcript role gates unified behind `isVisibleEntry` in transcript.ts; notices count as visible merged messages (index math consistent across read/copy/fork). Latent edge for 5.2: `forkConversation` treats a notice-index fork as a user fork — add a guard when rendering makes notices clickable.
