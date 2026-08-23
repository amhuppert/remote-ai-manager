# Validation certification recovery for native-SDD delivery (remote-ai-manager#8)

Status: IMPLEMENTED — runtime behavior and regression coverage are present in this ticket worktree.

Scope: graph validation lifecycle, final-publish/completion invariants, native-SDD
claimant diagnostics, recovery instructions, and delivery-verdict persistence.

No new persisted execution field, halt-reason variant, database migration, or
prepared-candidate proof path.

## 1. Recommendation

Make required context validation a shared, deterministic certification invariant:

> A non-skipped context whose resolved graph configuration requires validation is
> certifiable only when its latest validation round is terminal with
> `outcome: "passed"`. A graph may neither final-publish nor complete while such a
> context is uncertified.

The fix has four coordinated parts:

1. Centralize the certification predicate and its diagnostic details so graph
   completion and native-SDD claimant evaluation cannot drift.
2. Preserve the existing recovery route: an infrastructure halt resumes a
   task-complete context as validation-only work; pause-to-edit retires the open
   round to `outcome: null` and leaves the context schedulable for a fresh round.
3. Refuse final publish and completion if an uncertified context becomes
   quiescent anyway. Do not reopen a terminal, already-landed context inside the
   same execution.
4. Make delivery refusal and persistence tell the truth: name each claimant and
   its round state, give a recovery operation that changes v2 proof, and record
   the already-satisfied criterion verdicts once the graph is archived and its
   integrated candidate is stable.

The affected archived execution is not automatically reactivated. Its honest
recovery is a current-revision Studio waiver for the refused criteria or a
replacement delivery execution. Re-running prepared-candidate validation cannot
change its authored-context proof.

## 2. Incident retrospective

### Quality

The delivery gate was correct to refuse `R1.1` and `R1.2`. The persisted
`route-fix` context required both script and blocking context validation, yet its
only round was `phase: "concluded", outcome: null`; no reviewer certified it.
The product work may be sound, but the proof record is not.

The quality failure occurred earlier: graph completion inferred "all work done"
from no schedulable tasks, no remaining joins, complete task counts, output
capture, and loop settlement, but never checked required validation
certification. Status and proof diverged:

- context status: `completed`
- task count: `2/2`
- landing: `landed`, commit evidence
- merge status: `merged-success`
- required validation: concluded without a verdict

The recovery implementation already contains the right validation-only
iteration for task-complete contexts. It is reached only when the scheduler can
admit the context, while scheduler admission is keyed to `pending`/`ready` status.
That makes proof recovery accidentally status-dependent.

The pause behavior itself is defensible. Concluding an abandoned round with
`outcome: null` accurately says that nobody rendered a verdict, retains the
round sequence and evidence, and prevents stale validator answers from landing
after an edit. The defect is failure to enforce and recover the certification
debt that this truthful retirement creates.

### Cost

The affected session contains 29 conversations, but the ticket attachment does
not expose a primary cost aggregate, so no token or dollar total is published.
The mechanically supported waste is qualitative: every Merge retry after the
workflow was archived repeated a gate decision whose proof inputs could not
change.

The missing cost aggregate is an observability limitation, not evidence that
the incident was cheap.

### Speed

Primary lifecycle timestamps show about 40 hours 38 minutes from the initial
validator-infrastructure halt (`2026-08-21T00:33:01.300Z`) to graph completion
(`2026-08-22T17:11:06.257Z`). The supplied evidence does not partition that span
into agent work, operator wait, validation wait, and dead air, so no causal time
split is claimed.

### What worked — preserve these mechanisms

| Mechanism | Evidence to preserve |
| --- | --- |
| Fail-closed native-SDD delivery gate | `validationGatePassed` accepted only a concluded passing round and correctly refused the archived claimant. |
| Honest infrastructure classification | `validator_infra_error` represented an unheard validator, not a negative verdict, and kept the round open for retry. |
| Durable validation provenance | Round sequence, frozen candidate, roster, specialist state, phase, and outcome survived pause and completion, making the defect diagnosable. |
| Validation-only execution path | `runValidationOnlyIteration` already avoids an unnecessary implementer turn when every task is complete. |
| Honest pause retirement | `withdrawRoundQuestions` concludes an abandoned round with `outcome: null` and withdraws only round-scoped questions. |
| Existential claims | A criterion with another satisfied authored claimant remains satisfiable; `R1.3` demonstrated this. |
| Existing completion backstops | Unfinished tasks, missing declared outputs, and unsettled loops already use fail-closed completion checks; validation should join that pattern. |

