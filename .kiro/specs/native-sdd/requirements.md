# Requirements Document

## Project Description (Input)
Command Center's spec-driven development today lives in external Kiro skills writing markdown under `.kiro/specs/` — Alex (CC's single operator) and his agents have no durable spec identity, no enforced approvals, and no criterion-level evidence: gates are prompt etiquette, approvals are prose, and completion claims are unverifiable. Build **native SDD** as a first-class CC domain per the closed product design `docs/design/native-sdd/01-product-design.md` (rev 5, 2026-07-17, no open items — authoritative for all product semantics): specs as durable product objects with stable identity, revisions, granular per-element approvals with explicit sign-off, server-enforced gates (spec-level preset + per-gate dials over a hard floor), typed server-resolvable evidence with proof verdicts and criterion dispositions, execution compilation to graph workflow definitions with provenance-locked contract content, scoped delivery/merge gates, the Spec Studio UI (implement the Claude Design handoff bundle at `claude-design/spec-driven-development-ui/` using CC design-system tokens and primitives — the design system wins wherever the prototype diverges), the `cctl spec` agent surface, unified `#` references with element drill-in, and read-through ticket links. V1 is the full B1–B11 lifecycle spine; the falsifiable success test is doc §6.1 and its instrumentation is in scope. The six §3 invariants are fixed product requirements; the storage choice for authored content is decided in this spec's design phase. The existing Kiro skills and `.kiro/specs/` remain untouched (no import, no migration, no modification).

## Introduction

Native SDD makes spec-driven development a first-class Command Center domain. A spec becomes a durable product object — like a conversation, ticket, or workflow — that is addressable everywhere CC has an addressing surface, observable everywhere CC has a liveness surface, and enforceable at the server: gates are state transitions the server refuses, not prompt etiquette. The lifecycle spine is intent → review → enforced approval → reviewed execution plan → isolated execution → criterion-level evidence → controlled delivery, and V1 ships the whole loop.

These requirements translate the closed product design (`docs/design/native-sdd/01-product-design.md`, rev 6 — authoritative for all product semantics) into verifiable acceptance criteria. The binary V1 release-acceptance test from that document's §6.1 is captured as Requirement 21.

Naming ("spec", "Spec Studio", `cctl spec`) is working vocabulary; final naming is settled during the design phase.

## Boundary Context

