# Retire the validation round a plan-defect halt leaves open (command-center#86)

Status: IMPLEMENTED — revision 2. Uncommitted. Not live-tested.
Scope: `validation-round.ts`, `workflow-manager.ts` (resume), and
`iteration-orchestrator.ts` (finalize withhold — F1, folded in per Alex).
No schema change, no migration, no new event type.

Gates: `typecheck`, `seams`, `lint`, `build` green (full scope). `test --scope
full` — 23404 passed, 2 failed, both pre-existing and unrelated to this change:
`0030-native-sdd-v2-cutover.test.ts` timed out under swap pressure and passes in
isolation; `agent-backends/claude/conversation-runtime.test.ts` fails in
isolation too, on a `CONVERSATION_CAPABILITY_ENV_VAR` assertion in a module with
no import path to `workflow-graph`.

Decisions (Alex, 2026-08-21):
- **D1** — a retired round records `outcome: null`. §4.
- **D2** — F1 (infra halt finalizes and merges an uncertified context) is fixed
  in this ticket, not filed separately. §6.

## 1. Problem

A `plan_defect` halt deliberately leaves its validation round OPEN
(`iteration-orchestrator.ts:3227`, documented at `:3213-3218`). Nothing on the
recovery path — plan repair, or an operator's own live edit — ever retires it.
`contextIdsResumingInfraHalt` (`validation-round.ts:249`) matches
`validator_infra_error` and nothing else, so resume walks past the round it was
supposed to answer.

That single leak produces two different failures, and which one you get depends
on whether the repair added tasks.

### A. Deadlock — the repair adds tasks

The resumed loop sees pending tasks and must seed an implementer. The structural
guard at `iteration-orchestrator.ts:4666-4671` refuses, because
`isValidationRoundOpen` is still true. The throw escapes the loop as
`execution_loop_failed`, and plain resume re-halts identically. Only a hand-edit
of `runtime_json` gets the run moving again.

This is the case the ticket reports (`execution-history-log`).

### B. Stale-defect replay — the repair adds no tasks

With no tasks to seed, the context goes straight to validation. The round is
still open and — because a contract-only repair moves neither the tree nor the
task-state hash — `candidateIdentityMatches` succeeds, so the round is
**resumed** rather than replaced (`:2679-2682`).
`carriedForwardCohortLanes` then rebuilds the seat's stored `planDefects` into a
`kind: "plan_defect"` settlement (`:2206-2228`), the cohort re-aggregates it
(`validation-cohort.ts:607-632`), and the identical halt fires. No validator
ran. The repair is invisible.

**The ticket's "why earlier repairs survived" section is wrong.** `lane-canvas-kit`
on the same execution did not survive; it re-halted three times. From
`graph_workflow_events` for `81d48065`:

| time (2026-08-21) | event |
| --- | --- |
| 04:55:11.727 | `plan-defect-halted`, **roundSeq 4** — "Global-tier live-edit provenance is unavailable to the UI" |
| 05:00:44.735 | `plan-repair` **repaired**, 2 ops, resumed |
| 05:00:46.555 | `plan-defect-halted`, **roundSeq 4**, same defect — 1.8s later |
| 05:00:46.636 | `plan-repair` **exhausted** |
| 05:28:56.318 | `plan-defect-halted`, **roundSeq 4**, same defect (operator resume) |
| 05:30:01.875 | `plan-defect-halted`, **roundSeq 4**, same defect (operator resume) |
| 05:43:17 → 05:46:20 | resume; ~3 min to a real specialist result — a fresh round at last |

`roundSeq 4` repeating across every re-halt is the signature: the same open round
was resumed and its stored verdict replayed. Each cycle took under two seconds
because nothing was dispatched. The run burned its entire plan-repair budget on a
defect that had already been fixed, and escaped only when an unrelated sibling
merge moved `headSha` out from under the frozen candidate — an accident, not a
recovery.

### Root cause, stated once

`plan_defect` is classified resumable precisely because "the remedy is a repair of
the plan the defect names — plan repair's edit, or an operator's — followed by
resume" (`lifecycle-classifier.ts:228-231`). Resume is the sanctioned recovery
verb. It simply does not do the one thing this halt requires of it.

## 2. Fix

