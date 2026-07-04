# Gap Analysis: ask-question-in-graph-workflows

Generated 2026-07-03 by `/kiro-validate-gap`. Sources: discovery brief, requirements.md, and three codebase explorations (ask/answer flow, graph engine mechanics, UI + gating plumbing).

## 1. Current State Investigation

### Assets that exist and are reusable as-is

| Asset | Location | Relevance |
|---|---|---|
| Async ask flow (register → `waiting_for_input` → turn ends) | `src/lib/conversations/ask-route-handlers.ts:54-211`, `src/lib/workflows/conversation/machine.ts:490-504, 919-1022` | The entire question lifecycle; workflow gate lift is one conditional in the mode gate (`ask-route-handlers.ts:93-111`) |
| Answer flow (atomic consume + `<cc-question-answers>` format) | `src/lib/conversations/answer-route-handlers.ts:64-167`, `question-answers-block.ts:22-31` | Answer recording, idempotency (410 on duplicate), block formatting |
| `AskQuestionPanel` | `src/components/AskQuestionPanel.tsx:39-58` | **Fully reusable**: props-driven (`questions`, `questionId`, `onSubmit` callback), not conversation-coupled. Graph-page inline answering can mount it directly |
| Lane conversation view question panel | `src/features/session/prompt/PromptInputSlot.tsx:84-99` | Mounts the panel for **any** conversation with `pendingQuestionId` — no role/source gating. Requirement 4.2 is nearly free |
| Human approval gate (the template) | `approval-gate.ts:62-65`, `execution-loop.ts:400-700, 1825-1846, 1869-1871`, `use-approval-gate.ts:36-57`, `ApprovalGatePanel.tsx` | Park record, poll-wait, decision endpoint, SSE events, pause/restart re-entry, completion guard, UI standing derivation — the shape to mirror |
| Config cascade (8 blocks, 3 tiers) | `src/lib/config/schemas.ts:29-38`, `src/lib/workflows/schemas.ts:232-274`, `src/lib/workflow-graph/resolve-config.ts:17-168` | New boolean block slots into a proven pattern; resolved at seed time into `execution.workingDefinition` |
| Continuity service | `workflow-continuity-service.ts:62-67, 136-148, 284-330` | `resolveImplementerCall` / `shouldRotate` / `rotateBeforeNextTurn` — the pin and rotation-precedence logic hooks in here |
| SSE plumbing | `execution-events.ts`, `NotificationListener.tsx:965-1004` | Approval pending/resolved events + client invalidation are the exact pattern for user-input pending/resolved |
| CLI status rendering | `src/cli/commands/workflow.ts:91,106-108` | Status is a lenient `z.string()` — a new context status value flows through with **zero CLI changes** |
| Contract-test backstop | `graph-workflow-executions-repo.*.contract.test.ts` | `assertRoundTripDurability` pattern; extend fixture for the new field |

### Conventions that constrain the work

- Additive, forward-compatible schema changes only (shared `command-center.db` across branches).
- DI over `vi.mock()`; extract pure functions for orchestration logic.
- Structured logging (`createLogger`) on all new paths.
- Optimistic/pending UI feedback floor for the new answer mutation surfaces.

## 2. Requirement-to-Asset Map

