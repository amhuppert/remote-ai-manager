# Shared Conversation checkpoint after W5 and C2

Review for Alex, 2026-10-05, against `f8d211bc53ebd6ee3e791b4f4e977f36d8834604` and [design revision 2](2026-10-02-shared-conversation-design-r2.md). This is a review and recommendation. It changes neither the governing design nor the implementation and authorizes no cutover.

**Keep Conversation, Context, Run and Workspace. The implementation supports the shared machinery; another architectural rewrite is unwarranted. Correct Context's treatment of pending work and parked seats, connect real background activity to Conversation's turn lifetime, and make the design's main contracts agree with its accepted implementation limits before cutover.**

The previous retrospective preceded routes, loops, lanes, amendments and the new runtime/input integration. Those additions have strengthened the top-level design: standalone and workflow runs use the same constructor and scheduler; Run now reads semantic Context summaries; actual Workspace admission owns the last permit check; and one registry and input-evidence classifier serve the core. The remaining problems are incomplete semantic boundaries inside those domains. They are not evidence that four domains or durable intent reconciliation were the wrong choices.

Envelope: Alex alone, one active server and SQLite database per independent installation, concurrent agents and worktree writers, and server restarts during work. Local transactions, operation identities and checked Git effects earn their complexity. Distributed coordination, another actor framework, or a universal effect language would not.

## 1. Context must distinguish pending work, the next obligation and a seat's owner boundary

**Change now: implementation correction with a narrow internal contract improvement.**

`EffectView` exposes only a cause and two booleans (`src/lib/execution-context/progress.ts:19`). `deriveProgress` first derives the next unsatisfied acceptance step, then changes its running/waiting label when effects exist (`progress.ts:51`). If that next step derives a halt, pending effects cannot override it. The host also plans any further operation only when every pending intent has closed (`src/lib/execution-context/host.ts:410`). These shortcuts lose distinctions the implemented retry and concurrent-review behavior already requires.

**Demonstrated case: the last authorized retry reports exhaustion before it finishes.** `planEffects` reserves the retry's allowance (`src/lib/execution-context/effects.ts:535`), reservations count against the remaining budget (`src/lib/execution-context/allowances.ts:8`), and tasks still open cause the subsequent projection to derive `retries_exhausted` (`progress.ts:82`). An offline diagnostic using production `initialContextFacts`, `planEffects`, `advanceContext` and `deriveProgress` produced a pending `work(retry)` with a reserved charge and a halted projection both before and after admission. The permitted work is still submitted; this is a false control/owner observation, not proof that the retry is denied. Run can emit a premature halt notice (`src/lib/runs/host.ts:220`) and later report success if that retry completes the task. Validation remediation uses the same pattern.

**Source-traced case: one reviewer's question waits for its cohort.** Reviewer A can settle with a question while B keeps running. A's question is recorded (`src/lib/execution-context/advance.ts:345`), but B's pending intent prevents an answer wait being planned. Progress becomes `running(await_answer)`, while Run projects questions only from `waiting(await_answer)` (`runs/host.ts:192`). The question remains readable in `run show` through `openQuestions`; automatic owner attention and A's continuation wait for B. That contradicts r2 §5.5's seat-only parking, and is already reachable with the implemented concurrent reviewer cohort. The ask route records the question without an independent notification (`src/lib/conversations/ask-route-handlers.ts:303`).

Give Context one semantic summary of pending operations: operation/obligation, seat, actual admission and human wait. Derive an in-flight obligation from it before judging exhaustion for future work. Project seat questions independently of the single display lifecycle, and permit answer waits and reviewer continuations while unrelated reviews remain active. Deduplicate through the existing cause and seat identities. All required reviews must still settle before advice, approval or acceptance; implementer writes must still wait for their review readers.

This is a useful revision below the existing Context interface. Moving one allowance conditional would fix the false halt but leave seat questions coupled to batch completion. Storing another lifecycle or adding a supervisor per seat would create synchronized state and queues without a new requirement. Keep facts, pure derivation and one reconcile transaction; make their input express the distinctions they must own.

