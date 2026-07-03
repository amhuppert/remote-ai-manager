# AskUserQuestion — Async Redesign

Phase 3 of the [CC CLI migration](./README.md). This is the highest-risk piece of the migration:
it changes conversation-machine turn-end semantics, not just a transport.

## 1. Summary of the change

Today the agent's turn is **frozen** on a question: the MCP tool handler holds a promise open in
runtime state until the UI's answer POST resolves it. In the new design the agent **registers the
question and ends its turn**; the answer later arrives as the next turn's user message, delivered
through the existing prompt queue.

```
BEFORE (sync, in-turn)                       AFTER (async, across turns)
──────────────────────                       ───────────────────────────
agent: tool call AskUserQuestion             agent: cctl ask --file questions.json
  server: persist pending + SSE                server: persist pending + SSE
  server: HOLD PROMISE  ◄────── blocks         cli:   "Registered q_ab12. End your turn
  user answers (POST /answer)                          with a brief handoff note."
  promise resolves → tool result             agent: handoff note, turn ends
agent: continues same turn                   conversation → waitingForInput state
                                             user answers (POST /answer)
                                               server: enqueue structured answer message
                                             queue drains → NEW turn with the answer
```

Why this is the right trade (established in the exploration preceding this design):

- The held promise **does not survive a server restart**; the stale path in
  `src/lib/conversations/answer-route-handlers.ts:116-141` then *discards the user's answer*
  (HTTP 410). Async makes the pending question pure persisted state and the answer a queued
  message — restarts become non-events, answers are never dropped.
- It removes the last MCP tool, unblocking deletion of the entire `mcp-gateway` + supervisor +
  keepalive subsystem (doc 02 §6).
- Cooperative turn-ending is a **proven pattern** in this codebase: the `complete_task` rotation
  gate ships the same "end your turn now with a brief handoff note" instruction today.
- Cost is roughly neutral (both designs pay a prompt-cache miss when the user answers after the
  TTL; SDK session resume via `backendRef` → `resume:` keeps full history either way).

What is given up: in-turn continuation. An agent mid-flow must serialize intent into a handoff
note and re-orient next turn. Mitigated by prompt/skill discipline (§7); occasionally lossy for
questions asked deep inside a complex operation — accepted.

## 2. Ask path

### 2.1 CLI

`cctl ask --file questions.json` (also `--question "<text>" --option a --option b …` sugar for the
single-question case).

File payload = today's tool input, unchanged (`askQuestionItemSchema`,
`src/lib/conversations/schemas.ts:101-117`):

```json
{
  "questions": [
    {
      "id": "approach",
      "question": "Which migration order?",
      "header": "Sequencing",
      "context": "Phase 2 could land before Phase 1 if …",
      "options": [ { "label": "Phases in order", "description": "…" }, … ],
      "multiSelect": false,
      "required": true,
      "allowNote": true
    }
  ]
}
```

On success the CLI prints exactly:

```
Question batch q_<id> registered. The user has been notified.
End your turn now with a brief handoff note (what you asked, what you'll do with the answer).
The answer will arrive as your next user message.
```

This message is the motivating case of the guidance convention (doc 01 §6) but is **load-bearing
protocol, not a `hint`**: with `--json` it is returned as
`{ ok: true, questionBatchId, instruction: "End your turn now …" }` — a command-specific
`instruction` field, so agents never learn that `hint` sometimes contains something they cannot
ignore.

### 2.2 Endpoint

`POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/ask`

Validation, in order:

1. **Mode gate:** conversation must be an interactive session conversation. Autonomous task-runner
   conversations get `403 { error: "autonomous conversation — proceed with best judgment" }`. This
   replaces the tool-name pattern-match denial in
   `src/lib/agent-backends/claude/task-runner.ts:186-192` and is strictly better (server-owned,
   backend-agnostic). Lane conversations never had the tool (the `cc-graph-workflow` server doesn't
   register it) and are denied by the same check.
2. **Turn gate:** conversation status must be `running` (a turn is executing). Otherwise 409 —
   a stray `cctl ask` from outside a turn has no one to end a turn.
3. **Single-batch gate:** `pendingQuestionId` must be null, else
   `409 { error: "question batch q_x already pending" }`. One batch per conversation; batches
   already hold multiple questions, so this is not restrictive.
4. Zod-parse questions (`askQuestionItemSchema[]`), assign ids where omitted.