### Named failure mode

**Terminal claimant with validation debt**

Signal: a required, non-skipped context is terminal or publish-visible while its
latest required validation round is absent, open, or concluded without a passing
outcome.

Where to dig: context finalization, halt/resume disposition, pause retirement,
final-publish planning/claiming, completion invariants, then native-SDD claimant
projection.

Canonical fix class: one shared proof-state classifier, schedulable
recertification before terminality, and fail-closed publish/completion guards.

## 3. Target lifecycle

```text
tasks complete
    |
    v
required validation round open
    | pass                         | validator infrastructure halt
    v                              v
context may complete          context halted; round stays open
                                   |
                                   | resume: refill unheard seats
                                   v
                              context ready, tasks still complete
                                   |
                                   v
                              validation-only iteration

pause-to-edit while a round is open
    |
    +--> round concludes with outcome null
    +--> validator questions are withdrawn
    +--> context remains/returns ready
    +--> resume freezes the next round (seq + 1)

quiescence with required validation not passed
    |
    +--> no final publish
    +--> no execution completion
    +--> non-resumable recovery halt naming every context and round state
         (abandon/replacement; never silently reopen landed terminal work)
```

## 4. Design decisions

### D1 — One shared certification classifier

Add a pure graph-domain module, colocated under `src/lib/workflow-graph/`, that
owns both the requirement test and the current certification state.

Suggested contract:

```ts
type ValidationCertification =
  | { status: "not_required" }
  | { status: "passed"; roundSeq: number }
  | {
      status: "owed";
      reason:
        | "round_absent"
        | "round_open"
        | "round_concluded_without_pass";
      round: Pick<GraphWorkflowValidationRound, "seq" | "phase" | "outcome"> | null;
    };

function validationCertification(
  execution: GraphWorkflowExecution,
  contextId: string,
): ValidationCertification;
```

Validation is required under the current v2 rule when either script commands are
configured or the context validator is enabled. The classifier does not inspect
native-SDD claims. A graph validator is a context contract even when no spec
criterion claims that context.

`authored-context-outcome.ts` consumes this classifier instead of maintaining a
private `validationGatePassed` predicate. Its existing explicit outcomes remain:

- `script_failed` -> `script_gate_failed`
- `failed` -> `validator_gate_failed`
- every other required non-pass -> `validation_gate_failed`

The `validation_gate_failed` branch also carries the classifier's round snapshot
as internal diagnostic data. This is not a persisted schema change.

### D2 — Recovery stays pre-terminal and validation-only

Preserve `completed` as terminal. Do not add `completed -> ready` to
`CONTEXT_STATUS_TRANSITIONS`; reopening already-landed work can invalidate
downstream joins and contexts that consumed it.

For the supported recovery path:

1. An infrastructure halt leaves the required round open.
2. Production `signalHalt` leaves the context `halted`; the existing finalizer
   ownership guard must continue to prevent `halted -> completed`.
3. Resume changes `halted -> ready`, refills only the unheard specialist
   attempts for the named context, and leaves its completed task states intact.
4. Scheduler admission starts `runValidationOnlyIteration`; no implementer or
   tool server is created.
5. A pass concludes the round and permits ordinary context completion/landing.

For pause-to-edit:

1. The pause transition changes an active `running` context to `ready`.
2. `withdrawRoundQuestions` concludes its open round with `outcome: null` and
   releases an `awaiting_user_input` context to `ready` after its validator
   parks are removed.
3. Resume leaves it schedulable; the validation-only path freezes a fresh round
   with the next sequence number.

These are postconditions to test end to end, not new state fields.

### D3 — Final publish and completion fail closed

Add a shared finder over the D1 classifier for every non-skipped context whose
validation is owed. Use the same land-gated route settlement that existing
completion checks use to exclude a genuinely declined route.

Apply it at three boundaries:

1. `planFinalPublishJoin` returns no plan while certification debt exists.
2. Claim-time validation supersedes a stale persisted `final_publish` if debt
   appeared across pause/resume, matching the existing unfinished-task guard.
3. The execution loop's quiescent completion check records a
   `recovery_error` and halts instead of sending `complete`.

The recovery error lists context id plus exact state, for example:

```text
Refusing to complete: required validation is not certified for route-fix
(round 1, phase concluded, outcome null). The context is already terminal or
the scheduler found no recertification path. Abandon this execution and launch
a replacement; terminal landed contexts are not reopened in place.
```

`recovery_error` is intentionally non-resumable. Repeated Resume must not
pretend it can repair a terminal/landed context.

### D4 — Delivery refusal preserves claimant identity and proof detail

