# One machinery: Conversation, Execution Context, Run

Design proposal by Claude, 2026-10-02. It answers the notepad "Reimagined graph workflows" at revision 338 and the session Alignment charter. It is a design only; nothing here is implemented.

I wrote it without reading any other proposal for this work. The evidence comes from the code on branch `csm/graph-workflow-overhaul-ea4e4d`. File references were collected by research passes over the code and spot-checked; treat a line number as a pointer, not a proof. A separate reviewer then checked the draft against the code and the notepad, and its accepted findings are folded in.

Markers: no marker means the notepad already decided it. **(proposed)** means it is my recommendation and needs Alex's confirmation. Section 12 lists every such item in one place.

## 1. The result in one page

Three modules. Each hides one thing.

1. **Conversation** hides how an agent turn happens. Every input to every agent is a durable message, and `send` is the only way in. One delivery loop per conversation turns messages into turns. Nothing dispatches a turn directly. "Busy" stops being an error, and single-flight stops being a rule that five layers each enforce.
2. **Execution context** hides the certification protocol. It is a supervisor built around one pure function, `decide(state, facts)`, which names the next step: send the work order, restate what remains, open a validation round, ask for approval, halt. It talks to its implementer and validators only through the conversation contract.
3. **Run** hides everything between contexts: dependencies, routes, loops, edits, lanes, and what the owner is told. A run holds one or more contexts. `cctl agent` launches a run with one context. `cctl workflow` launches a run with several. They are the same record and the same code path.

Seven choices carry most of the simplification:

| # | Choice | What it removes | The principle behind it |
|---|---|---|---|
| 1 | `send` is the only way into a conversation | The `busy` refusal, the split between direct submit and queue, `waitUntilReady`, the second turn pipeline inside the core, ephemeral conversations | Define the error out of existence: a busy recipient is the ordinary case |
| 2 | Policy is set when a conversation is spawned, not on each turn | Seven ways to say "who drives this turn", and every role branch in the core | Keep the mechanism general and put policy with its owner, the spawner |
| 3 | Every conversation has a principal: the user, or its owner | The lane divert for questions, the user-input gate, the second-opinion machinery, and the open question about unsolicited messages | One somewhat general concept in place of three special ones |
| 4 | Supervisors are restartable loops over a pure `decide` | The loop fence, loop epochs, the staged prepare/finalize seam, in-memory retry counters, restart normalization | Make restart an ordinary pass through the loop, not an exception path |
| 5 | One owner-facing unit, the Run, with one record per context run | One active execution per session, the single halt slot, the second lifecycle for `cctl agent` | A single context is not a special case |
| 6 | The definition of a launched run never changes shape on its own | Loop unrolling, expansion, and 17 live-edit operations with their frontier checks | Each decision has one owner; state changes, structure does not |
| 7 | The session branch is the only integration point | Lane-to-lane joins, final publish, validation debt, landing intents and their crash replay | One fact that makes every lane rule derivable |

What is deleted, or replaced by something much smaller, with today's production line counts: structural mutation (about 7,300), plan repair (2,431), runtime expansion (2,214), loops as unrolled graph structure (about 3,100), the user-input gate (1,066), the builder (6,900), the planner (695), graph-bound spec delivery (about 12,000 on the spec side), `agent-runs` (1,269), and the two engine hosts (`execution-loop.ts` 3,581 and `workflow-manager.ts` 3,306).

What is new work, stated as plainly: the conversation core is rewritten; the subscriptions domain gains an owner mode, peer messages and reply waits (section 8.3); and lane publication needs a wrapper around the merge machine (section 7.7).

What I need from Alex is in section 12. The three that shape the most code are: whether `cctl agent` may be a run with one context underneath (12.1), whether questions from a spawned conversation go to its owner (12.4), and the migration order (section 13).

## 2. Operating envelope and assumptions

Source: `ENVELOPE.md` and the operating model in `AGENTS.md`.

- One operator, one machine at a time, one Next.js server process, one SQLite file. Agents act on Alex's behalf and are trusted. They can be mistaken; they are not hostile.
- Many conversations, runs and child processes run at once in that one process. Several writers share git worktrees.
- The server is restarted by rebuilds while conversations and runs are in flight. State outlives every build.
- A failure costs Alex's time, worktree state and API spend. Alex reads the logs and can retry.

What follows from that for this design:

- **In-process serialization plus one revision check per record is enough.** Build workers and older branches may open the database, but only one live server drives it. The existing runtime-owner claim at boot refuses a second one, and it is kept. So there are no cross-process leases, fencing tokens or distributed locks in this design.
- **Every long-lived loop must restart from durable state.** Restarts are inside the envelope, so this is not optional.
- **Bounded retries only.** A context retries inside its attempt budget. Nothing retries with backoff. Everything else halts with a message that says what to do.
- **Restrictions are coordination.** Write envelopes and strict output parsing stay because mistaken agents and unreliable model output are inside the envelope. Conversation identity stays an unsigned claim because a forging agent is outside it.
- **Lane worktrees are disposable; the session worktree is not.** The engine may reset a lane it created. It never commits, stashes or reverts work in the session worktree.
- **First version means smallest slice.** Section 13 orders the work so that each stage reaches a real `cctl` verb.

Assumptions:

- The decisions in notepad revision 338 are final: bounded routes, finite non-nested loops, revision-checked edits to future work, closed isolated lanes, no runtime expansion, second opinions through the owner.
- Collaboration mode and the merge and commit machines keep their code and their behaviour. Section 5.8 says what they need from the new core.
- The Smart Merge machine is used as it is. Its contract constrains lane publication (section 7.7).

## 3. What the code shows today

This section is the case for the design. Each finding is something a developer has to know or repeat today.

### 3.1 The conversation core is already shared, but by flags

Interactive and workflow callers use the same XState actor behind `src/lib/workflows/conversation/lifecycle.ts`. The sharing is done with per-turn flags and role checks.

| Finding | Evidence |
|---|---|
| Two ways in. An idle conversation takes a turn through `submitConversationTurn`. A busy one takes a row in the `pending_queue` JSON column, which a drain later turns into a turn. Programmatic callers use a third, `executeConversationTurn`, and get `busy` or wait. | `prompt/sdk-driver.ts:623`, `prompt/queue-operations.ts`, `conversation/manager.ts:1108-1565` |
| Single-flight is enforced in five layers. The graph loop also takes the conversation lock itself. | route probe `prompt/route-handlers.ts:414`, manager reservation `manager.ts:1228`, actor lock `actor-implementations.ts:453`, machine topology, durable owner `conversations/ownership.ts:53`; `workflow-graph/execution-loop.ts:1668` |
| Two turn pipelines. `task_run` closes the hosted runtime, starts a task runner on the same continuation, skips session instructions and writes the transcript differently. | `actor-implementations.ts:528-1955` and `1995-2333` |
| "Who drives this turn" has seven encodings: `role`, `owner`, `autonomous`, `inputOrigin`, `workflowContext`, envelope presence, turn `kind`. Each consumer reads a different subset. | `turn-spec.ts`, `machine.ts:229-235,681-686`, `actor-host.ts:290-298`, `turn-context.ts:215-219` |
| Fields set by exactly one caller ride on every turn: `fsWritePolicy`, `waitForBackgroundTasks`, `askUserQuestionsEnabled`, `structuredOutputTextField`, `origin`. | `turn-spec.ts:59-213` |
| Questions have three mechanisms that share one marker: `cctl ask`, in-turn tool questions, and graph lane answers recorded on the execution record. | `conversations/answer-route-handlers.ts:262-418`, `in-turn-questions.ts` |
| Workflow lanes are excluded from the queue, from subscriptions and from wakes. Recipient eligibility is decided in five places. | `queue-operations.ts:194`, `conversations/provenance.ts:46-58`, `subscriptions/route-handlers.ts:165` |
| The core reads the active graph execution on every session turn to look for validator instructions. | `conversation/runtime-instructions.ts:161-167` |
| `cctl agent run` is not a conversation at all. It is a task run with no CC identity, and its record has no link to the conversation that started it. Nothing can wake the caller when it ends. | `agent-runs/service.ts:372-399`, `agent-runs/schemas.ts:87-101` |

Checkpoint maintenance is 52 percent of `manager.ts`. That is real function, not accidental complexity. It stays, and section 5.5 says where it plugs in.

### 3.2 The graph engine ties every context to the whole graph

| Finding | Evidence |
|---|---|
| One execution blob per session, enforced by `PRIMARY KEY (project_path, session_name)`. An orchestrator cannot run two things at once. | `state-store/state-db.ts:2887-2909` |
| One halt slot serves the whole execution. A sibling's halt stops this context at its next turn boundary. | `iteration-orchestrator.ts:1623-1646`, `workflow-manager.ts:2802-2807` |
| Running one context reads lane, sibling or graph state in 14 places, down to embedding every downstream context's criteria in validator prompts. | `prompt-composer.ts:28-124`, `execution-target-resolver.ts`, `context-landing.ts:462-470` |
| A validator's question exists in three stores, reconciled in one direction only. | conversation marker, `pendingUserInputs`, `validationRound.specialists[].questionToken`; `user-input-gate.ts` |
| 25 halt kinds, three tables keyed by halt kind, and verb admission spelled as inline status arrays in the manager and two private sets. | `lifecycle-classifier.ts:204-248`, `plan-repair/trigger.ts:152`, `reset-context.ts:24` |
| The context's task list lives in the workflow definition, so a rejected approval and a failed script gate each push tasks into `workingDefinition.tasks` outside the one mutation path steering names. | `approval-gate.ts:388-431`, `context-validation-coordinator.ts:607-679` |
| A human approval is not bound to what was approved. Drift is shown on read; the resolve call checks nothing. | `approval-gate.ts:254-275`, `approval-snapshot.ts:140-147` |

### 3.3 Most between-context code serves generality the vision drops

| Area | Lines today | Why it is this size |
|---|---|---|
| Structural mutation | about 7,300 | 17 live operations. A third of `runtime-edits.ts` is concurrency: the prepare/finalize pair and the revision counters it needs. Only expansion and loop unrolling use the staged pair. |
| Loops | about 2,640, plus 470 in edits | A loop pass is unrolled into the working definition as new contexts with reserved ids, template versions and a slot ledger. |
| Placement and lanes | about 5,100 | A reserve, provision, finalize protocol with owner-stamped reservations, because schedulers from two loop generations can overlap around pause and resume. |
| Joins | about 1,880, plus about 640 in the loop and the transition code | Lane-to-lane merges, eager against quiescent scheduling, final-publish supersession, validation debt. |
| Envelope and landing | about 2,670 | Landing intents with commit trailers and branch probes, to replay a commit after a crash. |
| Routes | about 2,670 | The pure projection is 830 lines and worth keeping. The rest replays settlements after edits and restarts. |
| Expansion | 2,214 | Deleted by decision. |
| Plan repair | 2,431 | Deleted by decision. |

Three more facts matter for the design:

