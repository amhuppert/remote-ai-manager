# C5b: Claude between turns on the conversation core

Design amendment to `docs/design/2026-10-02-shared-conversation-design-r2.md` (amendment 13, §4.1–§4.9, §17).

**Decision.** Alex decided on 2026-10-12 (cutover decision Q1 = b) that a Claude conversation on the core keeps what
it had on the actor:
- background work that outlives the turn;
- Claude's own continuations when that work finishes;
- messages sent while Claude is working.

**Status.** Slices 2 (the adapter) and 3 (custody in the core, with its review fixes) are implemented; slices 4–5
are not. Revision 3: after the Opus and Astra reviews (`.cc/temp/reviews/c5b-design-{opus,codex}.md`) and Astra's
verification of revision 2 (`.cc/temp/reviews/c5b-design-verify-codex.md`, cited "V-1" and so on). The slice 3
amendments below follow its reviews (`.cc/temp/reviews/c5b-s3-{codex,opus}.md`) and the report
`.cc/temp/overhaul/c5b-slice3-report.md`.

**Sources.** Facts and citations: `.cc/temp/overhaul/c5b-research.md` (cited "R§n"). Review findings are cited as
"O-F1", "A-1" and so on.

## 1. The problem

Every core turn closes its runtime before the row settles (`recorded-turn.ts`), so "nothing runs outside an admitted
attempt" holds by construction. For Claude that kills the background Bash and subagents a turn started, drops the
continuation Claude would run when they finish, and leaves a message sent mid-turn for the next turn.

The Claude adapter already supports retention (R§1.1):
- one CLI process for the runtime's life;
- background-task tracking;
- "external" turns for provider-initiated work;
- live input through the same stdin channel.

What is missing is a host rule that keeps the process alive without letting it act outside admission. Observing a
continuation's first frame is not admission, because the provider has already started (R§3.2 invariant 1).

## 2. Two owners, one question

The protocol knowledge lives in two existing owners, and everything else composes them (A, "simpler alternatives";
O-F10):

- **The backend adapter answers one question: does this runtime still owe provider work?** The answer and its
  changes are exposed through the conversation port, as `owesWork()` and an `onOwedWorkChanged` event, plus an
  idempotent `onTerminated` event that fires whatever the task inventory. Backend-neutral code never reasons about
  task classes, uuids, notifications or CLI states.
- **The core executor decides which admitted attempt owns the runtime, its grant and its row.** It also decides when
  that ownership ends.

The capability is declared on the descriptor next to `externalTurns`, and conformance checks that the declaration is
coherent. Only Claude declares it. Codex and Cursor are unchanged (R§4 F8).

### 2.1 What "owes work" means for Claude

The Claude adapter computes the answer from facts it alone sees. The probes in §9 settle which signal is
authoritative:

1. **A visible waitable background task is in flight.** The predicate is the same one the activity indicator uses:
   running, waitable, not `skip_transcript`, not `ambient`. The tracker classifies `ambient` tasks as excluded, so
   custody never holds on work nobody can see (O-F7).
2. **A visible waitable task has finished and the CLI has not yet answered it.** Continuation debt is created on
   the tracker's running-to-terminal transition, whichever frame causes it: `background_tasks_changed`, a terminal
   `task_updated` or the notification. It is created before the owed-work change is published, and a later
   notification for the same task does not duplicate it (O-F1, A-1, V-1). The continuation starts after these frames,
   so an empty task set does not mean the work is done. The debt is discharged only by evidence that the CLI answered
   it; §9.1 gives the measured rule. A bounded wait (§6) covers debt the CLI never answers; it ends custody as `lost`,
   not as success.
3. **An external turn is active** (O-F4).
4. **An accepted input has not been answered.** Every prompt and live input carries the uuid the adapter stamped
   (§4.1). An accepted input stays owed until a terminal result names it in `user_message_uuid(s)`, or until the
   runtime is terminated or lost. An earlier result, a `queued_turn_count` of 0 or an `idle` event observed before the
   input was consumed never clears it (V-2).

Probe 5 showed that `session_state_changed: idle` does not mean "nothing is owed", so it discharges nothing (§9.1).

## 3. Custody

A runtime is released at the end of a turn unless it owes work. If it owes work, ownership passes to a **custody
attempt**: an admitted attempt that runs nothing itself and owns the runtime until the work is done. Everything Claude
does between turns therefore happens inside an admitted attempt that holds, guards and boot already know how to see.

