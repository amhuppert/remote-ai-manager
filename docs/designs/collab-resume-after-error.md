# Resumable collaborations after error (command-center#81)

Status: IMPLEMENTED — revision 3

All five gates green (test full, typecheck, seams, lint, build). Not yet
live-tested against real models.
Scope: Collaboration Mode, conversation path (`src/lib/workflows/collaboration/`),
plus the conversation-ownership seam it depends on.

Revision history:
- rev 1 — REJECTed by Codex (`docs/reports/codex-review-collab-resume-after-error.md`), 12 blocking findings.
- rev 2 — REJECTed at 6/10 (`docs/reports/codex-review2-collab-resume-after-error.md`); 2 findings closed, 8 partial, 2 not closed.
- rev 3 — this document. Three scope decisions from Alex (§2) resolve the
  remaining findings, mostly by *removing* the surface that carried them.

## 1. Problem

When a Collaboration Mode run hits a transient error — a model outage, a
timeout, a quota wall, or a server restart — the run is destroyed. The envelope
goes to `failed` and nothing can move it out again. Every artifact the two
agents produced is still on disk, but the only supported way forward is to start
over, paying for every round again.

## 2. Decisions taken

**D1 — Resume the negotiation window only.** A failed run is resumable when its
recorded stream is a clean prefix that has *not* reached a clarification gate
(`open_conflicts`) and has *not* begun the final answer (`final_answer`). Those
two windows refuse explicitly with restart advice.

This is what makes revision 3 tractable. The two hardest correctness problems in
revision 2 — proving the user actually consented to a clarification gate, and
delivering the final answer exactly once — are not solved, they are **excluded
by an eligibility check**, which is a claim the code can actually keep. The
gate-consumption receipt, the content-bound transcript digest, and the
idempotent-delivery protocol are all deleted from the design.

**D2 — Fix conversation ownership properly.** A durable owner plus a turn
generation incremented at admission, honored by ordinary prompt admission.
Revision 2's `claimedPromptCount + isConversationBusy` heuristic is abandoned:
it cannot distinguish a dead collaboration from a dead ordinary prompt, and a
cached conversation actor can write back exactly the claimed count.

**D3 — Refuse runs without their exact staffing snapshot**, including the
existing paused-resume path. One rule, no special case, no silently substituted
agent configuration.

## 3. Why it is not resumable today

1. **The envelope is frozen.** `updateEnvelope` (`envelope.ts:822-843`) refuses
   to mutate a `completed`/`failed` envelope.
2. **`manager.resume` rejects it** — `status !== "paused"` plus a mandatory
   pause-token match (`manager.ts:1604-1612`).
3. **Slice re-entry is not idempotent.** `initializeEnvelope` short-circuits
   only for an `open_conflicts` artifact *and* an `input.resume` payload
   (`envelope.ts:689-725`); otherwise re-entry restarts at the drafts and
   re-appends duplicate artifacts.
4. **The advertised restart recovery does not work.** `instrumentation.node.ts:326-336`
   marks an interrupted run `paused` with a `recovery-<id>` token no client can
   supply, commented as replaying "from the last completed round". Because of
   (3) it re-runs everything.
5. **The conversation is released and nothing re-claims it** (`failRun` →
   `markConversationAwaiting`).

## 4. The organising idea

**The sidecar is a log of recorded model outputs that may be reused. It is not
an exactly-once step log.**

A call can complete, bill, advance the lane ref and write worktree files, then
crash before its line is appended (`helpers.ts:282-311`). The invariant is
one-directional:

> A recorded artifact means the step happened and its output can be reused.
> An absent artifact means the step must be run again.

That is at-least-once execution of model calls, which is safe: re-running a
draft or a proposal overwrites its own deterministic artifact paths and costs
money, nothing more. It is *not* safe for gate consumption or final delivery —
which is exactly why D1 excludes them.

## 5. Design

### 5.1 The step ledger, fail-closed and fork-aware

New module `src/lib/workflows/collaboration/step-ledger.ts`.

```ts
export type CollaborationLedgerOutcome =
  | { kind: "ok"; ledger: CollaborationStepLedger }
  | { kind: "empty" }
  | { kind: "unusable"; reason: LedgerRejection };

export type LedgerRejection =
  | { code: "unreadable"; detail: string }
  | { code: "corrupt_lines"; lineIndexes: number[] }
  | { code: "duplicate_step"; step: string }
  | { code: "noncanonical_step"; step: string; detail: string }
  | { code: "causal_gap"; missing: string; before: string };

export interface CollaborationStepLedger {
  replay<S extends CollaborationStepKey>(step: S): StepArtifactFor<S> | null;
  readonly recorded: readonly CollaborationArtifact[];
  readonly negotiationRoundsCompleted: number;
  /** Present when the stream reached a clarification gate or a final answer.
   *  D1 refuses to resume either; the eligibility check reads this. */
  readonly reachedGate: boolean;
  readonly reachedFinal: boolean;
}
```

