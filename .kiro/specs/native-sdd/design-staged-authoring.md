# Design addendum: staged authoring discipline

> **Superseded in part (2026-09-24).** Revisions and delivery-plan attempts no longer have a Proposed state: a draft is reviewed while it stays editable, and sign-off is the only freeze. Rules here for request-changes drafts, and for opening a draft at the stage after its approved base, are retired: an amendment opens at Design and returns to Requirements only for a requirement change. Requirement 27 in `requirements.md` and "Amendment — continuous review" in `design.md` describe the current lifecycle.

**Status:** APPROVED by Alex 2026-07-22 and folded into `requirements.md` (R22 + deltas), `design.md`, `tasks.md` (20.x), and product design rev 6 the same day — this document remains the decision record. (Direction approved 2026-07-22: staged · stage-keyed admissibility with dial-governed advance · forward-blocking; revised twice folding accepted findings from two Codex design-review rounds.)
**Motivated by:** Workflow design review 2026-07-22 — single-pass authoring is structurally forced; the three authoring gates are approval categories inside one review, not phases
**Extends:** `requirements.md` R3/R6/R9/R10/R11 + new R22; `design.md` Physical Data Model, State Machines, Transition Ownership, Authoring → Review → Sign-off, TransitionPredicates, LintEngine, AuthoringService, CctlSpecFamily; `docs/design/native-sdd/01-product-design.md` §4, B6, B8 (rev 6). Fold completed 2026-07-22: §5 deltas in `requirements.md`, §6 deltas in the product design, §8 tasks appended to `tasks.md`, design decisions integrated into `design.md`.
**Date:** 2026-07-22

## 1. The gap

An agent asked to create a spec authors requirements, design, and the full task plan in one pass before any human review, because the workflow gives it no other path:

- Lint rule `9.3.uncovered-criterion` is `blocks_propose` (`lint.ts:358`): every acceptance criterion must already have a covering task or `propose` is refused. A requirements-only draft is unproposable by construction.
- Sign-off demands the plan approval unconditionally under a Gate dial (`transitions.ts:257`), so a task-less revision could never become approved even if it were proposable.
- The requirements/design/plan gates therefore never *sequence* anything: they are three groups of approvals checked together at one sign-off on one revision. The fast-path preset's "combined approval" (R11.5) collapses a distinction that the other presets never actually had.

This is a design gap, not an implementation deviation — the implementation is faithful to rev 5 of the product design, and no artifact records a decision for or against staged review; the single-pass model fell out of making the revision the unit of review.

Why it matters (the quality argument, accepted 2026-07-22):

1. **Solution contamination.** Requirements written by the agent that is about to write the design get reverse-engineered from the design it already has in mind — the write-the-test-after-the-code failure mode.
2. **Feedback compounding.** Requirements reviewed before design exists let human corrections propagate into fresh design authoring. In single-pass, corrections arrive after everything is built and the agent patches under sunk cost — reliably worse than authoring from an approved foundation.
3. **Anchoring.** A complete-looking spec with a full traceability graph invites bulk approval; reviewing requirements on their own merits is harder when thirteen tasks already depend on them.
4. **On this feature's own thesis** ("gates are state transitions the server refuses, not prompt etiquette" — `requirements.md` Introduction), ordering that matters must be server-enforced. Skill-text guidance alone is the enforcement model native SDD was built to replace.

## 2. The discipline invariant

> A draft revision carries an authoring stage — **requirements → design → plan**. Elements of a later stage cannot be authored before the current stage's concluding gate is satisfied, under the same dial that governs that gate: where the dial is Gate, the stage concludes only through review and sign-off; where it is Notify or Off, the agent advances through an explicit, recorded gate admission. Editing earlier-stage content is always permitted — staleness and re-approval (R10.5–10.6) handle the consequences. Fast-path's combined approval keeps its single-pass shape. No new policy surface exists: the three authoring dials gain a second effect, not a sibling.

Enforcement strength therefore tracks human oversight exactly: contract-bearing yields three small, focused reviews; exploratory advances freely with an admission trail; fast-path is unchanged.

## 3. The staged flow (contract-bearing)

1. `cctl spec create` opens the draft at stage **requirements**. Admissible: intent/context sections, requirements, criteria (questions and assumptions always). Decisions, design-narrative sections, and tasks are refused.
2. Agent proposes → human reviews *only requirements* → approves items → signs off. The revision approves; the requirements-gate admission records `human_approval`.
3. The next draft (amendment, `based_on` the approved revision) opens at stage **design**. Admissible: + decisions, + design-narrative sections. Requirements remain editable; edits flip their approvals stale per existing machinery.
4. Design-stage sign-off (decision approvals + carry-forward requirement approvals; **no plan approval demanded**) → next draft opens at stage **plan**. Tasks become admissible; coverage lint applies at this propose.
5. Plan-stage sign-off (plan approval + carry-forwards) yields the executable revision. Execution start pins it.