**Scope.**
- Custody applies only to ordinary interactive turns: person-attended or autonomous messages on a conversation the
  core owns.
- It does not apply to seat work turns, which keep today's in-turn background wait. The continuation loss on seats
  (R§2.3) is an existing defect with its own follow-up.
- It does not apply to task turns, or to turns run in debug mode. The latter matches the actor's debug state, which
  ignored external turns (O-F12, A-8).

**No idle retention.** When nothing is owed, the runtime is released exactly as today. No process is kept "for
latency", so no unadmitted wake source (scheduled or loop wakeups) can act.

### 3.1 One owner at a time

The runtime has exactly one owning attempt at any moment: a turn, then custody, then the next turn (O-F4). The
external-turn handler (seam S2) routes every provider event to the current owner. Row writes are fenced by the owning
attempt id, the current-attempt rule of r2 §4.3.

### 3.2 What custody holds

| Resource | During custody |
|---|---|
| Execution | The custody attempt (`core_attempts`, `admitted`) and the executor's per-conversation loop. The admission rules below are per entry kind (§4) |
| Workspace grant | Custody's own `interactive_write` on the worktree, taken with `tryAcquire` before the ending turn releases its grant. Interactive grants never conflict with each other and jump the queue (`workspace/admission.ts:114-116`, `:157`), so the take always succeeds and no grant moves (O-F2) |
| Model-capacity slot | Not held. A segment (§3.3) cannot wait for capacity because the provider has already started, so a segment over-commits `maxConcurrentQueries` for its length. This is a stated exception; segments can be long |
| Runtime | Retained and registered (MCP status, capabilities, skill commands) |

### 3.3 Turn end

At the end of an ordinary turn, inside today's `runRecordedTurn` boundary, in this order:

1. Ask `owesWork()`.
   - If the answer is no, release the runtime as today (unchanged path).
   - If yes, ownership of the runtime passes to custody:
     - insert the custody attempt (`admitted`, cause `custody:<turn attempt id>`, inheriting the turn's source and
       autonomy);
     - take custody's grant (§3.2).

     Custody opening is refused if the session is being merged (§5). In that case the runtime is released as in the
     "no" case, with a loss notice saying the merge stopped the background work.
2. Settle the turn's **accounting**: cost, duration, turn count and the attempt's terminal. Release its slot and grant.
3. **Project the row from the surviving owner's actual state**, not from the ending turn (V-4):
   - `running` while a segment is active;
   - `waiting_for_input` while a durable question remains;
   - otherwise `awaiting`.

   The same projection runs whenever a turn's claim ends while a custody survives: the ending turn's own claim and a
   successor's failed or cancelled claim, which returns ownership to custody. The projection is read as the row is
   written; a stored row keeps no turn source, so ending such a claim as an ordinary one would show idle during a
   segment.

Custody is inserted before the turn settles, so a crash in between leaves an admitted custody row for boot to see
(O-F12). An external turn already active at the end becomes custody's first segment, and step 3 keeps the row
`running` for it.

**Segments.** A CLI turn that runs during custody is a **segment** owned by custody:
- **Start.** The row becomes `running`, unless an ordinary turn has already claimed it (§4). The source and autonomy
  are inherited from the handing turn, so no new `activeTurnSource` value is introduced and `cctl ask` keeps the
  turn's rule (A-9, O-F12).
- **Frames.** They are appended in order through the same adapter-owned barrier that orders live-input acceptance
  before later frames (A-7). Segment settlement awaits its frames and its owned live deliveries.
- **Result.** It settles the segment: the cost delta, duration and turn count go to the row. The row then returns to
  `awaiting`, or to `waiting_for_input` while a question remains, and the person is notified.
- **Zero-work notifications.** The adapter emits `external_turn_started` only on the first non-`init` allowlisted
  frame. A zero-work notification result that follows only `init` emits no segment; any cumulative-cost movement goes
  to the owner as cost without a turn count (A-smaller 4, O-F12).
- **Running description.** `describeRunning` reports the active segment, so `cctl wait` causation and session
  alignment see it (O-F12).

**Custody ends** when `owesWork()` turns false (`settled`), on Stop (`stopped`), on runtime death (`lost`), at the
bound (`timed_out`), at shutdown (`interrupted`), or at a handover (`handed_over`). Except at a handover, the runtime
is closed and collected before custody leaves the busy set. That ordering also keeps a checkpoint's activity epoch
`0` honest, because checkpoints are refused while custody holds (O, "drop as unnecessary").