Teach resume that a round its own halt left open has **two** possible
dispositions, not one.

| halt reason naming the context | disposition | why |
| --- | --- | --- |
| `validator_infra_error` | **refill** — keep the round open, reset unsettled attempts | unchanged (D5): a human decided the provider is worth another try, and the settled verdicts judged this same candidate |
| `plan_defect` | **retire** — `concludeValidationRound(round, null)` | the contract those verdicts judged no longer exists |
| anything else, or no halt reason | **leave alone** | the restart path (`normalizeAfterRestart`) resumes a pause nobody looked at; a crashed round is legitimately resumable |

Retiring does not erase anything. `concludeValidationRound` retains the candidate,
the roster, and every seat's verdict — it moves `phase` to `concluded` and stops
the round from owning the candidate. The frozen evidence the plan-defect halt
comment wants readable stays readable.

### 2.1 `validation-round.ts` — widen the classification

Replace `contextIdsResumingInfraHalt` with a per-context disposition map:

```ts
export type ResumeRoundDisposition = "refill" | "retire";

export function validationRoundResumeDispositions(
  haltReasons: readonly (GraphWorkflowHaltReason | null | undefined)[],
): ReadonlyMap<string, ResumeRoundDisposition>;
```

Conflict rule, when a context is named by both a primary and a secondary halt
reason: **retire wins**. A repaired contract invalidates every verdict the round
holds, including the ones a refill exists to preserve.

The existing scoping rule and its reasoning carry over verbatim — halt reasons
are per-context, and a sibling's open round is not what the operator resolved.

### 2.2 `workflow-manager.ts` — apply it in the resume reducer

At `:2604-2611`, inside the loop that already clears failure counters:

```ts
const round = contextState.validationRound;
if (round && isValidationRoundOpen(round)) {
  const disposition = dispositions.get(contextState.contextId);
  if (disposition === "refill") {
    contextState.validationRound = resetValidationRoundAttempts(round);
  } else if (disposition === "retire") {
    contextState.validationRound = concludeValidationRound(round, null);
  }
}
```

Record both sets on the existing `execution.resumed` lifecycle log line
(`retiredRoundContextIds`, `refilledRoundContextIds`) rather than adding an event.
Concluding a round without an incident is what `withdrawRoundQuestions` already
does on pause-to-edit (`user-input-gate.ts:822-828`); consumers read the round
record, which the resume write broadcasts anyway.

### 2.3 The seed guard is unchanged

`iteration-orchestrator.ts:4666-4671` keeps throwing. It is the only structural
detector of a real implementer/cohort overlap, and softening it to
"conclude and continue" would silently paper over a genuine concurrency bug.
Once resume retires the round, its invariant holds again on its own terms.

## 3. Why the resume seam, not the supervisor

The ticket offers `createPlanRepairSupervisor` (before `resumeExecution`, when the
repair produced operations) as the alternative. Four reasons against it:

1. **It misses the operator.** Someone who resumes a `plan_defect` halt by hand —
   after their own live edit, or after none — hits both failure A and failure B
   with no supervisor in the picture. `lifecycle-classifier.ts:228` names that
   operator as a first-class remedy. Resume covers both actors with one change.
2. **Plan repair already resumes through this path.** `deps.resumeExecution` is
   the RESUME handler trio; the supervisor gets the fix for free.
3. **One owner for one question.** The halt-keyed round decision already lives in
   the resume reducer, with the same shape and the same per-context scoping. A
   second halt-keyed round decision in the plan-repair module would be two owners
   for "what happens to a round an intentional halt left open."
4. **It is strictly more durable.** The ticket asks that the release survive a
   repair whose resume fails. At this seam that is structural rather than
   ordered: the retirement *is* part of the resume mutation. There is no window
   where the round is retired but the halt still stands. If resume fails, nothing
   was retired, the round is still readable, and the next resume retires it.

Note also that the supervisor's proposed condition — "when the applied repair
produced operations" — would fix A and only accidentally fix B. Keying on the
halt type fixes both by construction.

Rejected as primary seam: the live-edit apply core. "The candidate moved" is
already owned by the orchestrator, which checks candidate identity before
accepting each specialist result and before publishing the aggregate. Concluding
rounds there too would put a second owner on that decision.