`buildCollaborationStepLedger(stream, snapshot)` is pure — no I/O — so every
rejection is directly testable. It takes the executable snapshot as well as the
stream because canonicality depends on it (round bounds, expected agents).

**The draft phase is a fork, not a prefix.** This was revision 2's worst bug.
When Agent One's call fails and Agent Two's succeeds, the phase still tracks
Agent Two's draft and then fails (`initial-draft.ts:104-190`, pinned by
`envelope.test.ts:1046-1080`), so the sidecar legitimately contains **`[I2]`
alone** — which is precisely this ticket's headline case, one model having an
outage. Revision 2's grammar would have refused it, and its own replay would
then produce `[I2,I1]`, which an append-only file can never reorder into
`[I1,I2]`.

So `initial_draft` is modelled as an unordered two-element frontier: zero, one,
or both drafts in either on-disk order are all valid. The **in-memory tracker**
is canonicalised at the join (agent_one before agent_two) so prompt history is
stable regardless of disk order; the file is never reordered.

Everything after the join is a strict linear prefix: `cross_review`, then rounds
`1..k` each `proposed_changes → counter_proposal → resolution_decision` with
only the trailing round partial, then optional `open_conflicts`, then optional
`final_answer`.

**Canonicality is checked against the snapshot,** because the storage schema
alone is permissive — it accepts either agent and arbitrary integer rounds for
drafts and cross-review, and no agent at all for `open_conflicts`
(`collaboration-schemas.ts:409-448,470-480,558-609`). The ledger requires the
expected agent/target per kind, round 0 for drafts and cross-review, positive
contiguous negotiation rounds within the snapshot's configured maximum, and
gate/final round agreement.

**The read must be discriminated.** `readCollaborationArtifacts` returns `[]`
both for "no file" and "read threw", and silently drops schema-invalid lines
(`artifacts-store.ts:149-199`) — under revision 1 a transient read error would
have re-dispatched the whole run as fresh. Add
`readCollaborationArtifactStream()` returning
`{ kind: "absent" } | { kind: "ok"; entries; skipped } | { kind: "unreadable"; error }`.
Resume consumes the strict reader; display paths keep the lenient one.

Duplicates arise today from the broken restart path. Policy: **refuse**, naming
restart. Choosing between two attempts' lines is how attempts get spliced.

**Replayed files are validated before the first live call.** A replayed artifact
names generated markdown files that may since have been deleted or truncated. On
resume, every replayed artifact's referenced files are checked for existence and
readability; a missing one is a terminal refusal, not a silent bad prompt. This
also covers the narrow torn-file case from a concurrent stale attempt.

### 5.2 Step seam

Extract the produce half only:

```ts
/** Replay or produce one step's artifact. Never commits, never terminalizes:
 *  a key already in the ledger returns its recorded artifact with no model
 *  call; otherwise the step is built, dispatched, parsed, and its generated
 *  files validated. The caller decides what a failure means and when to
 *  commit — the parallel draft phase must gather both peers before either. */
produceCollaborationStep(ctx): Promise<
  | { kind: "replayed"; artifact: T }
  | { kind: "produced"; artifact: T }
  | { kind: "failed"; errorSummary: string; cause: CollaborationFailureCause }>
```

Commit (`trackArtifact` + `persistArtifactsSnapshot`) and `failRun` stay in the
phase files, so the draft phase keeps its gather-then-commit ordering and its
"process both outcomes before failing" behaviour. A replayed artifact is never
committed — its line is on disk and its entry is already in the tracker.

`final_answer` uses produce only; `finalizeFinal` keeps sole ownership of
tracking it (`envelope.ts:1002-1013`), so it is appended exactly once.

### 5.3 Attempt epoch

Once a resume flips the envelope to `running`, terminal status stops fencing the
previous attempt — status is not worker identity — and
`markEnvelopeFailedAfterSliceThrow` bypasses the guard entirely with an
unconditional `repo.update` (`manager.ts:171-212`).