- **A one-context write workflow cannot run in the session worktree.** The authored `session` lane admits read-only members only, so the smallest write workflow provisions a worktree and runs a final-publish merge (`placement-validation.ts:113-131`).
- **The owner is not told.** A launch creates a passive follow. To be woken the agent must register `cctl subscription wait workflow <id>` itself, and only terminal status wakes it. Approval, question and pause boundaries never do (`subscriptions/workflow-source.ts:182-207`).
- **Code and steering have drifted apart in at least eight places** in the lane and edit code, including a second write path that steering says does not exist. That is what unknown unknowns look like.

## 4. The model

```
   user (UI, cctl)          peers            subscription sources
        │                     │                      │
        ▼                     ▼                      ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ Layer 1   CONVERSATION                                       │
 │   send ─► mailbox ─► one delivery loop ─► one turn pipeline  │
 │   settlement log · status · open request · runtime           │
 └───────▲───────────────────────────────────┬──────────────────┘
         │ spawn · send · stop               │ settlements
 ┌───────┴───────────────────────────────────▼──────────────────┐
 │ Layer 2   EXECUTION CONTEXT  (supervisor, one per context run)│
 │   decide(state, facts) ─► next step                          │
 │   tasks · attempts · certification · approval                │
 └───────▲───────────────────────────────────┬──────────────────┘
         │ start · stop · resume · amend     │ outcome
 ┌───────┴───────────────────────────────────▼──────────────────┐
 │ Layer 3   RUN                                                │
 │   schedule · routes · loops · edits · lanes · boundaries     │
 └───────┬──────────────────────────────────────────────────────┘
         │ boundaries, through the subscription inbox
         ▼
   owner conversation (interactive)
```

### 4.1 Vocabulary

- **Conversation** — one agent's durable dialogue: record, transcript, mailbox, and a backend runtime while it has work.
- **Principal** — who a conversation answers to. The user, for an interactive conversation. Its owner conversation, for a workflow conversation. The user can act as principal of any conversation.
- **Message** — the only input to a conversation. It has a sender. A **turn** message starts a turn. An **attached** message is quoted context that rides along with a later turn.
- **Settlement** — the durable outcome of consuming a message: a turn, or a slash command.
- **Slot** — the right to use a conversation. One thing holds it at a time: a turn, or a **hold** taken by something that is not a turn.
- **Execution context** — a contract: brief, tasks, acceptance criteria, validators, placement, policy.
- **Context run** — one execution of a contract by one implementer conversation and its validator conversations.
- **Run** — what an owner launches and repairs. One or more contexts and the structure between them. The notepad calls layer 3 "Workflow". I call the launched thing a run, because an agent run and a workflow run are the same thing; "workflow" stays the word for a run with several contexts.
- **Boundary** — a point where a run finishes or needs its owner or the human.
- **Workspace** — where a context run works: a repository directory, a write scope, and a way to identify and land the result.
- **Lane** — an isolated worktree and branch that a closed group of contexts shares.

### 4.2 Who owns which decision

The charter requires one owner per decision. Module names are proposals; the ownership is the point.

| Decision | Owner |
|---|---|
| Which input a conversation takes next, and that only one thing uses it at a time | `conversations/actor.ts` |
| Whether a message starts a turn, is attached, or is refused | `conversations/actor.ts` (delivery rules, section 5.3) |
| How followed sources and peer messages reach an interactive conversation: batching, limits, receipts | `subscriptions/` (existing, with the additions in section 8.3) |
| What a turn's input contains | `conversations/turn/input.ts` |
| What "waiting" means, and who may answer | `conversations/actor.ts` (open request) |
| Runtime create, reuse, recreate, release | `conversations/turn/runtime.ts` |
| How many turns run at once, and who goes first | `conversations/actor.ts`, over the existing query semaphore |
| Structured-output sequence, gate and repair | `workflows/primitives/agent-call-facade.ts` (unchanged) |
| The context protocol: attempt charging, certification order, verdict folding, halts | `execution-context/protocol.ts` (`decide`) |
| Task ledger and the task verbs | `execution-context/tasks.ts` |
| Verdict schemas by authority | `execution-context/validation.ts` |
| What a scope may write, the identity of a candidate's files, who may write where at once | `workflow/workspaces.ts`. The conversation core carries the composed policy to the backend and never interprets it. |
| Lane fork, landing commit, closure, publication | `workflow/lanes.ts`, with the Smart Merge machine doing the merge |
| Route semantics | `workflow/routes.ts` (today's `route-projection.ts`, carried over) |
| Guard and predicate evaluation | `workflows/primitives/output-schema-subset.ts` (unchanged) |
| Loop pass decisions | `workflow/loops.ts` |
| Which context starts next, and when a run is finished or blocked | `workflow/schedule.ts` |
| Every change to a launched run's definition | `workflow/edits.ts` (one function) |
| Accept-time validity of a definition, and default resolution | `workflow/definition.ts` |
| Run lifecycle verbs and who may call them | `workflow/runs.ts` |
| What the owner is told | `workflow/boundaries.ts` (the ledger) |

### 4.3 Records

Each record has one writing module and one revision. A write states the revision it read; a stale write fails. That, plus one registered loop per record in the process, is the whole concurrency story.

| Record | Key | Written by | Holds |
|---|---|---|---|
| `conversations` (existing, extended) | conversation id | conversation core | Spawn attributes, principal, status, hold, totals |
| `conversation_messages` (replaces the `pending_queue` JSON column) | message id | conversation core | Sender, body, `replyTo`, `expect`, turn or attached, delivery state, the settlement that consumed it |
| `conversation_turns` | conversation id, sequence | conversation core | One settlement per consumed message batch |
| `runs` | run id | run layer | Owner, frozen definition, scheduling state, revision |
| `context_runs` | context run id | supervisor | Run id, context id, pass, frozen contract, protocol state, revision |
| `run_boundaries` | run id, sequence | run layer | Kind and frozen payload |

Workspace admission is not a record. It is derived from the context runs that have started and not finished, and from the lanes that have not published.

## 5. Layer 1: Conversation

### 5.1 The contract

```ts
/**
 * A Conversation is one agent's durable dialogue. Every agent with a history is
 * a conversation. A one-shot model call with no history is not one; it goes
 * through the AgentCall task path.
 *
 * Callers never start, queue, retry or serialize turns. They send messages and
 * read settlements. One thing uses a conversation at a time, and that is this
 * module's concern alone.
 */
interface Conversations {
  /**
   * Create a conversation. The record is durable before this returns.
   * No turn runs until a message arrives.
   */
  spawn(spec: ConversationSpec): Promise<ConversationAddress>;

  /**
   * Deliver a message. The message is durable before this returns. The call
   * never waits for the recipient and never fails because the recipient is busy.
   * A message with an id that was already sent is accepted again without effect.
   * Throws only when the recipient does not exist, is archived, or refuses this
   * sender (see delivery rules).
   */
  send(to: ConversationAddress, message: Message): Promise<SendReceipt>;

  /** Take back a message that no turn has consumed yet. False if it is too late. */
  withdraw(messageId: MessageId): Promise<boolean>;

  /**
   * Convenience for callers that need one answer: send, then return the
   * settlement of the turn that consumed the message. Aborting the signal
   * cancels that turn and leaves the conversation as it was, with no hold.
   */
  request(to: ConversationAddress, message: Message, signal: AbortSignal): Promise<Settlement>;

  /**
   * Cancel the running turn, if any, and hold the mailbox: pending messages are
   * kept, and no turn starts until `resume` is called or the user sends a new
   * message. Resolves after the turn has settled and the runtime is closed.
   */
  stop(address: ConversationAddress, reason: string): Promise<void>;

  /** Release a hold left by `stop`. Pending messages are delivered in order. */
  resume(address: ConversationAddress): Promise<void>;

  /**
   * Take the slot for work that is not a turn: a checkpoint, a collaboration
   * run, a side task. Resolves when the slot is free. Messages keep arriving and
   * wait. The hold is durable and names its holder, so the holder can reclaim it
   * after a restart. The holder ends it with `hold.release()`.
   */
  hold(address: ConversationAddress, holder: HolderRef): Promise<Hold>;

  /** Status, open request, current hold, usage totals, sequence of the last settlement. */
  read(address: ConversationAddress): Promise<ConversationView>;

  /**
   * The ordered, durable log of outcomes. `after` is a settlement sequence
   * number. Safe to call again after a restart: it returns what was recorded.
   */
  settlements(address: ConversationAddress, after: number): Promise<Settlement[]>;

  /** Resolves when a settlement newer than `after` exists. */
  nextSettlement(address: ConversationAddress, after: number, signal: AbortSignal): Promise<Settlement>;

  /**
   * Live events of this conversation's turns, for a UI. Not durable: a late
   * subscriber misses what came before. The durable facts are the transcript
   * and the settlements.
   */
  watch(address: ConversationAddress, listener: (event: TurnEvent) => void): Unsubscribe;
}
```

These are the notepad's five operations. Address is the `ConversationAddress` type (today's `ConversationTarget` with its project). Observe is `read`, `settlements`, `nextSettlement` and `watch` for code, and boundaries in the inbox for an owning conversation (section 8). `resume` is the inverse of stop, `withdraw` is today's cancel of a queued message, `request` is a convenience, and `hold` serves the callers in section 5.8.

```ts
interface Message {
  id?: MessageId;                 // supplied by callers that must be idempotent
  from: Sender;                   // user | owner | peer conversation | system feature | subscription
  body: MessageBody;              // text, images, feedback blocks, question answers, a slash command
  replyTo?: MessageId;            // this message answers that one
  awaitReply?: { expiresInSeconds?: number };   // the sender wants an answer
  expect?: { outputSchema: JsonSchema; mode?: "work_then_format" | "single" };
  modelSelection?: BackendModelSelection;       // per-turn override from the composer
}

type SendReceipt = { messageId: MessageId; disposition: "turn" | "attached" };

interface Settlement {
  seq: number;                                   // per conversation, no gaps
  via: "turn" | "command" | "external";          // a model turn, a slash command, or a provider-initiated continuation
  messageIds: MessageId[];                       // every message it consumed, including ones delivered mid-turn
  outcome: "completed" | "failed" | "stopped";
  waitingOn: null | { kind: "question" | "reply"; requestId: MessageId };
  text: string | null;
  structuredOutput?: unknown;                    // present when the message carried `expect` and the gate passed
  failure?: { kind: FailureKind; retryable: boolean; retryAfterHint?: string; message: string };
  usage: UsageMetrics;
}
```

Status is one of `idle`, `running`, `waiting`, `stopped`. It is derived from the slot, the open request and the stop flag. `waiting` means the last turn ended with an open request: a question to the principal, or a message the conversation is waiting to have answered.

### 5.2 What is fixed at spawn

Everything that today rides on a turn because one caller needs it becomes an attribute of the conversation, set once by whoever spawns it.