Effect: send the existing `ASK_QUESTION` machine event via `sendConversationEvent` (the same
external-event path the abort route uses). The machine transition already persists
`status: waiting_for_input` + `pendingQuestionId` + `pendingQuestions`, broadcasts the
`ask-question` SSE, and dispatches the push notification
(`machine.ts:531-545` → `dispatcher.ts:114-139` "Session <s> needs your input"). **No promise is
created** — `runtime.activeQuestionResolver` and the handler's held promise are deleted.

## 3. Answer path

`POST …/conversations/[conversationId]/answer` is **rewritten** (same route, new behavior):

1. Validate `body.questionId === conversation.pendingQuestionId`, else 404/409.
2. Validate answers against the existing wire format (`askQuestionAnswerSchema`,
   `schemas.ts:304-314`): per-question `{ selected: string[], note: string | null, skipped: boolean,
   question?: string }`, keyed by question id.
3. **Atomically:** clear `pendingQuestionId`/`pendingQuestions` (marks the batch consumed — this is
   the idempotency point; a duplicate POST now gets `410 "already answered or superseded"`), and
   submit the answer as a user message through the **standard prompt-submission path** — the same
   path a typed message takes, so both timing cases are handled by existing machinery:
   - turn still running → FIFO-queued (`src/lib/conversations/message-queue-service.ts`);
   - conversation idle/waiting → drained into a new turn immediately.

The answer message body is a delimited block designed to survive queue coalescing
(`coalesceContent` merges consecutive text rows into one turn input — the block must be
self-contained, not position-dependent):

```
<cc-question-answers batch="q_ab12">
{ "approach": { "selected": ["Phases in order"], "note": "but land 2.3 early", "skipped": false,
                "question": "Which migration order?" } }
</cc-question-answers>
```

The UI tags this message (metadata on the queue row) so the transcript renders it as an answer
card rather than raw text; the model reads the JSON directly.

## 4. Conversation-machine changes (the real surgery)

Verified current behavior that breaks the async design if untouched:

- `finalizingTurn` unconditionally writes `status: "awaiting"` **and `pendingQuestion: null`**
  (`src/lib/workflows/conversation/machine.ts:899-925`, clobber at :915). The agent asking and then
  ending its turn would wipe its own question.
- Queue draining happens on `idle` **entry** (`machine.ts:208`,
  `manager.ts:944-949`). A waiting state that doesn't drain would stall any user message sent
  instead of an answer.

### 4.1 Target state model

New top-level state `waitingForInput`, entered from `finalizingTurn` when a pending question
survives the turn:

```
executing ──ASK_QUESTION──► executing            (status→waiting_for_input, pendingQuestion set,
                                                  SSE + push fire — unchanged from today)
finalizingTurn ──[pendingQuestion != null]──► waitingForInput   (status stays waiting_for_input)
finalizingTurn ──[else]─────────────────────► idle              (unchanged)

waitingForInput:
  entry: drainPendingQueue                      (same action as idle)
  SUBMIT_PROMPT → running                       (claiming ANY turn clears pendingQuestion —
                                                 answer consumed it already, or a fresh user
                                                 prompt supersedes it)
```

Policy decisions pinned here:

- **Supersede-on-new-turn:** a user who types a normal message instead of answering starts a turn;
  the pending question is cleared (superseded) at turn claim, and the panel dismisses via the
  status SSE. The user choosing to redirect the agent is a legitimate override, and draining in
  `waitingForInput` is what prevents the stall.
- **Interrupt clears the question** (unchanged): `ABORT_TURN` already assigns
  `pendingQuestion: null` (`machine.ts:425-431`); in `waitingForInput` there is no turn to abort,
  but an explicit user "stop" affordance, if invoked, clears pending state the same way. Rationale:
  after a stop, the next input comes from the user anyway — the question is moot.
- The mid-turn `ANSWER` machine event and its transition (`machine.ts:552-563`) are **deleted** —
  answers are prompts now.
- `syncDerivedFields` (`manager.ts:746-755`) continues to mirror machine context to
  `ConversationState.pendingQuestionId/pendingQuestions`; the new state must be covered.

### 4.2 Rehydration

`waitingForInput` must round-trip through machine-snapshot persistence —
`rehydrateConversationActors()` restores snapshots at startup (`instrumentation.node.ts:58-75`).
A conversation asleep in `waitingForInput` across a restart must wake in it, with the panel
rendering from persisted `pendingQuestions` (already the case for reloads today). Extend the
machine snapshot contract test accordingly.