`delivery-gate-v2.ts` currently drops context ids when it reduces claimant
outcomes to counts. Retain `{ contextId, outcome }` through
`unmetClaimantOutcome` and render one bounded diagnostic per claimant.

For the incident, both criterion outcomes should say the equivalent of:

```text
R1.1: claimant route-fix failed validation_gate_failed
(validation round 1 is concluded with outcome null)
```

The merge machine's refusal formatter must include these reasons rather than
only joining criterion handles. The structured `haltReason.unmet` remains the
source of truth for detailed surfaces.

Split recovery instructions by the state that can actually change:

- Active/unsettled graph: repair or resume the graph until claimant validation
  passes, then retry delivery.
- Archived claimant failure: obtain a current-revision Studio waiver for the
  listed criteria or abandon/start a replacement delivery execution, then retry
  Merge.
- Never suggest prepared-candidate validation as claimant recovery. The v2 gate
  does not read `candidateValidation` when evaluating authored contexts.

### D5 — Record stable partial verdicts without claiming delivery

After claimant evaluation, first require
`getIntegrationReadyFinalCandidate(...)` to be satisfied. That guarantees the
workflow is completed/archived and the satisfied contexts are integrated, so
their outcomes cannot change through another live edit.

At that point, call the existing idempotent `recordVerdicts` for every satisfied
criterion **before** the aggregate criterion decision. If two criteria remain
unmet, the other 52 receive `verdict_recorded`; the execution still remains
`running` and none are projected as `delivered` until a gate-passed merge marks
the execution delivered.

Do not record partial verdicts while final-candidate integration is pending or
failed. That would persist proof from a still-mutable graph.

The corrected all-pass retry records the remaining verdicts, permits Merge, and
uses the current idempotency key to avoid duplicates.

### D6 — Existing archived executions are not rewritten

No migration rewrites archived `runtime_json`, moves a History execution back to
Current, or reconstructs a verdict that no validator rendered. Such a rewrite
would fabricate provenance and revive cleaned-up worktrees/lanes.

For execution `649a825a-d47c-4b99-959c-5c75f085362c`, the supported choices are:

- grant Studio waivers for `R1.1` and `R1.2`, explicitly accepting the missing
  machine certification while retaining the implementation evidence; or
- abandon the current spec execution and run a replacement delivery whose
  `route-fix` claimant reaches a passing round.

This is deliberate designed friction: the audit property stays intact, and the
product explains why a merge retry alone cannot change it.

## 5. Module changes

| Owner | Change |
| --- | --- |
| `src/lib/workflow-graph/validation-certification.ts` | New pure classifier and debt finder; no persistence or I/O. |
| `src/lib/workflow-graph/authored-context-outcome.ts` | Consume the shared classifier and expose raw round diagnostic detail on `validation_gate_failed`. |
| `src/lib/workflow-graph/lane-join.ts` | Refuse planning `final_publish` while certification debt exists. |
| `src/lib/workflow-graph/execution-loop.ts` | Re-check debt at final-publish claim and quiescent completion; halt fail-closed. |
| `src/lib/workflow-graph/workflow-manager.ts` | Preserve infra-refill and `halted -> ready`; add lifecycle logging/assertions needed by the regression, not a terminal reopen. |
| `src/lib/workflow-graph/user-input-gate.ts` | Preserve concluded/null retirement; assert the pause path returns affected contexts to the schedulable set. |
| `src/lib/specs/delivery-gate-v2.ts` | Preserve claimant ids/details, split recovery instructions, and persist stable satisfied verdicts before aggregate refusal. |
| `src/lib/workflows/merge/machine.ts` | Include criterion reasons in the refusal headline/details. |
| Native-SDD authoring skill | State that authored-context outcomes, not merge candidate validation, own v2 claim proof; name waiver/replacement recovery for archived claimants. |

No UI change is required to correct the misleading `0/54`: the existing
delivery projection already distinguishes `verdict_recorded` from `delivered`.

## 6. Red-green-refactor test plan

Implementation must begin with the behavior-level lifecycle reproduction. Use
the registered single-file test command for each red/green loop.

### T1 — Incident lifecycle reproduction

New integration test, preferably
`src/lib/workflow-graph/validation-certification-lifecycle.integration.test.ts`:

1. Complete every task in one validation-required context.
2. Run the production signal-halt path after a blocking specialist exhausts
   infrastructure attempts.
3. Assert the execution halts, the context is not completed/landed, and the
   round remains open.
4. Resume and assert the context is schedulable as validation-only work.
5. Pause while the replacement round is open; assert it becomes
   concluded/null and the context is ready.