Required regressions: the final task and remediation retry while queued, running and settled; and two reviewers where A asks, is notified, receives an answer and continues while B remains running. Assert durable boundaries and no duplicate intents. Preserve W5 disposition 15's accepted limit that cancellation may leave a question open if its waiter was never submitted; cancellation must still settle the Context. Revisit that limit only if the new seat planning changes the case.

## 2. Genuine Claude background progress must reach the admitted attempt's watchdog

**Change now: implementation correction. The turn-lifetime design remains right.**

Native work seats wait for background tasks (`src/lib/conversation-core/native-seat-turns.ts:139`). Claude performs that wait after the primary `sendPrompt` result (`src/lib/agent-backends/claude/conversation-runtime.ts:465`). Real background task progress still updates the tracker and creation callback (`src/lib/agent-backends/claude/query-session.ts:1309`), but with no pending provider turn or external-turn handler it is discarded from the per-turn event stream (`query-session.ts:1321`).

Core production's `onBackgroundActivity` updates only the display channel (`src/lib/conversation-core/production-engine.ts:183`). Its watchdog refresh is inside `onEvent` (`src/lib/conversation-core/turn-engine.ts:179`). With a nonzero inactivity timeout, an admitted work seat can therefore close a genuinely progressing background task: for example, task progress every ten seconds after primary yield still does not refresh a sixty-second watchdog. This conclusion is source-traced, not a fresh live-provider reproduction. A zero stall timeout does not trigger this failure.

Pass genuine provider activity to the lifetime through a neutral, attempt-bound event or callback, checking the captured runtime/attempt before refreshing it. Preserve the UI projection and the independent background-settlement deadline. Repeated polling or an unchanged status snapshot must not keep stalled work alive.

Keeping Claude runtimes between turns could support richer external continuations and live input, but would also require additional admission, usage and configuration ownership. It does not solve a different requirement in this scenario: the background work already belongs to the current attempt. The narrow activity bridge is cheaper and preserves the current release-after-turn policy.

Add a composed core-engine/Claude-adapter regression with an inert SDK pump: yield the primary result, emit real task progress past the stall bound, then complete; repeat with silence and require confirmed cleanup before conflicting admission. Current core tests usually disable the stall timeout and supply empty creation callbacks, so their green result does not prove this connection.

## 3. Retain the evidence of owner dispositions

**Change before extending repair or historical observation: a small durability correction.**

The validated disposition carries a reason or inspection evidence (`src/lib/execution-context/schemas.ts:525`), but the Context mutation clears the halt and applies the effect without retaining the decision (`src/lib/execution-context/advance.ts:570`). `grantAllowance` increments totals without the reason (`src/lib/execution-context/allowances.ts:63`); `confirm_effect` discards its required evidence (`advance.ts:615`). The host checks the occurrence, then passes only the disposition onward (`src/lib/execution-context/host.ts:554`).

After reload, Context cannot explain from its facts which halt the owner resolved, what inspection justified confirmation, or why more retries were granted. A prior Run halt boundary and the executor's outcome cannot substitute for that owner decision. This is missing evidence in the fact model promised by r2 §§5.2–5.7, not proof of a new executor recovery failure.

Append the existing disposition, occurrence, time and reason/evidence in the same Context transaction. Keep that history private and expose it when diagnosis needs it. Extend the maximal round-trip fixture and an occurrence-bound resume test with reload. A small decision list is enough; event sourcing and another receipt ledger would add no useful capability.

## 4. Consolidate accepted amendments into the authoritative contracts

**Design/documentation correction now; preserve accepted limits unless new evidence warrants reopening them.**

R2's amendment log captures real learning, but several main contracts still describe the superseded alternative. A maintainer reading a section locally can implement a deleted feature or add machinery to enforce an intentionally declined guarantee.

