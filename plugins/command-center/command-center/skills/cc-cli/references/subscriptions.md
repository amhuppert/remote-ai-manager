## Conversation subscriptions and inbox

Automatic passive follows belong to the current ordinary conversation, including
project conversations. Recorded involvement establishes them: supplied notepad
context, linked tickets, spec authorship/review and launched work. A read or
search alone does not create a follow.

```
cctl subscription list
cctl subscription unfollow <subscription-id>
cctl subscription wait workflow <execution-id> --reason "Continue after the workflow finishes"
cctl subscription wait validation <run-id> --reason "Inspect the verdict" --expires-in 3600
cctl subscription wait git_job <job-id> --reason "Inspect the git result"
cctl subscription waits
cctl subscription wait-get <subscription-id>
cctl inbox list
cctl inbox list --all --limit 20 --offset 20
cctl inbox get <delivery-id>
```

`subscription list` includes the reason, remembered opt-out and any source-read
problem. `unfollow` persists the opt-out so later involvement cannot silently
reactivate it. Existing delivery evidence remains available.

`inbox list` reconciles durable source changes and returns a bounded page.
Omission metadata names the next read. `get` returns one saved occurrence and its
source retrieval command. Neither read acknowledges delivery or starts a turn.
Use `--all` to include accepted history. An uncertain delivery needs inspection;
it is not automatically replayed. Runtime acceptance does not prove agent action.

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
provenance for inspection; it cannot be supplied by a caller. Each exact source
wakes at most once, and durable batching and rate limits bound generated turns.

`subscription waits` returns a bounded outline and scoped pagination/detail
commands. `wait-get` uses the subscription id to show the reason, source outcome,
expiry and wake batch. A settled source wait alone does not prove runtime
acceptance: inspect the batch state and the returned `inbox get` command for
delivery evidence. Failed or uncertain wake delivery requires inspection and is
not blindly replayed. Runtime acceptance does not prove agent action.

`subscription unfollow` cancels a wait before its wake is batched. Inspect a
batched wait with `wait-get` first. For an uncertain batch, the server also
permits cancellation if it proves that the canonical conversation queue has no
matching row and the transcript has no accepted input receipt. This cancels only
the selected wait and its inbox delivery. Other members stay unresolved; find
their subscription ids through `subscription waits` and unfollow each remaining
member, at most six per batch. Once every member is cancelled, the orphaned batch
closes and releases the conversation's wake limit. Nothing is resent.

A planned, queued or failed batch, or an uncertain batch with a queue row,
remains refused with `ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED`. Review the existing
queue delivery before retrying or discarding it. An accepted transcript receipt
is acceptance evidence and cannot be treated as a missing send. Mode changes,
advisory inbox hints and full UI controls are later deliverables.
