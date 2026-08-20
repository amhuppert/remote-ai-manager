# Focused re-review: resumable collaborations after error, revision 2

Revision 2 is a substantial improvement over revision 1. It now describes the
sidecar honestly as a reusable record of model outputs, separates production
from commit, recognizes gate consumption and final delivery as distinct
boundaries, introduces a failure-instance epoch, and refuses legacy records it
cannot replay exactly.

It is not ready to implement. The remaining problems are concentrated rather
than diffuse, but they are still correctness problems: the ledger grammar does
not match the real parallel draft frontier; policy-suffix validation cannot run
inside the stream-only ledger described; the envelope/conversation claim still
is not atomic; `claimedPromptCount + isConversationBusy` is not an ownership
protocol; and the proposed epoch does not cover the sidecar, generated files,
lanes, notifications, Stop revocation, or controller registration. The design
also still lacks a strict, complete executable snapshot.

This is a focused re-review of the 12 prior blockers and the mechanisms added
by revision 2. It is not a new full audit.

## A. Closure of the 12 blocking findings

| # | Revision-1 blocker | Judgment | Evidence basis |
|---|---|---|---|
| 1 | Sidecar is not an exactly-once step log | **CLOSED** | CODE-CONFIRMED + DESIGN-TEXT REASONING |
| 2 | Parallel refactor loses deterministic commit ordering | **PARTIALLY CLOSED** | CODE-CONFIRMED |
| 3 | `final_answer` can be appended/delivered twice | **PARTIALLY CLOSED** | CODE-CONFIRMED + DESIGN-TEXT REASONING |
| 4 | `open_conflicts` is not consent | **PARTIALLY CLOSED** | CODE-CONFIRMED + DESIGN-TEXT REASONING |
| 5 | Ledger is not fail-closed; splice risk | **PARTIALLY CLOSED** | CODE-CONFIRMED |
| 6 | Policy replay and semantic failures | **PARTIALLY CLOSED** | CODE-CONFIRMED + DESIGN-TEXT REASONING |
| 7 | Compound resume claim is not atomic | **NOT CLOSED** | CODE-CONFIRMED design consequence |
| 8 | Idle state is not conversation ownership | **NOT CLOSED** | CODE-CONFIRMED design consequence |
| 9 | Terminal status does not fence zombie attempts | **PARTIALLY CLOSED** | CODE-CONFIRMED |
| 10 | Failed resume lacks failure-instance binding | **PARTIALLY CLOSED** | DESIGN-TEXT REASONING backed by CODE-CONFIRMED contract mismatch |
| 11 | Back-compat/exact staffing replay is unspecified | **PARTIALLY CLOSED** | CODE-CONFIRMED |
| 12 | Simpler collaboration-owned scope | **CLOSED** | DESIGN-TEXT REASONING |

### 1. Sidecar contract — CLOSED

**Judgment: CLOSED — CODE-CONFIRMED + DESIGN-TEXT REASONING.**

Revision 2 replaces the false exactly-once invariant with the correct
one-directional rule: a recorded output may be reused; an absent output is run
again with at-least-once provider execution
(`docs/designs/collab-resume-after-error.md:70-86`). That matches the current
call/commit window: the provider call and lane outcome finish before a phase
parses, validates, and appends the artifact
(`src/lib/workflows/collaboration/helpers.ts:282-311`;
`src/lib/workflows/primitives/workflow-agent-caller.ts:230-278`). It also
correctly removes gate consumption and final delivery from the artifact rule.

The later epoch/ownership defects can make at-least-once execution unsafe under
concurrent stale workers, but that is finding 9, not a reason to retain the old
checkpoint claim.

### 2. Parallel produce/commit — PARTIALLY CLOSED

**Judgment: PARTIALLY CLOSED — CODE-CONFIRMED.**

Separating `produceCollaborationStep` from `commitCollaborationStep`, gathering
both draft outcomes, committing serially, and terminalizing only afterward is
the right shape (`docs/designs/collab-resume-after-error.md:162-192`). It avoids
the revision-1 race in which two concurrent helpers independently mutated the
tracker, sidecar, envelope, and terminal state.

The remaining hole is that the initial phase is a fork, not a linear
Agent-One-then-Agent-Two prefix. Current code deliberately persists Agent Two's
successful draft when Agent One fails, yielding exactly `[I2]`
(`src/lib/workflows/collaboration/initial-draft.ts:104-190`), and a regression
test pins that shape
(`src/lib/workflows/collaboration/envelope.test.ts:1046-1080`). Revision 2 says
commits are always Agent One before Agent Two and its ledger requires “both
initial drafts” before the rest of the prefix
(`docs/designs/collab-resume-after-error.md:143-147,185-192`). Reusing `[I2]`
and later producing I1 necessarily leaves raw disk order `[I2,I1]`; an
append-only file cannot retroactively become `[I1,I2]`.