## 4. D1 — the retirement outcome is `null`

The ticket proposes `candidate_mismatch`. Decided: **`null`**.

- `concludeValidationRound(round, null)` is the existing vocabulary for "this
  round is over and nothing it collected may be recorded" — exactly what
  `withdrawRoundQuestions` writes when an operator pauses to edit the plan the
  round was reviewing. A plan-defect recovery is that same situation with an
  agent holding the pen.
- `candidate_mismatch` carries accounting. `settleCandidateMismatchBudget`
  (`iteration-orchestrator.ts:2343-2353`) increments
  `consecutiveCandidateMismatchCount` on exactly that outcome, and at the bound
  halts with `candidate_unstable`. Writing it from resume without running that
  accounting puts the one outcome that mints a budget charge outside the module
  that owns the budget. (Nothing breaks *today* — resume zeroes that counter for
  `ready` contexts on the same pass — but the outcome would mean two different
  things depending on who wrote it.)
- It is also not factually true in case B. The candidate did **not** move; that is
  precisely why the round was resumable. "Retired without a verdict" is `null`.
- No consumer distinguishes them. `authored-context-outcome.ts:117,126-127` gates
  on `passed` and treats `script_failed`/`failed` as gate failures; `null` and
  `candidate_mismatch` both fall through identically.

A third option — a new, self-describing `plan_repaired` outcome — reads better in
the UI but costs a **breaking migration**: `outcome` is a persisted `.strict()`
Zod enum (`schemas.ts:1235-1244`), so a sixth value needs the schema-floor fence
that `candidate_unstable` needed in migration 0031. Not worth it for a label.

The "why" is not lost: the plan-repair round log carries the diagnosis, and the
resume lifecycle line names the contexts whose rounds were retired (§2.2).

## 5. Tests (red first)

The discriminator the ticket names — *plan-defect halt + resume* — plus the
task-adding variant that produces the reported crash.

| # | given | assert | fails today because |
| --- | --- | --- | --- |
| T1 | `plan_defect` halt on C; C `ready`; round seq 1 open at `specialists`; 2 `pending` tasks added after the freeze | after `resume`, C's round is `concluded` and `isValidationRoundOpen` is false | stays `specialists` |
| T2 | same, but 0 pending tasks and the seat carrying `planDefects` | round `concluded`; the next validation pass freezes a **new** round with no carried-forward lanes | round is resumed and the stale defect replays |
| T3 | `validator_infra_error` halt on C, round open, one unsettled lane at 3 attempts | round still OPEN, attempts back to 0 | — pins D5 against regression |
| T4 | resume with no halt reason (restart path), round open | round untouched — neither retired nor refilled | — pins the crash-resume case |
| T5 | `plan_defect` names C; sibling D also holds an open round | only C's round is retired | — pins the scoping rule |
| T6 | C named by a `plan_defect` primary and a `validator_infra_error` secondary | retired, not refilled | — pins the conflict rule |
| T7 (integration) | plan repair applies task-adding ops, then resumes | seeding the implementer does not throw; no `execution_loop_failed` | this is the reported crash |

As implemented: T1, T2, T5 and T6 landed in `workflow-manager.test.ts`; T3 and T4
already existed there and still pass unchanged. T7 landed in
`validation-plan-defect-halt.test.ts` — the cohort harness reaches the seed, and
with the fix disabled it rejects with the ticket's own message verbatim
(`Cannot seed the implementer for execution context "context-plan": validation
round 1 still owns the candidate.`). F1-T1 and F1-T2 landed in the new
`validation-infra-halt-finalize.test.ts`.

T1–T6 are reducer-level against `workflowManager.resume`, alongside the existing
infra-refill cases in `workflow-manager.test.ts` (they share the `openCohortRound`
and `createRepository` helpers). T7 extends
`plan-repair/plan-defect-routing.integration.test.ts`; confirm the engine harness
can reach `seedImplementer` before promising it — if not, T1 plus a direct
guard-level assertion covers the same claim.

For F1:

| # | given | assert | fails today because |
| --- | --- | --- | --- |
| F1-T1 | a validation-only iteration whose cohort infra-exhausts; `signalHalt` sets the context to `halted` with a pending halt reason | the context stays `halted` — finalize does not write `completed` | finalize falls through to `completed`, and the lane lands |
| F1-T2 | the ordinary path: tasks done, round `passed`, no halt | still transitions to `completed` | — pins the happy path against the new guard |

