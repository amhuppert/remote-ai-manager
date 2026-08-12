# Workflow audit — Spec import delivery (2560164c-6ef2-4e03-895d-429546836bd6)

Native-SDD delivery of spec `spec-import` rev 4 (spec execution `f43385f1`, plan attempt
`0def1c65`, definition `1e789fac` rev 1). Session "Import specs". Landed on main as
`c6d3273a` ("Add spec import (Spec import, rev 4)").

## Verdict

The run completed 9/9 contexts and shipped working, validator-hardened code for ~$207 in
14h 18m of wall clock — but roughly 6.5h of that was engine reliability incidents (one
SDK dead-turn halt with a 3h 22m operator wait, plus two ~1h hung turns), not work. The
plan itself executed faithfully: every context ended GO, the blocking validator cohort
caught 10 real defects pre-merge, and all join conflicts auto-resolved. The two findings
that most deserve engineering attention are **structural properties of the SDD→graph
indirection layer**, not agent mistakes: (1) the delivery-plan document cannot express
lane placement, so the materializer compiles every context to its own full-access
worktree lane — D5 lightweight parallelism is unreachable from native-SDD plans even
though it had landed a day earlier; and (2) the charter's two-value access-policy
vocabulary forced the approved spec — the plan's own #1-ranked source of truth — into
the permission-gated grade, so every validator in all 9 contexts was forbidden from
reading it.

## Overview