The design must model I1 and I2 as independent fork nodes, accept a singleton
of either agent and both pair orders, then canonicalize the in-memory tracker at
the join. Alternatively it must deliberately discard/withhold I2 until I1 is
available, accepting the extra call. The test text at design lines 517-519 is
also reversed: after Agent One validation fails, Agent One—not Agent Two—is the
peer that needs redispatch.

### 3. Final artifact and final delivery — PARTIALLY CLOSED

**Judgment: PARTIALLY CLOSED — CODE-CONFIRMED + DESIGN-TEXT REASONING.**

The stable transcript ID and `appendTranscriptEntryOnce` are the correct base
primitive. The current finalizer tracks F before transcript delivery and
envelope completion (`src/lib/workflows/collaboration/envelope.ts:1002-1122`),
while the current production dependency uses non-idempotent, failure-swallowing
`safeAppendTranscriptEntry`
(`src/lib/workflows/collaboration/deps-factory.ts:176-180`). Revision 2 fixes
the ordinary crash/retry duplicate by proposing `collab-final:<workflowId>`
and the existing ID scan/append primitive
(`src/lib/prompt/transcript.ts:311-343`).

Three real holes remain:

1. The general contract says replayed artifacts are never committed, but it
   also says `finalizeFinal` retains ownership of tracking F
   (`docs/designs/collab-resume-after-error.md:179-196`). Current
   `finalizeFinal` unconditionally tracks F. Delivery of a replayed F therefore
   needs an explicit `produced | replayed` branch or a finalizer contract that
   commits only the produced variant.
2. `appendTranscriptEntryOnce` deduplicates by ID only
   (`src/lib/prompt/transcript.ts:320-332`). If a stale attempt delivers a
   different final first, the stable ID makes the wrong content win forever.
   The final-delivery operation must be attempt-fenced and treat same-ID,
   different-content as a conflict, normally by persisting/comparing a content
   digest derived from the recorded final artifact.
3. Revision 2 does not explicitly replace the current “catch, warn, continue to
   completed” behavior. A final transcript append failure must leave an
   operationally failed, resumable delivery—not a completed envelope with no
   answer. Conversation release and backend-ref advancement must occur only
   after a successful/deduplicated delivery and must compare both collaboration
   epoch and conversation ownership generation.

Stable-ID append can serve as the durable delivery receipt; a second snapshot
receipt is not inherently required. It does need an applied/existing/conflict
result, rather than the current `Promise<void>`, if the design wants the
documented dedupe event and content-conflict handling.

### 4. Ask-user consent — PARTIALLY CLOSED

**Judgment: PARTIALLY CLOSED — CODE-CONFIRMED + DESIGN-TEXT REASONING.**

The receipt is the right concept. Current code appends O before writing the
paused envelope (`src/lib/workflows/collaboration/envelope.ts:920-980`), so the
user's successful token-bound resume—not O—is the consumption fact. Writing
answers and the receipt in the same envelope CAS means an ordinary receipt
cannot be lost after the claim commits, and concurrent paused resumes can have
only one winner.

The proposed receipt is under-bound. The branch checks only
`gateConsumed.round` (`docs/designs/collab-resume-after-error.md:241-257`), even
though the receipt also carries question IDs. The claim signature accepts a
caller-supplied `gateConsumed` but accepts neither the expected pause token nor
a gate identity (`docs/designs/collab-resume-after-error.md:403-409`). A stale
receipt can therefore consume a newly regenerated gate at the same round—for
example, if the sidecar is absent and the ledger is treated as fresh—or an old
synthetic recovery pause can be mistaken for a real gate.

The claim must verify the paused token inside its mutator and derive the receipt
from the currently persisted O/current-open-conflicts projection. Persist a
stable gate identity (workflow, round, and a digest of ordered question IDs and
text), require the exact question-ID set, and reject a receipt whose matching O
is absent. The caller should submit answers and a token/gate ID, not an
authoritative `GateReceipt` object.

### 5. Fail-closed ledger — PARTIALLY CLOSED

**Judgment: PARTIALLY CLOSED — CODE-CONFIRMED.**

The discriminated read, preservation of skipped-line diagnostics, rejection of
duplicates, and causal validation before a model call fix the revision-1
empty-on-read-error and interior-splice defects
(`docs/designs/collab-resume-after-error.md:90-160`). Current code really does
collapse absence/read failure to `[]` and skip malformed/schema-invalid lines
(`src/lib/workflows/collaboration/artifacts-store.ts:149-199`).

