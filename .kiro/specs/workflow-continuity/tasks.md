# Implementation Plan

- [ ] 1. Establish the new continuity configuration and schema cutover
- [ ] 1.1 Replace the old implementer and agent-validator context settings with one continuity policy per lane
  - Model continuity as enabled or disabled plus one optional context limit for the implementer, task-validator, and execution-context-validator lanes
  - Default all three lanes to continuity enabled with no limit configured
  - Enforce positive integers when a limit is provided and treat an omitted limit as "no limit logic"
  - Ensure execution startup copies the new policy into active execution state without runtime mutation
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 6.2, 6.3_

- [ ] 1.2 Add a hard cutover guard that rejects legacy soft and hard continuity payloads everywhere they can enter the system
  - Detect removed legacy fields in saved workflow definitions and active executions before strict graph-workflow parsing runs
  - Return explicit operator-facing errors for workflow load, save, execution start, and execution recovery paths
  - Keep the rollout intentionally non-compatible with no migration, no read-union parsing, and no silent normalization
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 7.1, 7.2_

- [ ] 1.3 Update workflow authoring flows to emit only the new continuity shape
  - Remove the old soft and hard context settings from workflow generation and editing flows
  - Preserve the difference between an empty limit and a numeric limit in all persisted workflow definitions
  - Keep continuity controls available only for agent-driven validator lanes
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 6.2, 6.3_

- [ ] 2. Persist per-lane continuity state and centralize reuse decisions
- [ ] 2.1 Add active lane state for the implementer, task-validator, and execution-context-validator lanes
  - Persist one active session record per lane with its context binding, engine identity, reuse metadata, and last usage snapshot
  - Clear all lane state when execution advances into a new execution context
  - Keep validator history linkage append-only while lane state remains mutable runtime state
  - _Requirements: 2.2, 2.3, 2.4, 3.3, 3.4, 3.5, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 7.1, 7.2, 7.3, 7.4_

- [ ] 2.2 Build one continuity decision path for lane reuse, forced fresh sessions, and post-turn rotation
  - Reuse a lane only within its current execution context and only when its configured continuity mode permits it
  - Defer rotation decisions until after a completed turn, then schedule the next call to start fresh if the configured limit was exceeded
  - Disable all limit-based behavior when no limit is configured instead of applying fallback heuristics
  - Mark validator limit evaluation as unsupported when the engine cannot provide the needed signal
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2_

- [ ] 2.3 Harden recovery behavior and observability for stale lane references
  - Fall back to fresh sessions when a saved Claude conversation or Codex thread can no longer be resumed
  - Reset lane state that no longer matches the active execution context before the next call is resolved
  - Emit structured continuity logs for reuse, creation, rotation scheduling, context resets, legacy-schema rejection, and stale-session recovery
  - _Requirements: 5.3, 5.4, 6.4, 6.5, 7.1, 7.2_

- [ ] 3. Apply continuity to implementer execution
- [ ] 3.1 Replace fresh-per-iteration implementer startup with continuity-aware session resolution
  - Reuse the same implementer session across iterations only when the lane policy and current context allow it
  - Start a fresh implementer session at every iteration boundary when continuity is disabled
  - Keep fresh-session behavior scoped to the next iteration boundary when a disabled lane finishes a turn naturally
  - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 5.1, 5.3, 5.4_

- [ ] 3.2 Rebuild implementer prompts correctly when a mid-context rotation creates a fresh session
  - Use a full iteration seed whenever the resolved implementer session is fresh, even if the lane is staying in the same execution context
  - Continue using follow-up prompting only when the implementer lane is truly reusing its current session
  - Preserve reviewable task linkage to whichever implementer conversation actually produced the current task progress
  - _Requirements: 2.3, 2.4, 5.4, 7.3, 7.4_

- [ ] 3.3 Remove the old exhaustion heuristic from implementer execution
  - Stop using the prior percentage-based exhaustion behavior and rely entirely on the configured continuity limit when present
  - Keep no-limit mode free of implicit rotation behavior
  - Ensure post-turn implementer limit evaluation is recorded once and reused on the next iteration decision
  - _Requirements: 2.3, 2.4, 2.5, 6.1, 6.2, 6.3_