Each gated boundary forces a turn/context boundary on the authoring agent — the stage after review is authored fresh, from approved content, without unapproved downstream artifacts in the draft. That, not the write-order per se, is the quality mechanism.

## 4. Design decisions

### SA1 — Stage is a declared, persisted field on the revision

`spec_revisions.authoring_stage` ∈ (`requirements`, `design`, `plan`); additive floor DDL + migration with `DEFAULT 'plan'` (per `.kiro/steering/tech.md` and `src/lib/state-store/migrations/README.md`; note the additive-column cross-process race gotcha), so every pre-existing revision is unstaged-equivalent and nothing retro-blocks. Schema in `schemas.ts` (`specAuthoringStageSchema`), repo mapping + `spec_revisions` round-trip contract fixture extended.

Because the stage now gates authorization (SA4/SA5 key lint and the plan approval on it), it is contract state: `authoring_stage` joins the canonical revision content hash — `computeSpecRevisionContentHash` currently hashes element rows only — and the export, so stage tampering is detectable per R2.5 and `cctl spec verify` covers it.

Rejected alternative: deriving stage from content. Ambiguous — a zero-decision spec's design-stage revision is content-identical to its requirements-stage base, and prose sections span stages. The declared stage also lets review surfaces frame the review ("Design review of rev 3"), which content inspection cannot.

### SA2 — Element admissibility is a pure predicate, enforced at the draft-write transition

New pure function (in `transitions.ts`, beside the other predicates): `admitDraftWrite(stage, elementKind, sectionRole?, resolvedDials) → TransitionDecision`.

| Stage | Admissible element writes |
|---|---|
| requirements | `section` (roles `intent_*`, `context`), `requirement`, `criterion` |
| design | + `decision`, + `section` role `design_narrative` |
| plan | + `task` (everything) |

- Questions and assumptions are records, not elements — always admissible (they are the sanctioned landing place for "writing the plan revealed R4 is wrong" at any stage).
- **Forward-blocking only**: writes to earlier-stage elements are always admitted; R10.5–10.6 staleness governs the consequences.
- Enforcement lives in AuthoringService's draft-write path (server-side, before CAS), refusing with new refusal code **`stage_blocked`** (added to `refusalCodeSchema`), unmet condition naming the element kind and current stage, and an instruction naming the legitimate next step (propose the stage for review, or `cctl spec advance` where policy admits). Refusals record `spec-intervention-recorded` events like every other enforcement intervention (R21.4 counting applies). One edge: a refused first element on `cctl spec create` returns the refusal without an intervention row — no spec identity exists yet to attach one to.
- Admissibility depends solely on the draft's current stage — never on the dials (the resolved dials enter the predicate only to phrase the refusal instruction). The dials govern how the stage *advances* (SA3): Gate concludes a stage through review and sign-off; Notify/Off admit an explicit recorded advance. A premature write is refused identically under every policy — only the instruction differs (propose the stage for review vs. `cctl spec advance`).

### SA3 — Stage assignment and advance are owned transitions

New rows for the Transition Ownership table:

| Transition | Initiator | Authorization | Predicate | Records | Idempotency |
|---|---|---|---|---|---|
| Open draft (stage assignment) | existing open-draft paths | existing | stage rule below | stage stamped on the revision row + events | existing |
| Advance stage | agent — `cctl spec advance <slug> --from <stage>` | agent; **refused where the concluding dial is Gate** (`human_act_required`-style instruction: propose and obtain sign-off) | draft exists; next stage exists; dial is Notify/Off; conditional update on (current draft revision id, `--from` stage) — a replacement revision at the same stage does not satisfy a stale command | in-place conditional stage bump + `spec_gate_admissions` row (gate = the concluded stage's gate, basis `notify_policy`/`off_policy`) + events, one transaction | the identified revision already at or past the implied target ⇒ no-op success; any other mismatch ⇒ typed stale-stage conflict carrying the current revision and stage |

Stage rule at open:

- No base approved revision → `requirements`; **except** when **all three** authoring dials resolve to the combined-approval dial (pure fast-path, R11.5) → `plan` (single-pass preserved, staging vacuous). A sparse override mixing combined with other dials treats combined as Gate for stage purposes — mirroring how `approvalUnmetConditions` already degrades a mixed combined policy to per-element Gate semantics.
- `based_on` an **approved** revision → the stage after the base's stage, capped at `plan`. A base at `plan` means post-approval amendments open fully unstaged — staging governs initial authoring progression, not amendment work.
- `based_on` a **withdrawn** revision (request-changes flow) → the withdrawn revision's stage, unchanged — a failed review attempt does not advance the spec.
- Policy changes apply prospectively (R11.10): the dials are resolved at each write/advance/open, so loosening mid-spec unblocks from that moment only.

Ingress ownership is explicit and **complete** — five paths open drafts: `cctl spec create` (new spec), the first draft write against an approved spec (amendment), the server-opened request-changes draft, and the links-service entry paths — conversation promotion and ticket graduation — which today create specs and amendment drafts by calling the repository directly (`links-service.ts:462`, `:496`) and would otherwise silently land on the column default. Stage initialization therefore has one owner: the repository's revision-creation APIs take the stage as a **mandatory parameter** (the SQL column default exists solely to backfill pre-migration rows, never for new writes), every ingress obtains it from the single SA3 stage rule, and links-service routes through that owner exactly like the CLI paths. Sign-off never auto-opens the next draft. In every path the stage stamp (or advance), its gate-admission row, and the durable events commit in one transaction, with SSE published after commit.

### SA4 — Coverage lint becomes stage-honest

The `9.3` criterion-coverage findings fire (still `blocks_propose`) **only for a plan-stage draft revision** — keyed on the stage, not on task presence. A requirements- or design-stage propose is exempt; a plan-stage propose must cover every criterion and every task must cover at least one criterion. This includes the degenerate zero-task plan (every criterion uncovered → refused), so an empty plan can never be proposed, let alone approved, and prevents tasks that cannot satisfy the criterion-targeted evidence contract from reaching execution. `9.2.empty-spec` is unchanged at every stage (nothing reviewable without a requirement + criterion); `9.4`–`9.6` are unchanged (vacuous without tasks). The completeness check moves to where completeness is claimed, and the floor is untouched: execution start still refuses uncovered selected criteria (R16.5) independently.

### SA5 — Sign-off preconditions become element-conditional

In `approvalUnmetConditions` (`transitions.ts`): the plan approval is demanded **iff the proposed revision is a plan-stage revision** (with SA4's lint, such a revision always carries a coverage-complete task set). Requirement and decision approvals are already demanded only for elements present in the revision (vacuous truth preserved).

Authorization is **stage-scoped**: the dials a revision's transitions consult are those of its own stage plus any earlier stage whose elements it modified — `proposeDials` becomes a function of the revision, not of the policy alone. This governs both the propose-absorption test (all consulted dials Notify/Off ⇒ propose absorbs sign-off) and the human-actor requirement on sign-off. Example: requirements=Notify with design=Gate lets a requirements-stage revision propose-and-absorb as a pure Notify admission, while its design-stage successor requires human sign-off. The combined-approval dial only ever governs plan-stage revisions (fast-path drafts open at plan), so R11.5 atomicity is untouched; policy edits resolve prospectively at each transition (SA3).

Sign-off records the gate admission for the revision's stage, plus re-recorded admissions for any earlier-stage gate whose elements the revision modified (their approvals were re-demanded, so the re-admission is honest).

### SA6 — Execution start requires a plan-stage revision

`startExecution` gains one refusal: the pinned approved revision must have `authoring_stage = 'plan'` (unmet condition: "The pinned revision has not completed plan-stage authoring."). Belt-and-braces over scope validation — makes the staged contract explicit rather than an emergent property of task selection, and covers the legacy default correctly (pre-migration revisions are `'plan'`).

### SA7 — Stage is a projection field, never a phase

The phase primary is untouched; no new phase enum values (R3.11 spirit: roll-ups and facets, not stored phases). The stage is a **separate optional projection field**, not an overload of the existing `draft | in_review` authoring facet — that facet exists only while a revision is editable or proposed and cannot express "Approved · requirements stage". The phase projection's return shape and the view schemas gain `authoringStage?`, populated until a plan-stage revision is approved: from the current draft/proposed revision's stage, else from the latest approved revision's stage. Every phase-bearing renderer (Studio detail header, list badges, chip hover peek, `cctl spec status`) presents it beside the phase — "Draft · requirements", "In review · design", "Approved · requirements stage" — dissolving the misleading transient where a spec whose requirements-stage revision just approved would read bare "Approved".

### SA8 — Agent surface

- New verb `cctl spec advance <slug>` (SA3), with progressive-disclosure help wired into `spec.help.ts`.
- `cctl spec status` adds the authoring stage and which gate concludes it.
- `spec.help.ts` reframes `propose` from "propose the completed draft" to "propose the current authoring stage for review".
- `.claude/commands/spec.md` documents the staged default under gated presets: author requirements → propose → end turn awaiting review → author design from the approved base → … The skill text is guidance; the server is the enforcement (SA2) — both must tell the same story.

## 5. Requirement deltas (fold into `requirements.md` on approval)

- **R3 — add criterion 12:** "Until a plan-stage revision is approved, spec surfaces shall present the current authoring stage alongside the phase wherever the phase renders."
- **R6.3 — amend:** status reads additionally include "the current authoring stage and its concluding gate".
- **R6.4 — amend:** writes additionally include "advancing the authoring stage where the governing dial admits it".
- **R9.3 — replace with:** "When a plan-stage draft revision is proposed while any acceptance criterion has no covering task or any task covers no acceptance criterion, the spec system shall refuse the proposal with a finding naming the uncovered criterion or task; a proposed revision at an earlier authoring stage shall not be refused for criterion-coverage defects."
- **R10 — add criterion 10:** "The spec system shall require the plan approval as a sign-off precondition only for a plan-stage proposed revision; requirement and decision approvals shall be required only for the requirements and decisions the proposed revision contains."
- **R10 — add criterion 11:** "The gating dials consulted by a proposed revision's propose and sign-off transitions shall be those of the revision's authoring stage and of any earlier stage whose elements the revision modified."
- **R11 — add criterion 12:** "The three authoring gates (requirements, design, plan) shall additionally govern staged-authoring advance per Requirement 22, under the same dials and overrides, with no separate policy surface."

### New Requirement 22: Staged authoring discipline

**Objective:** As the operator, I want authoring to progress requirements → design → plan under the same dials that gate approval, so that each stage is authored from reviewed foundations and agents cannot pre-build downstream artifacts on unvalidated intent.

#### Acceptance Criteria

1. The spec system shall record an authoring stage — requirements, design, or plan — on every draft revision at open, visible in Spec Studio, CLI status, and review surfaces.
2. While a draft revision is at the requirements stage, the spec system shall admit writes of intent/context sections, requirements, and criteria; while at the design stage, additionally decisions and design-narrative sections; while at the plan stage, additionally tasks. Question and assumption records shall be admissible at every stage.
3. When a write targets an element kind of a later stage than the draft's current stage, the spec system shall refuse it with a typed refusal (machine-readable code, the unmet condition, and the legitimate next step — proposing for review where the concluding dial is Gate, advancing where it is Notify or Off) and record the intervention.
4. The spec system shall always admit writes to elements of the current or an earlier stage; consequences of editing approved earlier-stage content are governed by the approval-staleness rules of Requirement 10.
5. Where the concluding gate dial is Gate, the stage shall advance only through sign-off of a revision at the current stage; where it is Notify or Off, the agent shall advance the stage through an explicit act — identifying the draft revision and the stage it expects to conclude, refused with a typed conflict when either expectation is stale — recorded as a gate admission naming the admitting policy, never as an approval.
6. Where all three authoring gates resolve to the fast-path combined approval (Requirement 11.5), draft revisions shall open at the plan stage and single-pass authoring shall be preserved unchanged; a policy mixing the combined approval with other dials shall treat combined as Gate for staging purposes.
7. A draft opened from an approved revision shall open at the stage after its base (capped at plan); a draft opened by request-changes shall retain the withdrawn revision's stage.
8. If execution start is requested pinning a revision that is not a plan-stage revision, the spec system shall refuse the transition.
9. Revisions created before this discipline exists shall be treated as plan-stage revisions.

## 6. Product-design deltas (fold into `01-product-design.md` as rev 6 on approval)

- **§4 Revision state:** note that a revision carries an authoring stage (requirements → design → plan) and that gated presets conclude each stage with its own propose → review → sign-off cycle; amendment drafts against a plan-stage base open unstaged.
- **B6 lint table:** the "Every criterion is covered by ≥ 1 task" row's severity becomes "Blocks `propose` of a plan-stage revision".
- **B8:** add the staged-authoring paragraph: the three authoring dials also govern authoring-stage advance (Gate = advance via sign-off; Notify/Off = explicit recorded admission; fast-path unstaged); rationale per §1 of this addendum. The five-gate matrix itself is unchanged.
- Record the decision date 2026-07-22 in the doc's decision log.

## 7. Compatibility and observability

- Pre-existing revisions default to `plan` (SA1): every current spec and execution behaves identically; `verify`/`export` gain the stage field additively (not byte-identical — an additive field). An older binary — including a branch dev server against the shared `command-center.db` — opens revisions at the `'plan'` default: this is the same additive-column posture every schema-extending branch already operates under (additive defaults, read-side quarantine), the exposure is staging silently skipped (a quality regression; the delivery floor is stage-independent), and new-code writes never rely on the default (stage is a mandatory creation parameter, SA3). No bespoke version fence is added.
- No workflow-machinery, evidence, delivery, or ticket-link surface changes; the delivery floor is untouched (SA4, SA6).
- The §6.1 success measures already capture requirement-caused rework and approval friction (R20.1) — the staged discipline's intended effect (less rework, smaller reviews) is directly observable against pre-change history; no new instrumentation is required.
- Cost acknowledged: contract-bearing specs go from one review interaction to three smaller ones. Fast-path remains the single-review escape valve.

## 8. Tasks (append to `tasks.md` on approval)

- [ ] 20. Staged authoring discipline
- [ ] 20.1 Stage persistence: `authoring_stage` column (floor DDL + migration, default `'plan'` for backfill only; mandatory parameter on the repo creation APIs), `specAuthoringStageSchema`, repo mapping, `spec_revisions` round-trip contract extension; stage in the canonical revision content hash and export/`verify`
  - _Requirements: 2.5, 22.1, 22.9_
- [ ] 20.2 Pure predicates (TDD): `admitDraftWrite` stage-only admissibility matrix; open-draft stage rule (create / based_on approved / based_on withdrawn / combined-dial); advance predicate with expected-stage conditional update; stage-scoped dial resolution for propose/sign-off
  - _Requirements: 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 10.11_
- [ ] 20.3 Transition integration: lint 9.3 keyed on plan stage; plan approval iff plan-stage at sign-off; stage-scoped dial consultation and gate admissions; `startExecution` plan-stage refusal
  - _Requirements: 9.3, 10.10, 10.11, 22.5, 22.8_
- [ ] 20.4 AuthoringService enforcement and the stage service operation: `stage_blocked` refusal code, draft-write guard before CAS, intervention events; single-transaction stage stamp/advance + admission row + events across all ingress paths (create, amendment first-write, request-changes, links-service promotion/graduation routed through the same owner)
  - _Requirements: 22.3, 22.5, 22.7, 6.5_
- [ ] 20.5 CLI: `cctl spec advance --from <stage>` verb, stage in `spec status`, help-registry updates including the `propose` reframing
  - _Requirements: 6.3, 6.4, 22.5_
- [ ] 20.6 Projection and Studio: `authoringStage?` on the phase projection and view schemas; renderers (detail header, list badges, hover peek), stage-framed review header
  - _Requirements: 3.12, 22.1_
- [ ] 20.7 `/spec` skill: staged authoring flow as the default under gated presets
  - _Requirements: 22.5 (guidance surface)_
- [ ] 20.8 E2E: contract-bearing staged golden path (three reviews to an executable revision); refusal demonstrations (out-of-stage task write; execution start pinning a non-plan-stage revision); fast-path single-pass regression
  - _Requirements: 22.3, 22.6, 22.8, 21.3_

## 9. Rejected alternatives

- **Skill-guidance-only staging** — prompt etiquette, the enforcement model this feature exists to replace; agents drift to pre-authoring everything and staging the proposes as theater.
- **Deriving stage from revision content** — ambiguous for zero-decision specs and untyped prose; see SA1.
- **Auto-advance on first out-of-stage write under Notify** — a silent stage change hides the moment; native SDD's philosophy is explicit, recorded transitions (mirrors the explicit-sign-off decision in B7).
- **A separate staging policy dial** — a second policy surface to keep coherent with the first; the authoring dials already express exactly the needed strength per boundary.
- **Server-blocking backward edits (strict one-way phases)** — discovery during design legitimately reworks requirements; staleness machinery already prices those edits correctly. Kiro's own flow permits returning to earlier phases.
- **Review-scoped propose on a single revision (a declared "review scope" instead of stages)** — duplicates what revisions already are; the amendment cycle plus approval carry-forward is the existing mechanism for successive reviews of a growing artifact.
- **Dirty-earlier-stage barrier (demoting or quarantining the draft when earlier-stage content changes)** — proposed in review; re-affirmed as rejected. Staleness lands at propose exactly as it does for every amendment to approved content in the base design, and the 9.9 approval-freshness advisory already provides live visibility in the lint panel between edit and propose.
- **Boundary hashes on stage advance** — the propose/sign-off content hash is the review-path integrity mechanism; advance is deliberately the non-review path, its CAS is revision-scoped, and its blast radius under Notify/Off is a recoverable stage bump.
