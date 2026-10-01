## Conversation subscriptions and inbox

Automatic passive follows belong to the current ordinary conversation, including
project conversations. Recorded involvement establishes them: supplied notepad
context, linked tickets, spec authorship/review and launched graph workflows.
Validation runs require an explicit subscription or finite wait; submitting a
validation command does not create a follow, even while it is queued or running.
A read or search alone does not create a follow.

Spec review feedback uses the passive inbox for ordinary session and project
conversations. It arrives with the next user message even when the runtime
already exists. Lost-background-task reminders use the same durable receipts
but reach the next replacement runtime, including generated turns and workflow
roles. Internal `conversation` sources
contain notices for their own recipient; they are not peer-turn subscriptions
and cannot be created through the catalog. `inbox get` exposes the full preserved
text when a notice's briefing contains only a preview.

```
cctl subscription catalog
cctl subscription subscribe notepad <notepad-id> --reason "Track decisions"
cctl subscription subscribe workflow <execution-id> --reason "Continue after completion" --mode active --expires-in 3600
cctl subscription list
cctl subscription get <subscription-id>
cctl subscription pause <subscription-id>
cctl subscription resume <subscription-id>
cctl subscription mode <subscription-id> passive
cctl subscription cancel <subscription-id>
cctl subscription unfollow <subscription-id>
cctl subscription wait workflow <execution-id> --reason "Continue after the workflow finishes"
cctl subscription wait validation <run-id> --reason "Inspect the verdict" --expires-in 3600
cctl subscription wait git_job <job-id> --reason "Inspect the git result"
cctl subscription waits
cctl subscription wait-get <subscription-id>
cctl subscription wait-get <subscription-id> --wait-id <generation-id>
cctl inbox list
cctl inbox list --all --limit 20 --offset 20
cctl inbox get <delivery-id>
cctl inbox summary
cctl inbox hints off
cctl inbox hints on
```

`subscription catalog` names source identity requirements, supported event ids
and allowed modes. Use the exact source id: ticket UUID, native spec id, notepad
id, workflow execution id, validation run id or git job id. A ticket number or
spec slug is not the source id. The catalog needs server credentials, but no
conversation identity.

`subscription subscribe` explicitly creates or updates a follow, including a
remembered general passive opt-out, and deliberately resumes delivery. Passive
mode is the default. Repeat `--event-kind <id>` to
select catalog events; omit it to follow all supported events. Event selection
is for passive subscriptions. Use `--reason-file <path>` for literal prose.
Active mode registers a finite terminal wait and returns immediately, with the
same lifetime and lease constraints as `subscription wait` below.
An existing finite wait retains its exact reason and expiry. A changed reason
returns `ACTIVE_WAIT_REASON_LOCKED`; a changed expiry returns
`ACTIVE_WAIT_EXPIRY_LOCKED`. Explicit active registration after cancellation or
settlement creates a new generation when another outcome can be delivered.
An already consumed final outcome returns `ACTIVE_WAIT_SOURCE_FINAL`; register
a different operation's exact source instead. An undelivered terminal outcome
remains eligible, and a consumed resumable workflow halt can wait for the next
boundary after the workflow resumes.

`subscription list` returns bounded reason excerpts, expiry, pause state, remembered
opt-outs and source-read problems. Text and JSON contain the same selected data.
Each row includes a stable id and scoped `subscription get` command. Detail
shows the full reason, cursor, finite wait and wake batch. `pause` holds delivery
and waking while source collection and the finite expiry clock continue.
Outcomes remain inspectable. It safely withdraws a pending wake or an unsent
planned batch, subject to the queue evidence described below. `resume` resumes
delivery of retained outcomes; it does not recreate a cancelled wait or clear
an opt-out for public sources. For an internal own-conversation notice source,
`resume` also restores passive following after `unfollow`; public `subscribe`
does not create these internal sources. Accepted turns cannot be recalled.

`subscription mode` changes an existing follow to passive or to a finite active
wait. Active mode supports only exact terminal sources: workflow, validation
and git_job. Use `--expires-in` when creating a finite wait; an existing wait's
expiry is immutable. Mode changes retain pause state. Passive mode keeps the
finite wait and its outcome, including an expired outcome for the next explicit
user message. A pending or unsent planned wake can be safely withdrawn on
downgrade; an unsafe delivery needs queue review. `cancel` cancels a finite wait with the same queue
evidence checks as `unfollow`; `unfollow` remembers a general source opt-out so
later involvement cannot silently reactivate it. Existing delivery evidence
remains available.