## 4. Entries during custody

Custody is not "a runner" in the old sense. Each operation has its own rule (O-F3, V-6):

| Entry | During custody |
|---|---|
| A full turn: `sendUserMessage`, including a queue drain that carries delivery metadata | **Handover** (§4.1). The delivery metadata and its hold and receipt semantics are kept |
| Live delivery (`deliverLive`) | Accepted into the retained runtime only while a turn or segment is running. In idle custody it is refused, so the message stays queued and drains as a handover turn |
| `task`, `command`, `claim`, `hold`, `whileIdle` leases (checkpoint, capture, debug enter, collaboration claim) | Refused: "background work is running; stop it or wait". A task already queued behind the ending turn is answered `not_started` with the same message (`executor.ts:836-844`), not left waiting up to the bound. One refusal rule replaces "tasks queue behind custody" (O-F3, O alternative 4) |

The queue bridge treats idle custody as not busy for draining, so a queued message hands over rather than waiting.

### 4.1 Handover

1. The message's turn opens its attempt, claims the row and acquires its slot and its own `interactive_write` as
   usual, while custody stays the runtime's owner and keeps its grant (O-F2, A-2).
2. Before input preparation, the turn checks configuration drift against the retained runtime
   (`runtimeConfigurationChanges`). The check needs the turn's model selection, profile and instructions, which exist
   only after admission, so it runs after step 3: custody has already settled `handed_over`, and the admitted turn
   owns the drift. On drift the turn closes the runtime and records the loss, saying the configuration changed. The
   turn's own `<runtime_recovery>` then carries the loss (O-F11). Without drift, the check is the turn's reuse
   decision: its later `obtain` reuses the runtime without comparing again, so a configuration saved while the input
   is prepared applies at the next check rather than closing work the prompt was prepared for. A staged capability
   change is not drift (O-F8).
   - **MCP saves** already apply live, during turns too (`setMcpServers`, `conversation-runtime.ts:625-665`).
   - **Staged capability changes** apply at the next real provider-turn boundary: whenever the retained runtime has
     no active turn or segment (a turn end, a segment end, or a handover with no active segment). A change still
     staged when a prompt supersedes an active segment applies at that prompt's turn end. The apply's
     `skipped-turn-active` answer leaves it staged; it is never dropped and never loops (V-5).
3. At the turn's admission (`admitAttempt`), one in-process step settles custody `handed_over`, makes the turn the
   runtime's owner and releases custody's grant. A segment active at that moment passes to the turn:
   - its frames keep being appended;
   - it makes no row transition, because the turn has claimed the row;
   - the turn's prompt then supersedes it through the adapter's takeover.
4. If the turn fails or is cancelled before admission, custody remains the owner. Stop while the turn waits stops
   both. A turn that has taken the runtime over and fails before its recorded lifetime begins (its row cannot be read,
   or its begin write fails) gives the runtime back to a new custody while it still owes work, and otherwise
   collects it before its grant is released. Admission waits for a custody that has started ending, and never takes
   one over.

**Attribution is adapter-owned (A-3, O-F5).** The adapter stamps a uuid on every prompt and live input it sends. It
resolves a caller turn on a result whose `user_message_uuid(s)` names that prompt. A result that names no input
answers the waiting caller only when its origin is absent or `human` (zeroed crash and startup results carry no
uuid). A result from a provider origin, or one that names other inputs, is provider work recorded under the current
owner. Checkpoint capture already relies on uuid echo on the installed CLI (`query-session.ts:810-811`, `:1391-1396`).
Probe 1 confirms it for folded and queued prompts. There is no order-based attribution.

### 4.2 Live input

- **Retaining runtime.** A Claude runtime in a turn or segment accepts live input through the queue's live path. The
  port gains a live-input declaration for "input the provider may answer after the turn's result", alongside
  `running_turn` (seam S5), with its own conformance case.
- **Receipts are unchanged** (A-6, O-F5). Archival, contribution receipts and queue release all settle at
  acceptance, as r2 §4.4 requires. `promptCount` is bumped once per accepted input.
- **Response debt is separate from delivery.** Whether an accepted input has been answered is owed work (§2.1 rule 4),
  never a receipt outcome. Death or the bound reports unanswered debt in the loss notice; it is never "uncertain
  delivery".