The proposed causal grammar is nevertheless not the real phase graph. It
rejects the code-confirmed singleton `[I2]`, and revision 2 itself can create
`[I2,I1]` when it resumes that singleton. It also cannot validate the general
“impossible policy suffix” with `buildCollaborationStepLedger(stream)`, because
the policy needs threshold and rounds remaining in addition to R
(`src/lib/workflows/collaboration/policy.ts:104-148`). The same R can legally be
followed by the next round, O, or F under different immutable snapshot inputs.

The ledger must enforce exact canonical metadata too. The storage schema alone
accepts either agent and arbitrary integer rounds for initial drafts and
cross-review, arbitrary integer rounds for later artifacts, and no agent at all
for O (`src/lib/workflow-graph/collaboration-schemas.ts:409-448,470-480,502-512,558-609`).
Validation therefore needs expected agent/target, I/X round zero, positive
contiguous negotiation rounds bounded by the snapshot's configured maximum,
O/F round agreement, and generated-ref metadata consistency. The listed
rejection union has no explicit noncanonical/impossible-suffix code
(`docs/designs/collab-resume-after-error.md:112-116`).

### 6. Policy replay and semantic failures — PARTIALLY CLOSED

**Judgment: PARTIALLY CLOSED — CODE-CONFIRMED + DESIGN-TEXT REASONING.**

Classifying policy `fail` as terminal closes the infinite “Resume, replay the
same R, fail again” loop. R is persisted before policy runs
(`src/lib/workflows/collaboration/resolution.ts:245-264`), and
`next_action: "fail"` always maps to failure
(`src/lib/workflows/collaboration/policy.ts:104-115`).

The policy-version problem remains. Revision 2 persists neither a policy
version nor the policy outcome. Its stream-only ledger cannot evaluate the
policy, and replay-time lookahead detects drift only when a later artifact
exists. If the old policy chose final and the final call failed before F, the
stream ends at R; changed code can now choose ask-user and there is no suffix to
label impossible. Persist either a policy contract version that must match or
the per-round policy outcome (preferably both a small version and the outcome),
then compare replay against it.

The `operational | terminal` idea also needs an exhaustive typed mapping by
failure site. Backend `retryable` is not the same question as user-authorized
collaboration resume: the shared contract defines it as whether re-running that
backend call is plausibly safe (`src/lib/workflows/primitives/agent-call-vocabulary.ts:192-208`),
while timeout and quota classifiers can be non-retryable even though a manual
resume after conditions change is intended to be operational. Parse/injection,
file validation, missing files, manager throws, Stop, restart, policy, and
ledger rejection do not all carry a normalized backend failure. A typed
`CollaborationFailureCause` and a pure exhaustive mapping are required; string
inspection or `retryable === true` is not.

### 7. Compound claim — NOT CLOSED

**Judgment: NOT CLOSED — CODE-CONFIRMED design consequence.**

Revision 2 explicitly retains two mutations and compensation
(`docs/designs/collab-resume-after-error.md:412-420`). Serializing E and C on the
same queue does not make them one transaction. The production queue protects
each call separately
(`src/lib/state-store/setters.ts:2066-2095`); other prompt, Stop, and recovery
mutations may reserve between awaited calls.

The ordering creates the residual it claims to avoid:

- `E → Stop → C`: Stop completes the envelope before the conversation claim;
  C can still set the conversation running, leaving a completed workflow with a
  stranded conversation.
- `E → C → process exit before controller registration/dispatch`: both records
  are running with no worker. Startup recovery currently repairs only the
  envelope, not conversation ownership.
- `E → C(refuse) → delayed compensation`: unless compensation is an exact
  `(status=running, attemptEpoch=e)` CAS, it can overwrite Stop or a newer
  attempt. The design also does not specify which cleared error/completion
  fields compensation restores.

Both objects are in the same session state. The collaboration-owned lifecycle
operation should update envelope and durable conversation owner/generation in
one session-state mutation. The process-local conversation lock must be
acquired before that durable transaction and released on a failed transaction;
after controller registration, recheck the exact epoch/owner before dispatch.

### 8. Conversation ownership — NOT CLOSED

**Judgment: NOT CLOSED — CODE-CONFIRMED design consequence.**

`claimedPromptCount + !isConversationBusy` works only for a quiescent restart.
It is not reliable for the restart ambiguity or multi-tab concurrency. The
design itself admits that collaboration and prompt admission use different
locks and defers their unification
(`docs/designs/collab-resume-after-error.md:375-380,499-504`). That is required
for correctness.

The six rows in section 5.8 compare with the code as follows:

| Design row | Code-verified result |
|---|---|
| Clean slice failure | **Conditionally works** if no prompt/actor persistence is racing. Count normally matches and the prompt lock is absent. |
| Release failed; row remains `running` | **Not uniquely attributable.** It has the same `(count match, busy false)` state as an ordinary prompt that started and then crashed before finalization. |
| Process restart; row remains `running` | **Claims the collaboration orphan, but also falsely claims the indistinguishable ordinary-prompt orphan.** Executing actors are intentionally not rehydrated (`src/lib/workflows/conversation/rehydration.ts:50-72`). |
| User prompt in flight | **Busy is not reliably true.** The actor accepts `SUBMIT_PROMPT` before `prepareTurn` acquires the lock (`src/lib/workflows/conversation/machine.ts:483-487,558-594`; `src/lib/workflows/conversation/actor-implementations.ts:1053-1062`). External turns do not acquire this lock at all (`src/lib/workflows/conversation/machine.ts:500-530`). |
| User prompt completed | **Count is not reliably `+1`.** The lock is released synchronously while the row sync is fire-and-forget (`src/lib/workflows/conversation/manager.ts:339-350`; `src/lib/workflows/conversation/persistence-adapter.ts:244-263`). A cached actor can also retain the pre-collaboration count and later write exactly the claimed count. |
| Paused run | **Incorrect.** Pause holds no prompt lock, paused resume performs no generation reclaim, and another tab/API caller can prompt during the pause. Direct Stop of a paused run mutates only the envelope (`src/lib/workflows/collaboration/manager.ts:1824-1882`). |

The cached-actor counterexample is decisive. Collaboration start reads N and
changes the row to N+1 (`src/lib/workflows/collaboration/manager.ts:355-379`),
but it neither updates nor stops an already-live actor. `ensureConversationActor`
returns that cached actor without rereading the row
(`src/lib/workflows/conversation/manager.ts:633-665`). Its context still has N;
its next prompt finalizes to N+1 and writes that value back
(`src/lib/workflows/conversation/machine.ts:408-420,889-914`;
`src/lib/workflows/conversation/persistence-adapter.ts:75-92`). The row then
matches `claimedPromptCount` even though a complete intervening prompt occurred.

Prompt admission also checks the process-local lock, not persisted `running`
status (`src/lib/prompt/route-handlers.ts:328-370`). Because collaboration never
acquires that lock, a prompt can begin immediately after a successful resume
claim. The correct protocol must use the same live lock and a durable owner/turn
generation incremented at admission, before transcript/provider effects.

### 9. Attempt epoch — PARTIALLY CLOSED

**Judgment: PARTIALLY CLOSED — CODE-CONFIRMED.**

A durable epoch is the correct worker identity and fixes the false use of
terminal status as a fence. Revision 2 also correctly names the unconditional
manager catch, re-entry initializer, and compare-and-delete registry teardown
(`docs/designs/collab-resume-after-error.md:198-230`).

The assertion that it covers “every write that can outlive its attempt” is
false. The complete correctness-relevant set is larger:

| Outliving effect | Current write site | Revision-2 coverage |
|---|---|---|
| Envelope transitions | `envelope.ts:701-753,787-843,859-903,920-980,1002-1134`; manager catch `manager.ts:171-212` | Named, except Stop does not revoke/increment the epoch. |
| Raw artifact sidecar | `helpers.ts:55-62`; `artifacts-store.ts:78-90` | **Omitted.** A stale append can create a duplicate/gap before the later envelope no-op. |
| Generated worktree files | deterministic paths `artifact-files.ts:35-91`; initial calls bypass the write mutex `lane-scheduler.ts:44-63` | **Omitted.** Old and new attempts can write the same path; this is not merely extra cost. |
| Lane ref/metrics | `workflow-agent-caller.ts:269-278,411-427`; `lane-service.ts:86-123`; second record at `helpers.ts:304-309` | **Omitted.** `LaneState` has no attempt identity. |
| Conversation status/backend ref | `deps-factory.ts:181-255` | Named in prose, but no composite epoch + conversation-generation mutator is specified. Set-to-value can still overwrite a newer turn. |
| Alignment seen version | `initial-draft.ts:219-259`; assignment at `alignment-gate.ts:166-183` | **Omitted.** A stale run can write an older version. |
| Transcript delivery | `transcript.ts:311-343` | Named, but cross-store atomic fencing/content binding is unspecified. |
| SSE/push | `envelope.ts:888-897,973-980,1123-1130,1207-1215` | **Omitted.** Current envelope-update seams return no applied/refused result, so a stale no-op can still publish/push. |
| Abort-controller registration | `manager.ts:1465,1755`; registry replace at `abort-registry.ts:35-42` | Teardown fixed; delayed registration can still replace a newer controller. |

`commitCollaborationStep` must fence the sidecar append itself, not check only
the later envelope update. Generated output must be attempt-scoped and promoted
under the fence, or old calls must be cancelled and joined before a new claim.
Cancellation may still be deferred for cost only if staging/promotion prevents
stale file effects; without either, the design's claim that an in-flight call
only keeps spending is incorrect.

