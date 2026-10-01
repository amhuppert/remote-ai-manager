# Conversation subscriptions and passive briefings

This direct implementation covers Command Center tickets #167 and #168. Alex
authorized implementation without a Native SDD spec. The delivery contract comes
from the Agent Subscriptions & Notifications brainstorm and Vision revision 31.

## Scope and ownership

The subscriptions domain owns durable follows, remembered opt-outs, source
cursors, an inbox, semantic batching, and input-acceptance receipts. The durable
record supports passive/active mode, event-kind selection, and optional expiry;
this release creates passive automatic follows and dispatches no active input. Domain source
records remain canonical. This is a local SQLite feature, not a general event
broker. Ordinary session and project conversations are eligible; workflow and
collaboration lanes are excluded.

Automatic follows arise from recorded involvement: supplied notepad references,
linked tickets, spec authorship/review, and launched workflows. A search result or
ordinary source read does not create a follow. Every follow exposes its reason.

Passive briefings accompany user messages only. Turn provenance must be explicit:
neither `autonomous: false` nor a queue drain proves a message came from the user.
Generated feedback, question-answer protocol messages and machine continuations
do not consume passive inbox items. The live user-input queue must obey the same
contract as a newly started turn.

Ticket #169 owns active dispatch. Ticket #170 owns the full controls UI, mode
changes, and advisory hint. Ticket #171 owns migration of existing notice paths.
This change supplies the small CLI/API surface needed to inspect the inbox and
remember an unfollow; it does not expose an active mode that cannot yet dispatch.

## Persistence and semantic interface

`src/lib/subscriptions/` owns schemas, service policy, and source adapters.
`src/lib/state-store/conversation-subscriptions-repo.ts` owns SQL. Additive tables
join the synchronous schema floor and ordered migration ledger. They do not
require a compatibility version bump. Repository contract tests reload real
SQLite rows with maximal field coverage.

Recipient identity is `{projectPath, conversationId}`. Conversation IDs are
durable across runtime replacement; the service resolves scope and eligibility
from the current conversation record. A source reference is `{kind, id}` with
an immutable domain ID; adapters check project/global visibility. Session names
and internal project sentinels are not subscription identities.

The shared contract uses these service operations:

- `autoFollow({recipient, source, reason, initialCursor?})`: baseline a genuinely
  new follow, preserve existing progress and explicit opt-outs.
- `reconcile(recipient)`: read facts from supported durable sources; atomically
  record matched inbox entries and advance each source cursor.
- `list(recipient)` and `unfollow(recipient, subscriptionId)`.
- `readInbox(recipient, {limit, offset, includeSettled?})` and
  `getDelivery(recipient, deliveryId)`: explicit inspection, without acknowledging
  input delivery.
- `prepareBriefing({recipient, attemptId, maxItems?, maxChars?})`: claim a bounded
  passive batch and return a block, `onInputAccepted`, and `finish` receipt.

Source adapters return a cursor, normalized facts, and a missing-source outcome.
A null cursor means establish a baseline, not replay the entire source history.
Normalized facts retain occurrence identity, event kind, source title, summary,
time, revision/outcome and retrieval handle. Actor provenance controls edit-echo
suppression; completion of launched work remains deliverable to its launcher.

The repository atomically compares the prior cursor, inserts deduplicated inbox
entries, and advances the cursor. Unique recipient/source occurrence identities
collapse overlapping follows and replay. Explicit unfollow persists as a
tombstone. Source deletion leaves an inspectable outcome rather than cascading
away inbox evidence.

## Reconciliation and delivery

Reconcile before user-message briefing and explicit inbox inspection. Source
adapters read durable revision/event logs where available, and terminal state
records where that is the domain contract. No browser connection or captured SSE
frame is required. State snapshots do not promise every intermediate transition.
Errors leave cursors unchanged and expose a diagnosable failure.

Initial adapters cover notepad revisions, ticket status/posts, spec events,
workflow events/results, registered validation outcomes and git-job outcomes.
Substantive involvement is discovered or recorded by the owning domain, never
inferred from an unverified author string in an SSE payload. Existing token plus
conversation identity may establish provenance without granting workflow caller
authority to a project conversation.

The initial semantic catalog has these recovery contracts:

| Source | Notable occurrence | Recovery | Automatic involvement |
| --- | --- | --- | --- |
| Notepad | Saved content revision or restore; revision identity and author | Durable revision records after the accepted-context watermark | Notepad actually supplied as accepted context |
| Ticket | Status transition and authored status post | Durable status-change IDs and post timestamp/ID cursor | Recorded conversation or current-session link |
| Spec | Revision, submitted review, approval/attention decision and execution change | Durable spec-event ID and actor | Recorded authorship/review event |
| Graph workflow | Named boundary such as approval, question, halt or completion | Durable graph-event ID, including archived executions | Execution's recorded launching conversation; existing CLI launch authority requires an ordinary session principal |
| Validation | Terminal outcome for one run | Durable run ID plus terminal state; no claim of intermediate event history | Explicit opt-in only |
| Git job | Terminal outcome for one job | Durable job ID plus terminal state | No inferred follow where launcher identity is absent |