| Contract to reconcile | Current decision and evidence | Concrete next action |
| --- | --- | --- |
| Standalone Run has no internal graph (§2.1; §13 rejects a synthetic one-entry graph) | Amendment 4 deliberately normalizes it to one entry. `resolveAgentLaunch` feeds the shared definition/scheduler (`src/lib/runs/launch.ts:189`). Standalone callers author no topology. | Distinguish caller contract from internal normalization everywhere; retain the one scheduler. |
| Run stores route choices and loop passes (§7.1; §10) | Amendment 8 derives choices/outcomes from frozen definitions and durable accepted outputs. `planRun` is shared by schedule, observation and amendment comparison (`src/lib/runs/schedule.ts:139`; `src/lib/runs/amendment.ts:204`). | Describe invocation facts plus derived routing; do not add a second route/loop ledger. |
| `Runs.approvePlan` in §7.1 | Alex removed plan approval; amendment 12 and the strict workflow schema reflect that (`src/lib/runs/workflow-definition.ts:750`). Human candidate approval remains distinct. | Remove the obsolete public operation and update examples/acceptance inventory. |
| One terminal recorder as an atomic durable settlement promise (§4.7) | The earlier disposition accepts separate conversation-row and attempt/mailbox writes with visible failure and interrupted recovery (`.cc/temp/reviews/design-retrospective-dispositions.md:8`). `recordedResult` now propagates row-settle failure (`src/lib/conversation-core/recorded-turn.ts:111`). | State that reduced contract; this review supplies no new reason to require the declined single transaction. |
| Smart Merge cancellation implies every lane writer has stopped (§6.2; amendment 11) | W4 deliberately permits a started Git/resolver operation to outlive machine cancellation in the cancelled Run's unique, retained lane (`.cc/temp/reviews/w4-dispositions.md:47`). The final session publication still rechecks cancellation. | Define terminal cancellation accurately: the machine has handled cancel, but that lane can still have an uncollected writer. No future removal/reuse caller may infer quiescence from it. Full draining is not a new requirement here. |
| Blanket conflicting-admission block until receipt durability (§10) and richer journal fields (§6.4) | Workspace releases grants after the effect ends and before recording its result; on write failure it logs and leaves the operation running for restart recovery (`src/lib/workspace/executor.ts:516`). W4 V1 explicitly accepts this policy. Recovery uses the operation's marker and sparse facts. | Separate a finished effect with missing bookkeeping from an unfinished writer. Document the actual per-operation evidence and restart remedy. Do not add a whole-session quarantine or a Git/SQLite transaction to satisfy old prose. |

Also keep the currently explicit in-memory input-receipt retention, owned-path evidence, unconfined reviewers, and Claude next-turn input behavior. Those are accepted tradeoffs, not unresolved defects. Some precise Git limitations still live only in W4 dispositions, including staged-copy resync and incoming parent-path collisions; put those near the recovery contract rather than making the reader discover them in a historical review.

The accepted cancellation mitigation is credible in this envelope: a cancelled lane is unique and retained, supported work does not reuse it, and a stopped final publish cannot change the session. If a new cleanup or reuse consumer needs quiescence, add bounded writer tracking at the injected integration-actor boundary and a cancellation regression then. Replacing the retained merge algorithm with a durable supervisor now would exceed the demonstrated need.

## 5. Two focused ownership cleanups earn their cost

**Do with the relevant increment; neither requires a broad private-module refactor.**

- Candidate epoch resets are split between the outcome coordinator (`src/lib/execution-context/advance.ts:233`) and Candidates (`src/lib/execution-context/candidates.ts:48`). Adding a capture/verification field requires finding both resets. Pull the complete work-epoch reset into the existing Candidates owner, preserving one Context facts record and transaction. Merely changing every parameter to a fact slice would not by itself establish information hiding.
- Capability-specific seed merging remains in Conversation (`src/lib/conversation-core/runtime-application-state.ts:150`), which knows all cascade kinds and `pendingHash`/`appliedHash` rules. The capability domain owns related application and delivered-state reconciliation (`src/lib/agent-capabilities/apply/helpers.ts:162`; `src/lib/agent-capabilities/runtime-seed.ts:83`). Move this seed policy into that domain and retain Conversation's sequencing/store adapter. Preserve the save-during-runtime-creation behavior; do not force seed and application contracts into one algorithm merely because they resemble each other.