```ts
interface ConversationSpec {
  scope: { projectPath: string; sessionName?: string };
  principal: { kind: "user" } | { kind: "owner"; conversation: ConversationAddress; contextRun: ContextRunId; seat: "implementer" | { validator: string } };
  profile: AgentProfileRef;                    // resolved to a snapshot at spawn, as today
  runtime: { backend: AgentBackendId; modelSelection: BackendModelSelection };
  instructions?: string;                       // the spawner's role contract, rendered before the profile block
  workingDirectory: string;                    // defaults to the session worktree
  writeGrade: "readOnly" | "owned" | "full";   // what it is, for display and for rules
  writePolicy?: FsWritePolicy;                 // composed by the workspace; the core passes it to the backend unread
  capabilities: {
    ask: boolean;                              // may ask its principal
    spawn: boolean;                            // false for every conversation whose principal is an owner
    subscriptions: boolean;                    // may follow sources; false for workflow conversations
    memory: { read: "off" | "linked-only" | "ambient"; contribute: boolean };
    validationCommands: CommandSelector;       // which registered commands it may run
  };
  peers: "wake" | "attach" | "refuse";         // what a message from a non-principal does (section 5.3)
  holdTurnForBackgroundTasks: boolean;
}
```

`principal.kind` is the only thing that separates the two kinds of conversation. `user` is an interactive conversation. `owner` is a workflow conversation. The core never branches on a role name; it reads these attributes.

The turn pipeline reads the same attributes for both kinds. So a change to the pipeline reaches both, which is the first success measure.

### 5.3 Delivery rules

`send` is the one entry. What happens to a message is decided in one place, by sender and recipient:

| Message | Interactive conversation | Implementer | Validator |
|---|---|---|---|
| From the user | turn | turn | turn |
| From its owner, or the supervisor acting for the owner | — | turn | turn |
| An answer to its question | turn | turn | turn |
| A reply to a message it awaits | a wake, through its wait (section 5.4) | turn | turn |
| A peer request (the sender awaits a reply) | a wake, under the existing limits | attached | refused |
| A peer note | attached to the next user message | attached | refused |
| A followed subscription source | as the subscription's mode says | not a recipient | not a recipient |

Order among turn messages: answers and human messages first, then owner and supervisor messages, then wakes. This is today's rule that human input outranks wake rows.

One turn consumes one turn message, or one batch that the existing rules allow to share a turn. A human message may be delivered into the running turn when the backend accepts live input, as today; the actor does this itself, and the settlement lists that message too. Everything else waits for the turn boundary.

**Two stores, one decision.** The actor decides the disposition. Where the message then lives follows from the recipient:

- A workflow conversation's messages, turn and attached, live in its mailbox. Attached messages are claimed with the next turn its principal starts and rendered as quoted context. A workflow conversation is not a subscription recipient, and this does not make it one.
- An interactive conversation's turn messages live in its mailbox. What it follows lives in the subscription inbox, as today, and inbound peer messages join it there as occurrences of a `conversation` source. That reuses the briefing, the wake batches and their limits, the receipts and `cctl inbox`. Section 8.3 lists what the subscriptions domain must gain.

**This answers open item 3 (proposed).** An unsolicited message never starts a turn in a workflow conversation. An implementer sees it as quoted context the next time its principal gives it a turn. A validator never sees it, and the sender is told so by a typed refusal instead of a silent drop. A validator's inputs stay under the supervisor's control, which is what makes its verdict worth having.

For an interactive recipient, a peer request wakes it and a peer note waits for the user. The wake goes through the existing wake batches: at most one unresolved batch per conversation, at most three new batches a minute, six items a batch, held while a question, checkpoint or approval is pending.

An address names a conversation by id within the project. A sender in one session reaches a conversation in another with the same call; the existing lookup by id resolves the scope. Messaging needs no ownership.

### 5.4 Principal, questions and replies

`cctl ask` asks the principal.

- In an interactive conversation the principal is the user. This is today's flow.
- In a workflow conversation the principal is the owner conversation. The question becomes a boundary of the run and wakes the owner (section 8.2). The owner answers from what it knows, or relays the question to the user with its own `cctl ask`. The user can also answer directly in the UI, because the user can act as principal anywhere. The first answer wins. **(proposed, section 12.4)**

A second opinion is the same thing with a different payload: the implementer sends its owner a message with `awaitReply`. The notepad already settled that.

The core owns the open request. A conversation that ends a turn with an open question or an awaited reply is `waiting`. There is one answer route. The supervisor does not keep a copy of the question; it reads `waitingOn` from the settlement and charges nothing while the conversation waits.

How an awaited reply comes back depends on who is waiting:

- **An interactive sender** waits through the existing subscription waits, as the notepad says: a finite wait on the message, default 24 hours, and the reply or the expiry wakes it. Waits cover workflow, validation and git-job sources today; this adds the awaited message as a fourth.
- **A workflow conversation** is not a subscription recipient. Its reply arrives in its mailbox as a turn message, and its supervisor parks the context meanwhile. This is a small step beyond the notepad's wording, which speaks only of subscription waits. **(proposed)**