The claim mints a durable monotonic `attemptEpoch` on the feature snapshot,
threaded into `AsymmetricCollaborationSliceInput`. Every durable write that can
outlive its attempt checks it inside the store mutator and no-ops on mismatch:

| Write | Site |
|---|---|
| Envelope transitions | `updateEnvelope` (`envelope.ts`), `markEnvelopeFailedAfterSliceThrow` (`manager.ts:171-212`) |
| Sidecar append | `trackArtifact`'s sink (`helpers.ts:55-62`) |
| Conversation status / backend ref / ownership release | `deps-factory.ts:181-255` |
| Lane outcome record | `callPrimitive` (`helpers.ts:304-309`) |
| Status publication and push | the `publishStatus` / `dispatchPush` seams, which must fire only on an applied write |

Stop **revokes** the attempt (increments the epoch) so an in-flight call cannot
commit after it.

Two related fixes: `initializeEnvelope` currently writes `status: "running"`
unconditionally (`envelope.ts:701-753`) and can reopen a just-stopped envelope —
it becomes epoch-checked; and the stop registry's `release(workflowId)` deletes
whatever controller holds the key (`manager.ts:871-891`) when the shared
registry already exposes compare-and-delete (`abort-registry.ts:49-67`).

**Accepted residual:** generated worktree files are *not* epoch-fenced. Both
attempts write the same deterministic paths (`artifact-files.ts:35-91`). Staging
and promotion would fix it; the window requires a live worker whose envelope has
already left `running`, which the claim's `from` set makes unreachable except
across two server processes sharing one config dir. Replayed-file validation
(§5.1) catches the observable consequence. Documented, not silently assumed.

### 5.4 Failure cause and class

`resolution_decision` is persisted before policy evaluation
(`resolution.ts:245-264`) and `next_action: "fail"` maps deterministically to
policy failure (`policy.ts:104-115`) — offering Resume there would replay the
same decision forever.

A typed `CollaborationFailureCause` union covers every failure site, with a pure
exhaustive mapping to `operational | terminal`:

| Cause | Class |
|---|---|
| `agent_call` (normalized backend failure) | operational |
| `structured_output` (parse / injection / exhausted) | operational |
| `artifact_files` (generated file invalid or unreadable) | operational |
| `process_restart` | operational |
| `unhandled` (manager or slice throw) | operational |
| `policy_fail` | terminal |
| `ledger_unusable` | terminal |
| `missing_premise` (snapshot ineligible) | terminal |
| `user_stopped` | terminal (not a failure; never offers resume) |

The class is **not** derived from the backend's `retryable` flag: that answers
"is re-running this call immediately safe", which is a different question from
"may the user resume this run later, after the outage passes" — a quota or
timeout failure is `retryable: false` and still operationally resumable
(`agent-call-vocabulary.ts:192-208`).

`callPrimitive` carries the normalized failure through (`failureKind`,
`retryable`, `retryAfterHint`) instead of flattening it to a string, so the UI
can say *why* it failed.

### 5.5 Resume eligibility

Checked before any state change, so a refusal leaves the run exactly as it was.
Eligibility is also projected onto the envelope the UI already reads, so the
Resume control disappears without anything being mutated — revision 2 had the
contradiction that discovering an unusable ledger was "terminal" while refusals
changed no state, leaving the button offered forever.

| Gate | Refusal |
|---|---|
| `failureClass === "operational"` | 409, restart advised |
| Executable snapshot parses in full (§5.6) | 409, restart advised |
| Ledger outcome is `ok` or `empty` | 409, naming the rejection |
| `!ledger.reachedGate` (D1) | 409, restart advised |
| `!ledger.reachedFinal` (D1) | 409, restart advised |
| Every replayed artifact's files readable | 409, restart advised |
| Conversation still owned (§5.7) | 409 conflict |
| `expectedAttemptEpoch` matches | 409 stale |

An `empty` ledger is resumable only when nothing durable claims earlier
progress: an empty stream with a non-zero recorded round count means the sidecar
was lost, which is data loss rather than a fresh run, and refuses.

### 5.6 The executable snapshot (D3)

A versioned, **strict** schema — not three field-presence probes against a
permissive `passthrough` record (`feature-snapshot.ts:39-58`). Today's resume
defaults missing brief, rounds, backend and threshold
(`manager.ts:1632-1657,1764-1767`); all such defaults are removed from the
executable path.

Required: `brief`, `conversationId`, both agents with their resolved model,
effort, fast-mode and profile snapshots, `negotiationRounds`,
`autonomousResolutionThreshold`, captured `sessionContext`, `claimedTurnGeneration`,
`attemptEpoch`, and durable `imageRefs`.

