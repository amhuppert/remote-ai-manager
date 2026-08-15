# Direct-authored delivery plans — design proposal

Native SDD delivery shifts **from** authoring an SDD plan document that a materializer
compiles into a graph workflow definition, **to** authoring the graph workflow
definition directly, with a thin data link back to the spec. The compilation layer —
the proven source of the planning failure mode — is deleted, not improved.

Source evidence: `docs/reports/workflow-audits/2026-08-14-d7-ephemeral-workflows-midflight.md`
(execution `beb0da38`: 16 NO-GO / 3 GO, three breaker halts, all traced to information
lost in plan→pack compilation), `docs/reports/workflow-audits/2026-08-11-spec-import-delivery.md`,
and `docs/design/2026-08-11_sdd-workflow-alignment.md` (the previous alignment round).

## Problem: the gap is structural, and improvement rounds cannot close it

Two prior rounds closed *specific* gaps between the SDD plan dialect and the graph
model — plan-tier lane placement (commit `5324b51d`, from alignment design D1) and
pinned-spec materialization into lanes (alignment design D6). The D7 run then failed on
*new* gaps in the same class:

- The plan's machine-readable wiring ownership never reached validator packs
  (`contextPack` filters to the owning context, `src/lib/specs/delivery-plan-materializer.ts:602-668`),
  while the shared validator rule honors deferral only via AC text
  (`src/lib/workflow-graph/validator-runner.ts:348`) → forced NO-GOs on planned deferrals.
- The plan dialect exposes no breaker, iteration, validator, or script-gate knobs
  (`cctl spec schema plan-edit` — none of these fields exist), so the instance default
  breaker (4) applied to contexts whose natural convergence was 5–7 rounds.
- Charter invariants compiled from `governance` are globally quantified with no
  scoping, so end-state invariants bound mid-migration contexts.

The dynamic is structural: the graph dialect grows (D4 routing/loops/output schemas,
D5 placement, validator cohorts, per-context config), and the SDD dialect + compiler
must re-implement each addition or silently pin it. Every compiler default is a
decision the planner cannot see or change; every pack-rendering choice is a lossy
projection of the plan. A translation layer between two rich dialects re-opens this gap
on every feature; deleting the translation closes the class.

The inversion is safe because of a load-bearing fact confirmed in code: **the spec
lifecycle machinery does not read the plan document.** `spec delta` computes from
revisions + prior executions + criterion dispositions (`src/lib/specs/delivery-delta.ts`),
`spec measures` reads the event log only (`src/lib/specs/measures.ts:631-706`),
`spec capture` uses the attempt only for addressing (`src/lib/specs/execution-service.ts:2117-2123`),
and the delivery gate reads `execution.scope_json` + dispositions + the pinned
revision's criterion `validationStrategy` (`src/lib/specs/delivery-gate.ts:191-224,269-305`).
The document's structure feeds only: the materializer, plan lint, the seed, snapshot
diff, Studio plan rendering, and discovery dedupe. Those are exactly the parts that
change.

## Design

### D1 — The attempt document IS the launch document

`spec plan edit` accepts the graph authoring dialect — the same
`{name, description?, definition, layout}` shape `cctl workflow validate`/`create`
take (`workflowDefinitionMutationSchema`, `src/lib/workflows/plan-validation.ts:32`) —
plus one spec-only sidecar section (D3). The attempt document becomes:

```jsonc
{
  "launch": { "name": "...", "definition": { /* WorkflowSemanticDefinition */ }, "layout": { ... } },
  "binding": {
    "dispositions": [ { "criterionElementId", "disposition", ... } ],   // unchanged shape
    "claims": [ { "contextId", "criterionElementIds": [ ... ] } ]        // replaces wiring/proofPlan/sourceMap
  }
}
```

Accept-time validation = `validateWorkflowPlan` (the general gate: schema, placement,
lane acyclicity, guards, loops, command selectors — `src/lib/workflow-graph/validation.ts:333-346`)
plus binding lint (D3). The planner authors, per context and in one dialect: acceptance
criteria, placement, `circuitBreaker`, `iterationPolicy`, validator cohort,
`scriptValidator` commands, `humanApprovalGate`, mutability, D4 routing/loops — every
knob the compiler used to pin. The `graph-workflow-planning` skill becomes the single
planning source of truth; `native-sdd-authoring` shrinks to spec authoring + binding.