These are concrete change-amplification problems. Additional services, caches, plugin registries or mechanical file splitting would make them harder to understand.

## Major choices reassessed

| Choice | Verdict after implementation | Alternative and why it is less suitable now |
| --- | --- | --- |
| Four domains and one shared Conversation path | Keep. The domains separate turn execution, acceptance, topology and physical effects. Both launch forms reach the same Context and lifetime. | A common facade over separate task/workflow engines permits cancellation, input and receipts to diverge again. Flattening everything into one engine gives callers more lifecycle and Git knowledge. |
| Pending intents and one reconcile path | Keep. Context consumes outcomes, closes intents and records the next work in one transaction (`execution-context/host.ts:387`); live, resume and boot use the same mechanism. | In-process awaits plus separate restart repair reintroduce the historical split. A receipt table duplicates executor outcomes. |
| Permits checked at actual admission | Keep. Workspace now acquires an abortable grant and performs the last permit check before effect admission (`workspace/executor.ts:497`); parent permit generations cover Run/Context. | A check only at enqueue cannot enforce pause while waiting; another lock or scheduler is unnecessary. |
| Facts, candidate-bound proof and derived acceptance | Keep, with finding 1. Proof identities survive internal step changes without every handler invalidating every proof. Advisory authority and candidate approval remain distinct. | Stored phase fields and handler-driven invalidation recreate synchronized state. Per-seat supervisors are excessive for the current concurrent cohort. |
| Context briefing composer and closed turn-input contributions | Keep. Each owns a different decision: what an obligation asks a seat to do versus how Conversation delivers input and receipts. | A generic prompt/input plugin framework has no current producer that needs it. Work/format/repair still belongs in AgentCall. |
| Binding/grant separation and cooperative interactive writers | Keep Alex's decision. Durable supervised ownership survives waits; grants protect active operations; owners stay responsive. Owned evidence deliberately covers owned paths. | A lifetime worktree lock blocks owner questions and serializes session conversations. Whole-tree evidence for every owned writer defeats the selected concurrency tradeoff. |
| Closed lanes and Workspace-owned publication | Keep. One compiler wait graph covers lane start, Context completion and publication; the final publish checks the captured target under the session grant and Git lock. | Separate lane/context cycle rules missed real deadlocks. Letting the merge machine move the target bypasses Workspace ownership. |
| Reuse of Smart Merge through a narrow adapter | Keep the algorithms and accepted cancellation limit. Workspace owns target publication; the adapter supplies captured head, checks and fresh tasks. | A second merge/check/fix loop duplicates settled policy. Restart-durable merge internals are explicitly outside the current contract. |
| Derived routes/loops and full-definition amendments | Keep. One projection governs runtime, view and old/new amendment comparison. Fresh finite loop passes preserve evidence. | Persisting choices again creates another authority. Runtime graph expansion restores the removed repair model. Current whole-authored-graph concurrency refusals are conservative but disclosed; order new work after completed work. No new evidence justifies incremental compilation. |
| One-level ownership and owner-mediated repair/questions | Keep. It fits both ordinary sub-agent and workflow use. Repair stays an owner amendment; human candidate decisions stay human-only. | Restoring a repair agent or nested spawning introduces another authority. Seat questions need finding 1's projection correction, not a new ownership model. |
| Registry, runtime lifetime and per-backend launch policy | Keep. One process registry serves route/boot copies; configuration seeding preserves newer saves. Per-turn runtime disposal limits stale receipt reach. Complete the admitted activity signal in finding 2. | Persisted incarnation checks or retaining runtimes across turns add no present benefit under the accepted lifetime; revisit if that lifetime changes. A universal launch/pricing/continuation module combines decisions with different owners. |
| Artifacts/configuration freezing, client owners, export-and-delete cutover | Still appropriate, partly unimplemented. Their contracts have not been disproved by the available code. | Mutable paths are not frozen bytes, and dual runtime fallback is not a substitute for finishing the migration. Do not infer completed guarantees from types or the amendment log. |