**Image replay is new and load-bearing here.** Start passes `imageRefs` into
both initial-draft calls (`manager.ts:1467-1481`) but `initializeEnvelope` never
persists them (`envelope.ts:734-751`). Since D1's whole point is that an
initial-draft failure is the headline resumable case, a resume that re-runs a
draft without its images would silently change the input. The refs are durable
file pointers (`transcript.ts:4-31`), so they are persisted on the snapshot and
replayed.

Cross-field consistency is validated (Agent One's backend equals the primary
backend). A record that fails the strict parse refuses with restart advice —
including on the existing paused path (D3).

### 5.7 Conversation ownership (D2)

The failed run released the conversation. Re-taking it cannot be inferred from
status or prompt count:

- a completed turn returns the row to `awaiting` with a **higher** `promptCount`
  (`machine.ts:889-914`);
- `ensureConversationActor` returns a **cached** actor that never re-reads the
  row (`conversation/manager.ts:633-665`), so a stale actor holding the
  pre-collaboration count writes back exactly the claimed count, erasing the
  evidence;
- a restart leaves the row at the pre-crash `running`, because rehydration
  restores only actors with a pending question and never repairs the persisted
  status (`conversation/rehydration.ts:50-72`);
- `(running, count P, busy false)` describes a dead collaboration *and* a dead
  ordinary prompt identically.

So ownership becomes explicit state on the conversation record:

```ts
/** Who holds this conversation for a non-prompt turn, or null when free.
 *  A prompt is admitted only against a free conversation, so the field is the
 *  single answer to "may a turn start here", replacing three signals that each
 *  answered part of it. */
owner: { kind: "collaboration"; workflowId: string; attemptEpoch: number } | null;

/** Turns ADMITTED into this conversation, incremented in the same durable
 *  mutation that admits one — before any transcript or provider effect. A
 *  cached actor cannot forge it, because it is a row-level increment rather
 *  than a value derived from actor context. */
turnGeneration: number;
```

Both are new persisted columns: migration, repository mapping, and the maximal
round-trip contract fixture all move together (`AGENTS.md:69-82`).

- **Prompt admission** (`prompt/route-handlers.ts`, where `isConversationBusy`
  is already checked at :361-369) refuses when `owner !== null` with a typed
  409, and increments `turnGeneration` in the admitting mutation.
- **Collaboration start** sets `owner` and records the resulting
  `turnGeneration` as `claimedTurnGeneration`.
- **Terminal collaboration outcomes** (failure, stop, completion) clear `owner`
  so the user can type again — under the epoch fence, so a stale attempt cannot
  release a live one's ownership.
- **Resume claims** iff either the owner is still us (`owner.workflowId ===
  workflowId` — the restart case, unambiguous now) or the owner is free and
  `turnGeneration === claimedTurnGeneration` (the clean-failure case, with no
  intervening turn). Anything else refuses.

A dead ordinary prompt no longer aliases a dead collaboration: prompts never set
`owner`, and their admission already incremented `turnGeneration`.

### 5.8 The claim

One collaboration-owned operation, executed as **one write-queue critical
section covering both the envelope and the conversation**. Revision 2 used two
queued mutations with compensation; the review was right that serialization is
not a transaction, and enumerated interleavings where Stop or a crash lands
between them and strands one of the two records.

Both records are reachable from the same state store under the same write queue
(`setters.ts:2066-2095`), so a combined focused mutation is a new setter, not a
new architecture. It atomically:

- verifies the envelope status is in `from` and `expectedAttemptEpoch` matches;
- verifies conversation ownership per §5.7;
- increments `attemptEpoch`, sets `status: "running"`, clears `errorSummary`,
  `completedAt` and `pause` (the repository stamps `completedAt` on every
  terminal transition and never clears it on a running one —
  `workflow-envelope-repository.ts:131-190` — so a resumed run would otherwise
  carry its previous failure's completion time);
- writes `owner` on the conversation;
- records `resumeCount` and the failure it resumed from.

It returns a discriminated outcome (`claimed | wrong_status | stale_epoch |
conversation_taken`), so the route maps each to its own 409 text rather than
inferring from a status alone. After the controller is registered, ownership is
re-checked before dispatch, closing the claim-to-dispatch window where Stop can
land (`manager.ts:1686-1755`).

The process-local conversation lock is acquired before the durable transaction
and released if it fails, so a prompt cannot slip in behind a successful claim.

### 5.9 Orchestrator

`runAsymmetricCollaborationSlice` keeps its narrative:

- Build the ledger at entry; seed `tracker.artifacts` with `ledger.recorded`
  canonicalised (§5.1) and **without** the append sink; take
  `negotiationRoundsCompleted` from the ledger.
- Run the phase sequence unchanged **from round 1**. Recorded rounds replay with
  no model calls; the first unrecorded step runs live. Starting at round 1
  rather than `completed + 1` keeps the policy re-deciding from the same
  recorded decisions — it is pure over `(decision, threshold, roundsRemaining)`
  (`policy.ts:104-148`), all replayed verbatim — and removes any chance of an
  index drifting against the log.
- Delete `runResumeFinalAnswer`, `initializeEnvelope`'s `resumeArtifacts`
  short-circuit, and the ad-hoc artifact scans.
- `input.resume` reverts to meaning only "the user's answers".

**The paused path keeps its observable semantics through the unified replay.**
A paused envelope's ledger contains `open_conflicts`; the ask-user branch falls
through to the final answer when `input.resume` is present, which is exactly
today's rule (`envelope.ts:719-725`). D1's gate refusal applies only to
*failure* resumes, where no verified pause token proves the user was asked. A
genuinely paused envelope proves it by construction — the pause was persisted
before the token was ever handed out.

Policy drift across a deployment (old artifacts, new policy code) is detected as
an impossible suffix: a replayed decision of `fail` or `ask_user` at round `k`
while artifacts exist for `k+1`. That check needs threshold and rounds-remaining,
so it lives in the replay orchestration with ledger lookahead, not inside
`buildLedger(stream)`.

### 5.10 Route, client, UI

- New typed errors mapped in `RESUME` — without them the handler's final catch
  turns them into 500 (`route-handlers.ts:665-709`):
  `CollaborationNotResumableError`, `CollaborationLedgerUnusableError`,
  `CollaborationConversationOwnershipError`, `CollaborationStaleAttemptError`.
- The resume request becomes discriminated: `{ kind: "paused"; resumeToken;
  userAnswers }` | `{ kind: "failed"; expectedAttemptEpoch }`, rather than an
  optional field asserted at each call site (`mutations.ts:721-746`,
  `use-collab-row-renderer.tsx:50-59`). `expectedAttemptEpoch` is the `If-Match`
  that stops a delayed retry of failure N from claiming failure N+1.
- UI: the existing failure banner (`CollabPassage.tsx:899-943`) gains the
  failure kind and a **Resume collaboration** button, rendered from the
  envelope's projected eligibility (so an ineligible run shows restart advice
  instead), disabled in flight, with the 409 text inline.

### 5.11 Startup recovery

Mark interrupted collaborations **`failed` with `failureClass: "operational"`**
and a restart summary, through a collaboration-owned atomic transition that also
writes the failure class and preserves the attempt epoch — the generic `fail`
action only calls `markFailed(errorSummary)` and has no snapshot patch
(`recover-workflow-envelopes.ts:118-145`). This replaces the synthetic
`paused` + unguessable token (`instrumentation.node.ts:326-336`).

Recovery preserves every paused envelope *before* consulting the resolver
(`recover-workflow-envelopes.ts:91-104`), so already-written synthetic pauses
survive the change. They carry the same `human_approval` gate kind as a real
gate, so they are not distinguishable by kind alone: a paused envelope whose
round has no matching `open_conflicts` artifact is refused with restart advice
rather than treated as consent. Recovery also clears conversation `owner` for
envelopes it fails, so the user is not locked out by a dead run.

## 6. Observability

Stable structured events, no tokens/prompts/profile text (`AGENTS.md:85-88`):
claim outcome with observed vs expected status/epoch; ownership decision with
observed vs claimed generation and owner; ledger outcome with replayed vs live
step counts and any rejection code; eligibility refusal with its gate; epoch
fence rejections; resume terminal outcome.

## 7. Non-goals

- **The gate and final-delivery windows** (D1) — refused explicitly, not
  silently mishandled. A follow-up ticket can add them on these foundations.
- **Automatic retry**, **reconfiguring on resume**, **the graph-workflow
  collaboration path**, **repairing a corrupt sidecar**, **cost accounting for
  failed attempts** (lane persistence keeps tokens but drops cost/duration —
  `workflow-agent-caller.ts:430-465`), **cancelling an in-flight provider call
  on Stop**, and **epoch-fencing generated worktree files** (§5.3).