- [ ] 4. Apply continuity to validator execution for both Claude and Codex
- [ ] 4.1 Thread independent task-validator and execution-context-validator continuity through agent validation
  - Resolve task-level and execution-context-level validators as separate lanes even when they use the same engine
  - Start fresh validator sessions for every invocation when continuity is disabled
  - Keep script-based validation outside the continuity model
  - _Requirements: 3.1, 3.2, 4.1, 4.2, 5.1, 5.2_

- [ ] 4.2 Add Codex start-or-resume execution with durable lane reuse metadata
  - Reuse an existing Codex thread within the same execution context when continuity is enabled and the saved thread can be resumed
  - Start a fresh Codex thread when no thread exists, continuity is disabled, the context changed, or resume fails
  - Capture the returned thread identity and turn usage without deriving context-window heuristics from it
  - _Requirements: 3.6, 4.6, 5.3, 5.4, 6.4, 6.5, 7.1, 7.2_

- [ ] 4.3 Persist validator session references and CC-owned review artifacts for every agent validator turn
  - Attach lane-aware session references to validator outcomes so execution history can point back to the reused Claude conversation or Codex thread
  - Persist a compact Codex review artifact containing the thread identity, final response, and usage snapshot for in-product reviewability
  - Record supported, disabled, and unsupported limit-evaluation outcomes alongside validator continuity state
  - _Requirements: 3.3, 3.4, 3.5, 3.6, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4_

- [ ] 5. Update workflow editing and execution history surfaces
- [ ] 5.1 (P) Expose continuity controls in workflow authoring with the new defaults and limit semantics
  - Replace the old soft and hard context controls with continuity toggles and one optional limit for the implementer lane
  - Add matching continuity controls to task-validator and execution-context-validator agent sections
  - Keep the default state explicit in the UI: continuity enabled, limit empty
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 6.2, 6.3_

- [ ] 5.2 (P) Surface reused validator sessions and Codex review artifacts in execution history
  - Show lane identity and engine metadata for validator results without collapsing task-validator and context-validator history together
  - Preserve Claude transcript navigation for validator outcomes that reference Claude conversations
  - Render the persisted Codex review artifact directly in execution history so reviewability does not depend on external thread storage
  - _Requirements: 5.1, 5.2, 7.3, 7.4_

- [ ] 5.3 Validate shared-conversation inspection flows for reused implementer sessions
  - Keep task-level transcript access working when multiple task updates point to the same implementer conversation
  - Ensure shared-session history remains understandable even when several iterations reuse one implementer lane
  - _Requirements: 2.2, 2.3, 5.4, 7.3, 7.4_

- [ ] 6. Add continuity regression coverage across schema, runtime, and UI
- [ ] 6.1 (P) Add focused unit coverage for continuity policy parsing, cutover rejection, lane decisions, and metadata shaping
  - Cover default-on continuity, optional limit parsing, legacy schema rejection, lane reuse decisions, stale-session fallbacks, and validator metadata shaping
  - Verify no-limit mode never triggers rotation heuristics and unsupported validator limits stay disabled
  - _Requirements: 1.4, 1.5, 1.6, 2.4, 2.5, 2.6, 3.5, 3.6, 4.5, 4.6, 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.4_

- [ ] 6.2 Add end-to-end runtime coverage for implementer continuity, validator continuity, and restart recovery
  - Exercise implementer reuse across iterations, mid-context rotation after an over-limit turn, and context-boundary resets
  - Exercise separate task-validator and execution-context-validator lanes for both Claude and Codex where supported
  - Verify persisted lane state and Codex review artifacts survive restart and remain usable on resume
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 7.1, 7.2, 7.4_

- [ ] 6.3 (P) Add UI coverage for authoring controls, validator history linkage, and shared-session inspection
  - Verify the workflow editor saves the new continuity shape and rejects the removed legacy fields
  - Verify execution history shows Claude links, Codex review artifacts, and lane metadata correctly
  - Verify task history remains reviewable when multiple task updates point to the same implementer conversation
  - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 7.3, 7.4_