Stop must revoke the attempt (increment epoch or require both matching epoch and
`status === running` for every effect), release durable/live conversation
ownership, and prevent a post-Stop controller registration/dispatch. Terminal
status alone cannot fence the non-envelope effects that section 5.3 omitted.

### 10. Failure-instance `If-Match` — PARTIALLY CLOSED

**Judgment: PARTIALLY CLOSED — DESIGN-TEXT REASONING backed by CODE-CONFIRMED contract mismatch.**

`expectedAttemptEpoch` is the correct binding and prevents a delayed request
for failure N from claiming failure N+1
(`docs/designs/collab-resume-after-error.md:448-465`).

The proposed atomic claim does not accept it
(`docs/designs/collab-resume-after-error.md:403-409`), despite later prose saying
the claim compares it. The same signature omits the paused resume token. Define
the fresh-run epoch, require the relevant expected token/epoch inside the
single mutator, increment on a successful attempt claim, and revoke/increment
on Stop. Return a discriminated epoch/token mismatch rather than only the
observed status.

### 11. Exact executable snapshot and compatibility — PARTIALLY CLOSED

**Judgment: PARTIALLY CLOSED — CODE-CONFIRMED.**

Refusing records without `sessionContext`, `agents`, or `claimedPromptCount` is
the right compatibility choice and complies with the requirement not to invent
old profile snapshots. It is not a complete executable-snapshot gate.

The current user snapshot schema requires only the `origin` discriminator and
keeps `sessionContext`/`agents` optional with arbitrary passthrough fields
(`src/lib/workflows/collaboration/feature-snapshot.ts:39-58,115-125`). Current
resume defaults missing brief, rounds, backend, and threshold
(`src/lib/workflows/collaboration/manager.ts:1632-1657,1764-1767`). Revision 2's
eligibility table checks none of those fields
(`docs/designs/collab-resume-after-error.md:308-331`).

It also omits image replay. Start supplies `imageRefs` to both initial calls
(`src/lib/workflows/collaboration/manager.ts:1327-1335,1467-1481`), but
`initializeEnvelope` does not persist them
(`src/lib/workflows/collaboration/envelope.ts:734-751`) and current resume does
not reconstruct them. A failure with a missing initial draft therefore resumes
with a different input. The start transcript persists only path/media refs, not
the in-memory base64 payload (`src/lib/workflows/collaboration/transcript.ts:4-31`),
so revision 2 must either persist durable image replay references and load the
bytes from those files or explicitly refuse such a resume.

Add a versioned strict execution schema covering at least: normalized brief,
conversation ID, both agents/profile snapshots, rounds, threshold, captured
session context, post-start claimed generation, initial attempt epoch, durable
image replay refs, policy contract/outcomes, and every runtime setting the
design promises not to reconfigure. Validate cross-field consistency (for
example Agent One backend versus the primary backend) and remove all resume
defaults from the executable path. Legacy records fail closed with restart
advice unless Alex separately approves a compatibility mode.

### 12. Narrower scope — CLOSED

**Judgment: CLOSED — DESIGN-TEXT REASONING.**

Revision 2 keeps the claim collaboration-owned, excludes the graph path, and
uses a narrow collaboration model-output seam rather than adding a speculative
generic envelope primitive (`docs/designs/collab-resume-after-error.md:162-196,382-410,490-504`).
The implementation mechanisms still need correction, but the abstraction
scope itself answers finding 12.

## B. New-mechanism attack

### B1. Discriminated ledger read and causal prefix

**Judgment: safe direction, incomplete graph — CODE-CONFIRMED.**

Use the following notation: `I1`, `I2`, `X`, and round artifacts `Pᵣ`, `Cᵣ`,
`Rᵣ`, with optional gate `Oᵣ` and final `Fᵣ`. Current production can
legitimately leave these shapes:

- `[]`, `[I1]`, `[I2]`, or `[I1,I2]` after the parallel draft join;
- after both drafts, any linear prefix of `X, P1, C1, R1, P2, C2, R2, ...`;
- after a completed R: no suffix (call/policy failure), `O`, `F`, or `O,F`;
- O without a paused envelope after a crash between O append and pause persist;
- F with a running/failed envelope after a crash/failure during delivery.

The proposed grammar falsely refuses `[I2]`. Its own replay can then create
`[I2,I1]`, which it also appears to refuse. These must be modeled as a fork
frontier rather than a total prefix.

Other refusals are real availability costs but can be deliberate safety policy:

- broken current recovery can concatenate a new spine after an old prefix and
  duplicate keys (`src/lib/workflows/collaboration/envelope.ts:311-340,689-725`);
- repeated/concurrent current paused resume can append duplicate F because the
  manager's status/token read and running update are not one CAS
  (`src/lib/workflows/collaboration/manager.ts:1589-1612,1681-1689`;
  `src/lib/workflows/collaboration/envelope.ts:1233-1351`);