## 5. Guards outside the conversation

| Path | Rule |
|---|---|
| Lane publication into the session worktree | Waits on the grant conflict (Workspace admission, unchanged) |
| Session merge | Refused, advisory and in the in-lock check, while any conversation of the session holds custody. Ordinary turns are untouched, including the merge's own resolver and repair task turns, so there is no new refusal for them on any backend (V-3). Custody opening (§3.3 step 1) consults the session's finished state and A4's finalizing-merge job check at the insert boundary, after every await. So no custody starts once a merge is finalizing, and a turn that ends then releases its runtime with a loss notice. A project conversation's custody on the project checkout is a stated limit, the same exposure the actor had (O-F12) |
| Session or conversation deletion | Retirement stops custody and collects the runtime before disposal; failed collection refuses the deletion |
| Archive (conversation, session, bulk, project) | Stops custody before setting the flag; failed collection refuses the archive. Archive does not retire today, so this is new wiring (A-smaller 3, O-F12) |
| Stop in the UI | Offered while custody holds, not only while the row is `running`: the conversation observation exposes custody, and Stop appears with the background-activity indicator. `findBusyOtherConversations` counts custody as busy (O-F6) |
| MCP and capability saves from routes | MCP applies live as today. During a turn or segment Claude answers `skipped-turn-active` and the capability change is staged; it applies at the next provider-turn boundary (§4.1 step 2) |
| Memory preview, collaboration's runtime release | Read the core host. Collaboration claims are refused during custody, so its release only needs the core path for completeness (R§2.5) |

## 6. Stop, bound, death, shutdown, restart

**Stop during custody.**
- Stop closes the retained runtime, which ends background work and any segment.
- Custody settles `stopped`, with a loss notice.
- `settled` resolves when the process is confirmed collected. Failed collection keeps today's grant quarantine.
- A turn that has been stopped never opens custody, whenever the stop reached it (before its engine started, or after
  its result while its receipts settle): its runtime is closed while the turn still holds its grant.

**Loss notices.**
- A loss notice claims only a termination that was seen. When the runtime could not be confirmed collected, the
  person is told the stop could not be confirmed, and the agent's notice waits until it can be.
- Custody stays admitted until its loss is recorded for the agent. Its runtime, grant and busy-set entry are still
  released once collected. The next message's admission records the owed loss before the turn prepares its input,
  or refuses the message with the reason; boot records it otherwise (as `interrupted`, since the original end is
  not stored).

**Bound.**
- Custody ends after a constant 120 minutes (`timed_out`), with the loss notice. There is no new setting.
- The adapter's 30-minute wait demotion does not apply during custody.
- The bound is per custody attempt, so a handover starts a new one.
- A pending terminal notification (§2.1 rule 2) has a bound of its own, kept in the adapter, which alone knows task
  ends and turn starts. Debt for a task that ended while no CLI turn ran, with no turn started or coming within
  60 s, ends the session; the host hears it as death, so custody ends `lost` with its notice. Other tasks still
  running do not hold it off. A turn's result gives debt it left unanswered a fresh 60 s. Continuations start within
  about 100 ms (§9.1), so this only catches a CLI that never answers. The 2 s folded-notification grace is a separate,
  measured heuristic: one observed overlap does not bound every continuation delay. A continuation that starts later
  than the grace after a turn that folded nothing is the residual risk.

**Death.**
- The adapter's `onTerminated` fires on any runtime death, including an input-only custody with no tasks (A-smaller
  2, O-F10).
- Custody settles `lost`, and the host closes and collects the dead runtime.

**Shutdown.**
- `core.shutdown()` aborts custody like a running turn. The close records the loss notice, and custody settles
  `interrupted`.
- Boot then has nothing to add for it.

**Restart after a crash.**
- An admitted custody row is a crash.
- Boot first closes the worktree the custody held to turns and publications until 5 s after the server started
  (§9.1, probe 2), whether or not its notice can be recorded.
- Boot records its runtime-loss notice, keyed by the custody attempt id and therefore idempotent. The notice is
  persisted before the attempt is settled, so a second crash retries it (A-10).
- Boot then settles the attempt with the custody outcome. The domain outcome union and the repository's maximal
  round-trip fixture gain the custody shape (A-smaller 1).