- Ran 2026-08-10T22:57:50Z → 2026-08-11T13:16:36Z · wall clock **14h 18m**
- 9 contexts, 23 tasks, 10 edges · charter present · 0 shared documents
- Implementer: claude/opus xhigh · context validator: codex/gpt-5.6-sol xhigh,
  `strategy: task`, `authority: blocking` · human approval gate **disabled**
  (plan agent-signed under a notify-policy admission; Alex's dial change made that legal)
- Iterations per context: schema-foundation 3 (first killed by an SDK failure),
  import-service-core 3, delivered-marking 1, carry-forward-and-gates 3,
  validation-loop 1, studio-ui 6, cli-verb 2, agent-guidance 2, closeout-verification 3
- Verdicts: 10 NO-GO across 7 contexts; 2 of 9 contexts passed first try
  (delivered-marking, validation-loop); every context ended GO

## The lane / parallelism question

**Fact:** all 9 contexts compiled to `placement: { lane: <own id>, mode: "full" }` —
one worktree lane per context (lifecycle: 1 `lane.created`, 8 `lane.forked`).

**Separate lanes did not prevent parallelism.** In this engine, separate worktree lanes
are the pre-D5 mechanism *for* parallelism (same-lane work shares one worktree; D5 adds
concurrent same-lane scheduling with serialized writes). The scheduler ran with
`maxConcurrency: 8` and executed contexts concurrently whenever the DAG allowed:
delivered-marking ∥ carry-forward (06:24Z), validation-loop overlapping carry-forward,
cli-verb ∥ studio-ui ∥ carry-forward (3-wide, 07:37–07:53Z), agent-guidance ∥ studio-ui.

**What limited parallelism was the plan's edge structure**, and that was deliberate.
`scheduler.ready_set` never contained more than 2 contexts; the DAG is a near-chain
(schema-foundation → import-service-core → {delivered-marking → validation-loop →
{cli-verb → agent-guidance, studio-ui}, carry-forward} → closeout; critical path = 6 of
9 contexts). The planner's launch report states the rationale verbatim:

> **Deliberate serialization:** the contexts that edit `import-service.ts` /
> `route-handlers.ts` are chained rather than parallel, so the joins don't fight over
> the same files; the genuinely independent tracks (transitions/review-service, CLI,
> guidance, Studio) carry the parallelism.

That is rational **given** the solo-lane compile: with every context on its own branch,
file overlap between parallel contexts surfaces as join conflicts, so the planner spent
edges to serialize hot files. The observed cost of the model in this run:

- Final-publish join `a780a491`: **55m 05s** (12:21:31→13:16:36Z) merging 7 lane
  branches sequentially into the session branch, with **6 LLM sub-turn
  conflict-resolution rounds** (presentation.ts, SpecsInventory.tsx, import-service.ts,
  schemas.ts, route-handlers.ts, and stories/tests around them).
- Pre-closeout join `eb9d717f`: 8m 22s merging carry-forward + studio-ui into the
  agent-guidance lane so closeout could fork from the union.
- ≈ 63 minutes of merge machinery on the critical path, plus the correctness risk of
  LLM-auto-resolved conflicts (validated only at final publish; `laneMergeValidation`
  was `final-only`).

**Lane-per-context was not the planner's decision.** The delivery-plan document schema
(`deliveryPlanContextSchema`, `src/lib/specs/delivery-plan.ts:139` — `.strict()`) has no
lane, mode, isolation, or path-ownership field, and the materializer hardcodes solo
placement for every context (`src/lib/specs/delivery-plan-materializer.ts:400`), with an
explicit compatibility comment: "every materialized context takes the solo placement:
its own lane, full write access… exactly the one-worktree-per-context behaviour this
path had before placement became required." The planner could not have produced anything
else.

## D5 lightweight parallelism availability

Timeline (all sourced from git and DB timestamps):

| Event | When |
|---|---|
| D5 planning guidance added to graph-workflow-planning skill ("Lane Placement and File Ownership", `0d09729d`) | Aug 8 05:33 EDT |
| SDD task-element schema gains `executionLane`/`touchedPaths` (`a43e7551`, during the D5 execution) | Aug 9 03:58 EDT |
| D5 lands on main (`447e4a7f`) | Aug 9 20:41 EDT |
| Spec-import spec authored (rev 1 → rev 4 approved) | Aug 10 16:57–18:48 EDT |
| Delivery plan authored + launched (attempt `0def1c65`, conversation `6fbf0ca4`) | Aug 10 18:51–18:57 EDT |
| Run halts (SDK `agent_turn_failed`, `[ede_diagnostic] … stop_reason=tool_use`) | Aug 10 19:53 EDT |
| D5 hardening lands (`b69b3e3f`, fs-write envelope / task-runner / CLI sandbox proxy) | Aug 10 22:49 EDT |
| Operator resumes run (context reset, lane reused) | Aug 10 23:16 EDT |

So **D5 was on main, in the running server, and documented in the direct-workflow
planning skill ~22h before this plan was authored** — the compiled definition carries
D5-era required `placement` fields, proving the server build had it. The plan still
could not use it, because of the indirection findings below.

## Friction (ranked by impact)

1. **[indirection / schema] Native-SDD plans cannot reach D5 placement.**
   The only live SDD→graph path is DeliveryPlanAttempt → materializer, which hardcodes
   `{lane: contextId, mode: "full"}` per context. The vocabulary that *does* drive
   placement — `executionLane` + `touchedPaths` on spec **task elements**
   (`src/lib/specs/schemas.ts:213-215`, consumed by `contextPlacements` in
   `src/lib/specs/compiler.ts:1077`) — sits on the legacy compile path, which has **no
   production caller**, and `legacy-plan-import.ts` drops `executionLane` when
   converting a legacy plan into an attempt document. Evidence: definition contexts all
   `mode:"full"` own-lane; `deliveryPlanContextSchema` strict with no placement fields;
   spec rev 4 has 0 task elements. Fix: [engine] add optional placement vocabulary to
   the attempt document (per-context lane + grade + ownedPaths, mirroring
   `contextPlacementSchema`) and map it in the materializer; lint overlap at propose.

2. **[indirection / charter] The plan's top-ranked source of truth was unreadable by
   every validator.** `accessPolicySchema` offers only `worktree-relative` |
   `external-readonly` (`src/lib/workflows/charter-schemas.ts:23`). A native spec is
   DB-resident, so the planner had to mark "Approved spec-import revision 4 —
   `cctl spec show spec-import`" as `external-readonly`, and the charter's blanket rule
   ("never read… automatically — explicit human permission is required") locked it.
   Every validator cohort in all 9 contexts reported the spec unqueried (e.g.
   schema-foundation GO: "The external-readonly approved spec was not queried because
   explicit permission was not provided"); the delivered-marking validator resolved a
   genuine R4.2-vs-R1.2 source conflict from context-pack copies without consulting the
   ranked source. Validation held because acceptance contracts embedded the criteria,
   but the ranking was theater. Fix: [engine/charter] add a CC-native access grade
   (readable via read-only `cctl` verbs without human permission), or inject the pinned
   revision content into validator briefs.

3. **[engine reliability] 6h 26m of hung/dead turns + a 3h 22m operator halt.**
   schema-foundation's first iteration died silently (55m of no activity → halt
   `agent_turn_failed` / sdk_error `[ede_diagnostic] result_type=user
   last_content_type=n/a stop_reason=tool_use`; context reset on resume; operator wait
   3h 22m). Two more hung turns: 1h 6m (schema-foundation, post-resume) and 1h 1m
   (studio-ui iteration 2). All excluded from agent-work totals; the wall-clock damage
   is real. The D5 hardening commit `b69b3e3f` (fs-write envelope, task runners) landed
   inside the halt window and the run resumed on the hardened build — timeline fact,
   causality unproven. Fix: [engine] tighten dead-turn watchdog thresholds; a 55-minute
   silent first turn should halt (or retry) far sooner.

4. **[planning shape] A cross-cutting invariant (honest-provenance) leaked across
   context boundaries and re-opened "done" surfaces.** 6 of the 10 NO-GOs cite
   honest-provenance: carry-forward ×2 (status/pending projections), studio-ui (fail-open
   attribution), closeout ×2 (Studio still showing imported revisions as "approved rev
   1"; then amendment mislabeling). Closeout's fixes edited studio-ui's files
   (`SpecDetailPage.tsx`, presentation) *after* that lane completed, which is part of
   why final publish needed 6 conflict sub-turns. An invariant that quantifies over
   "every surface" does not decompose into disjoint per-context criteria; the closeout
   catch-all absorbed the leakage at the cost of 2 extra iterations and late conflicts.
   Fix: [planning-skill] for surface-spanning invariants, either schedule the sweep
   context *before* independent UI tracks close, or own the invariant in exactly one
   context with explicit surface inventory.

5. **[infra / CLI] Build-skew cost closeout an iteration.** The real-import smoke
   committed server-side but `cctl` exit-4'd on version mismatch and discarded the
   success body; the retry hit `slug_taken`. Validator NO-GO'd for the missing `ok:true`
   receipt (correct per AC), and twice flagged the pre-existing middleware defect (skewed
   mutations commit before the mismatch is reported) as an out-of-scope advisory. Known
   class; aligns with the recorded build-skew gotcha.

6. **[extractor hygiene] Validator "advisories from this round" blocks are interleaved
   verbatim into the friction list**, making the markdown report hard to scan. Cosmetic,
   worth a renderer fix in `scripts/workflow-audit`.

## What worked (preserve these)

- **Blocking validator cohort earned its cost (~$27).** 10 NO-GOs were all real,
  spec-anchored defects — including two that gate the feature's core promises: blocking
  lint findings being imported as approved specs (R1.2), and criterion-only changes
  retaining virtual approval (R11.2). No NO-GO reads as a validator enforcing a wrong AC;
  one AC-vs-spec conflict (R4.2) was resolved through the charter hierarchy as designed.
- **Context packs were self-contained.** Every one of the 24 iterations ran exactly 1
  orchestrator prompt cycle — zero follow-up churn across 15 implementer conversations
  (avg ~$12, 40–198 sdk turns). Peak context occupancy 28% of window; no compaction.
- **Deliberate hot-file serialization worked as intended mid-run**: no lane-vs-lane
  conflicts surfaced until the closeout-era edits; the merge machinery auto-resolved all
  of them (sub_turn) without human intervention, and post-merge full-scope validation
  was green.
- **Notify-policy admission + agent sign-off** ran the entire pipeline with zero human
  gate waits; the single human touch was the halt resume.
- **Halt→resume recovery was clean**: context reset, lane reused, no duplicated work
  outside the killed iteration, and the run completed on the post-hardening server.

## Cost

$180.50 across 15 implementer conversations (extractor transcript-corrected) + est.
$26.95 validator cohort (22.6M in / 20.2M cached / 155k out) ≈ **$207 total**.
By context: carry-forward $35.36 · closeout $29.39 · schema-foundation $26.28 ·
import-service-core $21.47 · studio-ui $20.94 · cli-verb $17.72 · delivered-marking
$10.45 · agent-guidance $10.00 · validation-loop $8.89. No cost_gap/cost_mismatch
findings; validator line may still undercount (pre-usage-reporting events carry tokens
only).

Waste identified: the killed schema-foundation iteration 1 (conversation `41b00401`
lineage spans the halt; its ~$12.86 covers both the dead turn and iteration 2's real
work — not separable at conversation grain), plus rework iterations whose defects a
placement-aware or invariant-aware plan might have avoided (closeout iterations 2–3,
~$10–15 of its $29.39).

## Time

Wall 14h 18m · agent turns 8h 59m (runs 2–3 wide, so agent time > its wall share) ·
hung turns 6h 26m (excluded; overlaps the halt window) · operator recovery 3h 22m ·
human gate waits 0s · joins ≈ 63m (55m final publish + 8m pre-closeout).

What could have run in parallel but didn't: nothing *within this plan's edge set* — the
scheduler saturated every ready set. The serialization itself was the planner's chosen
insurance against join conflicts; reclaiming it requires either placement vocabulary
(finding 1) or accepting conflict risk.

## Recommendations

1. [engine] Extend `DeliveryPlanDocument` contexts with optional placement
   (lane + grade + ownedPaths); materialize it; lint ownership overlap at propose time.
   Until then, native-SDD deliveries are structurally pinned to worktree-lane-per-context.
2. [engine] Add a CC-native source access grade (or inject pinned spec content into
   briefs) so a plan's highest-ranked source is actually readable by its validators.
3. [template/definition] Surface the placement rule in the generated guidance registry
   (`cctl spec schema guidance` ← `DELIVERY_PLAN_MATERIALIZER_FIELD_MAPPINGS`) — today
   the mapping list omits placement synthesis entirely, so a planner reading the
   compile contract is never told every context becomes a solo full-access lane.
4. [planning-skill] When the schema gains placement: teach shared-lane chains
   (chain-shaped groups like schema-foundation→import-service-core→delivered-marking→
   validation-loop are the ideal shared-lane candidates — ordering already exists, and a
   4-member lane costs 1 worktree + 1 join instead of 4+4). `native-sdd-authoring`
   currently has no placement content; that is correct only while the schema has none.
5. [planning-skill] Add the cross-cutting-invariant guidance from finding 4.
6. [engine] Dead-turn watchdog: halt/retry a silent turn in minutes, not 55; two ~1h
   hung turns in one run is a reliability pattern, not noise.

Alignment: recommendations 1/3/4 extend the lane-placement direction already recorded in
the graph-workflow-planning skill (D5) rather than inventing a new mechanism;
recommendation 6 aligns with the existing turn-stall watchdog work; the build-skew
advisory (friction 5) is already a recorded gotcha awaiting a middleware fix.

## Sources

Extractor: `bun run workflow:audit -- --execution 2560164c-6ef2-4e03-895d-429546836bd6`
· lifecycle/decisions JSONL under `<config>/workflow-logs/2560164c…/` · archived
execution row (`graph_workflow_archived_executions`) · definition
`<config>/workflows/…/1e789fac….json` · plan attempt + snapshot rows
(`spec_delivery_plan_attempts`/`_snapshots`) · planner transcript `6fbf0ca4…` ·
validator briefs under `contexts/<id>/validators/general/` · git history (`447e4a7f`,
`b69b3e3f`, `0d09729d`, `a43e7551`, `c6d3273a`).