Cancelling a running validation or git-job wait restores passive collection of
its eventual result. Once that source's terminal result is accepted or dismissed,
its follow expires and leaves the active Following count. The follow, wait
generations and delivery evidence remain inspectable as history. Workflow
following continues because a halted workflow can resume and produce more
boundaries.

`inbox list` reconciles durable source changes and returns a bounded page.
Omission metadata names the next read. Outline excerpts include their original
character count and a scoped detail command. `get` returns one saved occurrence and its
source retrieval command. Neither read acknowledges delivery or starts a turn.
Use `--all` to include accepted history. An uncertain delivery needs inspection;
it is not automatically replayed. Runtime acceptance does not prove agent action.

`inbox summary` reads the recorded pending count and hint preference without
reconciling sources or changing delivery/read state. Advisory hints default to
on for ordinary conversations. After a successful command, an attributable
conversation may receive a compact pending count and `inbox list` hint. Hints
never deliver contents, acknowledge input or start a turn, and remain optional.
Command-specific hints take precedence. Offline help, lanes and commands aimed
at a different conversation do not query an inbox for hints. A bounded summary
request failure silently omits the hint.

`inbox hints off` persists the preference for the addressed conversation;
`inbox hints on` restores it. Inspect the current preference with `inbox summary`.
Explicit inbox inspection remains available with hints disabled.

Passive updates accompany the user's next message. Generated turns and feedback
do not consume unrelated pending updates. Repeated revisions may be summarized,
while separate decisions and run outcomes retain their identities.

Scope comes from the injected conversation environment. Explicit project,
session and conversation flags address a different target within the authorized
scope. Project conversations use their project route and never a placeholder
session. Workflow lanes retain their assigned context policy and cannot use this
subscription surface.

`subscription wait` registers an explicit wait for the exact workflow execution,
validation run or git job to reach a terminal state, then returns immediately
with the wait id, subscription id, state and expiry. It does not poll or block.
Use `--reason-file <path>` for literal prose. The default lifetime is 24 hours;
`--expires-in` accepts 1 to 604800 seconds (7 days). Arbitrary predicates and
nonterminal source kinds are not supported.

A validation wait observes the run; it does not detach `validate run` or renew
its private submitter lease. The submitting command must keep observing a leased
run, or the lease can expire and interrupt it; that interruption is a terminal
result too. System-owned runs have their own lifecycle. Launching validation and
yielding safely needs a separate server-owned lease-transfer feature. For a
launch-and-yield flow today, use a nonblocking graph workflow execution and
register its exact execution id.

The server checks durable source state, including a source that finished before
registration, and queues a bounded result turn for this ordinary conversation.
Several ready waits may share one turn. A missing source or expired wait settles
with that outcome. Paused conversations retain their queued wake for later.
Runtime replacement does not erase the wait. The server records wake-turn
provenance for inspection; it cannot be supplied by a caller. Each generation
reserves one outcome, and durable batching and rate limits bound generated turns.

`subscription waits` returns a bounded outline and scoped pagination/detail
commands. `wait-get` uses the subscription id for the latest generation, or
`--wait-id` for the exact historical generation printed by `waits`. Both show
the reason, source outcome, expiry and wake batch. Historical handles keep
identifying that generation after another is registered. A settled source wait alone does not prove runtime
acceptance: inspect the batch state and the returned `inbox get` command for
delivery evidence. Failed or uncertain wake delivery requires inspection and is
not blindly replayed. Runtime acceptance does not prove agent action.

`pause`, passive mode, `cancel` and `unfollow` can safely withdraw a whole pending
wake row, or release a planned batch with no queue row. They cancel that batch
and release all member claims. Other waits remain ready and pending, and can
batch again. A batch marked queued with no queue row requires review; absence
alone does not prove that it was never delivered.

A delivering, failed or ambiguous wake remains refused with
`ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED`. Inspect its queue and delivery evidence
before retrying. For an uncertain batch, explicit `cancel` or `unfollow` also
permits discarding the selected member if the server proves that the canonical
conversation queue has no matching row and the transcript has no accepted input
receipt. Other members stay unresolved until separately cancelled; the last
cancellation closes that orphaned batch and releases its wake limit. Nothing
is resent. An accepted transcript receipt is immutable acceptance evidence and
cannot be treated as a missing send or recalled turn.