Validation commands already return their results to the submitting caller, so
neither historical nor queued or running commands establish automatic follows.
An explicit passive subscription can collect the selected run's later outcome;
an explicit finite wait can observe its terminal result, including a run that
finished before registration.

Workflow launch authority remains owned by its existing principal checks. A
project conversation cannot use these subscription endpoints to acquire session
workflow-launch authority; the adapters can address a recorded origin without
changing who is allowed to launch work.

The adapters check project/global visibility before exposing facts. Standalone
attachment changes, dev-server URL changes, memory and alignment broadcasts are
not in this catalog. Spec intervention records are excluded from the feedback
stream; the existing intervention policy remains authoritative. Content revision
facts can be summarized together, while decisions and outcomes keep occurrence
identities. An `eventKinds` selection filters semantic facts before insertion;
`null` selects all applicable facts. Source disappearance always has its own
inspectable disposition.

Repeated content revisions may share a brief summary; distinct decisions,
validation runs and failure/success outcomes retain their own identities. The
inbox keeps inspectable facts even when the prompt is bounded. Overflow names an
actual CLI retrieval command. Source text is context, not privileged instructions.

Only backend input acceptance settles delivery. Claims are tied to an attempt;
unaccepted attempts and interrupted claims have a visible disposition. Acceptance
whose durable receipt is uncertain must not silently cause either loss or blind
redelivery. Runtime acceptance does not prove agent action. Inspection does not
change human read state or input-acceptance state.

Preparation checks current recipient eligibility. Archived/deleted recipients do
not receive generated input; lane recipients are refused. Forked conversations
have new IDs and do not copy stored watches, cursors or opt-outs. Their own
recorded involvement can independently qualify them for a passive follow,
including a ticket linked to their current session; active watches never inherit. Existing source protocols,
approval authority and memory visibility remain unchanged.

## Verification

Use red-green-refactor with registered single-file tests, including real SQLite
reloads. Prove opt-out retention, source-cursor/delivery atomicity, restart
reconciliation, same-actor edit suppression versus launched outcomes, semantic
coalescing, bounded overflow, source deletion, and uncertain input receipts.

Production wiring tests cover both ordinary scopes, direct and queued user
input, machine turns leaving passive pending, and exact acceptance behavior.
CLI tests exercise the actual command registry and mounted scope-specific API
routes. Finish with registered typecheck, seams, lint and affected tests, then
verify the passive user journey against this worktree's dev instance and durable
state.

### Live verification completed

On 2026-09-30, exercised this worktree's isolated dev instance with a scratch
project, a Codex session conversation, and a Claude project conversation. Both
received a supplied notepad revision, then received a later human revision only
on their next user message. SQLite receipts moved from pending to accepted once;
CLI inbox inspection alone left them pending.

A generated direct turn and generated input delivered during a running Codex turn
left unrelated passive changes pending with zero delivery attempts. At that time,
a registered validation launched by the session conversation was automatically
followed and appeared alongside the next notepad briefing; validation following
now requires the explicit opt-in described above. Project-attributed edits were
suppressed, and an explicit unfollow prevented both subscription and legacy
notepad content notices on the next user message.

Restarting the dev server retained follows, cursors, receipts, and the opt-out.
Deleting a second notepad immediately after its context was accepted, before any
subscription inspection, produced a durable `source_missing` notice. The follow
already existed before the source was deleted.

The scratch session was deleted, its project conversation archived, the test
notepads removed, and the dev server stopped after verification. Evidence is in
the task's ignored `.cc/temp/subscriptions-live/` directory; no managing-server
configuration was changed.

### Automated verification completed

Registered format, lint, full-project typecheck, and architecture seam checks
passed. Full-suite run `vrun-20bf157f-fee8-46ec-8657-d1d7bb34a407` completed with
29,470 tests passing, six skipped, and two fixture failures. The standalone Claude
queue fixture needed to disable a production subscription dependency outside its
scope, and the checkpoint acquisition fixture needed to assert the runtime's new
receipt-owner callback.

Both fixtures were corrected without production changes. Their registered
single-file reruns passed (`vrun-e0372482-6ac8-4a36-a3a6-2fd48dff2967` and
`vrun-c0b780d6-092e-4fae-a174-f5de6fc37b43`), as did the ordinary-turn and live-queue
receipt integration reruns. Each focused run matched one file. The full suite was
not repeated after these fixture-only corrections.
