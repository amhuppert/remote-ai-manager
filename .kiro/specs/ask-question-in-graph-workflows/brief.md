# Brief: ask-question-in-graph-workflows

## Problem

Graph-workflow implementer and validator agents run fully autonomously — they
cannot ask the user a question at a real fork. Today `cctl ask` is blocked
server-side inside workflow-driven turns (`ask-route-handlers.ts` denies when
`conversation.role !== null` or `conversation.activeTurnSource === "workflow"`),
and the system prompt tells autonomous turns to proceed with best judgment. When
an unattended workflow hits a consequential, hard-to-reverse, or genuinely
ambiguous decision, the agent must guess. A wrong guess is expensive: it can
send an entire context (and its downstream dependents) down the wrong path
before any human sees it.

## Current State

The async ask/answer flow is **fully built for user-driven conversations** and
demonstrably works:

- `cctl ask` → `POST .../conversations/[id]/ask` registers a pending question,
  dispatches the `ASK_QUESTION` machine event, and the conversation enters
  `waiting_for_input` with a `pendingQuestion` record; the agent ends its turn.
- `POST .../conversations/[id]/answer` atomically consumes the pending marker and
  queues the answer as a `<cc-question-answers>` block — the conversation's next
  user message — which the conversation actor drains to resume.

The graph engine already has the canonical "context parks → user acts → context
resumes" machinery in the **human approval gate**: `awaiting_approval` context
status, a `pendingApproval` record on the context state, a poll-based wait in the
execution loop, an HTTP decision endpoint, `approval-pending`/`approval-resolved`
SSE events, automatic re-entry after pause/restart, a completion guard that
refuses to finish while a context is parked, and **no iteration burn** while
waiting.

The **gap**: these two flows are not connected. Workflow lane turns cannot ask,
there is no `awaiting_user_input` context state, and there is no config toggle to
enable the capability.

## Desired Outcome

- An implementer or context-validator agent in a graph workflow can invoke
  `cctl ask` mid-task when the capability is enabled.
- The execution context enters an **"awaiting user input"** state: it parks
  indefinitely, sibling contexts keep running, the wait survives server
  pause/restart, the workflow refuses to complete while parked, and the wait
  burns no iterations.
- The user answers from the graph workflow page (inline, reusing the existing
  question panel) or from the lane conversation view.
- On answer, the **same lane conversation** resumes via existing continuity,
  draining the `<cc-question-answers>` block and continuing exactly where the
  agent left off.
- The capability is a boolean toggle in the existing global → workflow →
  per-context config cascade, **disabled by default**.

## Approach

**Compose existing primitives (Approach ①).** Add a new cascading boolean gate
that, when enabled, lifts the server-side workflow block on `cctl ask` for
implementer and context-validator lane turns. The agent asks from within its
lane conversation turn (the conversation already transitions to
`waiting_for_input`). The execution loop detects the lane's pending question and
parks the context in a new `awaiting_user_input` status with a `pendingUserInput`
record — a near-sibling of the approval gate's `awaiting_approval` /
`pendingApproval` — which powers the graph UI, the poll-wait, SSE broadcast, and
pause/restart re-entry. The user answers through the existing answer endpoint and
question panel; the answer queues as `<cc-question-answers>` and the next
iteration resumes the same lane conversation via existing workflow continuity.

**Why this approach:** it reuses the entire async ask/answer UI, wire format,
persistence, and resume path, and mirrors the proven approval-gate wait shape —
directly satisfying `engineering-principles.md`'s mandate to reuse primitives and
push variation to the edges (a new status value + a new cascade block + lifting
one server gate), rather than forking a parallel workflow-native ask mechanism
(Approach ②, rejected as duplicative of existing UI/persistence).

**Answer delivery (decided):** answers are stored on the context's
`pendingUserInput` record (like `pendingApproval.decision`) — NOT delivered via
the lane conversation's message queue. The conversation's pending-question
marker is cleared, auto-drain never fires on lane conversations, and the
execution loop builds the resume follow-up prompt containing the
`<cc-question-answers>` block itself. This keeps the loop the sole driver of
lane turns and makes the answer payload conversation-independent (which the
context-limit rotation case requires).

## Design Invariants (agreed with Alex)

1. **Detection ordering**: the pending-question check runs after the turn
   settles and before `shouldContinueInContext` / validation evaluation — and,
   for validator turns, before verdict interpretation (a validator ask ends its
   turn with no verdict; it must not be read as a validation failure or
   increment `consecutiveFailureCount`). `PromptStreamResult` does not expose
   the pending question today; surface it on the turn result or look up the
   conversation post-turn.
2. **Parked wait is free**: no iteration seeds while parked (the asking turn's
   seed-time increment stands; the resume turn is a normal new iteration — one
   ask cycle costs exactly its two turns), no failure-count movement, no token
   consumption. The loop's completion guard refuses to finish while any context
   is `awaiting_user_input`; pause/restart re-enters the wait automatically
   (mirror the `awaiting_approval` re-queue).