6. Resume; return a passing validator verdict.
7. Assert a new round sequence passes, final publish runs, and the execution
   completes.

RED must fail on the missing lifecycle behavior, not harness setup.

### T2 — Completion and publish backstops

In `execution-loop.test.ts`, seed a quiescent context with all tasks complete and
required validation in each invalid state:

- no round
- open `script` round
- open `specialists` round
- concluded/null round

Assert no `final_publish` is claimed, no `complete` event is sent, and the run
halts with the exact context/round diagnostic. Add a passing-round control.

In `lane-join.test.ts`, pin both plan-time refusal and claim-time supersession of
a stale final-publish join.

### T3 — Outcome diagnostic fidelity

In `authored-context-outcome.test.ts`, assert `validation_gate_failed` retains:

- claimant context id at the service boundary
- absent versus open versus concluded distinction
- round sequence, phase, and null/non-passing outcome

Keep existing `script_gate_failed` and `validator_gate_failed` behavior green.

### T4 — Delivery refusal and partial proof

In `delivery-gate-v2.test.ts` and its SQLite integration test, use two selected
criteria:

- one satisfied by an integrated claimant
- one whose only claimant has round 1 concluded/null

Assert refusal names both the criterion and failed claimant, contains
`validation_gate_failed` plus concluded/null detail, does not recommend
prepared-candidate validation, and persists a verdict only for the stable
satisfied criterion.

Then make the second claimant pass and assert both verdicts exist, the gate
passes without a waiver, and repeated evaluation is idempotent.

### T5 — Archived recovery instruction

In `machine.test.ts`, assert an archived claimant refusal tells the operator to
waive or start a replacement execution and renders the concrete claimant
reason. Preserve the distinct human-approval refusal copy.

### Wider verification

After the focused loops:

- changed-scope tests
- typecheck
- seams
- lint
- build if required by the registered validation catalog
- live reproduction against a scratch native-SDD execution before completion

## 7. Rejected alternatives

### Treat prepared-candidate validation as claimant proof

Rejected. It changes v2's trust model from stable authored-context outcomes to a
merge-wide fact that cannot say which claimant fulfilled which promised
criterion. It also contradicts the current native-SDD authoring contract.

### Change concluded/null into `passed`

Rejected. No validator rendered that verdict; doing so fabricates provenance.

### Automatically reopen every completed claimant

Rejected. `completed` is intentionally terminal. A landed context may already
have released downstream contexts and joins; reopening it after a failed
recertification would require graph-wide invalidation and replay, far beyond this
bug and unsafe to infer.

### Make the delivery gate lenient because tests passed elsewhere

Rejected. Whole-suite and downstream-join validation are supporting evidence,
not the blocking authored claimant verdict frozen by the approved delivery
binding. Human waiver is the explicit mechanism for accepting that substitution.

### Record verdicts before final-candidate stability

Rejected. A live graph can still change claimant outcomes. Partial verdicts are
safe only after the graph is completed/archived and its satisfied contexts are
integrated.

### Add a new persisted `recertification_required` flag

Rejected for now. The obligation is derivable from definition plus round state;
storing it creates another invariant to synchronize and migrate.

## 8. Acceptance mapping

| Ticket criterion | Design coverage |
| --- | --- |
| 1. Full halt/resume/pause/completion regression | T1 |
| 2. Publish/completion refuse absent/open/null proof | D1, D3, T2 |
| 3. Resume schedules validation-only recertification | D2, T1 |
| 4. Pause retirement requires a fresh round | D2, T1 |
| 5. Refusal names claimant and concrete reason | D4, T3, T4, T5 |
| 6. Recovery instruction changes v2 proof state | D4, D6, T5 |
| 7. Corrected path records verdicts and merges | D5, T4 |

## 9. Finding owners

| Finding | Owner |
| --- | --- |
| Validation absent from terminal graph invariants | Graph workflow engine: shared classifier, lane join, execution loop |
| Validation-only recovery reachable only through status | Workflow manager lifecycle regression suite |
| Pause retirement lacks an end-to-end recertification pin | User-input gate plus lifecycle integration test |
| Claimant identity/detail discarded by aggregation | Native-SDD v2 delivery gate |
| Merge refusal copy recommends ineffective evidence | Delivery gate instruction plus native-SDD authoring skill |
| Partial stable proof hidden as `0/N` | Delivery-verdict write ordering after integration-ready final candidate |
| Cost/time cause cannot be quantified | Future workflow telemetry/reporting work; not implemented in this ticket |
