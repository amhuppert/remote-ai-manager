# Recoverable one-time subscription wakeups

Ticket: command-center#169. Builds on the subscription foundation and passive
briefings in `agent-subscriptions-passive.md`.

An ordinary session or project conversation registers a finite wait for one exact
graph execution, registered validation run, or git job. It supplies the reason
for returning to that work. Registration returns immediately; the conversation
can end its turn. A terminal result causes one generated message at an eligible
turn boundary. Automatically discovered involvement remains passive.

## Durable ownership

The existing subscription remains the source/recipient identity and the existing
inbox remains the result and delivery evidence. A one-time wait stores its own
terminal condition and settlement independently of the passive source cursor.
Explicit registration can promote an existing follow, including a remembered
opt-out; automatic involvement never promotes or rearms it. Repeating registration
while its wait is waiting or ready returns that same generation and keeps its
deadline. A paused, passive or unfollowed live wait requires explicit control
restoration; repeating `subscription wait` does not silently restore it.
After settlement or cancellation, explicit active registration can create a new
generation while preserving history. Only an accepted or explicitly dismissed
terminal occurrence establishes its baseline. A terminal result that has never
been delivered remains obtainable immediately, including after cancellation or
expiry. An unresolved queued or uncertain input receipt remains held for review.
An already consumed validation, git job, or final workflow result refuses rearm
with `ACTIVE_WAIT_SOURCE_FINAL`; it cannot promise another outcome. A consumed
workflow halt can be rearmed only when the canonical lifecycle classifier says
the execution can resume. The new generation waits for a later boundary.

Registration verifies source existence before writing. Its passive source
cursor is established at registration, so workflow gates arriving before the
first sweep remain visible. The same source
reader reconciles pending waits periodically and after server startup. Workflow
terminality uses the graph lifecycle classifier; paused workflows remain pending,
while completed, halted and aborted executions settle. Validation uses its
canonical terminal classifier. Git jobs settle once their durable status is no
longer running, including a prepared result that still needs human landing.
The wait reports the source outcome; it does not approve or land anything.
Workflow follows continue collecting approval, question and later result
boundaries during a finite wait. Only the exact ready terminal delivery is
reserved for its active wake, and shared occurrence identity prevents a second
passive delivery. Accepted or dismissed outcomes spend the wait. A workflow
returns to passive following. A validation or git job follow ends its effective
lifetime when its actual terminal result is accepted or dismissed, including
passive delivery after cancellation or expiry. Its subscription and receipt
history remain inspectable. Cancellation or expiry while the source is still
running preserves passive collection of the eventual result. Historical waits
do not reserve later passive results; only a waiting generation or its ready
terminal outcome owns that ingestion.

Terminal outcome, missing-source notice or expiry is recorded with a stable
occurrence identity and retrieval handle. Source records remain authoritative.
The one-time policy does not depend on seeing an SSE frame, and does not resume
an interrupted job or workflow. Source recovery runs before wake dispatch starts.

## Queue handoff and delivery

A durable wake batch reserves at most six ready waits. Its ID is also the
initial queue message ID. A surviving queue row can be recovered without
creating another row. Handoff intent is persisted before enqueue: if a crash
leaves no queue row and no accepted transcript receipt, the batch becomes an
inspectable uncertain delivery rather than being resent automatically. An
explicit queue retry retains the batch identity even when its queue row changes.
The batch saves its bounded rendered message and causation IDs. There is at most
one unresolved wake batch per conversation, with at most three new batches per
minute. A wait is one-time;
failed or uncertain input does not generate another automatic attempt.

Queue metadata marks subscription input explicitly. It always has generated
provenance and next-turn delivery. It is never delivered into an ongoing turn or
coalesced with a human message. Pending human messages and question answers take
priority over wake rows, preserving their order even after answer submission has
cleared the pending-question marker. Queue claiming and final lifecycle admission
both check the recipient and its holds, because enqueue-time checks alone cannot
protect a question that opens later.

Pending human questions, checkpoint holds and applicable conversation approval
holds prevent wake admission. Archived conversations, workflow lanes and
conversations owned by another orchestrator are ineligible. A spec proposal
awaiting approval is not a blanket freeze on its author's unrelated work;
existing operation-specific approval rules still apply to every action after a
wake. Notifications grant no authority.