**Surviving writers (A-4).** Probe 2 decides whether backgrounded Bash dies with its CLI on close and with the server
on `SIGTERM` and `SIGKILL`.
- **If it dies, custody ships as above.**
- **If it can survive,** custody holds a durable cleanup-unconfirmed hold until collection or a scoped manual
  attestation, the precedent being `captureExecutionStopped` (amendment 13). Until that hold exists, Claude is not
  declared retaining.
- The loss notice states what is known; it never claims termination it did not observe.

## 7. Cost and continuity

**Cost.**
- Segments settle their own result delta. The takeover's synthetic completion is a transfer boundary, not a billed
  segment (A-3).
- No other process resumes the session during custody: tasks, capture and claims are refused. After custody the
  runtime is released, and the next one seeds from the transcript as today. So the in-memory baseline cannot drift
  (R§4 F4).

**Continuity.** A segment's session ref and `clear` disposition are recorded the way a turn's are (R§3.2 inv. 11).

## 8. Persistence

No SQL migration is needed:
- `core_attempts.cause` is free text with no mailbox foreign key;
- `activeTurnSource` is not persisted.

The domain schemas change:
- the attempt outcome union gains `{ kind: "custody", end }`, and recovery writes it;
- the repository contract fixture covers it;
- the descriptor and port gain the owed-work capability and the live-input declaration.

## 9. Probes before implementation

These run against the installed Claude CLI through the adapter, on the dev instance. Each answers a question the
design depends on:

1. **Takeover and input attribution.** Is a prompt sent during a continuation folded in (the result names its uuid)
   or queued (it does not)? Cover:
   - both handover orders;
   - coalesced live inputs;
   - an input whose stdin write completes after the CLI produced a result but before CC processed it;
   - error and zero-work results that omit `user_message_uuid(s)` (V-2).
2. **Process lifetime.** After `q.close()`, after server `SIGTERM` and after server `SIGKILL`, does backgrounded Bash
   stop writing? Observe the writes, not only the parent PID.
3. **Task end to continuation.** Record the order in which these arrive when the last waitable task ends:
   - `background_tasks_changed`, terminal `task_updated` and `task_notification`;
   - the continuation's first frame;
   - its result, with its `origin`.

   Does every finished task produce an answering result, zero-work included? Cover replay on resume, a continuation
   that starts another task, and a task that finishes during a person's turn (V-1).
4. **Answer latency under load**, for the rule 2 bound: busy tools, queued sends, rate limits.
5. **Session state.** With `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, does `idle` follow every result, notification
   turn and queued input? Is the state `running` before any frame of a notification turn? Is `queued_turn_count`
   present on results?

If probe 1 or probe 2 fails, Claude is not declared retaining until the stated remedy exists.

### 9.1 Results (2026-10-12)

**Setup.** Installed CLI through SDK 0.3.284, Haiku, the adapter's input shape (one persistent channel, stamped
uuids, bypassed permissions), `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. Probe: `scripts/probes/claude-between-turns.ts`.
Evidence: `.cc/temp/c5b-probes/`.

1. **Attribution (probe 1): passed.**
   - **Folded.** Two live inputs sent during a foreground tool call were folded into the running turn. Its one result
     named all three uuids in `user_message_uuids`.
   - **Queued.** A prompt sent the instant a background task ended was **queued, not folded**. The CLI first ran the
     continuation; its result had `origin: task-notification` and no uuid. Then it ran the prompt as its own turn,
     whose result named it. The adapter's current takeover, which resolves the caller on the next result, would have
     answered the person with the continuation's text. The uuid rule in §4.1 is required, and it works.
   - **Crossing.** An input sent in the same tick as a result started its own turn 2 ms later, named by its result.
   - **Per-send lifecycle.** Every send produces undocumented `command_lifecycle` frames (`queued` → `started` →
     `completed`) carrying `command_uuid` = the stamped uuid. Coalesced sends complete together. This is the CLI's own
     per-input acknowledgement; rule 4 below uses it.
2. **Process lifetime (probe 2): passed, with a window.**
   - `close()` stops background Bash at once.
   - When the CLI's parent is killed (`SIGTERM` or `SIGKILL`), the CLI sees its stdin close. Background Bash keeps
     writing for about 5 s (4.8 s and 5.0 s measured), then stops, and no process survives.
   - A Command Center restart takes longer than that, so no durable cleanup hold is needed. **Slice 3 obligation:**
     boot does not admit a turn or a publication into a worktree that a recovered custody attempt held until 5 s after
     the server start. This check costs nothing on a normal restart and closes the window if a restart is ever faster.
