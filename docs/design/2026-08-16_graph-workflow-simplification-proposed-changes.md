# Graph workflow simplification: proposed changes and per-role evaluation

Date: 2026-08-16
Ticket: command-center#69
Status: **Approved 2026-08-16** (change 0 implemented on this branch; changes 1–6 approved for implementation; changes 1+2 implemented by execution `d007fb79`). **Change 7 revised 2026-08-17 (evening)** — the original ephemeral-byproducts declaration (added after `d007fb79`'s `ownership_violation` false positive) is superseded: reviewed against the reduce-failure-modes criterion below, the declaration kept the audit's cost while gutting its coverage. Change 7 is now the **deletion of the ignored-path half of the lane drift audit**, approved in this revision. **Change 8 and the owned-landing index bug added 2026-08-17** after the same execution's third incident (a 174-round, budget-invisible `candidate_mismatch` loop) — proposed, awaiting approval.
Basis: the ticket's investigation and working-proposal attachments, the D7 mid-flight audit (`docs/reports/workflow-audits/2026-08-14-d7-ephemeral-workflows-midflight.md`), and code-verified current state after the #66 (direct-authored delivery plans) merge.

## Evaluation rubric

The ticket's goal is that each agent receives the smallest resolved contract needed for its job, with compiler/engine enforcement preferred over prose. Each change below is therefore evaluated on:

- **Simplification** — does it shrink prompts, reduce the number of judgments an agent must make, or replace prose with mechanical enforcement? A change that *adds* mechanism can still simplify the system if it deletes a recurring class of agent judgment or rework.
- **Per-role effect** — planner, plan reviewer, implementer, validator, plan-repair agent: easier, neutral, or harder, and why.

An honest evaluation includes costs: several changes shift work *onto* the planner at authoring time. That is intentional — the design principle is "resolve governance once, during planning, and compile it away" — but it is listed as a cost where it applies.

The 2026-08-17 review added a sharper acceptance test for engine-side changes: **does the change reduce the number of ways an execution can fail?** A mechanism that converts a silent failure into a typed halt passes (change 8). A mechanism that adds configuration which must be kept correct, or new fail-closed error paths, is suspect even when its intent is protective — it trades one failure class for another and keeps the maintenance burden. The change 7 rewrite below is this criterion applied. The supporting observation: all three of `d007fb79`'s incidents arose in the ownership/landing machinery itself — none were planning defects (plan repair's correct declines prove it). The recurring-bug generator right now is not under-governed planning; it is the number of bespoke moving parts in the landing/audit subsystem.

## Summary

| # | Change | Status | Planner | Reviewer | Implementer | Validator | Repair |
|---|---|---|---|---|---|---|---|
| 0 | Planning skill: core + references restructure | **Implemented** | easier | easier | indirect | indirect | neutral |
| 1 | `plan_defect` validator outcome → auto plan repair | **implemented (`d007fb79`)** | neutral | neutral | **much easier** | easier | easier |
| 2 | Render validator deferral cohort unconditionally | **implemented (`d007fb79`)** | easier | neutral | easier | **easier** | easier |
| 3 | Sources-of-truth diet: scope, resolve at plan time, stop broadcasting | approved | harder at authoring (intended) | easier | **easier** | **easier** | easier |
| 4 | Structured acceptance criteria (`[{id, statement}]`), staged | approved | slightly harder mechanically | easier | easier | easier | easier |
| 5 | Hash-bound plan review with dual lenses | approved | slight process cost | formalized | indirect | indirect | indirect |
| 6 | Semantic authoring lints (warning tier) | approved | easier | easier | indirect | indirect | indirect |
| 7 | Delete the ignored-path lane-drift audit + baseline machinery | **approved 2026-08-17** | easier | easier | **easier** | neutral | easier |
| 8 | Consecutive candidate-mismatch budget → typed halt | proposed | neutral | neutral | indirect | indirect | easier |
| — | Bug fix: owned-landing leaves the lane index rewound | proposed | n/a | n/a | n/a | n/a | n/a |

Deliberately **not** proposed: a new `WorkflowIntent` authoring schema, a specialist-lens registry, and full charter removal (rationale at the end).

---

## Change 0 — Planning skill restructured into core + references (implemented)