- **In scope**: The full B1–B11 lifecycle spine — spec objects with identity and references, revisions with granular approvals and explicit sign-off, server-enforced gates with presets and per-gate dials over a hard floor, open questions/assumptions/waivers/gate admissions as first-class records, typed evidence with proof verdicts and criterion dispositions, the `cctl spec` family including export/verify, Spec Studio review surfaces including the traceability view, deterministic lint, ticket links with graduation and materialization, execution compilation to graph workflow definitions with provenance locking, scoped delivery gates, liveness/attention integration, §6.1 success-test instrumentation from day one, and the §6.1 release-acceptance demonstration.
- **Out of scope**: The existing Kiro skills and `.kiro/specs/` files — no import, no migration, no modification (a deliberate decision that supersedes the collaboration report's migration path). The storage choice for authored content — decided in this spec's design phase against the six invariants. Deferred features: approved-with-conditions/obligations, specialist agent advisory reviews, semantic (agent-judgment) lint, spec-event-driven ticket lifecycle actions, direct human editing of spec content, concurrent disjoint-scope executions, cross-spec links and dependencies, dependency-propagated approval invalidation, drift detection and change-impact analysis, living-memory/portfolio features, and multi-agent authoring choreography.
- **Adjacent expectations**: The graph-workflow subsystem gains three **general** capabilities native SDD relies on — approvable workflow definitions, origin links, and provenance-locked definition regions — with no SDD special-casing in workflow machinery. The existing reference/chip foundation is extended into the unified picker defined by Requirement 5. The ticket system, attention machinery (Needs You, Active Work, notifications), pre-merge validation machinery, and merge jobs are composed via links and read-through display; native SDD does not duplicate their state. Spec Studio follows the approved UI prototype's interaction semantics, with the CC design system governing visual implementation; the binding artifact details (handoff bundle, tokens, primitives) are charter and design-phase material.

## Requirements

### Requirement 1: Spec identity, handles, and deep links
**Objective:** As the operator, I want every spec and each of its elements durably addressable by stable handles and deep links, so that humans and agents cite exactly the same object across every CC surface.

#### Acceptance Criteria
1. The spec system shall identify every spec by a per-project slug that is unique within its project.
2. The spec system shall identify sub-elements by slug-qualified handles with per-spec counters: requirements (`native-sdd/R3`), acceptance criteria as sub-elements of requirements (`native-sdd/R3.2`), decisions (`native-sdd/D2`), tasks (`native-sdd/T7`), open questions (`native-sdd/Q2`), and assumptions (`native-sdd/A1`).
3. While the surrounding context identifies a single spec unambiguously, the spec system shall accept bare handles (`R3`) as shorthand for the slug-qualified handle.
4. The spec system shall present one handle vocabulary everywhere handles appear: the UI, reference chips, CLI output, workflow briefs, and evidence records.
5. The spec system shall provide a deep link for every spec, requirement, decision, and task; when a user follows one, Spec Studio shall open scrolled to that element.
6. When a spec is renamed, the spec system shall keep previously copied references and deep links resolving through aliases.

### Requirement 2: Durable spec objects, revisions, and stable element identity
**Objective:** As the operator, I want specs to be durable objects with immutable approved revisions and stable element identity, so that approvals, references, and evidence never silently drift.

#### Acceptance Criteria
1. The spec system shall persist each spec as a durable object owned by a project, carrying a human-readable name and its per-project slug, with identity that is stable, neutral to any session worktree, and independent of either display value.
2. The spec system shall version spec content as revisions, of which only draft revisions are editable.
3. The spec system shall support prose-first markdown sections — intent (problem, outcomes, non-goals, success measures, constraints), design narrative, and free-form context — reviewed inline.
4. While a revision is approved, the spec system shall treat its content as immutable: any change to spec content shall occur only by creating a new draft revision.
5. The spec system shall make approved revisions tamper-evident: unauthorized modification of approved content is detectable and surfaced.
6. The spec system shall keep requirement, criterion, decision, and task identities stable across revisions: editing an element's text shall never change its identity.
7. The spec system shall require every requirement to carry a statement, one or more addressable acceptance criteria, and a priority/risk indication.
8. The spec system shall nest acceptance criteria under their requirement — approved and revised with it — while each criterion carries stable identity so coverage and evidence key on the criterion.
9. The spec system shall require every acceptance criterion to carry a declared validation strategy — the evidence kinds and checks that satisfy it — approved and revised as part of its requirement's content; a strategy shall name at least one machine-validation kind (test run or validator verdict), so no criterion carries an obligation nothing can machine-prove, and a strategy violating this shall be refused at write time.
10. The spec system shall record for every decision its chosen approach, rejected alternatives, and reason.
11. The spec system shall record for each task the requirements it traces to and the set of acceptance criteria it covers, supporting many-to-many task-to-criterion coverage, and optionally its declared lane group and touched file surfaces (Requirement 23).
12. The spec system shall derive a task's work status from that task's own execution events and completion claim with its evidence, never from the dispositions of the criteria it covers.
13. The spec system shall present requirement status as a derived projection of coverage, approval, and evidence state, never as an independently stored second truth.
14. The spec system shall keep approval, review, evidence, and execution state worktree-neutral: the same state is observable regardless of which session or worktree reads it.
15. The spec system shall maintain exactly one authoritative representation of each concern, with no silent bidirectional synchronization between representations.
16. The spec system shall relate specs to tickets, conversations, sessions/worktrees, workflow executions, and merge jobs through provenance-bearing links that identify their direction and category (for example graduated-from, materialized-from, reference), keeping each object's identity and lifecycle distinct.

### Requirement 3: Lifecycle phases as a composite derived projection
**Objective:** As the operator, I want the spec phase to be an honest derived projection of revision and execution state, so that a pending review or an active run is never hidden.

#### Acceptance Criteria
1. The spec system shall derive the spec phase — Draft, In review, Approved, Executing, Delivered, Abandoned — from revision and execution state; the phase shall never be directly settable.
2. The spec system shall report Draft while the current revision is editable and not yet proposed, In review while a proposed revision awaits approvals, Approved while an approved revision exists and no execution is active, and Executing while an active execution runs against a pinned revision.
3. The spec system shall move each revision only through Draft → Proposed → Approved or Withdrawn; when a draft revision is proposed, the spec system shall freeze its content for review.
4. A revision shall enter the Approved state only through the revision sign-off transition (Requirement 10), whether that transition is admitted by explicit human sign-off or by a recorded policy gate admission per the active dials.
5. The spec system shall move each execution only through Definition review → Running → Delivered or Abandoned; while Running, an execution shall retain the existing graph-workflow lifecycle behaviors, including halts and repairs.
6. While an execution is active, the spec system shall present Executing as the primary phase with concurrent authoring state (for example a revision in review) always visible as a secondary facet; a pending review or active run shall never be hidden by the projection.
7. The spec system shall report Delivered only when every non-removed criterion of the current approved revision is proven-and-merged or explicitly waived and no delivery is pending; removing a criterion in a later revision shrinks the contract and shall not count as delivering it.
8. Where a revision is delivered entirely through waivers, the spec system shall display that condition explicitly.
9. When changes are proposed against an approved or delivered spec, the spec system shall open a new draft revision whose authoring state shows as Draft until proposed and In review once proposed — subject to the precedence rule of criterion 6 — while existing pins (running executions, merged deliveries) keep pointing at the revisions they used.
10. The spec system shall treat Abandoned as terminal and shall record a reason whenever a spec is abandoned.
11. The spec system shall present partial delivery progress as a roll-up or badge, never as a stored phase.
12. Until a plan-stage revision is approved, spec surfaces shall present the current authoring stage alongside the phase wherever the phase renders.

### Requirement 4: Spec creation entry paths and source provenance
**Objective:** As the operator, I want to start a spec from a prompt, an existing conversation, or a ticket, with exact source provenance, so that intent is captured without creating competing sources of truth.

#### Acceptance Criteria
1. When the `/spec` command is invoked from the composer or the CLI, the system shall begin spec authoring in a conversation and shall create a real spec object from the first successful draft save, visible in Spec Studio from that moment, before content is complete.
2. The spec system shall allow a spec to exist in an incomplete draft state (partial sections) without violating lifecycle rules.
3. When an existing conversation is promoted to a spec, the system shall create the spec with the conversation linked as a source; the conversation shall feed the spec, not become it.
4. The system shall support graduating a ticket into a spec as an entry path (behavior detailed in Requirement 15).
5. When a spec is created by promotion or graduation, the spec system shall capture the exact source versions used — the specific messages and attachment versions, not a link to a mutable container — and that provenance shall survive later edits to the source.
6. The spec system shall maintain exactly one authoritative spec object per spec regardless of entry path.
7. The system shall treat conversations as the spec authoring surface and Spec Studio as the review, approval, and browsing surface (Requirement 8 governs Spec Studio's editing constraints).

### Requirement 5: Unified references, element drill-in, and chips
**Objective:** As the operator, I want one `#` picker across conversations, specs, and tickets with drill-in to spec elements and live reference chips, so that review conversations can cite exact elements and agents can fetch exactly what is cited.

#### Acceptance Criteria
1. When `#` is typed in a prompt input, the composer shall present one unified picker covering conversations, specs, and tickets, grouped by type and type-filterable as the query narrows.
2. The picker shall match specs on slug and name, listing current-project specs before specs from other projects.
3. When a spec is selected, the composer shall insert a spec chip; on submit the chip shall serialize to a `<spec-ref/>` tag the agent receives.
4. When the query continues below a selected spec (`#native-sdd/…`), the picker shall offer that spec's requirements, decisions, and tasks, matched on handle and statement text.
5. When a requirement, decision, or task is selected, the composer shall insert a chip that serializes to the corresponding `<requirement-ref/>`, `<decision-ref/>`, or `<task-ref/>` tag.
6. Spec chips rendered in a transcript shall show the spec name with its current phase, link through to Spec Studio, and offer a hover/peek summary (phase, requirement counts, approval state).
7. Requirement, decision, and task chips rendered in a transcript shall show the slug-qualified handle with the element's statement or label, linking to the exact element in Spec Studio.
8. Spec Studio shall offer a copy-reference control on the spec and on every requirement, decision, and task row; pasting a copied reference into a prompt input shall produce the same chip.
9. The spec system shall record on each reference the revision observed when it was created; when the referenced element has since changed, the chip shall display a changed/stale indicator.
10. A reference shall behave as an address, not an inlined content dump: referenced spec content enters agent context only when the agent resolves it through the agent surface.

### Requirement 6: Agent surface — the `cctl spec` command family
**Objective:** As an agent working in a CC session, I want a typed CLI as the only path to spec state, with machine-readable gate refusals, so that I can operate on specs safely and cannot corrupt or bypass lifecycle state.

#### Acceptance Criteria
1. The spec system shall accept agent reads and mutations of spec state only through the `cctl spec` command family; no supported agent path shall edit spec state directly.
2. The `cctl spec` family shall follow the established CC CLI contract: progressive-disclosure help, a `--json` output envelope, hint/reminder/instruction tiers, typed exit codes, and deterministic local validation before contacting the server.
3. The `cctl spec` family shall provide reads for: spec inventory; bounded outline, summary, canonical rendered, and full artifact views; spec status (phase, the current authoring stage and its concluding gate, gate states, pending approvals, open questions, coverage); single-element retrieval with its approval and evidence state; and text search over requirements and decisions.
4. The `cctl spec` family shall provide writes for: draft-revision content updates, proposing a draft for review, advancing the authoring stage where the governing dial admits it, answering open questions, recording assumptions, evidence-backed task completion claims, and routing approval requests to the human.
5. When a mutation violates the current gate policy, the CLI shall fail with exit status 1, a machine-readable failure code, the specific unmet condition, and an instruction for the legitimate next step.
6. If a task completion claim carries no evidence, or cites an evidence record that does not resolve or does not target a criterion the task covers at the pinned revision, the spec system shall reject the claim.
7. The spec system shall record the actual actor on every mutation as provenance: agent-authored mutations shall record the agent and originating conversation, and human acts shall record the human actor without a fabricated agent or conversation.
8. The `cctl spec` family shall produce a portable, reviewable export of a spec on demand and shall verify a spec's integrity against that representation, so the recoverable-representation invariant is demonstrable user-visible behavior in V1.
9. Every mutating `cctl spec` response shall report the resulting state, the addressing tokens the server assigned, what is blocked and which party must act, and the exact next command; and every schema-backed input the family accepts shall be printable from the CLI (Requirement 24).

### Requirement 7: Concurrent draft authoring
**Objective:** As the operator running parallel conversations, I want element-granular optimistic authoring, so that two agents drafting the same spec never silently lose each other's work.

#### Acceptance Criteria
1. The spec system shall apply draft mutations element-granularly, where each write identifies the element version it read.
2. While two authors write to different elements of the same draft, the spec system shall let both writes proceed independently and make each visible to other viewers and authors as it occurs, without manual refresh.
3. If a write to an element is based on stale content, the spec system shall reject it with a typed conflict carrying the current content, so the writer can reconcile and retry.
4. The spec system shall never resolve concurrent same-element writes by silent last-write-wins and shall not hard-lock draft content.

### Requirement 8: Spec Studio review surface
**Objective:** As the operator, I want a project-scoped surface for browsing, reviewing, and approving specs — with semantic change review, inline comments, evidence and traceability views — so that review happens on structure, not raw diffs.

#### Acceptance Criteria
1. Spec Studio shall be a project-scoped surface and a navigation peer of tickets and conversations, listing specs with phase chips, pending-approval badges, and linked-work roll-ups.
2. The spec detail view shall render prose sections as annotated markdown with inline comments, alongside a structured rail listing requirements, decisions, and tasks with per-item status and approval state, updating as change events occur while agents change the spec.
3. In V1, Spec Studio shall support annotating and approving but not directly editing spec content; content changes shall flow through an agent producing a new draft revision.
4. While a proposed revision is under review, Spec Studio shall present a semantic change list — element-level add/remove/modify with kind-aware summaries — with each change deep-linked to the affected element and carrying inline approve/comment controls; a raw diff shall remain available as a secondary view.
5. Spec Studio shall offer exactly these explicit review actions: Comment (never unfreezes the proposed revision), Request changes (ends the review attempt and opens a draft revision), Approve item, and Sign off revision.
6. The spec system shall persist comment threads across revisions with their original revision and range preserved, re-anchoring a thread only when its anchor can be relocated unambiguously and otherwise presenting it as stale/orphaned — never silently re-attached to changed text.
7. Where bulk approval is used ("approve all requirements", "approve all remaining" at section or revision level), the spec system shall record the same per-element approval state as individual approval.
8. The evidence view shall answer "what proves this?" per acceptance criterion — listing the attached evidence and its verdicts against the criterion's approved validation strategy, or showing that nothing proves it yet — never rolling proof up per task.
9. The traceability view shall present requirement → decision → task → execution → evidence as a navigable graph with lint findings surfaced in place.
10. Spec Studio shall keep the merge-gate and approval controls reachable: the controls surface shall be a primary view of the spec detail, delivery deep links shall resolve to the approving control, and per-criterion delivery state (proven and merged, proof recorded, waived, delivered elsewhere, awaiting proof) shall be computed by the server and rendered without client re-derivation.

### Requirement 9: Deterministic spec lint
**Objective:** As the operator, I want deterministic lint over the typed relationship graph, enforced server-side at transitions, so that structurally broken specs cannot advance. This requirement is the authoritative catalog of V1 lint findings and severities.

#### Acceptance Criteria
1. The spec system shall compute lint findings deterministically from structured spec state, with no agent judgment in V1; semantic checks are excluded from V1.
2. When a draft revision is proposed with no requirement containing at least one acceptance criterion, the spec system shall refuse the proposal with an empty-spec finding.
3. When a plan-stage draft revision is proposed while any acceptance criterion has no covering task or any task covers no acceptance criterion, the spec system shall refuse the proposal with a finding naming the uncovered criterion or task; a proposed revision at an earlier authoring stage shall not be refused for criterion-coverage defects.
4. When a draft revision is proposed while any task traces to no requirement, the spec system shall refuse the proposal with a possible-scope-creep finding naming the task.
5. When a draft revision is proposed while the task dependency graph contains a cycle or a dependency on a removed task, the spec system shall refuse the proposal with a finding naming the defect.
6. When a draft revision is proposed while any internal handle cites a removed or unknown element, the spec system shall refuse the proposal with a finding naming the dangling citation.
7. If a task completion claim is made while any criterion the task covers has no attached evidence, the spec system shall refuse the claim with a status-consistency finding.
8. While a rejected assumption is still cited by spec content, the spec system shall raise a blocking finding that prevents revision sign-off (the sign-off precondition in Requirement 10).
9. The spec system shall raise advisory, non-blocking findings for: an approved element changed in the current draft (approval freshness — feeding invalidation at propose per Requirement 10); a change to an element cited by an approved element (dependency change — the citing element's approval remains valid in V1); open questions still unresolved at propose; and a materialized task removed or re-scoped by an amendment (Requirement 15).
10. The spec system shall present lint findings in a panel on the spec, each deep-linked to its element, updating as the draft changes; a refused propose shall return the same finding list the panel shows.
11. When a draft revision is proposed while the declared lane grouping contracts the task dependency graph into a cycle, the spec system shall refuse the proposal with a finding naming the cyclic groups.
12. The spec system shall raise advisory, non-blocking graph-shape findings, evaluated on the lane-group-contracted graph: a plan of three or more tasks contracting to a single chain of contexts (fully serialized, including a single all-task group); a task covering more than half of the draft's criteria in a plan of three or more tasks; and two tasks in mutually independent contexts declaring overlapping touched file surfaces.
13. When a design-stage revision carries neither a decision nor a design-narrative section, the spec system shall raise one advisory, non-blocking finding on the spec so lint and status do not imply that advancing the stage also supplied design content.

### Requirement 10: Approvals — granular, durable, explicitly signed off
**Objective:** As the operator, I want per-element approvals with an explicit revision sign-off and amendment-scoped invalidation, so that approval always has a clear subject, moment, and author — and survives exactly the changes that don't touch it.

#### Acceptance Criteria
1. The spec system shall record each approval as durable state — subject element, revision granted at, approver, grant time, validity state — attachable independently to a requirement, a decision, a revision, and the execution plan.
2. The spec system shall treat approval records as exclusively human acts and shall record a gate admission for every admitted gated transition naming its basis — human approval (referencing the approval record), Notify policy, or Off policy; a policy admission shall never be recorded as an approval.
3. A revision shall become approved only through the recorded revision-level sign-off transition, with an explicit moment and recorded basis — the signing human, or the admitting policy where the governing dials are Notify or Off; freezing shall never be a side effect of approving the last element.
4. The spec system shall permit the revision sign-off transition only when all blocking comment threads are resolved and no rejected assumption is still cited; where the governing dials require human approval, sign-off shall additionally require the configured element approvals to be in place.
5. When a draft is proposed, the spec system shall classify every element as added, unchanged, modified, or removed; added elements shall remain visibly distinct from edits, approvals on unchanged elements shall carry forward automatically, approvals on modified elements shall become stale with the element-level change shown side by side for re-approval, and approvals on removed elements shall be closed.
6. The spec system shall treat editing a requirement's statement or any of its nested acceptance criteria as modifying that requirement, marking the requirement's approval stale.
7. When any task is added, removed, or re-scoped in a proposed revision, the spec system shall mark the plan approval stale.
8. The spec system shall invalidate approvals only on direct change in V1: a change to an element another element cites shall not invalidate the citing element's approval, raising the dependency-change advisory finding (Requirement 9) instead.
9. When a gate approval is requested, the system shall surface it in Needs You / Active Work with a deep link to the exact decision and fire notifications per the user's settings; granting it shall unblock the waiting agent (observable on its next status read or via a queued-turn nudge).
10. The spec system shall require the plan approval as a sign-off precondition only for a plan-stage proposed revision; requirement and decision approvals shall be required only for the requirements and decisions the proposed revision contains.
11. The gating dials consulted by a proposed revision's propose and sign-off transitions shall be those of the revision's authoring stage and of any earlier stage whose elements the revision modified.

### Requirement 11: Configurable autonomy — presets, per-gate dials, and the floor
**Objective:** As the operator, I want gating to be per-spec policy — a preset plus per-gate dials over a hard floor — so that autonomy matches the work without ever compromising delivery integrity.

#### Acceptance Criteria
1. The spec system shall attach gate policy to the spec as a preset plus optional sparse per-gate overrides; there shall be no project-level policy layer, and an override shall change one dial without leaving the preset.
2. The spec system shall govern five gates — requirements approval, design approval, plan approval, execution start (workflow-definition approval), and delivery/merge — each with a dial of Gate (hard stop, human approval required), Notify (proceeds with the human notified, recorded as a policy gate admission, and surfaced for post-hoc review with correction available through the existing operations — request changes, amendment, abandon), or Off (proceeds freely, still recorded as an admission).
3. Where the contract-bearing preset is active, all five gates shall be Gate.
4. Where the exploratory preset is active, requirements, design, plan, and execution-start shall be Notify and delivery/merge shall be Gate; additionally the spec system shall refuse completion claims and merges outright while the preset is active.
5. Where the fast-path preset is active, requirements, design, and plan approval shall collapse into one combined approval at propose — recorded atomically as all per-element approvals plus the revision sign-off, all together or none — with execution start at Notify and delivery/merge at Gate.
6. The spec system shall enforce, under every preset and override, that every execution pins a (revision, scope).
7. The spec system shall enforce, under every preset and override, that every in-scope criterion reaches merge with valid proof or a human-recorded waiver.
8. The spec system shall enforce the waiver rules of Requirement 14 — human-only, reason-required — under every preset and override.
9. The spec system shall allow the delivery/merge dial to be lowered to Notify but never to Off.
10. When a preset switch or any gate loosening is requested — including on an in-flight spec — the system shall require a hard, non-bypassable human confirmation, applied prospectively only and never retroactively creating approvals.
11. The elicitation layer shall keep question batches and checklists skippable, visible, and prunable.
12. The three authoring gates (requirements, design, plan) shall additionally govern the staged-authoring advance of Requirement 22, under the same dials and overrides, with no separate policy surface.
13. A confirmed policy change shall pin the authoring stage of any open draft revision and shall govern that draft's remaining transitions prospectively, never restaging a proposed or approved revision and never synthesizing approvals or admissions retroactively (Requirement 25); and any surface requesting a policy change shall obtain the required hard confirmation before asserting it.

### Requirement 12: Open questions and assumptions
**Objective:** As the operator, I want open questions and agent assumptions to be first-class records with human disposition, so that unresolved intent is visible and never silently baked into approved content.

#### Acceptance Criteria
1. The spec system shall record open questions as addressable records carrying what is unresolved, their attachment point (spec or element), provenance, and an open → answered lifecycle.
2. The spec system shall record assumptions as addressable records proposed by an agent and disposed by the human as confirmed, rejected, or deferred, attached to the spec or an element.
3. If the disposition of an assumption cited by an already-approved revision changes, the spec system shall require an amendment (a new revision); approved history shall never be mutated.

### Requirement 13: Evidence records and proof verdicts
**Objective:** As the operator, I want typed, resolvable, criterion-level evidence with distinct proof verdicts and fixed freshness rules, so that "what proves this criterion?" always has a verifiable answer.

#### Acceptance Criteria
1. The spec system shall record evidence as append-only, typed records attached at the acceptance-criterion level — commits, test runs, validator verdicts; every evidence kind is machine-produced.
2. The spec system shall accept evidence only as server-resolvable references to objects CC already knows; if a cited reference cannot be resolved, the spec system shall reject the record the same way it rejects a gate violation.
3. The spec system shall record on every evidence record its producer, producing execution, target criterion and revision, and the code/content state it evaluated.
4. The spec system shall treat evidence and proof as distinct: an attached evidence record shall not by itself mark a criterion proven — a proof verdict (deterministic validator or agent validator) under the criterion's approved validation strategy is required; no surface records a human proof verdict, and the human remedy for a criterion that cannot be machine-proven is a waiver (Requirement 14).
5. When cited evidence satisfies the criterion's approved validation strategy, the proof verdict shall be proven; a validator shall never require evidence beyond the approved strategy.
6. If a validator judges the approved validation strategy itself inadequate, it shall raise a finding or open question routed to the human — never unilaterally raise the required standard; changing a validation strategy shall be a spec amendment (a new revision).
7. While an execution runs, the system shall attach lane commits, validator verdicts, and test results automatically to the criteria they prove, stamping each validation result with the lane commit that sealed the tree it validated; a validation superseded by a later iteration before any commit shall be recorded honestly stale.
8. The spec system shall apply fixed, evidence-kind applicability rules to proof freshness — validity rules independent of the autonomy dials.
9. When a merge candidate results from a pure rebase with an identical relevant tree, the spec system shall keep existing proof valid.
10. When a delivery candidate is evaluated, deterministic validators shall rerun against the pre-merge candidate.
11. The spec system shall count commit evidence — and machine validation evidence that records a lane commit but no validated tree — toward delivery only when it resolves into the merge candidate's history.
12. When the evidence-kind vocabulary narrows, the spec system shall migrate persisted state deterministically and traceably: retired kinds are removed from validation strategies (appending the weakest machine-provable kind, with a note recorded in the strategy itself, when none remains), evidence of a retired kind is deleted, proof verdicts citing it are marked stale with the migration named as the reason, and accepted claims citing it are reopened — a criterion's proof obligation is never silently weakened and its proof never silently preserved.
13. The spec system shall retain evidence from an abandoned run as immutable fact that never automatically satisfies a later delivery; a later proof verdict may cite it only when its applicability to that delivery candidate is established.

### Requirement 14: Waivers and criterion dispositions
**Objective:** As the operator, I want per-scope criterion dispositions and human-only waivers, so that every exception to proof is an explicit, attributable decision.

#### Acceptance Criteria
1. The spec system shall track a per-scope disposition for every criterion: in-scope (pending or proven), deferred, waived (pointing at a waiver record), or delivered-elsewhere.
2. The spec system shall record a waiver only as a human act with a required reason, on a (criterion, revision) pair, terminal for that revision; a waiver is not a kind of evidence.
3. The spec system shall let agents and Notify/Off policy request or route a waiver but never grant one.
4. The spec system shall record "not in this delivery" as deferred, never as waived.
5. When a waived criterion changes in a later revision, the spec system shall mark the waiver stale and require a new human decision.
6. The spec system shall accept a delivered-elsewhere disposition only when a successfully merged execution delivered that criterion.

### Requirement 15: Tickets and specs — link, graduate, materialize
**Objective:** As the operator, I want tickets and specs linked with provenance and mirrored by read-through display, so that board views track spec-driven work without duplicated state or sync jobs.

#### Acceptance Criteria
1. The system shall let any ticket link to a spec (optionally to specific requirements or tasks); ticket detail shall show a spec chip with live phase, Spec Studio shall show linked tickets, and both link directions shall be citable as chips in conversation.
2. When a ticket is graduated into a spec, the system shall seed the spec from the ticket's description and attachments as intent input, link both objects with provenance, and leave the ticket a ticket tracking delivery-level status.
3. When spec tasks are approved, the system shall optionally materialize them as linked tickets.
4. If a later amendment removes or re-scopes a materialized task, the linked ticket shall display a source-task-removed/changed state via read-through display, and spec lint shall raise the advisory finding of Requirement 9.
5. Spec-derived displays on a linked ticket — phase chip, criteria progress, linked task status — shall always reflect the current spec state through the link, with no synchronization step that can lag or conflict, and spec-derived state shall never modify ticket-owned fields.
6. The ticket's own lifecycle (open/closed, board column) shall remain ticket-owned; V1 shall ship read-through display only, with no spec-event-driven ticket lifecycle actions.

### Requirement 16: Execution start — pinning, scope validity, one active run
**Objective:** As the operator, I want every run to pin an exact revision and validated scope, immutable for the run's life, so that what a run promises is fixed, honest, and reviewable.

#### Acceptance Criteria
1. When implementation starts, the spec system shall pin an exact (revision, scope) pair, where scope is the selected subset of tasks and criteria the run intends to deliver; partial scope shall be treated as normal, not exceptional.
2. The spec system shall allow at most one active execution per spec in V1, where an execution in Definition review counts as active.
3. If execution start is requested pinning a revision that is not in the Approved state, the spec system shall refuse the transition.
4. When execution start is requested, the spec system shall refuse it unless the selected tasks are dependency-closed.
5. When execution start is requested, the spec system shall refuse it unless every selected criterion has selected task coverage.
6. When execution start is requested, the spec system shall refuse it unless every excluded criterion carries an explicit disposition (deferred, delivered-elsewhere, or waived).
7. If a partial task selection is requested that the plan does not define as a valid smaller unit, the spec system shall reject the selection.
8. While an execution is running, the spec system shall keep its pinned revision and scope immutable; neither shall ever mutate mid-run.
9. When new work is discovered during execution, the spec system shall capture it as a proposed scope amendment on the spec — never a silent expansion of the run; an approved amendment shall queue for a future execution, and if the discovery blocks the current run the supported operation shall be abandon-and-restart.

### Requirement 17: Execution plan compilation and provenance locking
**Objective:** As the operator, I want the approved plan compiled into a standard graph workflow definition with contract content locked to its source, so that the run is reviewable with existing tools and the plan gate cannot be edited away downstream.

#### Acceptance Criteria
1. When an execution is prepared, the spec system shall compile the spec's approved plan into a standard graph workflow definition — task groups become contexts, dependencies become edges, acceptance criteria seed validator briefs, and each lane receives a narrow context pack — not a new artifact class.
2. The generated definition shall be reviewed and edited in the existing graph-workflow surface and validated by the existing workflow machinery.
3. The generated definition shall require its own approval before start, governed by the execution-start dial, and shall carry provenance links from each context back to the spec tasks and criteria it implements.
4. The definition's execution-only choices (isolation, lane grouping, retries, budgets) shall remain freely editable and reviewable; its contract-derived content (pinned revision and scope, task dependencies, task-to-criterion mappings, required validation strategy) shall be provenance-locked — read-only with a source link offering amend-at-source-and-recompile instead of in-place editing.
5. The system shall make the approvable-definition, origin-link, and provenance-locked-region behaviors available to workflow definitions generally, not only to definitions compiled from specs.

### Requirement 18: Scoped delivery and merge gate
**Objective:** As the operator, I want the merge gate to demand exactly what the run promised — read from the spec, never the workflow definition — so that partial delivery is routine and the gate is never trained around.

#### Acceptance Criteria
1. The delivery gate shall read its inputs from the spec's pinned (revision, scope) criteria, never from the workflow definition, so that editing the compiled definition can never weaken what delivery demands.
2. When merge is requested, the delivery gate shall evaluate exactly the criteria selected by the pinned scope — never the whole spec.
3. When the merge gate evaluates an execution, the spec system shall accept a selected criterion only if it is proven by valid proof, validly waived by a human for the pinned revision, or already delivered by an earlier successfully merged execution (shown as satisfied rather than re-demanded).
4. If any selected criterion is in none of the acceptable states of criterion 3, the spec system shall refuse the merge.
5. When the merge gate evaluates an execution, criteria excluded from the pinned scope as deferred shall be listed visibly as out-of-scope without blocking the merge.
6. The spec system shall mark an execution Delivered only after its merge succeeds — not when delivery is requested or approved.
7. When the delivery gate refuses solely because the required human delivery approval is missing, the spec system shall file the durable approval request itself — idempotently for the execution, keyed to the run's pinned revision — so the wait reaches Needs You without an agent action, and the resulting halt shall present as waiting on approval with a deep link to the approving control, distinct from an unmet-criteria failure.

### Requirement 19: Liveness and attention
**Objective:** As the operator, I want spec state changes to behave like every other CC domain — live, typed, and attention-routed — so that no spec surface polls or goes stale.

#### Acceptance Criteria
1. The spec system shall publish a typed event with a stable name for every phase, revision, execution, gate, approval, and evidence change, from day one.
2. Spec status chips and surfaces shall update from published events as they occur, without polling or manual refresh, and shall never retain a stale approval banner.
3. While spec work is in flight, it shall appear in Active Work; while a gate awaits a human, it shall appear in Needs You; and notifications shall fire per the user's settings.

### Requirement 20: Success-test instrumentation
**Objective:** As the operator, I want the §6.1 measures captured from CC's own events from day one, so that the V1 success test is computable when the pilot runs — these counters are cheap now and unreconstructable later.

#### Acceptance Criteria
1. The system shall capture, from CC's retained events from day one, the data behind the §6.1 measures: requirement-caused rework (reopened tasks and non-trivial revisions attributable to missed or changed intent), approval friction (active review time, intervention count, re-approval loops, excluding idle waiting), traceability completeness (share of delivered in-scope criteria reconstructible without transcripts), and automatic evidence capture (share of evidence attached from execution surfaces rather than manually).
2. The captured record shall let an independent reviewer navigate every delivered in-scope criterion from requirement → approved revision → task → changed code → valid proof → merge result without consulting conversation transcripts.
3. The measures shall be computable from CC's own events, with no manual bookkeeping step required during normal operation.
4. The system shall record the measure definitions in use, so the pilot can freeze them before it starts.

### Requirement 21: V1 release acceptance
**Objective:** As the operator, I want the V1 release gated on one real feature shipping through the spine with the enforcement demonstrably working, so that the capability is proven, not assumed.

#### Acceptance Criteria
1. The V1 release shall be accepted only after one real, medium-risk Command Center feature completes the full path from prompt to merged delivery on native spec state, with no manual state edits, no fallback to the Kiro skills, and no transcript used as authority.
2. The release evidence shall demonstrate an independent reviewer navigating every in-scope criterion of that feature from requirement → approved revision → task → changed code → valid proof → merge result, using the capture required by Requirement 20.
3. The release shall include demonstrations of the server refusing each illegal transition: execution start pinning a revision not in the Approved state, a task completion claim without acceptable evidence, and a merge with a selected criterion in no acceptable state.
4. If any illegal transition succeeds, or any out-of-band repair of spec state occurs during the release-acceptance feature, the release test shall fail.

### Requirement 22: Staged authoring discipline
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

### Requirement 23: The plan stage plans the execution graph
**Objective:** As the operator, I want the approved task plan to be the execution-graph plan — authored with lane sizing, ordering truth, parallelism claims, and conflict surfaces in view, and compiled without judgment — so that one reviewed planning act produces workflows that execute well, with no lossy translation step.

#### Acceptance Criteria

1. The spec system shall let each task optionally declare a lane group and the file surfaces it expects to touch, as reviewable plan content whose change stales the plan approval per Requirement 10.
2. When an execution is compiled, tasks sharing a declared lane group shall compile into one shared execution context; tasks without a group shall compile to their own context; compiled contexts shall be titled from their task content, not generic labels; and each context's acceptance criteria shall derive from the union of its member tasks' locked criterion briefs.
3. The compiled definition's charter shall be assembled deterministically from the pinned revision's approved intent sections; compilation shall apply no agent judgment and perform no summarization.
4. Declared lane grouping shall compile as the definition's initial grouping while remaining an execution-only choice per Requirement 17.4, editable in the workflow surface before execution starts without weakening any task's locked contract.
5. The spec system shall evaluate the graph-shape lint findings of Requirement 9 (criteria 11–12) so the plan review presents the execution-graph consequences of the plan.
6. Agent guidance surfaces for plan-stage authoring shall present execution-graph planning explicitly: tasks sized for one agent lane, dependencies as ordering truth, absent cross-lane precedence paths as parallelism claims, and splitting oversized tasks at authoring time (compilation groups tasks but never splits one).
7. Declared touched surfaces shall be carried into the compiled task metadata for use by the workflow surface.
8. Compiled task instructions shall include the approved content of each decision the task traces to.
9. Definition approval and execution start shall validate that the definition's task placement and intra-context order embed every approved task dependency, refusing the transition otherwise; definition editing shall re-derive each affected context's acceptance criteria from its members' locked briefs whenever membership changes.
10. Plan review surfaces — Spec Studio and the CLI reads — shall present each task's dependencies, lane group, touched surfaces, and criterion coverage.
11. Once a spec-origin execution is running, task-to-context placement shall be immutable: a live edit moving a task shall be refused.
12. A task completion claim shall be refused while any of the task's declared intra-context predecessors is incomplete.

### Requirement 24: Agent-surface self-description

**Objective:** As an agent operating native SDD from any repository, I want every mutating `cctl spec` response and every schema-backed input to describe itself — resulting state, assigned addressing tokens, what is blocked and by whom, and the exact next command — so that the surface is usable without reading Command Center's source.

#### Acceptance Criteria

1. Every mutating `cctl spec` response shall report the resulting state of the objects it changed, the addressing tokens the server assigned (element handles, revision, execution, and workflow-definition identifiers), what is blocked together with the party that must act — agent or human — and the exact next command to run.
2. When an element is created or updated through the agent surface, the response shall carry the handle that element now answers to; single-element and full-spec read projections shall carry the handle of every element they return; and an element that has no handle (a section or a number-less element) shall be reported explicitly as having none, with its element identifier labelled as an identifier rather than presented as an address.
3. When the spec system cannot resolve a supplied element address, the refusal shall state the handle format with an example per element kind, and where the supplied value matches a known element identifier the refusal shall name that element's actual handle.
4. The `cctl spec` family shall print, from the CLI itself, the schema of every schema-backed input document it accepts — element write documents by element kind and the execution scope document — with enumerated enum values, field constraints, and a worked example per kind.
5. When an execution is started, the response shall report the execution identifier, the compiled workflow-definition identifier, that no workflow has been launched, the exact command that launches the definition, and which party acts next under the governing execution-start dial.
6. The `cctl spec` status read shall qualify the reported phase with the current execution's state, and while an execution waits in definition review the status shall name that wait, the definition identifier, and the next action rather than reporting an unqualified running phase.
7. When a stage advance is refused because the spec has no open draft revision, the refusal shall name the command that opens a draft and shall state that the approved revision it identifies is immutable.
8. The `cctl spec` family shall provide a first-class command that opens — or returns the already-open — draft revision of an approved spec; the authoring-amendment path shall not be discoverable only as a side effect of another command's description.
9. Help for the authoring-amendment command and for the execution-time scope-capture command shall each state which amendment it performs and shall name the other, so the two are not confusable.
10. The `cctl spec` help shall state that gate policy is per-spec data, mutable, a human-only act performed in Spec Studio, and changed by no CLI verb.
11. Guidance surfaces shall describe the actual scope of spec search: while search is spec-scoped, both the runtime `/spec` expansion and the repository guidance document shall describe it as spec-scoped, and an automated check shall fail when the two surfaces disagree.
12. The spec system shall define and document the ordering contract of element position — one global order per revision with a declared tiebreak, with parent nesting derived from the parent element and never from position — and the authoring surfaces shall state the same contract the repository enforces.
13. Where a gate's state is computed against the current revision only, the status read and Spec Studio shall additionally present each prior admission's provenance — the revision it was admitted on, its basis, and its actor — as history, without asserting that the admission still satisfies the gate for the current revision.
14. New or changed agent-facing query disclosure levels shall emit concise text by default; `--json` shall serialize the same disclosure level and shall never widen a bounded read into a full payload. The existing `workflow status --json` and `spec status --json` projections are explicitly recorded migration debt: their text views are bounded while their structured views still carry every row, and no new surface shall copy that exception.
15. `cctl spec show <slug>` shall default to a bounded current-revision outline that nests each acceptance criterion beneath its requirement and carries stable handles, per-element status, collection totals, returned counts, and truncation state; `--summary` shall remain counts-only; every show success shall discriminate `storage` as `inline` or `artifact`; and `--rendered` and `--full` shall write their unbounded content to a file and return an artifact receipt with path, format, byte count, and content hash.
16. Every `spec show` success shall remain under the 60 KiB stdout budget in text and JSON modes. If an otherwise-inline summary or outline would reach that budget, the CLI shall write the exact inline JSON envelope to a file and return a bounded `storage: "artifact"` receipt with `reason: "stdout_budget_exceeded"`; every bounded read that omits data shall state what was omitted and name the exact command that reveals the next useful level; and a full or rendered spec shall never be emitted through stdout.
17. The CLI shall publish an offline read-envelope reference that names each command's payload field and documents revision roles: `baseRevision` is the current revision's immediate `basedOnRevisionId` parent, `currentRevision` is the lineage head regardless of state, and `currentApprovedRevision` is the latest approved revision regardless of whether it is that head's ancestor.
18. The canonical Markdown renderer used by export, pinned lane documents, and rendered reads shall traverse a parent before its children so an acceptance criterion stays adjacent to its requirement even when it was appended later in the revision's global storage order; the bundle format shall identify that byte-level rendering contract.

### Requirement 25: Policy-change staging semantics and action authority

**Objective:** As the operator, I want a confirmed policy change to have stated, prospective consequences for an open draft — and irreversible spec-level acts to be mine alone — so that autonomy changes never strand authored content, never manufacture approvals, and never happen without a confirmation I actually saw.

#### Acceptance Criteria

1. When a policy change is confirmed while a draft revision is open, the spec system shall pin that draft's authoring stage: the stage shall never move backward, and the policy change shall never advance it.
2. Following a confirmed policy change, the newly confirmed dials shall govern the open draft's remaining transitions, with propose and sign-off consulting the new policy under the stage-scoped rule of Requirement 10.11.
3. A policy change shall never create an approval or a gate admission for a transition that already occurred.
4. A policy change shall never restage a proposed, approved, or withdrawn revision.
5. The change-policy response and the `cctl spec` status read shall present the authoring stage sequence remaining for the current draft together with the gate that concludes each remaining stage under the new policy.
6. If the staged consequences of a requested policy change cannot be specified decision-completely for that policy shape, the spec system shall refuse the change while a draft revision at a wider authoring stage is open, naming the open draft and instructing the operator to resolve it first.
7. The spec system shall treat abandoning a whole spec as a human act: a request from agent transport shall be refused as human-act-required with an instruction naming the human surface, and the agent's supported path shall be to raise the proposal as an open question.
8. The spec system shall keep abandoning the active execution reachable from the agent surface with its required reason.
9. Any surface requesting a policy change shall present the hard confirmation whenever the server requires one for that change and shall assert a confirmed change only from that confirmation's explicit accept action; whether the change loosens gates shall govern the warning content only, never whether the confirmation appears.
10. The spec system shall record on every confirmed policy change the acting human, the previous policy, the resulting policy, and the pinned authoring stage of any open draft, so a later reviewer can determine which dials governed which transition.