## 6. D2 — F1: an infra halt finalizes and merges an uncertified context

This is what the ticket saw as "`config-panel-core` is completed while carrying an
open round." The open round is the symptom; the disease is worse. From the events:

```
23:16:26.794  validation-incident  infra_exhausted   roundSeq 1, general, 3 attempts, no verdict
23:16:26.817  context-status       halted            remainingTaskCount 0
23:16:26.849  context-status       completed         (+32ms)
23:16:28.172  lane-landed / merge-status / lane-commit
```

### 6.1 Mechanism

Three things have to line up, and they do:

1. The infra path calls `onHalt` and then `throw new IterationHaltedError`
   (`:3090-3102`). `signalHalt` records a **pending** halt reason and sets the
   *context* to `halted`, but leaves `execution.status` on `running`
   (`graph-workflow-signal-halt.ts:36-52`).
2. The catch at `:4489-4504` swallows the error and falls through to finalize.
3. `finalizeIterationResult` withholds completion for only two of the three ways
   an iteration can lose its context:
   - `:4136` — `execution.status !== "running"`. Does not fire: the halt is
     still pending.
   - `:4217` — context status `ready` or `pending` ("another writer has already
     taken this context back"). Does not fire: the status is `halted`.
   - `:4257` — `contextOwesOutput`. Does not fire: this context declares no
     output.

   So it falls to the `else` at `:4275` and writes `completed`.

The `contextOwesOutput` guard's own comment already describes this precise
failure — "a tripped breaker throws IterationHaltedError, which both loops
swallow and still finalize… this branch would otherwise write `completed` over a
halted context." **It is the right insight written at the wrong level of
generality**: it protects contexts that owe a declared output, when the invariant
is about every halted context. `config-panel-core` fell through the gap and its
lane landed and merged. (`authored-context-outcome.validationGatePassed` would
have refused it — the merge path does not consult it.)

The triggering infra failure was the Codex `invalid_json_schema` bug fixed in
`8d968460`. The finalize hole is independent and still live.

Worth recording why this survived so long: **every existing infra-halt test uses
the harness's one-write halt fake**, which sets `status: "halted"` immediately,
so the finalizer's mid-flight guard fires and the window never opens. Only
`validation-plan-defect-halt.test.ts` passes `productionSignalHalt: true` — and
it was written for the plan-defect path. The new test file mirrors it for the
infra path.

### 6.2 Fix — generalize the ownership-lost guard

Add `halted` to the withhold at `:4217`, whose comment already states the
principle: *this iteration no longer owns the context, so every outcome it would
write is stale.* A halted context is the clearest case of that.

```ts
const ownershipLost =
  finalizedContextState.status === "ready" ||
  finalizedContextState.status === "pending" ||
  finalizedContextState.status === "halted";
```

The withhold happens **after** the `terminatedByTerminalError` failure-count
increment at `:4187`, so consecutive-failure accounting is unchanged and a
terminal-error loop still trips the breaker.

The `contextOwesOutput` branch stays. It becomes unreachable for the halt case it
was written for, but it is not exclusively a halt guard, and deleting a
fail-closed check to prove a point is not worth the risk.

### 6.3 Why this does not create a new deadlock

An infra-halted context keeps its round open by design (`refill`, §2). Could
resume then reseed an implementer into that open round — failure A again? No: a
round is never frozen while tasks remain incomplete
(`iteration-orchestrator.ts:2582-2588`), so an open round always sits on a
context with zero pending tasks. Only a plan repair, which adds tasks *after* the
freeze, can produce the open-round-plus-pending-tasks combination. That is
exactly why the ticket's discriminator is the right one.

## 7. Still out of scope

**F2 — out-of-band `runtime_json` repair is unsafe without a server bounce.**
`createGraphWorkflowExecutionsRepo` keeps a parsed-row cache
(`graph-workflow-executions-repo.ts:530-534`) invalidated only by in-process
writes, so an external patch stays invisible and the next `mutateActive` clones
the stale record and writes it back. The ticket already flags this; it is a
repository-cache concern, unrelated to rounds.