- a process crash during append can leave only a malformed/schema-invalid
  trailing line. Rejecting every skipped line refuses a safe preceding prefix;
  accepting only a proven torn trailing suffix could recover more runs, but
  full refusal is acceptable if the restart cost is explicit.

Duplicate refusal is therefore conservative and correct; the I2 refusal is a
design bug. Record how many existing runs will be refused at rollout.

Impossible-policy-suffix detection belongs in replay orchestration with ledger
lookahead and the strict snapshot, not in `buildLedger(stream)`. A stream-only
ledger can recognize `next_action: fail` narrowly; it cannot evaluate the full
policy. If exact behavior across deployments is required, a policy version or
recorded policy outcome is still necessary even when there is no suffix.

### B2. Produce/commit split

**Judgment: retain the behavior, not necessarily the abstraction — DESIGN-TEXT REASONING.**

The split makes failure ownership and serial commit legible. Its required
corrections are:

1. represent the initial fork independently and canonicalize tracker order at
   the join;
2. make artifact append plus progress update one attempt-fenced commit protocol;
3. give F an explicit replayed-versus-produced finalization path;
4. return an applied/refused result so stale terminal status/push is suppressed;
5. validate replayed prerequisites/files before the first live downstream call,
   or classify missing replay files as terminal before spending.

The generic helper is not itself necessary for correctness. Small replay checks
at existing phase boundaries are an equally valid, lower-refactor
implementation if they preserve these behaviors.

### B3. Attempt epoch

**Judgment: necessary but materially under-scoped — CODE-CONFIRMED.**

The complete write audit in finding 9 shows the main break: a stale attempt can
append a sidecar line or overwrite deterministic output before an epoch-checked
envelope update no-ops. That can make the next ledger unusable or make a stable
final ID preserve stale text. Lane continuity and backend-ref advancement can
also regress. Status/push can lie after the state mutation refuses.

The epoch must be checked with the expected active status inside every durable
commit owner. Sidecar and final transcript operations need serialization with
the envelope fence or an attempt-aware outbox/receipt. Generated files need
attempt-specific staging/promotion or joined cancellation. Stop must revoke the
epoch. Compare-and-delete fixes teardown but registration must also be owned by
the attempt and followed by a pre-dispatch ownership recheck.

### B4. Gate-consumption receipt

**Judgment: ordinary atomicity works; semantic identity does not — DESIGN-TEXT REASONING.**

If receipt, answers, status transition, and epoch are written in one envelope
mutator, the receipt cannot be half-written: before commit there is no claim;
after commit it survives a worker crash. Two concurrent paused submissions
cannot both write it if status/token/gate are compared in that same mutator.

It can still be double-applied rather than double-written. Round alone is not a
gate identity, `answeredQuestionIds` is not checked by the shown branch, and an
`empty` reconstructed ledger can generate different questions at the same
round while a stale receipt remains in the snapshot. Bind the receipt to the
exact O artifact/question digest and require that O in the strict ledger.

Re-pause must replay the existing O without appending it again. This needs an
explicit produced/replayed gate branch analogous to F, not only the sentence
that the function appends “if none exists.”

### B5. Idempotent final delivery

**Judgment: stable ID solves duplicate lines only — CODE-CONFIRMED + DESIGN-TEXT REASONING.**

`appendTranscriptEntryOnce` provides process-local serialization and restart
dedupe by scanning IDs. It does not prove that existing content equals the
recorded F, does not expose dedupe versus append, and returns before rerunning
post-append indexing/SSE when it finds an existing ID
(`src/lib/prompt/transcript.ts:311-343`; append/index/SSE ordering at
`src/lib/prompt/transcript.ts:244-308`).

For collaboration correctness, require:

- stable ID plus content digest/conflict detection;
- attempt and conversation-generation ownership at delivery;
- append failures to remain operationally resumable;
- release/ref only after appended-or-identical-existing;
- an applied/existing/conflict result for logging and tests.

Missing SSE after a server crash is tolerable because clients reconnect/refetch.
Missed document indexing is a separate repair concern, but the transcript and
envelope must not claim delivery on append failure.

### B6. Operational versus terminal failure

**Judgment: required distinction; incomplete source mapping — CODE-CONFIRMED.**

The two classes are necessary for safe UX. Do not derive them mechanically from
backend `retryable`. Define and test every source:

- normalized provider/call failure;
- structured-output exhaustion and local parse/injection;
- generated-file validation/read failure;
- policy fail;
- strict-ledger rejection;
- missing/invalid executable premise;
- process restart;
- unhandled manager/slice exception;
- user Stop.

For example, quota and timeout can be operational for a later user resume even
when the backend says `retryable: false`; policy fail and an unusable ledger are
terminal. A committed artifact whose required file later disappeared cannot be
fixed by replaying that same artifact and should not be labeled operational
unless the design supports invalidating/reproducing it.