3. **Answer storage**: answers persist on `pendingUserInput` (context state),
   not the lane conversation's queue; auto-drain is never fired on lane
   conversations by the answer path.
4. **Resume conversation pinning**: the resume turn reuses the asking
   conversation (pinned via `pendingUserInput.conversationId`), overriding
   continuity-disabled rotation for that one turn — but `rotateBeforeNextTurn`
   (context limit / compaction) outranks the pin: rotation wins and the answer
   block is delivered into the fresh conversation's follow-up prompt (the wire
   format embeds the question text, so the fresh lane gets Q+A plus the
   standard handoff).

## Scope

- **In**:
  - New cascading config block (single boolean, gates both implementer and
    context-validator), disabled by default; resolved at seed time in the
    existing three-tier cascade (`resolve-config.ts`).
  - Lift the `cctl ask` workflow block for implementer/validator lane turns
    **only when the resolved toggle is enabled**.
  - New `awaiting_user_input` execution-context status + `pendingUserInput`
    context-state record; parking, poll-wait, completion guard, no iteration
    burn, pause/restart re-entry (mirroring the approval gate).
  - New SSE events for user-input pending/resolved (mirroring
    approval-pending/approval-resolved).
  - Answer path wired to graph workflow contexts: graph page shows the awaiting
    state and answers inline via the existing question panel; lane conversation
    view also answers.
  - Resume the same lane conversation with the queued answer via existing
    continuity.
  - Graph UI: `awaiting-user-input` wait-state kind + node styling/badge
    (mirroring `awaiting-approval`).
- **Out**:
  - Enabling `cctl ask` for collaboration second-agents or the reserved
    `__planner__` session (both stay blocked).
  - A timeout / auto-skip mechanism (park indefinitely; no background clock).
  - Per-role toggles (one toggle covers both roles).
  - Changing the ask/answer wire format or the question panel component.
  - Enabling the capability by default.

## Boundary Candidates

- **Config cascade block** — schema additions (global/workflow/per-context) +
  seed-time resolution of the new toggle.
- **Ask-enablement gate** — the server-side decision that lifts the workflow
  block for a lane turn based on the resolved toggle.
- **Awaiting-input execution state** — context status, `pendingUserInput`
  record, park/wait/resume in the execution loop, completion guard, no-iteration
  invariant, pause/restart re-entry.
- **Answer + resume wiring** — routing the answer to the graph context and
  resuming the same lane conversation via continuity.
- **Graph UI surface** — wait-state derivation, node/badge styling, inline
  answer affordance on the graph page.

## Out of Boundary

- The generic async ask/answer conversation flow (owned by
  `conversation-message-queue`) — reused unchanged.
- The general agent capability-suppression mechanism (owned by
  `agent-capabilities-configuration`) — the new toggle plugs in; the mechanism
  itself is not redesigned.
- The orchestrator-triggered post-completion approve/reject gate (owned by
  `human-review-gate`) — its machinery is the template but is not modified.

## Upstream / Downstream

- **Upstream**: async ask/answer flow (`conversation-message-queue`), human
  approval gate (`human-review-gate`), config cascade + resolution
  (`composable-workflow-primitives`, `workflow-parameterization`,
  `global-workflow-templates`), workflow continuity (`workflow-continuity`),
  capability suppression (`agent-capabilities-configuration`).
- **Downstream**: future workflow human-in-the-loop touchpoints could reuse the
  `awaiting_user_input` state; workflow templates may expose the toggle as a
  launch-time consideration.

## Existing Spec Touchpoints

- **Extends**: none (new spec).
- **Adjacent** (reuse machinery / avoid overlapping boundaries):
  `human-review-gate` (park/resume template), `agent-invoked-collaboration`
  (agent-initiated mid-task pause analog), `agent-capabilities-configuration`
  (toggle plugs into capability cascade), `conversation-message-queue`
  (async ask/answer resume), `composable-workflow-primitives` /
  `workflow-parameterization` (config cascade).

## Constraints

- **Composability first** (`engineering-principles.md`): specify by what's new
  (a status value, a cascade block, a lifted gate), reuse `actions.ts` /
  `runtime-state.ts` / `persistence.ts`, do not fork a parallel orchestrator.
- **No iteration burn** while a context waits (matches the approval-gate
  invariant).
- **Pause/restart durability**: the awaiting-input wait must survive a server
  restart and re-enter automatically, like `awaiting_approval`.
- **Backend-agnostic gating**: enablement is decided server-side (as the current
  block is), not via per-backend prompt filtering.
- **Disabled by default**: existing workflows keep current fully-autonomous
  behavior; opt in via the cascade.
- **Type safety / schema-first** (`tech.md`, `engineering-principles.md`): Zod
  schemas as source of truth; additive, forward-compatible persistence changes
  for any new context-state field.
