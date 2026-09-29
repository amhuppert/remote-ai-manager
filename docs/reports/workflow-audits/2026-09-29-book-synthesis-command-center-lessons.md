# Command Center lessons from book-synthesis delivery

Execution `62c5ad5a-4c6a-4ab5-ac53-3091a5007cca` · reviewed 2026-09-29.

## Assessment

Command Center successfully coordinated a substantial delivery across 23 contexts, two authored lanes, independent validators, human questions, and two clean joins. The strongest weaknesses were an advisory loop that can keep reopening passing work, incomplete validator orientation, and inaccurate audit summaries. Native SDD preserved local ownership and proof, but this run also showed that local acceptance can leave a defect discovered downstream without an owner obligated to resolve it.

The nine-hour runtime admission deadlock was the largest historical failure. Its direct fix already exists in this checkout. The recommendations below distinguish that fixed mechanism from gaps still present in current code. They concern Command Center; application defects are evidence of how the delivery machinery behaved, not a repair backlog for the audited project.

[Execution evidence and telemetry](2026-09-29-book-synthesis-delivery.md) contain the primary transcript, log, cost, and timing references. Current-code findings below are static inspection, not a claim that a patched server was live-tested.

## What to preserve

| CC mechanism | Evidence from this run | Lesson |
|---|---|---|
| Shared lanes with context-level work | 23 contexts used two authored lanes and two conflict-free joins | Context decomposition did not require a worktree and merge for every context. Preserve shared lanes. |
| Independent acceptance review | 22 contexts received first-round GO; one real defect received NO-GO and was repaired | Local contracts were usually implementable and reviewable. Preserve independent validation and distinguish first GO from final completion. |
| Thin-path and journey guidance | An early executable path preceded breadth; final verification found real integration omissions and replayed the bundled entry point | The SDD delivery skill's emphasis on reachable behavior helped. Preserve it rather than adding more abstract foundation stages. |
| Asynchronous questions | Two genuine decisions were answered in about five minutes total; work resumed | Human clarification worked. Agents should not guess through incompatible account/runtime requirements merely to avoid asking. |
| Durable recovery | Operator pause/resume recovered the pending phase without restarting completed work; the old loop was fenced out | Checkpointed phase state and generation fencing provided useful recovery even when runtime admission failed. |
| Detailed evidence | Transcript lineage costs, workflow logs, and server events made the failure and cost corrections reconstructible | The evidence exists. Improve the summary computations instead of requiring agents to rebuild them manually. |

This run supports those mechanisms in delivery. It does not independently evaluate the entire native spec authoring/review UI or prove that every human approval path works.

## Improvements worth making

### 1. Make advisory recertification actually bounded

**Observed:** 12 additional validator rounds followed GO verdicts and optional edits, costing $16.21 in validator usage alone. One context received four GO verdicts while its evidence note was revised and the same deferred findings reappeared. Some edits improved the evidence, so the whole amount is not labeled waste.

**Current mechanism:** recertification excludes advisory-authority seats, but a blocking seat can still return advisories. A passing recertification with such advisories can enter another response phase. Consequently, the steering document's claim that removing advisory lanes prevents a fresh batch is too strong. Existing recertification tests cover an advisory seat producing the advice and miss the blocking-seat variant.

**Smallest useful change [engine]:** on a recertification round, obtain the blocking verdict for the changed candidate without opening another optional advisory-response cycle. Preserve the original advisory dispositions and ordinary remediation if recertification fails. Add a regression covering a blocking reviewer that keeps returning optional advice. Align the steering text with the enforced behavior.

This uses the existing distinction between initial review and recertification; it does not need semantic finding deduplication or a new review framework.

Current evidence: `src/lib/workflow-graph/validation-round.ts:153–158` filters seats; `validator-output-schema.ts:123–126` retains the blocking seat's advisory field; `context-validation-coordinator.ts:2461–2462,2644–2649` collects advice and enters another response phase. `advisory-recertification.test.ts:91–104,239–245` covers only advice from the advisory seat. The conflicting documented guarantee is in `.kiro/steering/workflows.md:641`.

### 2. Put the readable candidate root in validator instructions

**Observed:** reviewers started in an empty scratch directory and searched for the candidate before beginning useful inspection.

**Current mechanism:** the runner knows the candidate worktree and passes its binding into dispatch, but the conversation validator prompt does not explicitly identify that readable root. Backends intentionally place the validator's working directory in scratch to restrict writes. The candidate is readable; an empty scratch cwd is not evidence of failed checkout provisioning.

**Smallest useful change [engine]:** supply two explicit paths: repository under review and writable scratch. Test the actual durable-conversation dispatch, keeping cwd in scratch while confirming that the prompt names the candidate. Do not relax the write policy.

Relevant owners under `src/lib/`: `workflow-graph/validator-runner.ts:1170,1342–1386` resolves the worktree and builds the prompt; `agent-backends/claude/query-session.ts:586` and `agent-backends/codex/conversation-runtime.ts:1825` relocate cwd. `workflow-graph/implementer-runner.ts:120–143` already provides a write-envelope briefing pattern.

### 3. Give downstream discoveries an accountable integration owner

**Observed:** later execution exposed a defect in behavior owned by an already-completed context. The later context was contracted to produce run artifacts, so it could satisfy its assigned criteria while deferring the defect. Final local GO verdicts therefore coexisted with incomplete evidence for the broader objective.