There is also a state/UX contradiction: eligibility promises refusals make no
state change, while section 5.6 calls a ledger discovered unusable on resume
“terminal.” If the prior envelope remains `failureClass: operational`, the UI
continues to offer Resume after every 409. Either persist a terminal
ineligibility assessment safely or expose eligibility in the read model so the
button disappears without mutating the attempt.

### B7. Eligibility gate

**Judgment: necessary, not strict enough — CODE-CONFIRMED.**

Eligibility must parse a versioned executable snapshot, not test the presence
of three fields in a permissive record. It must also cross-check ledger config:
rounds within the configured maximum, O/F round agreement, gate receipt versus
O, final artifact prerequisites, and conversation/workflow identity.

Treating `empty` as resumable is safe only when no durable fact proves earlier
progress. At minimum an empty ledger with a gate receipt or delivered/final
receipt is inconsistent and must refuse; otherwise a stale receipt can consume
new work. A missing sidecar after nonzero snapshot progress is data loss, not
indistinguishable fresh state. Conservatively refuse when bounded snapshot
receipts prove the file used to contain entries.

### B8. `claimedPromptCount + isConversationBusy`

**Judgment: unsafe for restart ambiguity and multi-tab — CODE-CONFIRMED.**

The signals are observations, not reservations. A prompt can be accepted before
the lock is acquired; the lock can be released before the row count is durable;
a cached actor can erase the collaboration increment; external turns can run
without the lock; a process restart erases the busy map; and prompts may begin
after resume because collaboration never acquires the lock.

The restart state `(row running, count P, busy false)` describes both a dead
collaboration and an ordinary prompt that appended its user turn and crashed
before finalization. No predicate over these two values can distinguish them.
The lifecycle needs a durable owner type/id and admission-time turn generation,
plus the shared live conversation lock held by the collaboration across running
and paused states (or released and reacquired with the same durable checks).

### B9. Envelope-first claim and compensation

**Judgment: worse interleavings exist than the design admits — CODE-CONFIRMED design consequence.**

The critical orders are:

1. prompt accepted → E → C succeeds before prompt lock acquisition;
2. prompt lock release → E → C succeeds → delayed prompt count write;
3. E → Stop → C, stranding the conversation after a completed envelope;
4. E → C → crash before controller/dispatch, stranding both;
5. E → C → Stop → controller registration/dispatch;
6. E → C-refusal → delayed compensation overwrites newer terminal state;
7. E → C → a new prompt acquires the lock because collaboration did not.

Envelope-first reduces one window but does not establish ownership. Replace the
pair with a collaboration/conversation-lifecycle composite transaction and use
the actual prompt lock as a reservation. Every compensation must compare the
exact epoch/owner and restore explicitly defined fields.

### B10. `expectedAttemptEpoch`

**Judgment: correct mechanism, missing from the claimed atomic boundary — DESIGN-TEXT REASONING.**

The discriminated client request is good. Put `expectedAttemptEpoch` in the
claim input and compare it in the same mutator that changes status and increments
the epoch. Specify epoch zero/one at fresh start, what compensation preserves,
and that Stop revokes the current epoch. The paused branch likewise compares
its token and gate identity inside the mutator.

### B11. Startup recovery: paused to failed

**Judgment: correct future state, incomplete persistence/migration — CODE-CONFIRMED.**

Marking an interrupted in-process collaboration failed/operational is more
truthful and enables the ticket's restart flow. The generic recovery `fail`
action currently calls `markFailed(errorSummary)` and has no feature-snapshot
patch for `failureClass` (`src/lib/workflows/primitives/recover-workflow-envelopes.ts:118-145`).
Use a collaboration-owned atomic recovery transition that writes status,
summary, failure class/history, and preserves the attempt epoch.

Rollout also needs an explicit decision for already-synthetic paused envelopes.
Recovery preserves every paused envelope before consulting the inactive-action
resolver (`src/lib/workflows/primitives/recover-workflow-envelopes.ts:91-104`).
Old startup code produced `paused/human_approval` with a synthetic recovery
token (`src/instrumentation.node.ts:321-334`), while a real gate uses the same
human-approval kind (`src/lib/workflows/collaboration/envelope.ts:934-960`).
Require matching O/current-open-conflicts and the strict executable snapshot;
otherwise refuse with restart advice. Do not mint gate consent from the old
synthetic pause.

Startup must also reconcile durable conversation ownership. Changing only the
envelope leaves the row `running`; that is acceptable only if a later claim can
prove the owner, not with the ambiguous count/busy predicate. Paused Stop must
release ownership explicitly.

## C. Scope and sequencing

### What is required for a correct full resume

**Assessment: DESIGN-TEXT REASONING grounded in the code evidence above.**

