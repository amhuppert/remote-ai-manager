# Graph workflow simplification: proposed changes and per-role evaluation

Date: 2026-08-16
Ticket: command-center#69
Status: **Proposal** — change 0 is implemented on this branch; changes 1–6 are recommendations awaiting approval.
Basis: the ticket's investigation and working-proposal attachments, the D7 mid-flight audit (`docs/reports/workflow-audits/2026-08-14-d7-ephemeral-workflows-midflight.md`), and code-verified current state after the #66 (direct-authored delivery plans) merge.

## Evaluation rubric

The ticket's goal is that each agent receives the smallest resolved contract needed for its job, with compiler/engine enforcement preferred over prose. Each change below is therefore evaluated on:

- **Simplification** — does it shrink prompts, reduce the number of judgments an agent must make, or replace prose with mechanical enforcement? A change that *adds* mechanism can still simplify the system if it deletes a recurring class of agent judgment or rework.
- **Per-role effect** — planner, plan reviewer, implementer, validator, plan-repair agent: easier, neutral, or harder, and why.

An honest evaluation includes costs: several changes shift work *onto* the planner at authoring time. That is intentional — the design principle is "resolve governance once, during planning, and compile it away" — but it is listed as a cost where it applies.

## Summary

| # | Change | Status | Planner | Reviewer | Implementer | Validator | Repair |
|---|---|---|---|---|---|---|---|
| 0 | Planning skill: core + references restructure | **Implemented** | easier | easier | indirect | indirect | neutral |
| 1 | `plan_defect` validator outcome → auto plan repair | proposed | neutral | neutral | **much easier** | easier | easier |
| 2 | Render validator deferral cohort unconditionally | proposed (near bug-fix) | easier | neutral | easier | **easier** | easier |
| 3 | Sources-of-truth diet: scope, resolve at plan time, stop broadcasting | proposed | harder at authoring (intended) | easier | **easier** | **easier** | easier |
| 4 | Structured acceptance criteria (`[{id, statement}]`) | proposed | slightly harder mechanically | easier | easier | easier | easier |
| 5 | Hash-bound plan review with dual lenses | proposed | slight process cost | formalized | indirect | indirect | indirect |
| 6 | Semantic authoring lints (warning tier) | proposed | easier | easier | indirect | indirect | indirect |

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

## Change 4 — Structured acceptance criteria

**What.** `acceptanceCriteria` is a single prose string (`definition-schemas.ts`). Change it to ordered records `[{ id, statement }]` (mirroring invariants), with prose accepted and wrapped as one record during migration. Downstream effects, staged: validator issues cite criterion ids; the deferral cohort renders matching records instead of whole AC blobs; live-edit and plan-repair gain per-criterion ops (`update-criterion`) instead of rewriting the whole string; density becomes visible to lints (change 6) and to reviewers.

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
- **Repair: easier.** Today repair's `update-context` rewrites the entire AC string — maximal blast radius for a one-clause fix. Per-criterion ops make the smallest-edit principle mechanical.
- **Cost.** The largest engineering lift here: schema + live-edit ops + repair vocabulary + Studio/builder rendering + migration. It also converges with #66's claims model (claims already bind criterion ids on the spec side), so *not* doing it leaves the two surfaces permanently divergent.

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

## Deliberately not proposed

- **A new `WorkflowIntent` authoring schema.** #66 just eliminated the plan→workflow compilation seam by having agents author the execution dialect directly; introducing a second, smaller authoring dialect would recreate that seam with fresh translation-defect surface. The proposal document's goals (small semantic graph, engine-owned bookkeeping) are being reached incrementally inside the existing schema — changes 3, 4, and 6 — and the new prompt-composer/projection port shows compiled role-specific packs work without a schema rewrite. Revisit only if authoring size remains the bottleneck after those land.
- **A specialist validator lens registry.** Cohorts, per-assignment `focus`, and blocking/advisory authority already partition judgment. The actual gap is scoped *inputs* (change 3 applied per assignment), not new role machinery.
- **Removing the runtime charter entirely.** Mission, scoped invariants, and pinned context-local references earn their prompt space; it's the *hierarchy reconciliation*, unscoped broadcast, and amendment history that don't. Change 3 removes those and keeps the rest.

## Sequencing

1. **Changes 1 + 2** — engine-only, independent of each other and of everything else; they help every workflow immediately and close the ticket's named ask (typed plan-defect response).
2. **Changes 3 + 4 together**, coordinated with the second planning-skill revision pass (they change what planners author, so the skill updates once).
3. **Change 5** — advisory-first review record; protocol text ships with the same skill revision.
4. **Change 6** — continuous; each lint lands with the incident that earned it. Density and locator lints can land any time; the density lint gets sharper after change 4.

## Measures

From the working proposal's list, the ones these changes should visibly move: governance tokens per implementer/validator prompt (changes 2–4); implementation-remediation rounds later classified as plan defects (change 1 — should approach zero); first-pass context acceptance rate (2, 3); contexts whose scope expands during execution (1, 2); percentage of blocking findings citing an explicit criterion or rule basis (4); percentage of plan reviews terminal against the exact final revision (5); plan defects caught at validate/review time versus during execution (5, 6).