## The next increment

1. Correct the semantic pending/seat projection and genuine background-liveness connection, using failing behavior regressions before production changes.
2. Retain disposition evidence and centralize the two demonstrated private policies while those owners are being touched.
3. Consolidate the accepted contracts into r2's main body, so future work preserves current decisions instead of restoring superseded promises.
4. Continue the planned preparation/cutover work. Workspace placement should return a semantic physical identity and backend-feasibility result consumed by launch; retain dispatch-time checks for mutable conditions. Frozen artifacts, charter/configuration inputs, peer messaging, owner subscription wakes, client entity/transcript/composer owners, template transformation and legacy deletion remain unfinished work, not retrospective faults.

Backend input relay deletion is explicitly deferred to cutover and still matters: adding a neutral field currently crosses forwarding shapes in `TurnRequest`, AgentCall runtime resolution and the conversation port reconstruction. Carry the backend input whole while preserving AgentCall's real sequencing. Do not mark this cleanup complete merely because ordinary and live contributions now share an owner.

No evidence supports a fresh top-level rewrite, reopening cooperative interactive access, replacing owned evidence with whole-tree ownership, adding receipt/event-sourcing infrastructure, or rebuilding Smart Merge. The strongest change is to finish deep operations and semantic projections inside the domains already chosen.

## Verification and limits

Read the live repository contract, envelope, charter, amended r2, implementation stage notes and relevant review dispositions, then traced current production callers, repositories and behavioral tests. Three independent bounded reviews examined Conversation, Context and Workspace; Run's compiler, planner, amendments, observation and control were reviewed in the parent. Historical reports supplied hypotheses, not current verdicts. The review changed only reports and an ignored diagnostic artifact.

Registered validation completed from this worktree with `--require-match --json`:

| Actual matched scope | Verdict | Run |
| --- | --- | --- |
| `runs/schedule.test.ts`, `runs/amendment.test.ts`, `runs/workflow-definition.test.ts` | Passed; 3 files | `vrun-bcb5c538-d806-40bd-8906-de45dd9464fd` |
| `execution-context/host.test.ts`, `workspace/smart-merge-integrator.test.ts`, `conversation-core/turn-input.test.ts` | Passed; 3 files | `vrun-5c86fb9d-ef3f-4380-af02-7eec164163ed` |
| `execution-context/context-core.test.ts` | Passed; 1 file | `vrun-a4d609cc-5e90-4b1b-aead-3b9875950a81` |

The second request also named nonexistent `execution-context/progress.test.ts`; it was not counted as evidence. The actual Context core test was run separately. Envelopes are retained under `.cc/temp/retrospective-{run,core,context}-tests.json`. These passes establish existing baseline assertions, not the missing final-reservation, concurrent-question or background-activity regressions.

The final-retry diagnostic is `.cc/temp/retrospective-allowance-probe.ts`, with output in `.cc/temp/retrospective-allowance-probe-output.json`. It invokes only inert production pure modules, not Vitest or a registered runner. This narrow one-off diagnostic was needed because the existing registered tests did not express the in-flight reservation assertion. It used no provider, live database or application worktree mutation.

No browser, live model, fresh-process restart, new Git failure probe or SQLite fault injection was performed. Context reviewer-question and Claude-background findings are source-traced; their recommended composed regressions remain to be added in an implementation task. No full-suite, cutover-readiness or completed-feature claim is made.

Supporting scoped evidence:

- [Conversation/runtime checkpoint](../../memory-bank/agent-runs/2026-10-05-retrospective-conversation.md).
- [Context/intents checkpoint](../../memory-bank/agent-runs/2026-10-05-retrospective-context.md).
- [Workspace/lane checkpoint](../../memory-bank/agent-runs/2026-10-05-retrospective-workspace.md).