Rejected: keeping both dialects with a richer compiler ("third improvement round") —
the D7 evidence is that compiler fidelity is a treadmill. Rejected: dropping the
attempt and linking `workflow create --spec <slug>` directly — loses pinning, the
immutable sign-off snapshot, and the disposition ledger, which cost little and are the
delivery guarantees worth keeping.

### D2 — One hash, same acts, launch-exactly-approved becomes trivial

Attempt lifecycle (draft → proposed → approved/parked → launched), server-side CAS,
propose-gated-on-lint, sign-off admitting `execution_start` in the same transaction —
all unchanged (`src/lib/state-store/spec-delivery-plan-repo.ts:440-995`,
`src/lib/specs/delivery-plan-service.ts:1168-1228`). What simplifies:
`planHash` and `compiledDefinitionHash` collapse into one document hash;
`DeliveryPlanCandidateIdentity` keeps two legs (candidateId + hash) instead of three
(`src/lib/specs/delivery-plan.ts:523-541`); the propose-time cross-check and the
launch-time re-hash (`execution-service.ts:2566-2578`) become the same assertion.
`spec plan preview` stops being a compilation preview and renders the definition
itself — Studio reuses the ordinary workflow graph rendering instead of the
SDD-specific `delivery-plan-graph.ts` projection.

The server stamps `origin.sourceUri = spec-plan://<specId>/attempts/<attemptId>?plan=<hash>`
at propose/launch; an authored `origin` on the definition is refused. That preserves the
existing discriminator for the spec execution contract, amendability, and definition
dedupe (`src/lib/specs/execution-contract.ts:15,44-50`,
`execution-amendment.ts:39,147`, `execution-service.ts:2543-2560`) with zero new
machinery.

### D3 — Claims: the one delivery guarantee we keep, as set arithmetic

"Nothing leaves scope silently" survives because it never needed the compiler:
binding lint refuses propose when a `selected` criterion is claimed by zero contexts,
when a claim names an unknown criterion or context, or when a claimed criterion's
disposition isn't `selected`. Pure set arithmetic over `binding` — no NLP, no
faithfulness judgment. Dispositions keep their exact shape, so `spec delta`, the
delivery gate, and the scope mirror (`delivery-plan-service.ts:1577-1630`,
`execution-service.ts:2582-2619`) work unchanged.

What claims deliberately do NOT guarantee: that a context's acceptance criteria
faithfully restate the claimed criterion text. That guarantee was the compiler's
justification, and D7 showed its cost exceeds its value — validators demonstrably read
the pinned spec file directly (every D7 verdict cites pinned R/D numbers). The pinned
revision materialized at `.cc/graph-workflow-docs/spec/<slug>.md` (plan-document-
independent, `src/lib/specs/export.ts:347-358` — kept as-is) is the faithfulness
anchor; acceptance criteria cite handles (`R3.5`, `ephw-c-no-queue`) instead of
duplicating text.

### D4 — Claims map materialized for every lane: the sibling-visibility fix

At launch, the spec layer renders ONE global document —
`.cc/graph-workflow-docs/spec/claims.md`: every criterion → disposition → owning
context, plus every context → claimed criteria — seeded alongside the pinned spec via
the existing `seededDocuments` channel (`execution-service.ts:2723`). Identical for
every context, so there is no per-context filtering to get wrong: a validator judging
context A can see that criterion X belongs to context B and record a deferral instead
of a NO-GO. This directly kills the D7 failure mode at its enforcement point, and it
composes with the unchanged shared deferral rule (`validator-runner.ts:348`) — the
claims map is exactly the "named owner" evidence that rule wants.

Complementary shared-engine change (benefits all graph workflows, not just SDD):
`charter.invariants[]` gains an optional `appliesTo` (mirroring
`sourcesOfTruth[].appliesTo`, `src/lib/workflows/charter-schemas.ts:75-113`), and the
validator prompt's "check every charter invariant" instruction
(`validator-runner.ts:328-334`) respects it. A migration-shaped invariant can then be
scoped to the context that owns its surface instead of binding every context.

### D5 — Evidence and the delivery gate: coarser, honest