Backend input acceptance is evidenced by the canonical queue transcript archive,
which is written before accepted queue rows are removed. A known batch/message
ID in that archive proves input acceptance, not that the agent performed the
requested follow-up. Missing queue rows without that evidence are uncertain.
Explicit queue review owns retry or discard; the wake dispatcher never infers
that an ambiguous send is safe to repeat. If an uncertain batch has no queue
row and no acceptance receipt, explicit unfollow can discard one member at a
time. `cancel` ends the selected finite wait and preserves passive following;
`unfollow` also records the source opt-out. The server proves absence and
rechecks the batch state in the write
transaction. Other members remain unresolved; cancelling the last member
releases the batch governor without replaying it. Withdrawn input is superseded,
never accepted. Unbatched proven-failed input can become pending again; queued or
uncertain input is held for explicit review. Those holds remain inspectable but
do not count as actionable pending delivery.

## Scope

The CLI provides explicit registration and bounded wait inspection. Full UI
controls and advisory hints are covered by the follow-up subscription-controls
work. Recurring watches, one-shot agent-run completion and mid-turn interruption
remain outside this contract.
Generated wake turns do not consume unrelated passive briefings; those remain
attached to the user's next message.

Registered validation runs retain their existing ownership and lease rules.
Registering a wake does not renew a submitter lease or detach a blocking
`validate run`; a lost lease still produces its normal interruption outcome.
A durable launch-and-yield validation command would need an explicit ownership
transfer and is outside this change. Graph workflow launch is already detached.

The state schema advances to version 24 because older readers cannot decode the
new persisted queue metadata. Wait generations now require schema version 28:
ordered migration 0065 preserves historical waits, allows only one live
generation per subscription, restores spent active follows to passive, and
supersedes proven withdrawn legacy receipts without inventing acceptance.
Data migration 0067 retires consumed finite-source follows and restores the
known running cursor for legacy finite waits with no saved source cursor, so
their eventual result is not silently baselined away. Historical generations
can be inspected with `subscription wait-get <subscription-id>
--wait-id=<generation-id>`; the default selector remains the latest generation.
Startup applies the compatibility barrier before
accepting wake rows; the live managing instance is not changed by development.

## Verification

Behavior tests cover current-state registration, restart reconciliation, source
failure and interruption, bounded batches/rates, receipt recovery and hold races.
Live verification used only the worktree-local dev instance and a scratch
project. A Codex session launched review workflow
`eafac744-ece8-4994-a74e-e0b8a12fa700`, registered its wait, ended its turn, and
received `WAKE_REVIEW_RECEIVED 4817` after the workflow completed. A Claude
project conversation received the already-failed validation
`vrun-6d685ccb-be38-4a99-8305-6279e197178d` and completed git commit job
`1686cd30-d14b-4496-a072-ab454071618b`. Six wake batches reached durable input
acceptance across these probes.

The pending-question probe exposed an answer-ordering defect after the answer
route consumed its question marker. Queue selection was corrected and the
regression test first reproduced that failure. On the repeated live probe,
question `q_33f43f26-e811-4c93-8b94-3829153d2a69` and its pending wake survived a
server restart. After answer submission, the transcript recorded
`HOLD_ANSWER_RECEIVED` at 16:45:38 UTC, followed by `HOLD_WAKE_RECEIVED passed`
at 16:45:44 UTC. The question was not consumed by the wake, and the wake did not
precede the human answer. Local evidence: `.cc/temp/wakes-live/evidence.json`.

Focused queue-priority regression: `vrun-a3fc2fbe-07bf-4742-9748-bd8949ccda64`.
Existing queue/drain/prompt regressions: `vrun-419ba195-d38c-46d9-b32a-22916acc8d56`.
Core source/persistence/passive compatibility checks:
`vrun-cdbf6e91-656f-41ce-b80f-6418a1522137`.

The broader run also exposed a checkpoint scheduling regression: awaiting an
external wake hold before entering the serialized queue mutation let an empty
drain capture ordinary input that arrived later. Ordinary claims now enter the
mutation immediately; only an actual wake candidate requires that extra hold
read and a second serialized eligibility check. Both checkpoint suites passed
unchanged (103 tests): `vrun-f2ab0bb5-165b-48e7-9c84-80697c2d9a87`.

Final registered checks after the queue fix all passed:

| Check | Scope | Run |
| --- | --- | --- |
| Tests (`--require-match`) | Changed dependency set | `vrun-855a8b68-5f81-494a-8019-20ae5dc6794b` |
| Typecheck | Full | `vrun-22222bf9-eae4-48f1-bc4d-0233ab16771b` |
| Architecture seams | Full | `vrun-43d34042-2d27-427e-ac0e-5a4913d91073` |
| Lint | Changed | `vrun-24661393-7c8b-42a0-a10e-afb902b02aad` |
| Format | Changed | `vrun-a1b58b12-abbe-46e2-92ff-f8ed3711259b` |

The test verdict covers the changed dependency set, not a separately requested
full-suite run. The scratch sessions were removed and the dev server stopped.