**What CC already has:** pinned spec criteria, `covers`, cross-context ownership, `planDefects`, live plan edits, spec captures, and amendments. The lesson is not that escalation machinery is absent. Native delivery proof is derived from claimant GO plus landing; it is not an independent semantic rejudgment of the complete product. Under the current validator mandate, an out-of-scope defect is an advisory unless it prevents satisfaction of that validator's assigned contract.

**Smallest useful change [skills/planning]:** strengthen the existing matched-deferral rule at the integration boundary. When the approved behavior depends on evidence generated by several contexts, assign an integration owner to establish that the composed evidence is valid, not merely that files exist. Teach agents to distinguish:

- a disappointing but valid result, which may satisfy an experiment's contract;
- a failed required behavior or invalid proof, which needs an accountable repair path;
- a change to approved behavior, which goes through native capture/amendment and the existing human gates.

Route discoveries through the existing mechanisms. Completed contexts are frozen; a forward repair context or supported plan replacement can preserve their historical verdicts. Do not silently reopen approved work or turn every advisory into a blocker. The same rule should help ordinary graphs, with native SDD adding criterion linkage rather than a separate execution model.

Relevant current boundaries under `src/lib/`: validator mandate in `workflow-graph/role-instructions.ts:198–205`; completed-context edit restriction in `workflow-graph/runtime-edits.ts:1906–1923`; proof issuance in `workflow-graph/authored-context-outcome.ts:231–286`; proof evaluation in `specs/delivery-gate-v2.ts:600–625`. The exact repair operation must be checked against the active run and pinned revision. This archived run records no plan-repair rounds; that alone does not establish whether every current recovery mechanism was available in its server build.

### 4. Make the audit's default numbers trustworthy

**Confirmed current bug:** the extractor computes a corrected total but accumulates its lane/context breakdowns from raw recorded costs. This run reports $212.29 corrected overall while the displayed raw breakdowns sum to $360.17. Use the same selected cost basis throughout and test that the breakdowns sum to the total.

**Historical-data gap still in the reader:** question wait totals use pending/resolved events. This run has paired `user_input.waiting` / `wait_exit` records in iteration logs, but the extractor reports zero wait and unresolved questions. The current runtime does publish resolved events; add a fallback for historical logs rather than claiming the emitter is still wholly absent.

**Disclosure improvement:** state the cost boundary explicitly: CC conversation usage is not necessarily all model usage triggered by shell commands. A known external-job contribution can be reported separately, and unavailable amounts left unknown. Do not build a universal shell-cost collector from this one case.

**Speed analysis:** distinguish initial implementer intervals, validator time, advisory response time, and time waiting to obtain runtime admission. The present summary's “agent turns” is not total workflow labor. Keep overlapping durations explicit.

Owner: `scripts/workflow-audit/core.ts`, especially wait pairing around 1323, corrected total around 1485, and raw breakdown accumulation around 1505. Reproduce against this run and retain the corrected companion telemetry as the comparison evidence.

### 5. Apply existing feasibility guidance earlier

**Observed:** a prescribed provider flag conflicted with the user's authentication arrangement and required clarification late in the graph. Another external protocol was tested with a fake successfully but failed on a meaningful live response shape.

**Existing skill coverage:** `sdd-design` already requires verified runtime premises. `graph-workflow-planning` already distinguishes verified from inferred premises and asks planners to control only provider state they actually own. More generic “verify assumptions” prose would duplicate existing guidance.

**Smallest useful change [skills]:** sharpen review examples at the risky boundary: confirm the actual combination of account/authentication mode, executable version, flags, and representative response shape. When that cannot be resolved during design, schedule a bounded live feasibility task before expensive dependents. Reuse the existing design/planning process; add no universal approval gate.

This graph's long serial chain was authored, not an engine scheduling failure. Earlier feasibility work is a better-supported improvement than making shared mutable work parallel or splitting all contexts further.

### 6. Keep CC retrospectives focused on CC mechanisms

The audit skill prioritizes work-product quality and requires a final-diff judgment. Those checks should remain: otherwise a smooth, all-green workflow can hide ineffective delivery. But they need to serve the audit's stated objective.

**Improvement [audit skill]:** state the audit lens at the start and make every recommendation identify the responsible CC mechanism, observed evidence, current-code status, and smallest general improvement. For a CC retrospective, application defects should explain what planning, ownership, validation, or recovery allowed—not become the primary application repair plan. Compare historical behavior with current code before proposing work already implemented.

The first version of this audit overemphasized application fixes. This document corrects that emphasis while retaining the supporting execution evidence.

## Historical reliability failure already addressed in source

The run lost 9h 06m waiting for a Claude conversation to admit an advisory turn. A displaced external turn remained marked active; the next request never reached useful agent execution. This was outside the useful work measured by the turn watchdog.

Commit `5dba7bbad95db158473739fb635e1e951b015343` now supersedes that displaced turn. Preserve it and verify deployment/live regression behavior before treating this historical failure as still open. Admission wait also deserves an explicit diagnostic reason and identity so a future blockage is observable without forensic transcript reading. Any further automatic recovery should be justified against the remaining live mechanism; this audit does not recommend indiscriminately timing out legitimate external work.

## Suggested priority

1. Bound advisory recertification and correct its regression test/documented contract.
2. Brief validators with the exact readable candidate root.
3. Correct audit breakdown arithmetic and historical wait reconstruction.
4. Tighten integration ownership and feasibility examples in the existing SDD/planning skills.
5. Update the audit skill's objective and recommendation framing.

Verify the already-implemented admission fix separately. No additional SDD stage, automatic mutation of approved specifications, wholesale workflow redesign, or broad machinery is justified by this run.