The criterion-grain evidence pipeline keyed to `specPlanSourceMap`
(context→tasks→criteria metadata written by the materializer,
`delivery-plan-materializer.ts:760-903`, consumed by
`src/lib/specs/execution-origin-map.ts:31-83`) re-keys to claims (context→criteria).
Auto-ingest attributes a context's validation verdicts and lane commits to its claimed
criteria; task-grain `contributesToCriterionElementIds` retires. `proofPlan` retires
outright — it was advisory prose everywhere (no lint rule reads it; only pack prose and
diff aspects).

The delivery gate keeps functioning at this coarser grain: a selected criterion is
delivered when a claiming context completed with a blocking-validator GO and merged.
Where a criterion's `validationStrategy` demands evidence no producer can mint (the
known diff/screenshot gap), the answer stays Studio waivers — unchanged. If even this
proves more ceremony than value, the fallback simplification is pre-wired: set the
`delivery` gate dial to Notify for direct-authored attempts and the gate becomes a
report instead of a blocker. Recommendation: keep it blocking at context grain first;
demote only on evidence of friction.

### D6 — Locks: minimal and server-stamped; full live-edit parity

Today an SDD-launched workflow is effectively immutable mid-run. The materializer
stamps per-item locks on every context/task/edge field PLUS blanket wildcards —
`/executionContexts/*`, `/tasks/*`, `/edges/*`, `/workflowConfig`,
`/laneMergeValidation` (`delivery-plan-materializer.ts:745-757`) — and enforcement at
the single mutation choke point is caller-blind: every non-additive operation from any
writer, **including plan repair**, hits `findLockedRegionTouch`
(`runtime-edits.ts:805-822`) and is refused `region_locked` in every execution state
(locks are definition-level, not state-level). The only escapes are pre-launch
`spec plan reopen`, additive-only `workflow live amend` (the bypass fail-safes by
re-checking that every op is an additive type, `runtime-edits.ts:759-763`), and
`spec capture`. Practical consequence, lived in D7: the AC carve-out edit that would
have ended the churn was un-appliable mid-run, and plan repair's mutation vocabulary
on spec runs is reduced to additions.

This design shrinks locks to a server-stamped minimal set: `/charter`, `/origin`,
`/approvalRequired`. Everything else — ACs, task instructions, edges, per-context
config including breaker thresholds and validator cohorts — becomes editable through
the ordinary live-edit core with the same state gating as any workflow: structural
operations stay pause-only for operators, expensive validation rides the
prepare/finalize staging seam, the append-op exemptions remain reserved for
server-derived expansion/loop-unrolling, and the criterion coverage lock (see the
expressiveness section) guards claims on every batch. Plan repair regains its full
operation vocabulary on spec runs — likely the single biggest practical win of this
decision. Locking `/charter` does not freeze governance: the charter amendment act
remains the audited mid-run path; the lock only forbids silent rewrite through a
generic edit. `spec capture` and the discovery→seed flow are untouched (dedupe keys on
task ids, which the graph dialect also has). With mutation unlocked, `cctl workflow
live amend` is redundant with ordinary live edits and retires (settled decision 6).

### D7 — Launch path: persisted-definition now, one-off admission core later

Phase 1 keeps today's launch mechanics: sign-off → `spec start` reads the stored
document bytes, persists the definition keyed by origin, launches through
`executionStartGate.launchApprovedDefinition` (`execution-service.ts:2475-2812`).
Only the compile step disappears. Phase 2, once the in-flight ephemeral-workflows
delivery lands: `spec start` rides the extracted shared admission core with one-off
semantics — the dialect is already identical to the `workflow run` launch document, so
a spec run stops writing template storage at all and the spec execution link table
remains the only linkage. Nothing in this design depends on Phase 2.

## Expressiveness, dynamic control flow, and lint boundaries

**Constraints on the definition.** A spec-bound definition passes exactly the gate
every graph workflow passes — `validateWorkflowPlan` (schema, placement grammar, lane
acyclicity, barrier coverage, edge guards, output-schema subset, loop groups,
command-selector preflight, parameter reference lint) — plus three spec-specific
requirements, none structural: `origin` is server-stamped (an authored one is
refused), the charter carries the pinned-spec source entry (server-injected via the
existing `withPinnedSpecSource`), and the `binding` sidecar must be internally
coherent (below). There is no spec-specific subset of the dialect.