3. **Task end to continuation (probe 3): passed.**
   - `background_tasks_changed: []`, the terminal `task_updated` and `task_notification` arrive in the same
     millisecond.
   - The CLI reports `session_state_changed: running` 75–90 ms later, then `init` and the continuation.
   - The continuation's result carries `origin: {kind: "task-notification"}`.
   - No zero-work result was observed. Replay on resume was not probed.
   - **A task that ends while a turn is still running** (it ended during the same turn's foreground command) has its
     notification **folded into that turn**. The turn's ordinary result is the only answer, and no continuation
     follows, even 35 s later.
   - **Two staggered background tasks** (A ends, then B ends while A's continuation is between tool rounds). B is
     **not** folded into A's continuation: A's result even reports B as still running. B gets its own continuation,
     starting 7 ms after A's result and carrying the `task-notification` origin.
4. **Latency (probe 4).** Continuations started within 100 ms of the task's end, and queued inputs within 2 ms of the
   previous result. A queued prompt waits for a running continuation to finish (about 3.5 s here).
5. **Session state (probe 5).** `idle` follows every result, including while a background task is still running. So
   `idle` means "no turn is running", not "nothing is owed", and it cannot replace rules 1 or 2. `queued_turn_count`
   is present on results.

**Rule refinements from the results.**
- **Rule 2's discharge:**
  - **Between turns.** Debt for a task that ended between turns is discharged by the result of a notification turn
    (origin `task-notification` or `auto-continuation`) that began after the task ended. A notification result
    discharges only the debt that was owed when its own turn began. Turn boundaries come from the CLI's own frames,
    so a caller taking over the stream is not one. `idle` is not used.
  - **During a turn.** Debt for a task that ended while any turn was running, a provider turn or a person's, gets a
    2 s grace after that turn's result. Continuations start within about 100 ms. If no turn starts in that window,
    the notification was folded in and the debt is discharged. If a turn starts, the debt is examined again after
    that turn's result, under the same two rules.
  - Only background tasks create debt: foreground Bash produces task frames but never a continuation.
- **Rule 4's clearing:** an input is also cleared by a result that names it, not only by its `completed` lifecycle
  frame. The caller's result arrives before that frame, and waiting for the frame would make every turn end owe work.
- **Rule 4's discharge:** an accepted input is answered when its `command_lifecycle` frame reaches `completed` (or a
  terminal `cancelled`). Caller attribution still uses `user_message_uuids` on results (§4.1).
- **Limits.** Haiku only; the results describe CLI behaviour, which the model should not change. Re-run the probe
  after a CLI upgrade.

## 10. Deliberately not done

- **No idle runtime retained for latency.** Keeping an idle runtime would need a pre-execution gate.
- **No pre-execution hook gate:** the `UserPromptSubmit` hook is not verified to fire for continuations.
- **No per-task stop**, and no `interrupt()`-based Stop.
- **No custody for seats, task turns or debug mode.**
- **No change to Codex or Cursor.**
- **No new turn source.**
- **No grant transfer API.**

## 11. Implementation slices

1. **Probes** (§9).
2. **Adapter:**
   - the owed-work answer and its event;
   - `onTerminated`;
   - uuid stamping and caller resolution by uuid;
   - the deferred external start and zero-work quietness;
   - one ordering barrier for external events;
   - the descriptor capability and conformance cases.
3. **Executor custody:**
   - turn-end disposition;
   - the custody attempt and outcome;
   - per-entry admission;
   - the ownership fence and segments;
   - handover with drift-first and turn-start apply;
   - Stop, bound, death, shutdown and boot.
4. **Live input on the retaining runtime.**
5. **Guards:**
   - merge and the session fence;
   - deletion and archive;
   - the Stop affordance;
   - core-host readers.

Each slice gets tests first and an Opus and Astra review. The live matrix runs on the dev instance:
- the last task finishes and its continuation runs;
- a message while all model slots are busy, with a continuation starting during the wait and Stop during it;
- background writing versus a lane publication, and versus a merge after its final check;
- checkpoint, debug and `/collab` refused during custody;
- live input during a turn, during a segment and in idle custody;
- Stop during custody;
- cost across segments;
- a server crash during custody, then boot, then a second boot;
- the dual race in both orders.

Core equivalents replace the actor-path tests marked RE-PROVE in R§5.1. The core tests marked CHANGE in R§5.4 change
with slice 3.