In-turn tool questions (the backend's native ask) stay as they are: an in-memory reply inside the turn. They use the same answer route, which resolves the promise when the turn is still open.

### 5.5 One delivery loop, one pipeline

Per conversation the core runs one loop:

```
loop:
  wait until the slot is free and a deliverable turn message exists
  wait for a query slot                       // capacity, section 5.7. Waiting is not a failure.
  claim the message(s) under an attempt id
  run the turn pipeline, or run the slash command
  write the settlement, release both slots
```

The slot is granted to one thing at a time: a turn, a slash command, a provider-initiated continuation ("external turn"), or a hold. Checkpoints, compaction capture and collaboration's claim on its originating conversation are holds. Messages keep arriving while the slot is held; they are never refused by the core.

A slash command (`/commit`, `/merge`, `/align`, `/ticket` and the rest) is a message the core consumes by running the command, not a model turn. It still produces a settlement, with `via: "command"`.

There is one turn pipeline inside the core:

- A request from the new engine to a conversation it supervises (a review request, an output request) is a message with `expect`. It runs on the hosted runtime with the conversation's normal instructions. It does not close the runtime and rebuild the request prefix, so it keeps the provider's prompt cache. The existing note on output capture explains why that matters.
- **Side tasks keep their path.** Today commit and merge messages, ticket generation, conflict resolution and validation fixes run a `task_run` on the user's conversation: their own instructions, their own tooling, their own timeout and cancel. Those features are out of scope and must not change behaviour. So they take a `hold`, run through the unchanged AgentCall task path against the conversation's continuation, record the result, and release. The second pipeline leaves the core; it does not disappear until those features move to `request()`.
- Work that needs a model call but not a conversation's own context calls the AgentCall task path directly, as naming and ticket enrichment do today. Compaction and checkpoint generation run today on throwaway ephemeral conversations; they become such calls. They must still take a query slot, which the host does for them today.

The pipeline's steps are today's, in today's order: resolve the model, assemble input, bind the runtime, apply tooling, dispatch through the AgentCall facade, write transcript and settlement, record acceptance receipts. What changes is that each step reads spawn attributes and the message's sender instead of flags. For example, the passive briefing step runs for "a turn started by the user in an interactive conversation", and alignment eligibility reads the session's creation mode and the sender.

The prompt route keeps its shape. It sends the user's message and uses `watch` to stream the turn that consumes it to the browser. Streaming is observation of a turn, not a second way to start one.

**XState (my recommendation, not part of the contract).** The loop has four statuses and one slot. A plain async loop with a persisted status is enough, and it is easier to follow than a statechart with a manager in front of it. The charter only requires that the contract hide the choice. It does.

### 5.6 Stop and restart

- **Stop** cancels the turn, closes the runtime and sets `stopped`. Pending messages stay in the mailbox. `resume`, or a new message from the user, clears it. A message from an owner agent does not; it waits.
  - The user's Stop button keeps today's behaviour: the turn is cancelled and the messages the user had queued are delivered next. That is `stop` followed by `resume`, and the route decides it, not the core.
  - A supervisor that pauses a context stops its conversations and withdraws its own pending messages. It sends a fresh one on resume. An answer that arrives while the context is paused waits in the mailbox.
  - The Stop button on a workflow conversation's view should pause its context, because cancelling one turn of a supervised conversation only makes the supervisor send the next message.
- **Restart.** At boot the core records a `failed` settlement with kind `interrupted` and `retryable: true` for every turn that has no settlement. A message that was claimed but has no acceptance receipt becomes `uncertain`, as today. What happens next depends on who sent it: a user message waits for the user's retry or discard, and blocks new prompts until then, as today; a supervisor message is superseded, because the supervisor will send a fresh one (section 6.3).

### 5.7 Identity and capacity

- Every conversation gets `CC_CONVERSATION_ID` and its scope in its environment. The server derives everything else from the record: principal, context run, seat, working directory. `CC_WORKFLOW_EXECUTION_ID`, `CC_WORKFLOW_CONTEXT_ID` and the separate lane identity header go away. Commands that act on "my worktree", such as validation and dev servers, resolve it from the conversation's recorded working directory instead of those two variables. Verification stays a membership check, which fits the envelope.
- **Capacity.** The existing query semaphore is one global limit on concurrent turns, default 2, first come first served, with a five-minute timeout that fails the waiter. The graph loop sizes its dispatch to it today. In the new core the delivery loop takes a query slot before it claims a message and waits without a timeout: a turn that has not started cannot fail. Human-sent messages get the next free slot ahead of engine-sent ones. The run scheduler keeps no capacity ledger of its own.
- **One hazard to know.** An owner whose turn blocks in `cctl agent run --wait` keeps its query slot. If the limit is not larger than the number of owners waiting that way, their children cannot start. Launching and ending the turn holds no slot. The planning skill should prefer that for anything parallel. If starvation shows up in practice, the fix is to lend the owner's slot while it blocks in a wait call.

### 5.8 What the out-of-scope code needs

Collaboration, merge, commit and validation-fix keep their code and their behaviour. What they need from the new core, when interactive conversations move to it at stage 5:

| Today | New |
|---|---|
| `executeWorkflowTaskRun` on a user conversation (commit and merge messages, conflict resolution, validation fix; also ticket generation) | The same task path, run under `hold` (section 5.5). Same instructions, tooling, timeout and cancel. |
| `releaseIdleConversationRuntime` (collaboration) | A `releaseRuntime(address)` operation that does the same |
| The collaboration owner lock on `ConversationState.owner`, with its reclaim after restart | A durable `hold` with the same holder identity and attempt epoch. The field is renamed; it collides with the new meaning of owner. |
| The prompt route refuses a prompt while a collaboration holds the conversation | The route keeps refusing. It reads the hold from `read()`. The core itself would queue. |
| Collaboration appends to the transcript and updates counters itself | Unchanged; those modules are not part of the rewrite |
| The alignment rule that gives a user-started collaboration run the session charter | Carried into the new input assembly as it is |

`executeFreshTaskRun` and collaboration's own runtime hosting sit on the AgentCall facade and do not change.

Three things outside the conversation core also touch out-of-scope code when the graph engine is deleted at stage 4:

- Two schema files that collaboration and validation-fix import from `workflow-graph/` move to their consumers.
- The merge machine's session-merge admission is re-pointed (section 10).
- Second opinions from a lane used collaboration through `workflow-collaborator-caller.ts`. That caller is deleted; collaboration mode itself is untouched.

### 5.9 Alternatives considered

**A. Keep the two entries: direct dispatch for code, queue for people.** This is today's shape. The supervisor would handle `busy` whenever a person types into an implementer, and admission would stay in two implementations that must agree. It also keeps `waitUntilReady`, which today waits without a timeout. Rejected: it keeps the error that `send` defines away.

**B. `send` only (chosen).** The price is that a caller wanting a result must correlate a settlement to a message. `request()` hides that for the common case. The gain is that restart recovery for supervisors becomes "read the log from my cursor".

**C. A separate, simpler core for workflow conversations.** Cheaper to build first. Rejected as an end state because it is two machineries, which the deciding goal rules out. Section 13 does use a temporary partition during migration.

### 5.10 Edge cases left unhandled

- Two agents that keep sending each other requests can keep waking each other. The existing limit of three wake batches a minute bounds the rate, not the total. The messages are visible in the inbox.
- A person typing into an implementer during validation moves the candidate. The supervisor notices through the candidate identity and validates again. It does not prevent the typing.
- A project conversation has no session worktree. It cannot own runs in the first version, as it cannot launch workflows today.
- An interactive conversation with a pending question to the user is not woken, as today. An owner that relays a sub-agent's question to the user therefore receives no other boundary until the user answers. The runs keep going; their boundaries wait.

## 6. Layer 2: Execution context

### 6.1 The contract

One schema. `cctl agent run` takes exactly this object, without `dependsOn`. A workflow file is a list of them.

```jsonc
{
  "id": "limiter-core",
  "brief": "Add a token-bucket limiter under src/lib/rate-limit. Out of scope: wiring routes.",
  "tasks": [
    { "id": "build", "title": "Implement the limiter", "instructions": "..." },
    { "id": "tests", "title": "Cover refill and burst", "instructions": "..." }
  ],
  "allowTaskAdd": false,
  "acceptanceCriteria": [{ "id": "limits-per-key", "statement": "..." }],
  "implementer": { "profile": "builtin:general-implementer", "agent": { "backend": "claude", "modelSelection": { "...": "..." } } },
  "validators": {
    "script": ["typecheck", "test"],
    "agents": [{ "id": "ac", "profile": "builtin:general-reviewer", "authority": "blocking", "agent": { "...": "..." } }]
  },
  "approval": false,
  "retry": { "maxAttempts": 3 },
  "outputSchema": { "...": "..." },
  "placement": { "write": "full" },
  "capabilities": { "implementer": { "ask": true } }
}
```

Only `brief` is required. Everything else has a default from the cascade (section 7.8). An optional `workingDirectory` inside the workspace is carried over from today's agent runs.

With no `tasks`, a turn that ends is done. With no `outputSchema`, the result carries the implementer's final message and the task summaries, and no extra turn is spent. Today's one-shot returns a `{ summary, referenceDocuments }` envelope because it has no CC identity and cannot register documents. A spawned conversation has an identity and registers its own with `cctl docs register`, so that envelope goes away. Today's per-run `timeoutMs` goes away too; the stall watchdog and the owner's `stop` cover it.

Tasks are nested in the context and live in the context run's state once it starts. An agent-added task, a rejection task and a script-gate remediation task are all changes to that state. None of them touches the run's definition. That removes the two write paths that bypass the mutation core today.

### 6.2 The supervisor's interface

```ts
/**
 * Supervises one context run: one implementer conversation and its validator
 * conversations. Knows nothing about other context runs.
 */
interface ContextRuns {
  /** Create a context run and begin supervising it. Durable before this returns. */
  start(input: {
    contract: ContextContract;        // the resolved contract, frozen at start
    inputs: ContextInputs;            // shared brief, invariants, upstream outputs, parameters, previous pass output
    workspace: WorkspaceRef;          // where it works (section 6.6)
    owner: ConversationAddress;
  }): Promise<ContextRunId>;

  stop(id: ContextRunId): Promise<void>;                  // terminal
  pause(id: ContextRunId): Promise<void>;                 // stops running turns; halts with reason "paused"
  resume(id: ContextRunId): Promise<void>;                // a halted run continues with a fresh attempt budget
  amend(id: ContextRunId, patch: ContractPatch, expectedRevision: number): Promise<void>;   // halted runs only
  decideApproval(id: ContextRunId, decision: ApprovalDecision, candidate: CandidateId): Promise<void>;

  read(id: ContextRunId): Promise<ContextRunView>;        // status, phase, tasks, attempts, rounds, outcome
  changed(id: ContextRunId, afterSeq: number, signal: AbortSignal): Promise<ContextRunView>;
}
```

The outcome is what the notepad asks for: a status and an optional structured output, plus the summary, the advisories, the certified candidate and the usage.

### 6.3 The protocol

The supervisor is a loop around a pure function.

```
loop:
  state  = load(contextRunId)
  facts  = new settlements since state.cursor, script-run status, workspace snapshot, approval decision
  action = decide(state, facts)              // pure. This function IS the protocol.
  if action is "wait": await the next fact
  else: perform(action); save(apply(state, action))    // save checks the record's revision
```

Two properties make this safe to restart, and they replace the loop fence, the loop epoch and the in-memory retry counters:

1. **Every message the supervisor sends restates what remains.** The work order lists the open tasks. A follow-up lists the tasks still open and the findings to fix. So a message that was lost, or delivered twice, or left `uncertain` by a crash does no harm. The supervisor never relies on exactly-once delivery.
2. **Every write checks the revision it read.** One loop per context run is registered in the process. `stop` and `resume` signal it and wait for it to exit. If a stale loop survives anyway, its next write fails and it exits. That is the only fence.

`decide` walks these phases:

| Phase | What `decide` does |
|---|---|
| **working** | No work order sent: send it. Turn running: wait. Settlement with `waitingOn`: wait, charge nothing. Settlement `stopped`, from any of its conversations: halt `paused`. Settlement failed and not retryable: halt `turn_failed`. Tasks all done, or no tasks declared: go on. Otherwise charge an attempt if the turn completed no task, and send what remains. |
| **reporting** | If the contract has an `outputSchema`, send the output request with `expect` in `single` mode. A refused output charges an attempt. |
| **certifying** | Open a round bound to the candidate identity. Run the script gate if the context has one. Send each validator seat its review request. Fold the verdicts (section 6.4). |
| **approval** | If the contract asks for approval, record the request for this candidate and tell the human. Wait. |
| **landing** | Ask the workspace to land the certified candidate. |
| **done** | `completed`, with output, summary, advisories and candidate. |

Output is captured before certification, as today. A read-only context delivers nothing but its output, so the reviewers must be able to judge it, and the output hash is part of the candidate.

**Attempts (the simplified execution policy).** One counter and one number, `retry.maxAttempts`, default 3. An attempt is charged when a turn ends without completing any task, when a turn fails with a retryable failure, when a certification round fails, and when an output is refused. A turn that completes at least one task is progress and is not charged. When the budget is spent the context halts with `attempts_exhausted` and the last evidence. `resume` grants a fresh budget.

A context that may add tasks could make "progress" forever. So a context run also has a fixed ceiling on work turns, as a backstop; reaching it is `attempts_exhausted` as well.

This replaces `iterationPolicy.maxIterations`, the circuit breaker threshold, the two-follow-ups rule, and the three per-kind recovery counters that live in loop memory today.

### 6.4 Certification

- **Candidate identity** depends on the scope, as today. For `full` it is the head commit, the hash of the whole tree, the task-state hash and the output hash. For `owned` it is the hash of the tree under the owned paths, the task-state hash and the output hash; the head is left out, because a sibling that lands moves the head without touching these paths. For `readOnly` it is the output hash and the task-state hash. A verdict counts only for the candidate it was given for. If the candidate moved during the round, the round is discarded and opened again without a charge. Five moves in a row halt with `candidate_unstable`, as today.
- **Script gate** runs the context's registered commands through `ValidationService`. It runs only when the context has the whole tree to itself (`write: "full"`). A context with owned paths shares its tree with writers that may be half done, so a whole-repo command would report their state. Such a context is refused a script gate at accept time. In a lane it relies on the lane's checks. In the session workspace it has no deterministic gate at all: its agent validators review its diff, and the owner runs `cctl validate` when the parallel work is finished.
- **Validator seats.** One durable conversation per seat per context run, reused across rounds, spawned with a read-only write grade, `peers: "refuse"`, memory off. The read-only grade is an instruction, as today, because the backends can only confine a run by moving its working directory away from the candidate. Seats run in parallel. A seat that cannot produce a verdict is asked again twice. A blocking seat that still fails halts the context with `validation_unavailable`; an advisory seat that fails is recorded and does not hold the round.
- **Authority is kept as it is.** A blocking seat returns `{summary, issues, advisories, planDefects?}`. An advisory seat returns `{summary, advisories}` and cannot fail the context because its schema has no field to fail it with.
- **Folding**, in this order: candidate moved; a seat is waiting on an answer; any plan defect, which halts with `plan_defect` and goes to the owner with nothing reopened and nothing charged; any blocking issue, which reopens the named tasks, charges an attempt and returns to `working` with the findings; otherwise pass.
- **Advisories: one advisory pass (proposed, section 12.5).** On a passing round with fresh advisories the implementer gets one message with them, marked optional. Then the supervisor looks at the candidate. Unchanged: done. Changed: an ordinary round runs again. Advisories from that second round are not sent back; they go to the owner with the result. This keeps the useful behaviour and drops the disposition schema, the separate `advisory_response` phase and the blocking-only re-certification mode.
- **Approval is bound to the candidate.** A decision names the candidate it was made for. A decision for a candidate that has since moved is refused. A rejection adds a task with the human's message and returns to `working` without a charge.

### 6.5 Halts and parks

A halt belongs to one context run. A sibling keeps working. Every halt is resumable after the owner acts, or after no action at all if the owner just wants another budget. A halted context keeps its workspace admission, because its partial work is still in its scope.

| Halt | Meaning | Replaces |
|---|---|---|
| `attempts_exhausted` | The budget is spent | `circuit_breaker`, `max_iterations` |
| `plan_defect` | A blocking validator says the contract cannot be met | same |
| `turn_failed` | A failure that retrying will not fix: quota, a lost continuation, a refused capability | `agent_turn_failed`, `infrastructure_blocked` |
| `validation_unavailable` | A blocking seat or a script command could not run | `validator_infra_error`, both `script_validator_*`, `validation_candidate_unavailable` |
| `candidate_unstable` | The tree kept moving under validation | same |
| `landing_failed` | The lane commit failed, or tracked files outside every member's scope changed | `merge_failure`, `ownership_violation` |
| `paused` | The owner or the user paused it, or stopped one of its conversations | execution-wide pause |
| `engine_error` | The supervisor itself threw. The error is in the log. | `recovery_error`, `execution_loop_failed` |

Run-level halts are in section 7.9. Two states are parks, not halts: `waiting` (a question or an awaited reply) and `awaiting_approval`. Neither charges anything.

Eight kinds here and five at run level replace 25.

### 6.6 The workspace

The supervisor is handed a workspace and needs nothing else about lanes.

```ts
interface Workspace {
  /** The repository directory this context works on: the session worktree or a lane's worktree. */
  readonly root: string;

  /**
   * Where one seat runs and what it may write. For an unconfined implementer
   * and for validators, `cwd` is `root`. For a confined implementer, `cwd` is a
   * scratch directory outside the repository, keyed by the context run, and the
   * policy allows the owned paths (section 7.7).
   */
  seat(seat: "implementer" | { validator: string }): { cwd: string; writeGrade: WriteGrade; writePolicy?: FsWritePolicy };

  /** Identity of the files in this workspace's scope right now. Creates no commit. */
  snapshot(): Promise<FileIdentity>;

  /** What a reviewer should diff: the baseline recorded at start, and the paths in scope. */
  reviewScope(): Promise<{ baseline: string; paths: string[] | "all" }>;

  /**
   * Make the certified state durable here.
   * Session workspace: records the snapshot and commits nothing.
   * Isolated lane: commits the scope on the lane branch. Refuses if the
   * snapshot moved, or if tracked files outside every member's scope changed.
   */
  land(expected: FileIdentity, message: string): Promise<LandResult>;
}
```

The baseline needs one sentence, because today's is a commit and that is not enough here. Where work is uncommitted, a commit baseline would show a reviewer everything in scope that anyone left uncommitted before this context started. So at context start the workspace writes the scope's current state as a tree object from a temporary index, keeps it under a private ref until the context run ends, and diffs against that. No commit is made on any branch. The scoped snapshot already works this way today (`git/diff.ts`); the baseline is the new part.

### 6.7 Alternatives considered

**A. A long-lived imperative loop per run, as today.** Readable, but it holds state across awaits. That is why today's engine needs a fence on every write, an epoch, a registry with instance tokens, and restart normalization that pauses the run.

**B. A fully event-driven reducer.** Restart-safe, but control flow scatters across handlers and is hard to follow.

**C. A loop that re-reads state and calls a pure `decide` (chosen).** It reads top to bottom like A and restarts like B. `decide` is a table-testable function with no fakes, which is what the testing rules in `AGENTS.md` ask for. The cost is that every effect must be safe to repeat; property 1 above is how that is met.

## 7. Layer 3: Run

### 7.1 One owner-facing unit

A run holds one or more contexts. Launching, status, waiting, pausing, resuming, editing, stopping, boundaries and the UI all address runs.

`cctl agent run` builds a run with one context from the object in section 6.1. At the tool surface there is no workflow and no graph concept: the command refuses `dependsOn`, and it has its own lifecycle verbs (section 9). Underneath, the scheduler has one context with no dependencies, which it starts. That is how "the same as a workflow of a single context" becomes true by construction instead of by discipline.

An agent run may name a lane. That is not a graph concept: it means "work in your own worktree and merge back", for one context.

The alternative is two kinds of thing an owner can own: a bare context run and a workflow. Then status, wait, stop, resume, amend, the boundary ledger, the subscription source and the UI card each exist twice, or the workflow layer relays everything its children report. I recommend one kind. **(proposed, section 12.1)** The supervisor stays separately testable either way, because the run only calls its interface.

Storage follows ownership: a `runs` row owned by the run layer and a `context_runs` row per context run owned by the supervisor. The run row holds no context internals.

Any number of runs can be live in a session. The primary key that allows one execution per session is not carried over.

### 7.2 The definition

```jsonc
{
  "name": "Rate limiting",
  "brief": "Shared context. Rendered into every work order and review request.",
  "invariants": [{ "id": "no-new-deps", "statement": "Add no runtime dependency." }],
  "defaults": { "retry": { "maxAttempts": 3 }, "validators": { "...": "..." } },
  "lanes": { "impl": { "checks": ["typecheck", "test"] } },
  "contexts": [
    { "id": "triage", "brief": "...", "placement": { "write": "readOnly" }, "outputSchema": { "...": "..." } },
    { "id": "limiter-core", "brief": "...", "dependsOn": [{ "context": "triage", "when": { "properties": { "kind": { "const": "bug" } } } }],
      "placement": { "lane": "impl", "write": "full" } },
    { "id": "wire-routes", "brief": "...", "dependsOn": ["limiter-core"], "placement": { "lane": "impl", "write": "full" } },
    { "id": "report", "brief": "...", "dependsOn": [{ "context": "triage", "otherwise": true }], "placement": { "write": "readOnly" } }
  ],
  "loops": [],
  "parameters": [],
  "prerequisites": []
}
```

Compared with today's plan file:

- A context is one self-contained object. Its tasks and its dependencies are inside it. Today tasks and edges are separate arrays that point back by id. This is the notepad's shift from an upfront workflow definition to individual execution contexts.
- `layout` is gone. It exists for the builder.
- `charter` becomes `brief` and `invariants` (section 12.5).
- The same context object, less `dependsOn`, is what `cctl agent run` accepts.

### 7.3 Scheduling

The scheduler is the second restartable loop, around a second pure function.

```
decideRun(definition, state):
  verdicts = projectRoutes(definition, state)          // carried over
  loops    = settleLoops(definition, state)            // section 7.5
  for each context:
    verdict says skip           -> mark skipped
    pending and every active dependency is visible and its workspace can be granted -> start it
  for each lane: fork, close and publish when section 7.7 says so
  finished when every context is completed, skipped or stopped and every lane is published or empty
```

"Visible" means: the dependency completed in the same workspace, or its lane has published, or it is read-only and so delivers only its output.

Context status is one of `pending`, `running`, `waiting`, `awaiting_approval`, `halted`, `completed`, `skipped`, `stopped`. There is no stored `ready`.

Run status is derived by one function. `running`: some context is running, or can start. `blocked`: none is, and at least one is halted, waiting, awaiting approval or waiting for a workspace that a halted context holds, or a run-level halt stands. `completed`. `stopped`. The engine does not store a snapshot of it that thirty call sites must rebuild.

### 7.4 Routes

Kept, with today's semantics, because the projection is already one pure module with a clear rule:

- A context is eligible when every incoming dependency is satisfied.
- A plain dependency on a skipped context drops out. A context whose dependencies all dropped out is skipped.
- A dependency with `when` is satisfied when the guard matches the source's captured output. If it does not match, or the source was skipped, the context is skipped.
- `otherwise: true` is satisfied when no guarded sibling from the same source matched.
- A guard over output that cannot be read halts the run with `route_unevaluable`. It is never treated as false.

Dropped **(proposed)**: the `atLeastOne` and `exactlyOne` cardinality policies and their halt. An enum output with one guard per value is exclusive by construction, and `otherwise` covers "none matched". Also dropped with their features: must-run coverage locks (spec delivery) and the per-source settlement markers and route-control revisions (they exist to replay decisions after live guard edits).

### 7.5 Loops

A loop names a set of contexts, an `until` guard over the exit context's output, and `maxPasses`. Loops are finite and not nested. Accept-time rules are today's: one entry, one exit, connected, edges cross the boundary only at the entry and the exit. One rule is new: a loop body sits in one workspace, either one lane or the session workspace, because a lane that has published cannot take a second pass.

A pass is not new graph structure. The definition stays as written. The state keeps a pass number per loop, and each body context has one context run per pass.

- The exit completes and `until` matches: the loop concludes. Downstream dependencies see that pass's output.
- It does not match and passes remain: the pass number goes up, the body contexts return to `pending`, and each gets a new context run. The previous pass's exit output is an input to the entry. Today the prompt carries the last three passes; this carries one, and the rest can be read with `cctl inputs`.
- It does not match and no passes remain: the run halts with `loop_exhausted`. The owner raises `maxPasses`, concludes the loop by edit, or stops.

Each pass uses fresh conversations. This removes the reserved id namespace, template versions, the slot ledger, the engine-only edit operation and the staging seam it shares with expansion.

### 7.6 Edits

One function: `edit(runId, { baseRevision, operations })`. It applies the operations to the definition, runs the same accept-time validator as launch, checks the rules below, and writes with a revision check. One transaction, one revision.

| A context that is | May be changed |
|---|---|
| `pending` | Anything, including removal. New contexts may be added. It may be skipped. |
| `halted` | Its contract only: brief, criteria, open tasks, added tasks, reopened tasks, retry budget. Through `ContextRuns.amend`. Or `restart: true`, which ends its context run and starts a new one, with new conversations, from the contract. Or it may be skipped. |
| `running`, `waiting`, `awaiting_approval` | Nothing. Pause it first; then it is halted. |
| `completed`, `skipped`, `stopped` | Nothing. |

Operations: `add-context`, `update-context`, `remove-context`, `amend-context`, `skip-context`, `update-loop`, `update-run` (brief and invariants, for work not yet started). Dependencies are part of a context, so there are no edge operations. Tasks are part of a contract, so there are no task operations on the definition.

`skip-context` is how an owner gives up on one context without giving up on the run. The context becomes `skipped` and its dependents follow the route rules. Without it a single member that cannot finish would keep its lane from ever closing, and the finished work of its siblings would be stranded on an unpublished branch. In a lane, the skipped member's uncommitted changes in its scope are discarded, because the lane worktree is the engine's. In the session workspace they are left where they are.

This is safe without staging. The scheduler's "start context X" is a revision-checked write on the same record. If an edit lands first, the scheduler's write fails and it decides again from the new definition. If the scheduler lands first, the edit finds X running and is refused with the reason.

This is the notepad's "revision-checked safe edits to future work", plus the two things repair needs: changing the contract of a halted context, and skipping one.

### 7.7 Workspaces and lanes

One fact organizes this section:

> **The session branch is the only integration point. Work done in the session workspace is uncommitted and stays where it is. An isolated lane forks from the committed session head and publishes back to it. A lane never sees or carries uncommitted work. So at any moment the session worktree is in one of two states: being written in place, or serving as the clean base of open lanes. Never both.**

"Clean" means no tracked change and no untracked file that is not ignored. Today's launch guard uses this definition.

Placement is `{ lane?: string, write: "readOnly" | { owned: [...] } | "full" }`. No `lane` means the session workspace, with `write: "full"` as the default. This is the named-lane-key recommendation in the notepad.

**The session workspace.** The context works in the session worktree, in place. The engine commits nothing; the result is the working tree, as with an ordinary sub-agent. A dirty tree is fine. Writers are admitted under one rule, held per worktree and across all runs of the session:

- `readOnly` needs nothing.
- `owned` needs its prefixes to overlap no running writer's scope.
- `full` needs no other writer.
- No in-place writer is admitted while any lane in the session is unpublished.
- A context that cannot be admitted waits. Waiting is not an error.

The write scope has a cost that the author must know:

- `full` and `readOnly` run as an ordinary agent in the worktree: project instructions load, the network is open.
- `owned` is enforced by the backend sandbox, and enforcement makes the run hermetic. Both sandboxes make the working directory writable, so a run confined to part of a worktree has to run from a scratch directory outside it. It loads no user, project or local settings, so no `CLAUDE.md` or `AGENTS.md`; its shell reaches only the CC host. This is how owned lanes work today (`implementer-lane-write-envelope.ts`, `claude/query-session.ts`). So `owned` is the price of two writers in one tree. One writer should use `full`.

The admission table is not stored. It is derived from the context runs that have started and not finished, and from the lanes that have not published, and it is rebuilt at boot.

**Isolated lanes.** A lane key names a closed group: its members share one worktree and one branch.

1. **Fork.** The engine creates the worktree from the session head once every dependency that any member has outside the lane is settled: the other lane has published, the read-only context has completed, or the route is dead. So the fork contains everything the lane will ever need from outside, and the lane never needs a second merge in.
2. **Work.** Members run in the lane's worktree under the same admission rule. Each lands by a scoped commit on the lane branch when it is certified and approved. This is today's lane committer. After a landing, a tracked change that no member's scope covers is `landing_failed` and names the lane, as today's ownership audit does.
3. **Close.** The lane closes when every member is completed or skipped and every approval has been decided. A member inside a loop counts when the loop has concluded. A lane with nothing landed, because every member was skipped, closes without publishing.
4. **Publish.** The Smart Merge machine merges the session branch into the lane, resolves conflicts, runs the lane's `checks`, and publishes one squashed commit to the session branch. Then the lane's worktree and branch are removed and dev servers started in it are stopped, as today. A member outside the lane sees the lane's work from this point.

Rules that follow from the organizing fact. Each is refused with the fix named.

At accept time:

- The lane graph must have no cycle. `A (lane X) → B (lane Y) → C (lane X)` is refused: put C in a new lane, or in the session workspace after X, or in a follow-up run.
- A lane member may not depend on a session-workspace writer. That work is uncommitted and the lane cannot inherit it.
- In a run that has lanes, a session-workspace writer must depend, directly or through other contexts, on a member of every lane. It can only come last. A run that needs in-place writing first is two runs, with the owner's commit between them.

At launch:

- A run that has lanes needs a clean session worktree and no in-place writer running in the session. This is the committed baseline the notepad asks the owner to establish.

At publication:

- The merge machine publishes only into a clean target: it moves the session checkout to the new commit with a hard reset, and it parks the merge as ready-to-land when tracked files are dirty (`workflows/merge/actors.ts`, `git/worktree.ts`). Its dirty test ignores untracked files, so the wrapper checks those itself first. If the session worktree is not clean, the run halts with `publish_blocked` and names the files. The owner commits or removes them and resumes.
- A resume after `publish_blocked` or `publish_failed` runs the publication again from the start. The session head has moved, so the merge and the checks must be repeated. A resume after a conflict may carry per-file guidance for the resolver, as today.

Publication needs a wrapper around the merge machine. Today's join runner does these things and the wrapper keeps them: the merge mutex and the session git lock; today's policy for a merge left in the lane worktree (an unresolved one is aborted; a resolved but uncommitted one halts the publication until it is committed); resyncing the shared index, because the lane committer uses a private one; one clean retry after a conflict. The wrapper adds one check: the lane worktree must be clean before the merge starts. The merge machine commits whatever is dirty in the source worktree, and work that no context landed should not ride into the session branch that way.

Conflict resolution and check-fix turns run as fresh tasks with the run's default implementer runtime. Their commits are gated by the lane's checks and by no validator. That is today's behaviour.

Publication can be repeated. The merge job is not restored after a restart, as today. The run layer sees a lane that was publishing with no live job and publishes again through the same wrapper.

What this replaces: lane-to-lane context merges, final publish and its supersession rules, eager against quiescent join scheduling, validation debt across multi-source joins, fork-from-upstream-lane, the reserve, provision, finalize protocol, and landing intents with their crash replay. A lane commit that was interrupted is simply attempted again, because `land` is asked for the same candidate.

One difference in behaviour to accept: a read-only context no longer blocks writers in its workspace. Today a reader with an output schema excludes writers in both directions. If a reader needs a still tree, give it a dependency. **(proposed)**

### 7.8 Templates and defaults

- **Templates stay.** A template is a stored definition with parameters and prerequisites. Storage, tiers, substitution and prerequisite probes are carried over with the new definition shape. The template verbs stay as they are (section 9). With the builder gone, templates are written with `cctl workflow create` and listed and launched from the Templates page.
- **Defaults keep three tiers and lose blocks.** Global `workflowDefaults`, then the definition's `defaults`, then the context. The cascade is per leaf, as today: each leaf is replaced whole and no other leaf is touched. The leaves are `implementer`, `validators.agents` (the cohort is one leaf), `validators.script`, `approval`, `retry`, `allowTaskAdd`, and under `capabilities` one leaf per role and setting: `implementer.ask`, `validator.ask`, each role's memory read and contribute, each role's `validationCommands`. The result is frozen into the contract at launch. Gone: `planRepair`, `collaboration`, `mutability.allowAgentContextAdd`, `circuitBreaker`, `iterationPolicy` (now `retry`), `laneMergeValidation` (now `lanes.<key>.checks`).

### 7.9 Lifecycle, authority and restart

Verbs: `launch`, `pause`, `resume`, `edit`, `stop`, and `approve`. `pause` and `resume` take a run, one context or one lane. `stop` is terminal and stops every conversation of the run.

Today's `abandon` and the two resets are covered by `stop`, and by `edit` with `restart` or `skip-context`.

Launch guards: prerequisites and input validation are carried. A launch is refused while the session's merge is finalizing, as today. The dirty-worktree guard applies only to runs with lanes. The one-execution lease is gone.

Who may call the verbs:

| Verb | Caller |
|---|---|
| launch | An interactive session conversation, or the UI on behalf of one (section 8.4) |
| pause, resume, edit, stop | The owner conversation, or the user. Today any conversation in the session may steer a run; the notepad says repair needs ownership. |
| approve | The user only **(proposed, section 12.6)** |
| task verbs, ask | The context's own implementer or validator |

Run-level halts: `publish_failed` (conflict or failed checks), `publish_blocked` (session worktree not clean), `workspace_unavailable` (a lane could not fork), `route_unevaluable`, `loop_exhausted`.

**Restart (proposed, section 12.7).** At boot the run layer starts the loops of every run that is not finished. They read state and carry on. A turn that was cut off shows up as a failed settlement and costs one attempt. Today the engine pauses every running execution at boot and waits for someone to resume it. With loops that restart by construction, continuing is the simpler behaviour and matches "continuity resumes what the backend can resume". The switch is one line in one place if Alex prefers the pause.

### 7.10 Alternatives considered

**Lanes.**

- *A. Today's model.* Lanes fork from each other, merge into each other through context joins, and reach the session branch only in a final publish. It gives an untouched session branch until the whole graph is done. It costs the join planner, validation debt, supersession and the three-phase scheduler. For small runs that an owner replans, the atomic publish buys little: in-place work is never atomic anyway.
- *B. One worktree per isolated context.* The simplest scheduler. But every context pays a merge with conflict resolution and checks, and a two-step chain exposes its half-done state to the session branch.
- *C. Closed lanes anchored on the session branch (chosen, and the notepad's decision).* One merge per lane. An author who wants atomic integration puts the contexts in one lane.

**Session-workspace landing.** Committing each in-place context would pin what was certified and would let lanes inherit it. It would also put engine commits on a branch the user is working on, and it would need a clean tree or precise attribution. The notepad's rule, that a lane cannot inherit uncommitted session work, already assumes in-place work stays uncommitted. I kept it uncommitted and named the cost in section 14.

**Edits.**

- *A. Today's staged mutation with a frontier.* Needed when engine-side writers append structure while the run moves. Both such writers are gone.
- *B. Edits only while the whole run is paused.* Simple, but pausing cancels turns that have nothing to do with the edit.
- *C. One revision-checked write, limited to contexts that are not running (chosen).*

**Loops.**

- *A. Unroll each pass into the definition.* Today's design. It makes passes visible as graph structure and costs everything listed in section 3.3.
- *B. No loops; the owner launches the next run.* Always available, and the right answer for loops whose next step needs judgment. It costs an owner turn per pass.
- *C. Pass-indexed context runs (chosen).* The notepad keeps loops; this is the cheapest form that does.

### 7.11 Edge cases left unhandled

- The owner conversation works in the session worktree without asking for admission. If it edits paths it has handed to a context, the context's candidate moves. If it leaves changes while lanes are open, publication is blocked. The planning skill should say both; the engine does not stop it.
- The engine never reverts files in the session worktree. A halted, restarted, skipped or stopped in-place context leaves its partial work there.
- A stopped run keeps its unpublished lanes, worktrees and branches, until the session is deleted. The stop result names the branches so the owner can salvage them.
- A backend whose write restriction is instruction-only (Cursor today) gives owned scopes no mechanical protection. `landing_failed` is the backstop in a lane; in the session workspace there is none.
- Admission is first come, first served. A `full` writer can wait a long time behind a stream of owned writers.
- A context that waits for a workspace held by a halted context waits until the owner acts on the holder. The owner is told once (section 8.2).

## 8. Ownership and observation

### 8.1 The owner link

A run records its owner conversation. Each workflow conversation records its principal: the owner, the context run and the seat. Ownership is one level deep because `capabilities.spawn` is false for every conversation whose principal is an owner, and the launch route checks it.

Deleting or archiving the owner stops its runs. Deleting the session stops everything in it and removes lane worktrees, as today.

### 8.2 Boundaries

A boundary is a row in a ledger, written in the same transaction as the state change that caused it, with a frozen payload and the exact command to read more. This is today's result ledger design, keyed by run and sequence.

| Boundary | Wakes the owner | Also |
|---|---|---|
| Run completed | yes | Carries outputs, summaries, advisories, usage |
| A context halted, or a run-level halt | yes | Carries the halt and its evidence |
| A spawned conversation asks, or sends its owner a request | yes | The owner answers or relays |
| A context waits for a workspace that a halted context holds | yes, once | Names the holder, which may belong to another run |
| Approval requested | no | Push notification to the human; attached note for the owner |
| Run stopped by the user | no | Attached note for the owner |

A halt is reported when it happens, not when the rest of the run has drained. The owner can repair one context while its siblings keep working.

### 8.3 Delivery through the subscription inbox

Boundaries are occurrences of a `run` source in the existing subscription inbox. That gives durable identity, de-duplication between the owner and other followers, batching, the wake limits, the holds, and `cctl inbox` inspection.

Today a launch creates a passive follow, and a wake needs an explicit one-time wait that fires on terminal status only. An orchestrator that ended its turn would never continue. So launching registers the owner as a follower in **owner mode**:

- It is a follow with a cursor, like a passive follow. It is not a wait. Today's waits are one-shot, hold one delivery and expire within seven days; stretching them to recur would cut across their design.
- When the run has waking boundaries the owner has not received, one wake is queued. When it is delivered it carries every undelivered boundary up to the batch limit, read by cursor. Three halts while the owner was busy cost one owner turn, not three.
- It has no expiry. It ends when the run ends.

`cctl agent run --wait` and `cctl workflow wait` still block inside a turn. A boundary returned to the owner that way advances the cursor, so it does not also wake the owner later.

Any other conversation in the project may follow a run passively, as today.

This is real work in the subscriptions domain, and it should be counted as such:

| Addition | Today |
|---|---|
| A `run` source and owner mode | A `workflow` source; `source_kind` and `mode` are CHECK-constrained columns, so this is a table rebuild and a schema version bump, not an additive change. "Recurring watches" are explicitly out of today's contract. |
| Inbound peer messages to interactive conversations, as occurrences of a `conversation` source | That source is internal: `recordNotice` refuses any source but the recipient itself |
| A wait on an awaited message | Waits exist for workflow, validation and git-job sources |

Recipient eligibility is decided in five places today. With the principal on the record it becomes one question, "is the principal the user", asked in one place.

### 8.4 A template launched from the UI

The launch form asks which interactive conversation owns the run: an existing one in the session, or a new one. The run is created with that owner. The owner is woken at the first boundary and acts as any owner does. So every run has an owner that can repair it, and there is no ownerless case in the engine. This is the notepad's recommendation and I agree with it. **(proposed, section 12.2)**

### 8.5 Repair, end to end

1. The owner runs `cctl workflow run --file plan.json` and ends its turn.
2. Context `a` reaches certification. A blocking validator returns a plan defect: criterion `ac-2` contradicts invariant `no-new-deps`.
3. `a` halts with `plan_defect`. Context `b` keeps working. The boundary is written and the owner is woken with the defect and the commands.
4. The owner runs `cctl workflow live edit <run> --file ops.json` with `{ "baseRevision": 4, "operations": [{ "op": "amend-context", "context": "a", "acceptanceCriteria": [ ... ] }] }`, then `cctl workflow resume <run> --context a`.
5. The supervisor of `a` sends its implementer a message that states the amended contract and what remains. The same implementer conversation continues, with its history. The validators are asked again.
6. The run completes. The owner is woken with the result and reports to the user.

Or the owner skips `a` and lets the rest finish. Or it stops the run and launches a different one. No repair agent exists in any of these paths.

## 9. Tool surface

For the owner, one context:

```
cctl agent run --file ctx.json [--wait]      refuses dependsOn
cctl agent status <run>
cctl agent wait <run>                        next boundary
cctl agent pause|resume <run>
cctl agent amend <run> --file patch.json     the contract of a halted run
cctl agent stop <run>                        today's cancel
```

For the owner, several contexts:

```
cctl workflow run --file plan.json [--wait]
cctl workflow start <template> --inputs f.json
cctl workflow status [<run>] [--context <id>]
cctl workflow wait <run>
cctl workflow pause|resume <run> [--context <id> | --lane <key>] [--guidance-file f]
cctl workflow live get|edit|edit-preview <run>     today's group name, now with a run id
cctl workflow stop <run>
```

Template verbs are unchanged: `validate`, `create`, `replace`, `get`, `list`, `templates`, `edit`, `edit-preview`, `delete`. `live ledger` folds into `status`; `live abort` and `abandon` become `stop`.

The two groups are front ends over one run API.

For any conversation:

```
cctl conversation send <conversation> --file message.json [--await-reply]
cctl conversation answer <conversation> --file answers.json
```

For a spawned conversation:

```
cctl task complete <id> --summary "..."     cctl task add ...     cctl task list
cctl inputs [--full]
cctl ask --file question.json               asks the owner
```

### 9.1 Three call sites

A read-only sub-agent, the smallest case. This is all of it:

```jsonc
{ "brief": "List every call site that validates a session name, with file and line.", "placement": { "write": "readOnly" } }
```

A certified change in place. It has the tree to itself, so it runs as an ordinary agent and may have a script gate:

```jsonc
{ "brief": "Add retry to the ticket sync client.",
  "tasks": [{ "id": "impl", "title": "..." }, { "id": "tests", "title": "..." }],
  "acceptanceCriteria": [{ "id": "retries-3x", "statement": "..." }],
  "validators": { "script": ["typecheck"], "agents": [{ "id": "ac", "profile": "builtin:general-reviewer", "authority": "blocking" }] } }
```

To run two such writers at once in the session worktree, give each `"placement": { "write": { "owned": [...] } }` and drop the script gate. Each then runs confined and hermetic (section 7.7).

Two features in separate worktrees, then integration in the session workspace:

```jsonc
{ "name": "...", "brief": "...",
  "contexts": [
    { "id": "api", "brief": "...", "placement": { "lane": "api", "write": "full" } },
    { "id": "ui",  "brief": "...", "placement": { "lane": "ui",  "write": "full" } },
    { "id": "integrate", "brief": "...", "dependsOn": ["api", "ui"] } ] }
```

### 9.2 The six patterns in `docs/VISION.md`

| Pattern | How it is written |
|---|---|
| Classify and act | A read-only context with an enum output; one guarded dependency per branch; `otherwise` for the rest |
| Fan out and synthesize | N contexts with no dependencies between them; one context that depends on all of them and receives their outputs |
| Adversarial verification | One context with a validator cohort. This is first-class. |
| Generate and filter | Fan-out, then a judging context whose output names the survivors |
| Tournament | Judges as contexts over the attempts' outputs. For attempts that are code in separate worktrees, see the gap below. |
| Loop until done | A loop, or the owner launching the next run after reading the last result |

Two gaps, named:

- **A fan-out whose width is only known at run time.** With expansion gone, the owner reads the scout's output and launches the next run with N contexts. That is the replanning the vision asks for.
- **Code attempts where only the winner should land.** Every lane publishes when it closes. Keeping a lane unpublished for the owner to choose from needs a per-lane `publish: "hold"` option and two verbs. The lane model has room for it; I leave it out of the first version.

One extension the model makes cheap, also left out of the first version: **continuing a finished sub-agent.** A context run names its implementer conversation. A later run could adopt that conversation instead of spawning a new one, so follow-up work keeps its history and its prompt cache. This is the natural home for "address these advisories" and "one more thing".

### 9.3 What the UI shows

This design is about the server. For the UI it implies:

- A run appears as a card in its owner conversation, and on a run page. The page can reuse the existing canvas to draw contexts and dependencies, read-only.
- A context's detail lists its implementer and validator conversations. Opening one shows the ordinary conversation view, because it is an ordinary conversation. The composer works there: the user can act as principal.
- Questions and approvals use the existing panels. An approval shows the candidate it is for.
- The builder page is removed. The Templates page lists, launches and deletes; launch asks for the owning conversation.
- Server events shrink from 35 graph event types to a handful: run changed, context run changed, boundary recorded. Conversation events are unchanged.

## 10. Deleted, carried, simplified

| Feature | Disposition | Note |
|---|---|---|
| Repair agent | deleted | The owner repairs. Plan defects stay. |
| Runtime graph expansion | deleted | |
| Visual builder, `layout` | deleted | The execution view keeps the shared canvas. |
| Planner session, `workflow-draft` MCP, the `planner` role | deleted | |
| Graph-bound spec delivery | deleted | Section 11 |
| `agent-runs` | replaced | `cctl agent` is a run. `workingDirectory` is carried; `timeoutMs` and the result envelope are not. |
| User-input gate | replaced | The core's open request |
| Second-opinion collaboration from a lane | replaced | A request to the owner. Collaboration mode itself is untouched. |
| `task_run` inside the core, ephemeral conversations | replaced | `request()` for the new engine; a hold around the unchanged task path for side tasks; isolated calls for the rest |
| Live-edit core, staging seam, locked regions | replaced | `workflow/edits.ts` |
| Loop unrolling | replaced | Pass-indexed context runs |
| Context merges, final publish | replaced | Lane publication |
| Loop fence, epochs, four revision counters | replaced | One revision per record |
| Route projection, guard evaluator | carried | |
| Validator authority, plan defects, candidate identity by scope | carried | |
| Script validators | carried | |
| Write envelope, lane committer, ownership audit, worktree creation | carried | |
| The join runner's duties around the merge machine | carried | As the publication wrapper (section 7.7) |
| Lane cleanup and lane dev-server stop | carried | After publication, and at session deletion |
| Launch guards: prerequisites, inputs, merge finalizing | carried | The dirty-worktree guard applies only to runs with lanes |
| Templates, parameters, prerequisites, template verbs | carried | New definition shape |
| Agent profiles and assignment snapshots | carried | |
| Structured output protocol (AgentCall facade) | carried | |
| Stall watchdog | carried | The core owns it for every conversation. Collaboration keeps its own copy. |
| Checkpoints, compaction, forks, debug mode, slash commands | carried | Checkpoints and compaction capture as holds on the slot |
| Advisory loop | simplified **(proposed)** | One advisory pass |
| Charter | simplified **(proposed)** | `brief` and `invariants` |
| Config cascade | simplified **(proposed)** | Three tiers, per leaf, fewer blocks |
| Shared documents, seeded documents | simplified **(proposed)** | Outputs, files in the workspace, and the session's reference documents |
| Plan review verbs and skill | simplified **(proposed)** | A read-only agent run over the plan file |
| Route cardinality | simplified **(proposed)** | Guards and `otherwise` |
| Definition approval before launch (`approvalRequired`) | dropped **(proposed)** | It parks a launch until a human approves the plan. Its main user is managed spec delivery. An owner that wants a plan approved asks the user before it launches. Per-context approval stays. |
| Session merge admission | re-pointed | Today a session merge is refused while a graph execution holds the session. The rule becomes "no unfinished run in this session". |
| Collaboration mode, merge and commit machines | untouched | What they need is in section 5.8 |

## 11. Spec delivery

This is open item 5. **(proposed)**

Today the primary path is the managed delivery plan: a managed definition, signed off in the builder, launched as a graph execution with origin `spec_delivery`. Beside it, a human can continue a delivery in `session` or `external` mode from Spec Studio (`specs/delivery-continuation.ts`), and the delivery gate needs no graph outcome for that: a delivery with no workflow execution takes the session branch of the gate, and human acceptance satisfies it (`specs/delivery-gate-v2.ts`). So:

- **Delete the managed plan path** and what exists only for it: managed definitions, the delivery plan and its sign-off in the builder, ownership claims and the binding lint, the spec-delivery launch, the `workflow` continuation mode, and the graph outcome port in the delivery gate. On the spec side that is about 12,000 production lines plus about 3,300 of UI.
- **Deliver in `session` mode.** Starting a delivery stays a human act in Spec Studio. An interactive conversation in the session then owns the work. The rewritten `sdd-delivery` skill tells it to read the approved spec, plan small runs, launch them, and replan between them. That is the pattern this overhaul exists for.
- **Evidence comes from an ordinary run.** A template, `spec-verify`, holds one read-only context whose output is a verdict and evidence per criterion, checked by a blocking reviewer. The human reads that output in the existing delivery review, where they already mark criteria satisfied, waived or revoked.
- **The engine knows nothing about specs.** No criterion claims in prompts, no coverage locks in edits, no spec origin on runs. One measured cost goes with them: the ownership table was 69 percent of prompt bytes in one audited execution.

What is lost: an engine-enforced proof floor per criterion at the session boundary. The gate becomes the human review, informed by the verification output. If that proves too weak, the next step is small: let the spec domain follow runs and record per-criterion verdicts from run outputs. The engine would still not change.

At the cutover, a spec execution that is still bound to a graph execution must be finished first, or continued by a human in session mode. Stage 4 should refuse to proceed while one exists.

## 12. Decisions for Alex

Each item is a recommendation. "If not" says what changes.

### 12.1 `cctl agent` is a run with one context

The notepad says no workflow surrounds an agent run and it carries no graph concepts; the charter says it is the same as a workflow of one context. My reading: `cctl agent` has its own verbs, refuses dependencies and shows no graph, and underneath there is one kind of run. **If not:** bare context runs become a second owner-facing kind with their own status, wait, stop, resume, amend, boundaries, subscription source and UI card.

### 12.2 A UI launch picks or creates the owning conversation

Open item 1. **If not:** the engine needs an ownerless case, and a halted run has nobody to repair it but the user at the run view.

### 12.3 Unsolicited messages

Open item 3. A message from a non-principal never starts a turn in a workflow conversation: attached for an implementer, refused for a validator. For an interactive conversation, a request wakes it under the existing limits and a note waits for the user. **If not:** if peers may start turns in implementers, the supervisor still copes, because it re-evaluates after any turn. Certification just gets disturbed more often. Validators should refuse in any case.

A smaller first version is available here: peer messages never wake anyone, and only owner and child wake each other. It removes the wake on peer requests and the ping-pong case. It also means a request to an idle conversation in another session waits for that session's user. I recommend the full rule, but this is the cheapest thing to cut.

### 12.4 Questions go to the owner

Part of open item 4, the ask-user gate. In a workflow conversation `cctl ask` asks the owner, who answers or relays. The user can answer directly. Asking is on by default. **If not:** questions go straight to the user as today, the owner gets an attached note, and consultation requests remain a second channel. The core mechanism is the same either way; only the addressee changes.

### 12.5 The other engine features in open item 4

| Feature | Recommendation |
|---|---|
| Validator authority | Keep unchanged. |
| Advisory loop | One advisory pass, then an ordinary round if the candidate changed. No dispositions, no blocking-only mode. |
| Script validators | Keep. Per context only with `write: "full"`; otherwise the lane's `checks`. |
| Charter | `brief` and `invariants`. Invariants are appended to every context's criteria, so a blocking reviewer can still cite them by id. No ranked sources, no scoping, no amendment log; a change is an edit. Workflow conversations also receive the owner session's active Alignment charter as read-only governing context, so there is one charter mechanism, not two. That last part changes alignment rule R12.1, which excludes autonomous turns today. |
| Config cascade | Three tiers, per leaf, the reduced leaf list in section 7.8. |
| Shared and seeded documents | Drop both graph mechanisms. Contexts share through outputs, through files in a shared workspace, and through the session's reference documents. A lane agent is given those by absolute path into the session worktree; nothing is copied into the lane. Material that today rides in the plan as a seeded document goes in the `brief` or in a registered document. |
| Plan review | Not an engine feature. Review a plan with a read-only agent run. |

### 12.6 Approval is a human act

Today the origin conversation may resolve an approval gate. I recommend that only the user can, and that the decision is bound to the candidate. **If not:** the owner agent can approve its own sub-agent's work, and the gate means less.

### 12.7 Restart continues runs

Section 7.9. **If not:** runs halt with `interrupted` at boot and the owner is woken to resume them.

### 12.8 The proposed conversation additions and success measures

Open item 6. I recommend confirming them, with two additions to the conversation: the principal (which generalizes the owner link) and the settlement log. I would add one success measure: *an owner that launched a run and ended its turn is woken at the next boundary without having registered anything.*

### 12.9 Archived executions

Export them to files and drop the tables, with no viewer for the old shape (section 13.3). **If not:** a read-only viewer for old executions stays in the product. That is a backward-compatibility shim and needs explicit approval.

### 12.10 Smaller proposals, listed so none is silent

| Proposal | Section |
|---|---|
| One attempt counter, default 3, charged only when a turn makes no progress, fails, or a round or output is refused; a fixed ceiling on work turns | 6.3 |
| A workflow conversation's awaited reply arrives as a turn message, not through a subscription wait | 5.4 |
| Route cardinality policies dropped | 7.4 |
| A read-only context no longer blocks writers in its workspace | 7.7 |
| In-place writers and open lanes exclude each other in a session; in a run with lanes, in-place writers come last | 7.7 |
| `skip-context`, so an owner can give up on one context | 7.6 |
| Halt kinds reduced from 25 to 13 | 6.5, 7.9 |
| `abandon` and the two resets folded into `stop`, `restart` and `skip-context` | 7.9 |
| Definition approval before launch dropped | 10 |
| Per-run `timeoutMs` and the last-three-passes loop history dropped | 6.1, 7.5 |
| A plain loop instead of XState inside the conversation core | 5.5 |

## 13. Migration

Open item 7. **(proposed)**

### 13.1 Order

The old engine and the old conversation core can be deleted at different times, because during the transition they share only the layers below them: the backend runtimes, the transcript, the AgentCall facade and the query semaphore. None of those is rewritten.

| Stage | What ships | What it proves |
|---|---|---|
| 1 | The conversation contract, the message and settlement tables, and the new core hosting **workflow conversations only** | The contract, with the simplest users. Interactive conversations stay on the old core. |
| 2 | The supervisor, and `cctl agent run` on it, in the session workspace. The `run` subscription source with owner mode. `agent-runs` deleted. | A sub-agent is a conversation with an owner, and the owner is woken. |
| 3 | The run layer in slices: dependencies and routes; workspace admission; isolated lanes and publication; loops; edits. `cctl workflow run` on it. | The workflow tool. The old engine still serves old templates. |
| 4 | Template conversion, the run view, session-mode spec delivery. Then delete the old engine, builder, planner, plan repair, expansion and graph spec delivery. | Success measure 4. |
| 5 | Interactive conversations move onto the new core: prompt and queue routes through `send`, slash commands, questions, wakes, then checkpoints, forks, debug mode, external turns, and holds for side tasks and collaboration. Old core deleted. | Success measure 1. |

Why workflow conversations first: it puts the new core in use where a failure costs a re-run, before it carries every interactive conversation. Stage 5 is the largest risk in the whole plan and is last on purpose.

The temporary partition is by conversation. Old-engine lane conversations and interactive conversations stay on the old core; conversations spawned by the new run layer live on the new one. During stages 2 to 4 the owner is an interactive conversation on the old core, and it is woken through the subscription wake path that already works there. This is not a compatibility shim; it is two implementations side by side, which the charter allows for a time.

The two engines are told apart by the shape of the definition, not by a flag. A plan file or template in the new shape goes to the run layer. A stored template in the old shape goes to the old engine until stage 4 converts it.

### 13.2 Schema

- The new tables are additive: `conversation_messages`, `conversation_turns`, `runs`, `context_runs`, `run_boundaries`. Additive tables need no version bump under the migration rules.
- The subscription tables are not additive. Their `source_kind` and `mode` columns are CHECK-constrained, so stage 2 rebuilds them by rename, recreate and copy, bumps the schema version and publishes the compatibility marker.
- Dropping the old tables at stage 4 and stage 5 is a breaking cutover and follows the existing destructive-cutover precedent.
- Two known traps apply and should be planned for: `next build` opens the live database, and the synchronous floor runs on every open, so a table must not be dropped by the floor before a cutover has read it.

### 13.3 Stored templates, archived executions, bound spec executions

- **Templates.** A one-time converter maps the old definition to the new one. It is mechanical for contexts, tasks, criteria, parameters and prerequisites. Edges become `dependsOn`. The charter becomes `brief` and `invariants`. Loop groups become loops. It reports, and does not guess, where the old shape has no equivalent: a `session` reader stays a session reader; group lanes become isolated lanes; a lane pattern that the closed-lane rules refuse is listed for a human to fix.
- **Archived executions.** I recommend exporting each archived execution to a JSON file under the config directory and dropping the tables, with no reader left in the product. Keeping a viewer for the old shape is a backward-compatibility shim, which needs Alex's explicit approval. **If Alex wants the history browsable in the app, that is the shim to approve.**
- **Spec executions bound to a graph execution.** Finished or continued in session mode before stage 4 completes (section 11).

### 13.4 Rules and documents to update

- `.kiro/steering/workflows.md`: three shapes remain (conversation core, job machines, run engine), and the run engine replaces the graph engine. The adoption matrix loses most of its rows.
- `CONTEXT.md`: add principal, settlement, hold, run, boundary, workspace.
- The seam and cycle baselines shrink. They must not be raised to make a stage pass.
- The `graph-workflow-planning` skill is rewritten around context objects, the lane rules, the cost of owned scopes and replanning. The `graph-workflow-review` skill and the spec delivery skills change with sections 11 and 12.5.

### 13.5 Tests

The two `decide` functions are tested as tables: state and facts in, action out. The conversation core is tested against the scripted fake backends that exist. Persistence is tested with `createPersistenceFixture()` and a contract test per new repository. The compat harness and its recordings describe the old engine and are deleted with it.

## 14. Risks, and what would change my mind

- **Stage 5 is a rewrite of the path every conversation uses.** The contract is the protection: by then it has carried all workflow conversations through three stages. If stage 1 shows that the mailbox cannot express something interactive conversations need, the contract changes then, cheaply. Side tasks and collaboration keep their paths under a hold, so stage 5 does not also change them.
- **The subscription work is larger than a "reuse" label suggests.** Owner mode, peer messages and reply waits are three additions, one of them a table rebuild. If that grows, the fallback for owner mode is a wake row written by the run layer directly, which would duplicate the batching and limits the inbox already has.
- **Owner turns cost tokens.** Every question and every halt wakes the owner. If real runs show owners being woken mostly to relay, 12.4 flips to "questions go to the user" without touching the core.
- **Capacity.** The default limit is two turns at once, and an owner blocked in `--wait` holds one. Runs will feel slow until the limit is raised or owners end their turns.
- **Owned scopes are hermetic.** Two writers in one tree each lose project instructions and network. If that makes same-tree parallel writing unattractive in practice, separate lanes are the alternative, at the cost of a merge.
- **Closed lanes cost some parallelism.** A lane waits for all its outside dependencies before it forks, and in a run with lanes, in-place writing comes last. If plans keep wanting a lane that takes in work halfway, the missing piece is a merge of the session branch into an open lane. I would want to see that need in real plans first.
- **In-place work is not pinned.** A certified candidate in the session workspace is a tree hash, not a commit. Later edits by anyone change the tree. If that causes confusion in practice, an opt-in "commit on completion" for session-workspace contexts is the fix; the lane committer already does scoped commits.
- **Squashed publication.** A lane lands as one commit, because that is what the merge machine does. Conflict resolutions and check fixes made during publication are covered by the lane's checks and by no validator. Both are today's behaviour.

Evidence that would overturn a choice:

| Choice | Overturned by |
|---|---|
| `send` only | A caller that must be refused when the conversation is busy and cannot wait |
| One attempt counter | Runs that halt early on long task lists, or loop without bound |
| One advisory pass | Advisories that matter being ignored because nobody answers for them |
| Restart continues runs | A restart that was meant to stop spending and did not |
| In-place writers excluded while lanes are open | Owners that routinely need both at once |

## 15. Success measures

The notepad's four, and where the design meets each:

1. *A change to the conversation core shows up in both kinds of conversation.* One pipeline that reads spawn attributes (section 5.2, 5.5). Met at stage 5.
2. *`cctl agent` and a one-context workflow run the same execution-context code.* The same supervisor, and the same run record (section 7.1). Met at stage 3.
3. *An owner repairs a halted workflow with no repair agent.* Section 8.5. Met at stage 3.
4. *The old graph engine is deleted.* Stage 4.

And the one I would add: *an owner that launched a run and ended its turn is woken at the next boundary without registering anything.* Met at stage 2.