These are genuinely required if the product promises to resume any operational
failure, including restart, gate, and final-delivery windows:

1. a discriminated strict sidecar read and phase-graph validation;
2. a strict, versioned executable snapshot with durable image replay and policy
   identity/outcomes;
3. operational-versus-terminal classification and an exhaustive cause mapping;
4. failure-instance `expectedAttemptEpoch`, threaded through the slice;
5. a complete epoch/status fence for artifact commit, final delivery, state/ref
   writes, Stop, notifications, and controller ownership;
6. one durable envelope + conversation-owner/generation transaction, plus the
   shared live conversation lock used by prompt admission;
7. a gate receipt bound to the exact O artifact and answers;
8. content-bound idempotent final transcript delivery;
9. startup recovery that writes failed/operational atomically and reconciles
   conversation ownership;
10. route/client/UI support and real persistence/concurrency/crash tests.

### What can be deferred safely

Some revision-2 scope can be cut without shipping an unsafe subset, but only by
making the limitation explicit:

- **The generic produce/commit abstraction can be deferred.** Preserve the
  behavior with local replay/commit checks at existing phase seams. Residual
  risk is duplication of implementation, not incorrect recovery, provided the
  parallel fork and attempt-fenced commit rules are centralized enough to test.
- **Normalized `retryAfterHint` display and rich failure detail can be
  deferred.** The typed cause and failure class cannot. Residual risk is less
  helpful UX, not an unsafe claim.
- **Gate receipt can be deferred only by refusing failed resumes for every run
  with O/gate history.** Genuine paused token resume may remain supported. The
  residual risk is that a crash around clarification requires Restart; there
  is no silent consent bypass.
- **Idempotent final delivery can be deferred only by refusing failed resumes
  when F exists or finalization may have started.** Residual risk is loss of
  resumability at the most expensive boundary, but no duplicate transcript.
- **Repair of duplicate/corrupt sidecars can remain out of scope.** Fail closed
  with restart advice and measure refusal counts. Residual risk is false
  refusal/extra spend, not artifact splicing.
- **Active cancellation can be deferred only if attempt-scoped file staging and
  fenced promotion prevent stale writes.** Without staging, cancellation/join
  is a correctness requirement, not merely cost control.
- **Cost accounting and generalized graph-path reuse remain deferrable.** They
  do not determine resume correctness.
- **A broad conversation-lifecycle refactor can be scoped down, but the shared
  durable owner/generation and live lock cannot be deferred for collaboration.**
  The residual race exists precisely at this boundary.

A smaller safe first shipment could resume only operational failures whose
strict ledger is a clean prefix before O/F, using the complete executable
snapshot, actual conversation lock/owner, atomic lifecycle claim, expected
epoch, and fenced artifact commit. Gate-window and final-delivery resume could
then be added in a second slice. That is incomplete relative to the full ticket
promise but not unsafe if the eligibility refusals are explicit.

### Forced implementation order

**Assessment: DESIGN-TEXT REASONING.** The dependencies impose this order:

1. **Persisted contracts first:** define the snapshot version, failure-cause
   union/class mapping, initial/Stop epoch semantics, durable conversation owner
   and turn generation, gate identity, policy identity/outcome, and image replay
   refs. Remove executable-path defaults.
2. **Lifecycle ownership second:** add the shared live lock and one session-state
   transaction for start/resume/compensation/release/paused Stop/recovery. Make
   ordinary prompt/external-turn admission honor the same durable owner and
   increment generation at admission. Reconcile cached actors.
3. **Fencing third:** thread the epoch through manager/slice/lane/commit seams;
   fence sidecar append, output promotion, transcript delivery, conversation
   ref/status, terminal publication, controller registration, and Stop.
4. **Strict ledger fourth:** implement the discriminated reader and fork-aware
   graph validator against the strict snapshot. Add replay-time policy-outcome
   comparison and lookahead. Existing display hydration stays lenient.
5. **Replay orchestration fifth:** add replay-or-produce behavior while
   preserving the draft join; seed the tracker canonically; make O and F
   produced/replayed paths explicit.
6. **Gate and final delivery sixth:** write token/gate-bound receipt in the
   atomic claim and implement content-bound append-once before release/ref.
7. **Recovery/API/UI last:** change startup recovery only after failed records
   carry the new class/epoch/owner contract; then expose discriminated requests,
   409s, and buttons. Add rollout handling for synthetic paused records.
8. **Verification throughout, final live pass at the end:** real persistence
   fixtures for every claim/Stop/prompt interleaving, strict-ledger fixtures for
   all legal partial shapes, and injected crash boundaries after each durable
   effect.

The plan should not begin with UI or startup recovery: those surfaces depend on
eligibility, epoch, and ownership semantics that revision 2 has not yet made
correct.

VERDICT: REJECT — Architecture score: 6/10