| Req | Need | Status | Notes |
|---|---|---|---|
| 1.1-1.5 | New cascade block (e.g. `userInput: { allowAskQuestion: boolean }`) | **Missing** (pattern exists) | 3 schema tiers + `SEEDED_DEFAULTS` + `coerceGlobalDefaults` + `resolveWorkflowConfig` + `resolveContext`; seed-time snapshot behavior comes free |
| 2.1-2.2 | Conditional lift of ask mode gate | **Missing** + **Unknown** | The gate must map a lane conversation → (execution, contextId) → resolved toggle. `ConversationState` carries `role`/`activeTurnSource` but **no executionId/contextId** (`conversations/schemas.ts`). Resolution path is the key design decision (§4) |
| 2.3 | Collab/planner always denied | **Constraint (kept)** | Planner conversation has `role: "planner"`; collaboration agents never get lane env. Deny-list stays for non-implementer/validator roles |
| 2.4-2.5 | Notification + single-batch rule | **Exists** | Reused unchanged from ask flow |
| 3.1-3.2 | Park on turn-end-with-pending-question (impl + validator, before verdict) | **Missing** | New check in `finalizeIterationResult` (`iteration-orchestrator.ts:1239+`) and validator-runner before verdict interpretation. `PromptStreamResult` (`sdk-driver.ts:503-520`) does **not** expose pendingQuestion — surface it on the result or post-turn `getConversation` lookup |
| 3.3 | No iteration/failure cost while parked | **Exists (by construction)** | `iterationCount` increments at seed time only (`iteration-orchestrator.ts:1622`); `consecutiveFailureCount` only on validation failure/terminal error — park path must simply avoid those branches |
| 3.4-3.6 | Siblings run; completion guard; concurrent parks | **Missing** (pattern exists) | New status `awaiting_user_input` in `graphWorkflowContextStatusSchema` (`schemas.ts:580-587`) + completion-guard clause + re-entry clause mirroring `awaiting_approval` (`execution-loop.ts:1825-1846, 1869-1871`) |
| 3.7 | No timeout | **Free** | Approval gate has none either |
| 4.1 | Graph-page inline answering | **Missing** (components exist) | Mount `AskQuestionPanel` keyed by context; derive standing from `contextStates` like `use-approval-gate.ts` |
| 4.3-4.4 | One answer set; skip semantics | **Exists** | Answer endpoint idempotency + skip format reused |
| 5.1-5.2 | Resume same conversation w/ answer block; pin overrides continuity-off | **Missing** | Answers stored on new `pendingUserInput` context-state field (decision (b)); resume prompt embeds the block; one-turn pin carve-out in `shouldRotate`/`resolveImplementerCall` |
| 5.3 | Rotation outranks pin | **Missing** | `rotateBeforeNextTurn` already persisted per lane (`lane-service.ts:220,273`); precedence check + answer block into fresh conversation's follow-up prompt (`iteration-prompt.ts:323-359`) |
| 5.4 | Fast answer (before turn ends) | **Missing** | Machine already handles mid-turn `CLEAR_PENDING_QUESTION` (`machine.ts:457-468`); loop must check answers-already-recorded before parking |
| 5.5 | Normal accounting on resume | **Free** | Resume turn is an ordinary iteration |
| 6.1-6.2 | Distinct node state, real-time | **Missing** (pattern exists) | New `awaiting-user-input` kind in `derive-wait-state.ts` + `ExecutionContextNode` styling + 2 SSE event types + `NotificationListener` handlers |
| 6.3 | Status readouts | **Mostly free** | CLI passes status strings through; event log follows event pattern |
| 7.1-7.3 | Pause/halt/restart durability; answers-while-paused | **Missing** (pattern exists) | `pendingUserInput` on persisted context state rides existing persistence; re-entry mirrors approval re-queue; apply-on-resume mirrors approval decision application |
| 7.4 | Withdraw on abort | **Missing** (no pattern) | **No existing withdraw path**: abort flow doesn't clear `pendingApproval` today either, and no HTTP/service call clears a conversation's `pendingQuestion` outside a turn (only `ABORT_TURN`/`CLEAR_PENDING_QUESTION` machine events). Needs a small new service path |

**Answer-routing gap (cross-cutting, decided direction):** the answer endpoint today queues the answer onto the conversation and calls `ensureConversationActorAndDrain` (`manager.ts:1183-1212`) with **no role guard** — for a lane conversation this would fire a turn outside workflow control. Per the agreed invariant, workflow-context answers must instead record to `pendingUserInput` and never auto-drain a lane conversation. Whether this is a branch in the existing answer handler or a dedicated workflow-answer endpoint is a design decision (§4).

## 3. Implementation Approach Options

### Option A: Extend existing components only

Fold everything into the existing files: mode-gate conditional in `ask-route-handlers.ts`, lane branch in `answer-route-handlers.ts`, park/resume logic inline in `iteration-orchestrator.ts` and `execution-loop.ts`, config block additions in place.

- ✅ Fewest new files; every change sits next to the pattern it mirrors
- ❌ `iteration-orchestrator.ts` (~1600+ lines) and `execution-loop.ts` (~1900+ lines) are already at the project's split threshold; inlining a second gate grows them further
- ❌ Answer-handler branching mixes two behaviorally different flows in one route

### Option B: New parallel components

A separate user-input-gate subsystem: own service, own endpoints, own orchestration hooks, own UI panel.