- **A pre-existing bug found in review, left alone:** `finalizeFinal` catches a
  transcript-append failure, warns, and still completes the envelope
  (`envelope.ts:1047-1064`), so a delivery failure can leave a completed run
  with no answer. Independent of resume; worth its own ticket.

## 8. Test plan

Behaviour-level, red first. Concurrency and durability tests use
`createPersistenceFixture` and assert on reloaded state (`AGENTS.md:76-83`).

1. **Ledger (pure):** draft frontier accepts `[]`, `[I1]`, `[I2]`, `[I1,I2]`,
   `[I2,I1]`; linear suffix enforced; duplicate → refuse; interior gap →
   refuse; non-canonical agent/round → refuse; rounds beyond the configured
   maximum → refuse; unreadable → refuse (never `empty`); `reachedGate` /
   `reachedFinal` set correctly.
2. **Mid-round failure:** the peer whose step succeeded is not called again, the
   failed step is, and the sidecar gains no duplicate line. *(Core regression.)*
3. **Draft-phase failure:** with `[I2]` recorded, resume re-dispatches **Agent
   One only**; the tracker presents agent_one before agent_two regardless of
   disk order.
4. **Eligibility:** gate-bearing and final-bearing streams refuse with restart
   advice; terminal policy failure offers no resume; a snapshot missing agents,
   images, or `claimedTurnGeneration` refuses; empty ledger with recorded rounds
   refuses; a replayed artifact whose file was deleted refuses.
5. **Epoch fence:** a fenced attempt cannot mutate the envelope, append to the
   sidecar, record a lane outcome, release the conversation, or publish; Stop
   revokes the epoch.
6. **Claim:** concurrent claims → exactly one winner; `completed` never
   claimable; stale `expectedAttemptEpoch` refused; a failed conversation check
   leaves the envelope untouched (one transaction, nothing to compensate);
   `completedAt`/`pause`/`errorSummary` cleared.
7. **Ownership:** restart (owner still ours) claims; clean failure with matching
   generation claims; intervening completed turn refuses; a dead ordinary prompt
   does not alias a dead collaboration; prompt admission refuses an owned
   conversation and increments the generation.
8. **Paused path unchanged:** a genuinely paused run resumes to the final answer
   with answers folded in, exactly as today, through the unified replay.
9. **Persistence contract:** `owner` and `turnGeneration` round-trip; the
   collaboration snapshot round-trips with images and epoch.
10. **UI:** operational + eligible renders Resume; ineligible renders restart
    advice; 409 shown inline.

## 9. What shipped, and where it differs from this document

Implemented as designed, with three deviations worth recording:

1. **`updateEnvelope`'s terminal guard is unchanged, as designed — but the
   epoch fence sits beside it, not instead of it.** Both apply: terminal status
   stops a write to a finished run, the epoch stops a write from a superseded
   attempt to a running one.
2. **The claim is two mutations, not one.** The design called for a single
   combined envelope+conversation transaction. What shipped reclaims the
   conversation FIRST and only then moves the envelope, so a refused reclaim
   leaves a failed envelope failed and no worker is dispatched. The residual
   window is the reverse one — a crash between the reclaim and the envelope
   update leaves the conversation held by a run that is still marked failed,
   which the next resume reclaims cleanly via `still_owner`. That is strictly
   better than the compensation dance revision 2 proposed, but it is not the
   single transaction this document specified.
3. **Generated worktree files are not epoch-fenced** (§5.3 accepted residual),
   and replayed-artifact file validation was NOT implemented — the ledger
   proves the stream is causally complete, but a resumed run does not re-verify
   that every replayed artifact's markdown still exists on disk. A file deleted
   between attempts surfaces as a downstream prompt referencing a missing file
   rather than an upfront refusal. Worth closing.

## 10. Implementation order

Forced by the dependencies; UI and startup recovery last, because they depend on
the eligibility, epoch and ownership contracts existing first.

1. Persisted contracts: strict executable snapshot (with images, epoch,
   `claimedTurnGeneration`), failure-cause union and class mapping, conversation
   `owner` + `turnGeneration` columns and migration.
2. Ownership seam: prompt admission guard and generation increment;
   collaboration start/release through the same API.
3. The atomic claim (one combined mutation) and epoch threading/fencing.
4. Strict discriminated reader and the fork-aware ledger.
5. Replay orchestration in the slice; delete the old short-circuit.
6. Manager resume: eligibility, typed errors, route mapping.
7. Startup recovery, client mutation, UI.