**Dynamic abilities: all of them, for the first time.** The retiring SDD dialect
cannot express conditional edges, loop groups, output schemas, or routing cardinality
at all (its edges are bare `{from, to}`); direct authoring makes every D4/D5 feature
available to spec delivery: guarded edges, loop-until, runtime task/context addition
(`mutability`), output-schema captures, collaboration, ask-user gates, lightweight and
read-only placement, parameters, prerequisites. The launch path is the ordinary
admission core, so there is no spec-side executor to fall behind again.

Attribution for dynamic shapes is deliberately decoupled from claims. Claims are
**static intent** over authored context ids; runtime truth is observed by the delivery
gate. Generated contexts map to their authored ancestor through lineage the runtime
already persists: loop-pass contexts carry `loopGroupId`
(`src/lib/workflow-graph/schemas.ts:1543`) and resolve to the declared body context;
D4-expanded contexts leave acceptance receipts naming their source
(`schemas.ts:2045`); conditional routes leave settlements (`schemas.ts:2034`). A
criterion claimed by a loop body is delivered when any pass instance of that authored
context completes with a blocking GO. Work delivered inside runtime-generated contexts
attributes to the authored claiming ancestor — coarse, and stated as such.

**Binding lint: coherence only, never structure or modality.** Blocking rules, all
set arithmetic over ids:

1. Every `selected` criterion is claimed by ≥1 context.
2. Claims reference criterion ids that exist in the pinned revision and context ids
   that exist in the definition.
3. A claimed criterion's disposition is `selected` (claiming a waived/deferred
   criterion is a contradiction).
4. Exactly one disposition per criterion (unchanged from today).
5. A `required` parameter without a default is refused **until** `spec start` grows an
   `--inputs` pass-through (recommended: add the flag instead of keeping the
   restriction — it is the same inputs document `workflow start` takes).

Deliberate one-way-ness keeps this from excluding legitimate definitions: **criteria
need claimants; contexts never need claims.** Scaffolding, integration, closeout,
remediation branches, loop exits, and generated contexts all legitimately claim
nothing. Multiple contexts may claim one criterion (alternative routes, split
delivery).

One reachability rule DOES apply, and it is deliberately reused rather than invented:
the **criterion must-run coverage lock** (`src/lib/workflow-graph/criterion-coverage.ts`,
D4 R5/D11). It computes the conservative must-run set (contexts reached
unconditionally on every path) and refuses a graph in which a `selected` criterion has
no claiming context in that set. This module already exists with exactly two callers —
the SDD compiler at accept time and `checkLiveEditFrontier` at mutation time — with the
stated contract that both ends share one rule so an accepted plan and an accepted edit
cannot mean different things. Binding lint keeps it blocking and feeds it claims. It is
conservative: a criterion delivered by context A on one guarded route OR context B on
the other has no must-run claimant and is refused. The idiom that makes this
legitimate rather than restrictive: **disjunctive delivery needs an unconditional
attester** — also claim the criterion from an always-running context (typically
closeout/integration) that verifies whichever route delivered. The escapes are the
honest ones: re-disposition the criterion (defer/waive) or add the must-run claim.
This is the one place lint is stricter than pure set arithmetic, and it preserves the
existing engine guarantee that skipping a context can never implicitly waive a linked
criterion — mid-run, the same shared rule refuses an edit that would orphan a claim
(deleting the last claiming context, or guarding an ancestor edge) with a precise gap
report.

The residual risk is accepted and covered: within must-run coverage, a lint-green plan
can still under-deliver at runtime in ways statics cannot see. That is the delivery
gate's job — it observes what actually executed and refuses the merge for a selected
criterion with no evidence; remedies are the existing ones (run the route, waive with
rationale, capture follow-up scope). Static coverage says "nothing left scope silently
at planning time"; the gate says "nothing went undelivered silently at merge time."

Known limit, stated: claims are frozen at sign-off. A live amend can add contexts and
tasks mid-run but cannot rebind claims; scope changes route through `spec capture`
(discoveries) and waivers, as today. If rebinding proves necessary in practice, it
becomes a fenced live-edit act later — not in v1.

## What retires