- ✅ Clean isolation, easy unit testing
- ❌ Violates the composability mandate where reuse is explicitly cheap (panel, answer idempotency, wire format) — would duplicate the exact machinery the discovery phase decided to reuse
- ❌ Two question systems for the UI to reconcile

### Option C: Hybrid — mirror the approval gate's file topology (recommended)

New small modules exactly where the approval gate has parallel ones; extensions where the seam already exists:

- **New**: `user-input-gate.ts` service (sibling of `approval-gate.ts`: enter/record/apply), `pendingUserInput` schema + SSE event pair, `awaiting-user-input` wait-state kind + node styling, graph-page question standing hook (sibling of `use-approval-gate.ts`), inspector field editor for the new block (hand-built per `InspectorFieldEditors.tsx` pattern, ~150-250 lines).
- **Extend**: mode gate in `ask-route-handlers.ts` (conditional lift), answer path (lane-aware routing to the gate service), `finalizeIterationResult` + validator-runner (park detection), `resolveImplementerCall`/`shouldRotate` (pin + rotation precedence), config cascade files (9th block), completion guard + re-entry in `execution-loop.ts`, contract-test fixtures.

- ✅ Matches how the codebase already solved this problem shape once; keeps giant files from growing much; reuses everything the requirements say to reuse
- ❌ More coordination points than A — mitigated by the approval gate serving as a line-by-line reference

## 4. Key Design Decisions to Carry Forward

1. **Lane identity transport** (Req 2.1): how the ask endpoint learns (executionId, contextId) for a lane conversation. Candidates: (a) `cctl ask` forwards `CC_WORKFLOW_EXECUTION_ID`/`CC_WORKFLOW_CONTEXT_ID` (already injected into lane turns, already consumed by `resolveLaneContext()` in `src/cli/shared.ts:419-442`) and the server verifies against the active execution; (b) persist executionId/contextId on `ConversationState` at lane creation (additive field); (c) reverse lookup via execution lane states. (a) reuses the existing lane-verb convention and needs server-side verification anyway; (b) is the most robust for the answer/UI side, which has no CLI env. Likely both: (a) for the ask gate, (b) or standing-derivation-from-contextStates for the UI.
2. **Answer routing**: branch in the existing answer endpoint (lane-aware) vs a dedicated workflow answer endpoint (like the approval decision endpoint). Either way: record to `pendingUserInput`, clear the conversation's pending marker via `CLEAR_PENDING_QUESTION`, never drain.
3. **Park detection transport**: extend `PromptStreamResult` with pending-question info vs post-turn conversation lookup in the orchestrator.
4. **Prompt instruction accuracy**: `ASK_QUESTION_INSTRUCTIONS` is included unconditionally (`actor-implementations.ts:1621`) and its text says asking is denied for autonomous turns; `iteration-prompt.ts` never mentions asking. For enabled lanes the instruction set must teach the lane ask protocol (ask → end turn → park), and for disabled lanes remain accurate. Decide: conditional system-prompt instruction vs iteration-prompt section keyed on the resolved toggle.
5. **Withdraw-on-abort mechanics**: new service path that clears `pendingUserInput` and dispatches `CLEAR_PENDING_QUESTION` (+ SSE resolved event with a withdrawn flavor). Adjacent finding (out of scope, worth a note in design): execution abort today doesn't clear `pendingApproval` either.

## 5. Effort & Risk

- **Effort: M (3–7 days).** Every subsystem touched has a worked example to mirror (approval gate, cascade block, SSE pair, inspector editor); no external dependencies; the genuinely new logic is park detection ordering, the resume pin/rotation precedence, and lane identity transport.
- **Risk: Medium.** Two state layers (conversation machine ↔ context state) must stay coherent under races: fast answers, answer-vs-abort, drain suppression, rotation-during-park. All four agreed invariants are testable with DI'd orchestrator units + the persistence fixture; the risky seams are known and enumerated.

## 6. Research Needed (design phase)

- Exact lane-state shape: whether `laneStates` reliably maps conversationId → contextId per role (implementer vs validator lanes), to confirm/deny reverse lookup as a fallback for UI standing derivation.
- Where the graph page currently mounts per-context action UI after the `human-approval-gate-no-conversation` fix (contextId-keyed approve/reject) — reuse that mount point for the question panel.
- Whether the answer-while-paused path (Req 7.3) needs an explicit guard against the execution loop being stopped (approval gate handles this via decision-record persistence; confirm the same holds when no loop is running).
- Where the **global** `workflowDefaults` tier is edited (config.json by hand vs a config-editor UI surface) to decide whether the new block needs a global-tier UI at all.