**What.** `graph-workflow-planning` went from one 760-line file (~84% advanced mechanics) to a 292-line core covering the ordinary path plus four read-on-demand references (dynamic control flow, placement/parallelism, validation/staffing, revising/recovery). Previously undocumented engine behavior is now taught: invariant `appliesTo` scoping, two-way deferral integrity, one-off `workflow run`, parameters/`{{inputs.<name>}}`, prerequisites, `approvalRequired`, approval/ask-user/collaboration blocks, and automatic plan repair. The docs contract test now enforces the structure: references must exist and be linked from the core, the core is capped at 400 lines, all three deployed copies sync file-by-file, and the new material is pinned to the schemas that declare it.

**Simplification.** The planner's default read drops 760 → 292 lines while coverage of the actual engine *increases*. The 400-line cap is a mechanical ratchet against regrowth — the exact failure mode the investigation attributed to the old skill ("core scope rules are qualitative and buried in a long document").

- **Planner: easier.** Smaller default read; decomposition rules are no longer buried; the features that exist are all learnable. New guidance encodes the D7 lesson (scope end-state invariants or move them into the owning context's criteria) so the next plan doesn't repeat it.
- **Plan reviewer: easier.** The core is now a usable review rubric; the consolidated pre-submit checklist plus per-reference checklists partition what to check.
- **Implementer / validator: indirect.** They never read the skill, but benefit once planners author scoped invariants and honest deferrals.
- **Repair: neutral.** The skill now tells planners repair exists, which should reduce budget padding (padded budgets delay honest halts and make repair's diagnosis harder).
- **Cost.** Total documentation grew 760 → 911 lines across five files — the price of documenting real features. Per-read cost is what matters, and it fell sharply.

## Change 1 — Typed `plan_defect` validator outcome routed straight to plan repair

**What.** Today a blocking validator finding *must* name a `taskId` from the current context's task enum (`validator-runner.ts` builds the schema that way), and a plan-shaped problem can only be a non-blocking `plan` advisory. Plan repair triggers only after a halt (`circuit_breaker`, `max_iterations`, `loop_limit_reached`, `ownership_violation`). Add a third blocking response shape: no `taskId`; required fields for *why the defect is not locally remediable* and *which criterion, boundary, dependency, or governance rule conflicts*. On receipt the engine does not reopen any task; it preserves the candidate and validator evidence, invokes the existing D1 plan-repair machinery immediately (or halts with a typed plan-defect reason when repair is disabled), and recompiles affected pending contracts before resuming. Repair declining a `plan_defect` finding halts rather than resuming the reopen loop.

**Evidence.** The investigation's root-cause list item 5 ("validators cannot route planning defects to a planning recovery path") and the direct-authored execution's iteration-6 churn inside `one-off-start`. D7's three breaker trips each burned 4+ NO-GO rounds before repair even ran, and repair then declined because by halt time the evidence was a whole halted context, not a specific defect.

- **Planner: neutral.** No authoring change. Feedback quality improves: a plan defect comes back as a classified defect with the validator's reasoning, not as an implementation-failure statistic.
- **Plan reviewer: neutral.** No direct effect (change 5 owns review).
- **Implementer: much easier.** The single largest source of unfair work disappears: no more reopened tasks demanding downstream-owned wiring or contradictory states, and no more rational scope expansion to satisfy an unsatisfiable contract. This is the ticket's named ask.
- **Validator: easier.** Today the honest verdict on a contradictory contract has no legal spelling — the schema forces either misrouting (fail a task) or under-routing (non-blocking advisory). The new outcome is the judgment validators are already making implicitly, now with a required justification instead of a forced misdirection. One more response option, but it removes a recurring forced-error.
- **Repair: easier.** Invoked at first detection with a targeted, typed finding and a preserved candidate, instead of post-halt with 4 rounds of noise to re-diagnose. Declines should become rare because invocations arrive pre-classified.
- **Cost.** New engine surface: one response shape, one trigger path beyond halts, freeze/recompile semantics for affected pending contexts. Guardrail needed against overuse: the required not-locally-remediable justification, plus repair's existing authority to reject the classification (its `planningDefect: false` verdict already expresses "this is implementation work").

**Verdict.** Highest leverage per unit of engine change; everything downstream (repair prompt, op vocabulary, live-edit apply, resume) already exists, and #66's minimal locks mean repair can now actually reword an AC on spec runs.

## Change 2 — Render the validator deferral cohort unconditionally

**What.** The prompt composer already builds an "acceptance-criteria cohort for deferral checks" — the current context plus all graph-downstream contexts' ACs, with the two-route deferral rule — but only when a prompt projection exists, and only the spec execution-binding service provides one. Plain graph workflows get the *rule text* (which explicitly references "the downstream owner's acceptance criteria below") without the cohort, so validators are instructed to honor evidence they are never shown. The cohort derives purely from the working definition; render it for every context validation.

**What it looks like.** For a graph `shared-admission → spec-start-binding → final-verification`, with validation running for `shared-admission`, the composer (`renderValidatorDeferralCohort`, `src/lib/workflow-graph/prompt-composer.ts`) appends this to the validator's prompt — the current context plus every transitively downstream context's ACs, verbatim; upstream contexts are deliberately excluded because they cannot authorize a *future* handoff:

```markdown
## Acceptance-criteria cohort for deferral checks
The authoritative Spec ownership section above decides criterion assignment. Do not fail
this context for criterion work assigned only to another claimant. A stable authored
claimant may be a dynamic orchestrator accountable for generated or loop work; honor that
ownership without tracing generated children or loop instances.

Ownership alone never authorizes a production-capability deferral. Missing production
wiring may be deferred only to a graph-downstream owner, and only when either the current
context's acceptance criteria explicitly name that downstream owner for the obligation,
or the downstream owner's acceptance criteria below contain the matching obligation. A
claim, context title, graph edge, or vague downstream reference is not enough. If neither
route is present, raise an issue for the missing production call path.

This is the current and graph-downstream authored acceptance-criteria cohort, not a
wiring table. Upstream or unrelated claimants remain ownership-visible but cannot
authorize a future production handoff:

### `shared-admission` — Extract the shared admission core (current context)
1. `runAdmission()` is extracted into `src/lib/workflows/admission-core.ts` and both
   saved-start callers ride it in production.
2. The one-off entry point exists and is unit-covered; its production caller lands in
   `spec-start-binding`.

### `spec-start-binding` — Bind spec start to the admission core
1. `launchSpecDelivery` calls the admission core's one-off entry point on the production
   `cctl spec start` path.
2. …

### `final-verification` — End-to-end verification
1. …
```

Reading it: the validator can now verify criterion 2's deferral through *both* routes — the current AC names `spec-start-binding` (route 1), and `spec-start-binding`'s AC 1 below carries the matching obligation (route 2) — so it records the deferral in its summary instead of raising a missing-production-call-path issue. On today's plain (non-spec) run this entire section is absent while the base prompt still states the two-route rule, leaving route 2 uncheckable. One implementation note for the unconditional variant: the first paragraph refers to "the authoritative Spec ownership section above", which exists only under a spec claims projection — that paragraph stays projection-conditional; the deferral paragraphs and the cohort listing render everywhere.

**Evidence.** The D7 root cause ([native SDD] validator packs dropping sibling wiring ownership → forced NO-GOs on planned deferrals) was fixed by #66 *for spec runs only*. The inconsistent rule text on plain runs is the same defect waiting to recur.

- **Planner: easier.** Route 2 (the downstream owner's criteria carry the obligation) becomes checkable, so deferral stops requiring defensive carve-out prose duplicated into every deferring context's AC.
- **Plan reviewer: neutral.**
- **Implementer: easier (indirect).** Fewer forced NO-GOs on planned deferrals means fewer unfair reopened tasks and less pressure to force-build downstream scope early (D7 built two contexts' scope two contexts early for exactly this reason).
- **Validator: easier.** The judgment "is this deferral legitimate?" becomes evidence-backed instead of impossible. Cost: prompt grows by the downstream ACs — bounded by graph position (final contexts see almost nothing extra), and change 4 shrinks it further by rendering only matching criterion records.
- **Repair: easier.** Fewer spurious deferral-churn halts to diagnose.

**Verdict.** Small, engine-only, arguably a bug fix; do it with change 1.

## Change 3 — Sources-of-truth diet: scope, resolve at plan time, stop broadcasting

**What.** Invariants now have structured, engine-filtered `appliesTo`; sources do not. Every implementer *and* validator prompt still carries the full ranked hierarchy with free-prose `appliesTo`, the fixed precedence rules, `accessPolicy` instructions, and the amendment log; validators still carry the "defer to the higher-ranked source on a charter conflict" rule — a per-round reconciliation judgment. Change: (a) give sources structured applicability (context ids, mirroring the invariant mechanism that just shipped) and render each context only its sources; (b) require conflicts among sources to be resolved at plan time — an unresolved conflict blocks create, and the runtime deferral rule retires; (c) make `external-readonly` an acquisition concern (planner/engine materializes a snapshot or the source isn't attached) instead of a per-agent permission judgment; (d) drop the amendment log from prompts (it stays in `charter.md` and the durable record).

**Evidence.** Investigation runtime-governance findings: applicability, precedence, and access are "recurring agent judgments" whose cost grows with every context × iteration × validator; the hierarchy mixes categories that don't share a total order; D7's rank-2 session-scoped locator was flagged absent in all 19 verdicts.

- **Planner: harder at authoring time — intended.** The planner must now resolve conflicts and decide which contexts need which sources, instead of shipping the ambiguity to runtime. This is the core "resolve once" trade: one judgment during planning replaces the same judgment made independently by every downstream agent on every round.
- **Plan reviewer: easier.** "Is any source conflict unresolved?" becomes a blocking, mechanical review item instead of a latent runtime behavior.
- **Implementer: easier.** Smaller prompt, no precedence arithmetic, no permission-gated sources to reason about — just the references that apply to its context.
- **Validator: easier.** The higher-ranked-source deferral rule — a genuinely hard judgment that today can overturn the acceptance criteria mid-round — disappears. Verdicts judge the contract, not the constitution.
- **Repair: easier.** A smaller charter surface to amend, and `amend-charter` operations stop competing with a runtime precedence system for authority.
- **Cost.** Migration for existing definitions (unscoped sources default to global = today's behavior, so it's additive); planning takes longer for genuinely conflicted inputs — which is exactly where planning time is well spent.

## Change 4 — Structured acceptance criteria (staged)

**What.** `acceptanceCriteria` is a single prose string (`definition-schemas.ts`). Change it to ordered records `[{ id, statement }]` (mirroring invariants), with prose accepted and wrapped as one record during migration. Downstream effects, staged — see below: validator issues cite criterion ids; the deferral cohort renders matching records instead of whole AC blobs; density becomes visible to lints (change 6) and to reviewers; live-edit and plan-repair *eventually* gain per-criterion ops (`update-criterion`) instead of rewriting the whole string.

**Staging (added 2026-08-17).** The first stage lands the schema, the migration, the rendering, and the citation rules — everything that changes what agents *read* and *cite*. The per-criterion live-edit and repair ops are **deferred until an incident earns them**: they are new mutation vocabulary on the live-edit core, which is exactly the subsystem class that produced this month's incidents (the owned-landing index rewind, the mismatch loop, the drift false positive), and repair's existing `update-context` continues to work against structured records — it rewrites the array instead of the string, same blast radius as today, no worse. The smallest-edit principle applies to proposals too: ship the part that shrinks agent judgment now, and let the part that adds engine mutation surface wait for evidence that whole-array rewrites are actually causing repair defects.

**Specialist (non-AC) validators.** Every seat in a cohort — the default general reviewer, blocking specialists, advisory seats — already receives the context's acceptance criteria verbatim; the prompt is rebuilt per assignment from the same context, charter, criteria, tasks, and diff, and per-seat divergence is confined to the role contract, mandate, and output schema. That stays true: the criteria are the context's *scope contract*, and every validator needs them to respect scope boundaries and honor deferrals regardless of what it judges. So yes — all validators receive the structured records; what differs by seat is the **citation rule**, matched to what each seat is assigned to judge:

- The **acceptance seat** (the default blocking general reviewer) judges the criteria themselves. Its blocking issues cite criterion ids — that is the point of the change.
- A **blocking specialist** judges its own assigned mandate (its `focus` plus profile standard), not the criteria. Its blocking issues cite that assigned basis; a criterion id appears only when a mandate finding also contradicts a specific criterion. Specialists are *not* required to map their standard onto criterion ids — forcing that mapping would recreate at the criterion level the same misrouting change 1 removes at the task level.
- **Advisory seats** are unchanged: advisories carry no task id today and gain no required criterion id.

Together with change 1 this completes the uniform rule the working proposal sketched — *every blocking finding cites an assigned basis*: a criterion id for the acceptance seat, the assignment mandate for a specialist, a not-locally-remediable justification for a `plan_defect`. Two mechanical notes: the prompt-size benefit accrues to every seat identically (the deferral cohort renders matching criterion records instead of whole AC blobs in all seats' prompts), while per-criterion re-validation scoping applies to the acceptance seat only — specialist re-certification continues to key off the candidate hash, unchanged.

**Evidence.** The direct-authored plan's decisive defect was invisible *because* criteria were a blob: five paragraphs concealing 30+ independently falsifiable obligations mapped to three tasks. The investigation names "semantic acceptance-criteria density" concealment explicitly. The skill can only say "number your clauses"; the schema can enforce it.

- **Planner: slightly harder mechanically.** Records instead of paragraphs. The skill already instructs numbered clauses, so this converts existing best practice into the only spelling. Density becomes self-evident at authoring time — a 25-record context is visibly several contexts.
- **Plan reviewer: easier.** Can count obligations, classify findings per criterion (missing / misplaced / redundant / contradictory / over-specified), and demand splits with a concrete basis.
- **Implementer: easier.** A checklist-shaped contract: pass/fail per numbered outcome rather than exegesis of paragraphs.
- **Validator: easier.** Verdicts cite `criterion-id` the way they already cite invariant ids; "a blocking finding must cite an assigned basis" becomes schema-expressible; re-validation after remediation can scope to the failed criteria.
- **Repair: easier (stage 1), unchanged mechanics.** Repair reads records instead of a blob, so its diagnosis cites criteria precisely; its edit vocabulary is unchanged until stage 2 is earned.
- **Cost.** The largest engineering lift here even staged: schema + Studio/builder rendering + migration. It also converges with #66's claims model (claims already bind criterion ids on the spec side), so *not* doing it leaves the two surfaces permanently divergent.

## Change 5 — Hash-bound plan review with complementary lenses

**What.** Graph-side plan review is purely conversational: no review record, no verdict artifact, nothing binding a review to a revision. The spec side already binds start admission to `planHash`/`compiledDefinitionHash`. Add a lightweight review record for graph plans: reviewer run id, the `workingDefinitionHash` reviewed, terminal verdict, findings artifact; `create`/`replace` surface whether a terminal review exists for the exact submitted hash (advisory at first, enforceable per-project later). Pair it with a two-lens review protocol in the skill: completeness (missing outcome, dead handoff, uncovered requirement) *and* executability/minimality (overloaded context, misplaced obligation, contradictory phase, redundant criterion), with repairs preferring move/delete/defer/split over add.

**Evidence.** The investigation documents a canceled, artifact-less review being represented as a completed `CREATE` verdict, and a review objective that "rewarded discovering more obligations" — scope accretion instead of executability.

- **Planner: slight process cost.** Repairs invalidate the verdict; the reviewer must see the final revision. That cost *is* the control — it's precisely what the incident bypassed.
- **Plan reviewer: job formalized and rebalanced.** A terminal artifact bound to a hash makes the verdict meaningful; the dual-lens protocol makes "this context is too big" as legitimate a finding as "this requirement is uncovered", countering the one-sided incentive that inflated `one-off-start`.
- **Implementer / validator / repair: indirect.** Fewer defective plans reach execution; the review can no longer be simulated.
- **Cost.** New (small) mechanism. Keep it advisory-first to avoid friction while the workflow stabilizes; the record is the point, enforcement is a dial.

## Change 6 — Semantic authoring lints (warning tier)

**What.** `validateAuthoredDefinition` today has structural checks (cycles, placement, guards, loops, parameters, invariant scopes) but zero semantic ones. Add warning-tier lints: criteria-density per context (with change 4: record count > N; before it: clause-count heuristic); open quantifiers ("every", "all", "complete", "maximal") in criteria without a referenced inventory; source locators that cannot resolve from a lane worktree; oversized context/task prose. Warnings, not refusals — each earns promotion only with evidence, per the repo's earned-guidance rule.

**Evidence.** Each lint pins a specific incident: the 30-obligation context (density), D7's one-site-per-round invariant sweeps (quantifiers), the rank-2 locator flagged absent in all 19 verdicts (resolvability).

- **Planner: easier.** The feedback arrives at `validate` time, in seconds, instead of as execution rework days later. Warnings teach the skill's rules at the moment they're violated.
- **Plan reviewer: easier.** Mechanical pre-clearing; review attention goes to semantics lints can't judge.
- **Implementer / validator / repair: indirect** — fewer defective plans reach them.
- **Cost.** False-positive risk (an open quantifier is sometimes correct). Warning tier + answered-not-ignored submit rule (already in the skill) handles it; a noisy lint gets removed, not tolerated.

---

## Change 7 — Delete the ignored-path half of the lane drift audit

**Status.** Approved 2026-08-17. Supersedes this change's original form (a `validation.ephemeralByproducts` declaration in `CommandCenter.json`), which was reviewed against the reduce-failure-modes criterion and rejected — rationale below.

**What.** The D8 lane drift audit (`lane-drift.ts`, invoked from the enveloped-landing path in `execution-loop.ts`) has two halves. The **tracked half** reads `git status` and judges every dirty tracked path against the lane's ownership union — cheap, baseline-free, and load-bearing for merge integrity: an unattributed *tracked* change at landing time gets swept into someone's commit or lost. It stays exactly as is, `ownership_violation` halt included. The **ignored half** reconstructs a forensic answer for content git deliberately doesn't track: provisioning fingerprints every ignored file in the lane worktree (byte-level SHA-256 plus inode/size/timestamp identity), stores the per-file manifest in the lane's private git metadata (`lane-ignored-baseline-store.ts`), persists bounded per-root digests in execution state (`lane.ignoredBaseline`), and every enveloped landing re-fingerprints the entire ignored tree, cross-checks the manifest against the persisted digests, and digest-compares per root — any mismatch halts the execution. Delete that half entirely: the capture, the store, the persisted field, the audit branches, and the fingerprint pipeline in `git/worktree.ts` that exists only to feed it (verified: zero consumers outside this audit).

**Why the declaration was the wrong fix.** Three reasons, in increasing order of weight:

1. **The false positive is a category error, not a tuning problem.** The audit's own docstring names its threat as "a tool dumping state into the worktree" and lists "a post-install hook" as the server-mediated write to catch. That is *observationally identical to normal toolchain operation*: execution `d007fb79`'s halt was postinstall regenerating build-info and incremental tsc writing `tsbuildinfo` — the audit caught exactly what it was designed to catch, and it was benign. The threat signature and the system working correctly are the same event; no threshold or declaration distinguishes them.
2. **The declaration kept the cost and gutted the coverage.** All six roots it would have declared (`node_modules`, `tsconfig.tsbuildinfo`, `src/lib/build-info/build-info.generated.ts`, `.next`, `next-env.d.ts`, `dist`) are gitignored, and `node_modules`/`.next`/`dist` are precisely where a real malicious payload would land — that is where code executes from. Post-declaration, the machinery would still fingerprint the ignored tree at provisioning and every landing, still maintain the tamper-checked manifest, and still carry a per-project config key that must be kept correct plus an "undeclared byproduct still halts once" residual failure mode — while its remaining detection value shrank to roughly "credential files at novel ignored paths." A control that exempts its highest-value targets and keeps its full cost is not defense-in-depth; it is overhead.
3. **The single-operator threat model doesn't support halt-grade authority.** The actor being audited already executes arbitrary code with the operator's privileges on every validation run and every `bun install`. A post-hoc halt on a lane worktree was never a meaningful control against that actor — only against an accident, and the accidents it caught in practice were the toolchain doing its job. The engine already concedes the point structurally: the audit **fails open** when it cannot run (`lane_drift.audit_failed` → warn and continue) while halting the execution on its findings — advisory-grade reliability wired to halt-grade authority.

**What deletion removes.** The proven incident class (any enveloped lane that runs typecheck, test, or install eventually halts), and with it the human live-edit remediation and cargo-culted `ownedPaths` toolchain padding it was teaching planners. Beyond that, two **latent fail-closed halt paths** that convert infrastructure hiccups into execution halts and that no one has hit yet: a failed baseline capture at provisioning (any transient git error) yields an empty baseline, after which the lane's first landing halts on every pre-existing ignored file; a missing or corrupt manifest — or a failed tamper cross-check — reports every baselined root as unattributed, same halt. Finally the runtime cost: two full content-hashes of the ignored tree per lane (provisioning plus each landing) — hashing gigabytes of `node_modules` to guard a boundary the execution layer doesn't hold. This is the same cost the original change's rejected "re-baseline after every validation run" alternative existed to avoid; deletion avoids it without the config key. A `#68`-adjacent win.

**Deletion surface.** All single-purpose, verified zero consumers outside the audit:

- `lane-ignored-baseline-store.ts` (129 lines) and its test (71)
- The fingerprint pipeline in `git/worktree.ts`: `listIgnored`, `fingerprintFiles`, `fingerprintOf`, `readIgnoredEntries`, `readIgnoredContents`, the `IgnoredEntry`/`IgnoredWorktreeContents` types (~250 lines)
- `captureIgnoredBaseline`/`recoverIgnoredBaseline` in `parallel-worktrees.ts` (~60 lines)
- The ignored branches of `classifyLaneDrift` plus `summarizeIgnoredContents`/`digestIgnoredEntries` (~150 of `lane-drift.ts`'s 449 lines) and the `listManagedSkillsOwnedCheckoutPaths` exemption wiring in the auditor (managed-skills checkout state is ignored content; with ignored judgment gone the exemption is dead — the provisioning-time checkout itself stays, it serves the skills feature)
- The `ignoredBaseline` schema field, its round-trip fixture entries, and the ignored-path scenarios in `lane-drift.test.ts`/`lane-drift.integration.test.ts` (740 test lines, mostly this) — the tracked-path tests stay, and one new regression test pins the surviving contract: a landing with ignored-tree churn (`node_modules`, `tsbuildinfo`, generated build-info) lands clean, while an unattributed tracked change still halts

Net: roughly a thousand lines of production and test code, one persisted field, one private manifest file format, and one class of per-lane filesystem work.

**Persisted-field note.** `ignoredBaseline` removal follows the persisted-field rule: repository mapping, the round-trip contract fixture, and floor behavior update together. It is a `.default([])` array in lane state, so existing rows read cleanly through the schema while the engine simply stops consulting it.

**What is deliberately not included.** No advisory replacement. A name-grain "new ignored roots since provisioning" log line from a plain `git status --ignored --directory` listing was considered and left out: without the byte-level baseline it cannot distinguish churn from writes, and with it the cost returns. If a real foreign-write concern surfaces with evidence, a targeted control is re-earned then — the repo's earned-guidance rule, applied to the engine. Demoting the existing machinery to advisory (halt → log) was also rejected: the per-file fingerprints, manifest store, and tamper cross-check are only justifiable as forensic support for halt-grade authority; keeping them to decorate a log line keeps the entire cost of the mechanism and none of its point.

**Boundary kept.** The write envelope is untouched and remains the primary control — enforced at write time, deterministic, visible to the agent as an immediate error. The `ownedPaths` coordination contract is untouched: it is what makes owned landings scopeable and merges attributable when lanes share a worktree, and it is correctness machinery, not security machinery. The tracked half of the drift audit is untouched. The accepted residual: a file overwritten in place under an ignored root, or a new file dropped at an ignored path, is no longer detected post-landing. Given point 3 above, this detection was never load-bearing.

- **Planner: easier.** `ownedPaths` describes the work again, not the toolchain. No defensive padding, and no reviewing plans for whether they remembered the padding.
- **Plan reviewer: easier (marginal).** One less cargo-culted convention to check for.
- **Implementer: easier.** The TDD loop can no longer halt its own lane by running the validation commands its instructions require.
- **Validator: neutral.** The audit is engine-side; no validator judgment changes.
- **Repair: easier.** Non-defect invocations from this class end entirely — the incident burned repair round 1 of the execution's 5-round backstop on a correct decline. Unlike the declaration, there is no residual "halts once per undeclared byproduct" trickle.
- **Operator: easier.** No new config key to author, review, or keep correct as the toolchain evolves; two latent halt classes gone; faster lane provisioning and landings.

**Verdict.** The only change in the set that *reduces* the number of ways an execution can fail while also deleting code, config surface, and runtime cost. Directly on-mission.

## Change 8 — Consecutive candidate-mismatch budget wired to a typed halt

**What.** A validation round that concludes `candidate_mismatch` increments no counter today: not `consecutiveFailureCount`, not the iteration budget, nothing the circuit breaker or `max_iterations` can see. The engine re-opens the next round immediately. Add a small consecutive-mismatch budget (on the order of 5) tracked per context; exhausting it records a resumable typed halt (`candidate_unstable` or similar) carrying the last drift component and stage, so the failure becomes loud, diagnosable, and — where the cause is plan- or config-shaped — reachable by plan repair like any other halt.

**Evidence.** Execution `d007fb79`, incident 3: after `plan-defect-repair-routing`'s round 1 *passed* and its work *landed*, a poisoned lane index made every subsequent diff render fail ("working tree is dirty but no diff could be produced" → tree hash null → mismatch). The engine spun **174 rounds in 40 minutes at ~14-second intervals**, invisible to every existing budget, and would have spun indefinitely had the operator not noticed and paused. This is the same unfenced-loop class as the earlier zombie-loop RCA, in a new location.

- **Planner / plan reviewer: neutral.** No authoring change.
- **Implementer / validator: indirect.** Neither agent participates in mismatch rounds (the validator never dispatches); they benefit only from the execution failing fast instead of silently stalling their downstream contexts.
- **Repair: easier.** A typed halt with drift evidence replaces a stall that no automated recovery path could even observe.
- **Operator: the real beneficiary.** Today the only signals are a quietly growing round counter and wall-clock silence.

**Verdict.** Small, mechanical, closes an unbounded-loop class. The budget is deliberately generous — legitimate transient drift (an agent finishing a write mid-freeze) settles in one or two rounds; 174 identical drifts is only ever a defect.

## Bug fix (tracked here): owned-landing leaves the lane index rewound

Not a simplification change — a straight engine bug surfaced by the same incident, tracked on this ticket for sequencing. After `plan-defect-repair-routing`'s owned landing committed (correctly — the landing commit's content was verified complete), the lane worktree's **git index** was left rewound to the pre-lane base: ~2,470 lines of already-landed work staged as reverted, the context's new files staged as deleted, while the on-disk worktree remained byte-identical to HEAD. Every subsequent status probe then read "dirty", and every scoped diff produced nothing — the direct trigger for the mismatch loop above. This was the first landing on the lane that swept **pre-existing accounted sibling dirt** (the stray UI files inherited from incident 2's remediation) into an owned commit, which is the likely trigger condition. Fix: the owned-landing path must leave the lane index equal to the new HEAD (and a regression test should land a commit from a tree carrying accounted-but-unowned sibling dirt, then assert index == HEAD == worktree for the landed scope). Recovery, for the record, was index-only: `git restore --staged .` in the lane worktree, then resume — no content was lost.

## Deliberately not proposed

- **A new `WorkflowIntent` authoring schema.** #66 just eliminated the plan→workflow compilation seam by having agents author the execution dialect directly; introducing a second, smaller authoring dialect would recreate that seam with fresh translation-defect surface. The proposal document's goals (small semantic graph, engine-owned bookkeeping) are being reached incrementally inside the existing schema — changes 3, 4, and 6 — and the new prompt-composer/projection port shows compiled role-specific packs work without a schema rewrite. Revisit only if authoring size remains the bottleneck after those land.
- **A specialist validator lens registry.** Cohorts, per-assignment `focus`, and blocking/advisory authority already partition judgment. The actual gap is scoped *inputs* (change 3 applied per assignment), not new role machinery.
- **Removing the runtime charter entirely.** Mission, scoped invariants, and pinned context-local references earn their prompt space; it's the *hierarchy reconciliation*, unscoped broadcast, and amendment history that don't. Change 3 removes those and keeps the rest.
- **The `validation.ephemeralByproducts` declaration** (change 7's original form). Rejected 2026-08-17 for the reasons in change 7: it added a config key that must be kept correct, preserved the audit's full runtime cost, retained an "undeclared byproduct still halts once" failure mode, and exempted exactly the roots where a real payload would land. Deletion dominates it on every axis the rubric measures.

## Sequencing

1. **Changes 1 + 2** — implemented by execution `d007fb79`; they close the ticket's named ask (typed plan-defect response).
2. **Changes 3 + 4 (stage 1) together**, coordinated with the second planning-skill revision pass (they change what planners author, so the skill updates once). Change 4's per-criterion live-edit/repair ops are stage 2, deferred until earned.
3. **Change 5** — advisory-first review record; protocol text ships with the same skill revision.
4. **Change 6** — continuous; each lint lands with the incident that earned it. Density and locator lints can land any time; the density lint gets sharper after change 4.
5. **Change 7** — directly in-session with TDD as soon as execution `d007fb79` publishes (it deletes from `lane-drift.ts`, `parallel-worktrees.ts`, and `git/worktree.ts`, adjacent to files that execution's engine lane is actively editing — sequencing after the merge avoids same-file coupling). The persisted-field removal rides the same change. Too small for a workflow of its own; independent of changes 3–6.
6. **Change 8 + the owned-landing index bug** — same batch as change 7 (all three are small engine changes in adjacent files, earned by the same execution's incidents, and all want the published tree). The bug fix goes first: it removes the trigger; change 8 is the backstop that makes any future trigger loud.

## Measures

From the working proposal's list, the ones these changes should visibly move: governance tokens per implementer/validator prompt (changes 2–4); implementation-remediation rounds later classified as plan defects (change 1 — should approach zero); first-pass context acceptance rate (2, 3); contexts whose scope expands during execution (1, 2); percentage of blocking findings citing an explicit criterion or rule basis (4); percentage of plan reviews terminal against the exact final revision (5); plan defects caught at validate/review time versus during execution (5, 6); `ownership_violation` halts from gitignored-content churn and plan-repair rounds consumed by non-defect halts (7 — both reach zero by construction, since the class is deleted rather than configured around); lane provisioning and landing wall-clock, which stop paying a full ignored-tree fingerprint (7); engine lines of code and persisted schema fields, which go **down** for the first time in this program (7).