### 4.3 Semantic shift consumers must absorb

`waiting_for_input` used to mean "a turn is running but frozen"; now it means "no turn is running;
a question pends." Audit every consumer of the status:

- **Stop/interrupt affordance:** nothing to abort in `waitingForInput`; UI should show the waiting
  state without a stop control (or make stop = clear-question, per §4.1).
- **Liveness/occupancy logic** keyed on "turn active" must not count `waitingForInput`.
- **Client caches:** there are two pending-question caches on the client (known trap from the
  responsiveness sweep); both must track the new lifecycle — pending set mid-turn, surviving turn
  end, cleared on answer/supersede.
- **Push notifications:** no change — the notification fires on the ASK transition, which is
  untouched; `finalizingTurn → waitingForInput` must simply not re-fire a conflicting status push.

## 5. Edge-case matrix

| Case | Behavior |
|---|---|
| Answer arrives while asking turn still running | Pending cleared (consumed) + answer queued; turn finalizes → guard sees null → `idle` → drain starts answer turn |
| Agent ignores the end-turn instruction and keeps working | Degrades gracefully: question pends, answer queues behind the running turn. Only harmful if the agent *assumes* an answer — skill discipline (§7) |
| Second `cctl ask` while one pends | 409 from the single-batch gate; CLI prints the pending batch id |
| Duplicate answer POST (double-click) | First clears pending (consumed) → second gets 410 |
| User sends a normal message instead of answering | Drains in `waitingForInput` → turn claim supersedes/clears question → panel dismisses |
| Server restarts while question pends | State is persisted; machine rehydrates into `waitingForInput`; answer works normally. (Today: answer discarded with 410) |
| Turn aborted after ask, before turn end | `ABORT_TURN` clears pending (unchanged policy) |
| `cctl ask` when no turn is running | 409 (turn gate) — nothing would end a turn |
| Autonomous / lane conversation asks | 403 with "proceed with best judgment" text |
| Answer for archived/deleted conversation | Existing route-level 404 handling |

## 6. What gets deleted

- `runtime.activeQuestionResolver` and its type on `ConversationRuntimeState`
  (`runtime-state.ts:18-58`), the held promise + try/finally in
  `ask-user-question-tool.ts:105-186`, and eventually the whole tool file.
- `rejectActiveQuestionResolver` ceremony in the abort route (`abort-route-handlers.ts:62-65`).
- The stale-question answer-discarding path (`answer-route-handlers.ts:116-141`) — replaced by the
  consumed-marker idempotency in §3.
- The `ANSWER` machine event/transition.
- `task-runner.ts:186-192` name-based denial (superseded by the endpoint mode gate).

## 7. Skill / prompt contract

The `cc-cli` skill section for `ask` must teach, explicitly:

- Ask **only at real forks**; batch related questions into one call (one batch pends at a time).
- After `cctl ask` succeeds: write a brief handoff note (what was asked, what you will do with each
  possible answer), then **end the turn**. Do not start new work.
- If the CLI returns 409 "already pending": you asked already — end your turn.
- The answer arrives as a `<cc-question-answers>` block in your next user message; `skipped: true`
  means the user declined that question — proceed with best judgment.

## 8. Rollout

Ships inside Phase 3 as one atomic change (endpoint + machine change + answer-route rewrite + tool
deregistration); rollback is a revert. No dual mode: maintaining resolver and async paths
simultaneously would double the state-machine surface for no user benefit.

## 9. Verification plan

- **Unit (TDD):** machine transition tests for `finalizingTurn` guard, `waitingForInput` drain,
  supersede-on-claim, abort-clears; snapshot rehydration contract test; answer-route tests on the
  real-store persistence fixture (consumed-marker idempotency; answer survives
  restart-simulating reload).
- **CLI contract tests:** `ask` happy path, 409 turn gate, 409 single-batch, 403 autonomous.
- **Live (`cc-live-feature-test`), mandatory before GO — this class of change has historically only
  broken live:**
  1. Real session: agent asks via `cctl ask` → phone push received → panel renders → answer from UI
     → new turn continues with the answer block.
  2. Restart the server while the question pends → answer still delivers, new turn resumes the SDK
     session (`backendRef`).
  3. Send a normal message instead of answering → turn starts, panel dismisses, no stall.
  4. Answer while the asking turn is still streaming → answer turn follows immediately after
     finalize.