- The SDD plan dialect (`deliveryPlanDocumentSchema` and its mirror of
  `ownedPathSchema`, `src/lib/specs/delivery-plan.ts:159-201,412-430`) and the
  `plan-edit` schema registry entry (replaced by pointing at the workflow dialect docs).
- The materializer: `contextPack`, pack manifests + byte caps, `wiring`, `proofPlan`,
  `governance` compilation, `compiledDefinitionHash`, `specPlanSourceMap` writing,
  compilation-context deps (`service-factory.ts:673-700`).
- SDD-shape plan lint rules that duplicate `validateWorkflowPlan` (a handful survive
  as binding lint: coverage, unknown ids, spec-source presence in the charter).
- Studio's SDD plan-graph projection (`delivery-plan-graph.ts`,
  `SpecDeliveryPlanReview.tsx` structure rendering) in favor of the standard workflow
  definition renderer; dispositions/diff/comments panels stay.
- `governance.validationCommandNames` (the planner authors `agentValidation` /
  `scriptValidator` selections directly, checked by the existing selector preflight).

## What survives untouched

Pinned revisions; attempt lifecycle + CAS + sign-off-by-hash + `execution_start`
admission; criterion dispositions and the reaffirmation law (the seed's
`pending_reaffirmation` logic operates on dispositions, not structure); `spec delta`;
`spec measures`; `spec capture` + discovery seeding; the pinned-spec lane
materialization; gate policy presets; `spec abandon`; the legacy `spec task` path
(precedent for keeping launched SDD-dialect attempts readable).

## Migration and compatibility

Launched/abandoned attempts keep their SDD documents as read-only history (same
pattern as the archived-execution decode floor); `draft`/`proposed` attempts at cutover
must be reopened and re-authored — acceptable, they are pre-approval by definition.
`legacy-plan-import.ts` and `delivery-plan-seed.ts` emit the new shape (seeding from a
prior delivery = copy definition + rebind claims against the new pinned revision).
The running D7 execution is unaffected (its attempt is `launched`; the executed
`workingDefinition` is already independent of the plan document).

## Honest losses (accepted per the stated tradeoff)

1. Criterion-grain proof: evidence attribution becomes context-grain via claims.
2. Machine-checked AC faithfulness to criterion text: gone; the pinned spec file +
   validator review carry it.
3. The wiring ownership model as data: replaced by the claims map + AC prose.
4. Auto-generated per-context criterion packs: the planner writes ACs citing handles.
5. Task-grain criterion contributions: gone with `proofPlan`.

## Decisions (settled by Alex, 2026-08-14)

1. **Delivery gate**: stays **blocking at context grain** — merge refused while a
   selected criterion has no completed+GO claiming context; waivers remain the escape.
2. **Claims placement**: **sidecar `binding` on the attempt** — the definition stays
   pure graph dialect. (Context `metadata` rejected: deliberately dropped by the
   cascade and invisible at runtime.)
3. **Criterion must-run coverage lock**: stays **blocking at both accept time and
   live-edit time**, reusing the existing shared module fed by claims. Disjunctive-
   route delivery adds an unconditional attester claim (typically closeout).
4. **Invariant `appliesTo` scoping**: **ships with this change** — optional
   `appliesTo` on charter invariants plus validator-prompt respect, for all graph
   workflows.
5. **Layout**: **required and authored** on the attempt document, matching the D7
   one-off decision to persist the authored launch document verbatim.
6. **`workflow live amend`**: **retire** once minimal locks land — ordinary live
   edits (plus `spec capture` for discovered scope) subsume it.

## Sequencing sketch

1. Binding lint + claims schema; attempt document accepts the graph dialect behind the
   existing draft/propose CAS (new attempts only).
2. Hash collapse + server-stamped origin + minimal locks; `spec start` launches stored
   bytes without compiling; claims map seeded document.
3. Evidence origin-map re-key to claims; Studio renders the definition via the standard
   viewer; retire materializer + SDD dialect for new attempts.
4. Shared-engine: invariant `appliesTo` + validator-prompt respect.
5. (Post-ephemeral-workflows) `spec start` on the one-off admission core.

Each step is red-green testable in isolation; step 1 alone already lets the next spec
delivery be planned with full graph-dialect expressiveness.