---

# Design-Phase Discovery & Synthesis (2026-07-03, `/kiro-spec-design`)

## Resolved research items (all four)

1. **Lane-state reverse lookup: CONFIRMED viable.** `execution.laneStates` is `Record<contextId, Record<lane, GraphWorkflowAgentSessionState>>` (`src/lib/workflows/schemas.ts:1405-1410`); each entry carries `lane: "implementer" | "context_validator"`, `contextId`, and `sessionRef.conversationId` for Claude lanes (`schemas.ts:1338-1367`). Server-side scan resolves conversationId → (executionId, contextId, lane) with no new fields and no trust in client-supplied identity. This **superseded** the lane-identity-transport options in §4: chosen mechanism is reverse lookup; `cctl ask` and `ConversationState` need zero changes.
2. **Graph-page mount: correction.** `ApprovalGatePanel` mounts in the conversation view (`PromptInputSlot.tsx`), not on the graph page; the graph page's `ExecutionInspectorPanel` shows only status badges. The graph-page inline question mount is therefore **new work**: render `AskQuestionPanel` in `ExecutionInspectorPanel` for a parked selected context.
3. **Answer-while-paused: pattern confirmed.** `recordDecision` accepts `running | paused | halted` (`approval-gate.ts:17-18, 194-275`) as a pure state mutation; loop re-entry applies a recorded decision immediately without re-waiting (`execution-loop.ts:1825-1846`). Answers mirror this exactly.
4. **Global config UI exists and is hand-built per block**: `src/features/config/sections/WorkflowSection.tsx` + one field component per block under `sections/workflow/`. New block needs a small `AskUserQuestionsFields.tsx`.

Bonus: `graphWorkflowPendingApprovalSchema` shape confirmed (`{ conversationId, requestedAt, decision: nullable }`, `schemas.ts:914-921`) — mirrored by `graphWorkflowPendingUserInputSchema` with `answers` in place of `decision`, plus `lane`, `questionBatchId`, and a `questions` snapshot so the graph UI and resume prompt are self-sufficient.

## Synthesis outcomes

- **Generalization (declined deliberately):** approval gate and user-input gate are two instances of "park on a pending human action recorded on context state." No shared abstraction is extracted (two instances, different payloads/actions — YAGNI); instead the shapes/naming are kept parallel so a future third instance can motivate unification cheaply.
- **Build vs adopt:** adopt `AskQuestionPanel`, ask/answer endpoints + wire format, approval-gate wait/re-entry/guard patterns, cascade machinery, SSE plumbing. Only genuinely new module: `user-input-gate.ts`.
- **Simplifications locked in:**
  - No new answer endpoint — the existing answer route becomes lane-aware server-side, so `AskQuestionPanel` + `useAnswerQuestionMutation` work unchanged from both surfaces.
  - No `PromptStreamResult` widening — park detection is a post-turn conversation read in the orchestrator.
  - No CLI changes and no new `ConversationState` fields — lane resolution via `laneStates` scan.
  - Config block is one boolean: `askUserQuestions: { enabled }`, seeded `false`.
- **Boundary decisions:** single-writer rule — `user-input-gate.ts` is the only mutator of `pendingUserInput`; conversation-side effects limited to `CLEAR_PENDING_QUESTION` (machine gains that transition in `waitingForInput` → `idle`). Questions are snapshotted into the record at park time; the record is authoritative post-park (bounded duplication, single writer).
- **Crash-ordering rule:** record answers on execution first, clear conversation marker second; answers-present is authoritative and stale markers are cleared on next loop touch.
- **Adjacent gap recorded, not fixed:** execution abort does not clear `pendingApproval` today; the new `withdrawAll` deliberately does better for `pendingUserInput`. Fixing the approval-gate gap belongs to `human-review-gate`.
- **Cycle risk noted:** if importing conversation question schemas into `src/lib/workflows/schemas.ts` creates an import cycle, the question/answer primitives move to `src/lib/shared/schemas.ts` per structure.md — never duplicated.
