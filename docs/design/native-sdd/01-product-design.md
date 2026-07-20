# Native SDD — Product-Level Design

| Field | Value |
|---|---|
| Status | Rev 5 — collaboration-review package applied 2026-07-17 (approved; V1 thinning option declined — full scope retained); V1 success test defined (§6.1); no open items |
| Date | 2026-07-17 |
| Stage | Product behavior + domain model (pre-technical-design) |
| Inputs | `docs/reports/native-sdd-collaboration-proposals.md`, session charter, decision batches 2026-07-16/17, collaboration review 2026-07-17 (run bd6c3062) |

This document makes the native SDD proposal concrete at the product level: the behaviors users
and agents experience, and what those behaviors demand of the domain model. It deliberately stops
short of technical design — no storage decisions, schemas, API shapes, or component architecture.
Each behavior section ends with a **Domain-model implications** note: the constraint the behavior
places on the model we design next.

Naming ("spec", "Spec Studio", `cctl spec`) is deliberately working vocabulary; final naming is
deferred until the domain model is drafted (decided 2026-07-16).

## 1. Product stance

A spec is a **first-class, durable product object** — like a conversation, ticket, or workflow —
not a set of markdown files a skill happens to write. It is addressable everywhere CC has an
addressing surface (references, autocomplete, deep links, CLI), observable everywhere CC has a
liveness surface (status chips, SSE, Active Work, Needs You), and enforceable at the server (gates
are state transitions the server refuses, not prompt etiquette).

The lifecycle spine: intent → review → enforced approval → reviewed execution plan → isolated
execution → criterion-level evidence → controlled delivery. **V1 ships this whole loop** (decided
2026-07-16): authoring/review core plus execution compilation and evidence flow-back, not
authoring alone.

## 2. Objects and vocabulary (product level)

- **Spec** — the durable object. Owned by a project. Has a stable identity, a human-readable
  name/slug, a lifecycle phase, and a set of revisions.
- **Revision** — one version of the spec's content. Draft revisions are editable; an approved
  revision is immutable. "The spec changed after approval" always means "a new revision exists."
- **Sections** — the prose narrative: intent (problem, outcomes, non-goals, success measures,
  constraints), design narrative, and any free-form context. Prose-first, markdown, reviewed
  inline.
- **Requirement** — an individually addressable unit inside a spec: statement, acceptance
  criteria, priority/risk, a derived status (a projection of coverage, approval, and evidence
  state — never stored as a second truth), and its own approval. Requirement IDs are stable
  across revisions (editing a requirement's text does not change its identity; `R3` is `R3`
  forever).
- **Acceptance criterion** — an addressable sub-element of a requirement (`R3.2` = criterion 2
  of requirement 3), not free text and not an independent top-level entity. Criteria are the
  atomic unit of proof: tasks declare which criteria they cover, evidence attaches to criteria,
  and delivery gates evaluate criteria. They live inside their requirement (approved with it,
  revised with it) but carry stable identity so coverage and evidence can key on them.
- **Decision** — an individually addressable design decision (chosen approach, rejected
  alternatives, reason). Same stability rule as requirements.
- **Task** — a plan item that traces to one or more requirements and declares the set of
  acceptance criteria it covers (e.g. `T7 covers R3.1, R3.2, R5.1`). Task work status derives
  from the task's own execution events and completion claim (with its evidence) — never from the
  dispositions of the criteria it covers. Tasks and criteria are many-to-many and record
  different facts: work done is not criterion proven, and a criterion can be proven by another
  task's evidence.
- **Approval** — durable, granular state attached to a requirement, decision, revision, or plan:
  who, when, and at which revision. An approval is always a **human act**; transitions admitted
  by policy are recorded as gate admissions (below), never as approvals.
- **Gate admission** — the record of what admitted a lifecycle transition: human approval,
  Notify policy, or Off policy (B8). Distinct audit meaning from an approval.
- **Evidence record** — an append-only, typed fact attached at the acceptance-criterion level:
  diffs, commits, test runs, validator verdicts, screenshots, human sign-offs. Machine kinds are
  **server-resolvable references** to objects CC already knows (a commit in the session
  worktree, an actual validator run, a real capture) — an unresolvable reference is rejected the
  same way a gate violation is. Every record carries its producer, producing execution, target
  criterion and revision, and the code/content state it evaluated.
- **Proof verdict** — the determination (deterministic validator, agent validator, or human
  judgment) that cited evidence satisfies a criterion under its approved validation strategy.
  Evidence existing is not a criterion being proven.
- **Criterion disposition** — the per-scope delivery-evaluation state of a criterion: in-scope
  (pending or proven), deferred, waived (pointing at a waiver), or delivered-elsewhere (B10).
- **Waiver** — a human-only, reason-required exception recorded on (criterion, revision) —
  terminal for that revision, and not a kind of evidence. Executions reference it through the
  criterion disposition. Agents and Notify/Off policy can request or route a waiver but can
  never grant one. "Not in this delivery" is `deferred`, not waived; changing a waived criterion
  in a later revision stales the waiver and requires a new human decision.
- **Open question** — a first-class, addressable record (`native-sdd/Q2`): what is unresolved,
  where it attaches (spec or element), provenance, lifecycle open → answered.
- **Assumption** — a first-class, addressable record (`native-sdd/A1`): proposed by an agent,
  disposed by the human (confirmed / rejected / deferred), attached to the spec or an element.
  A **rejected** assumption still cited by spec content blocks revision sign-off (B6 lint); if
  the citing revision is already approved, changing the disposition requires an amendment —
  approved history is never mutated.
- **Execution** — a run that pins an exact (revision, scope) pair. Separate lifecycle from
  authoring; one revision can have many executions over time (**one active execution per spec in
  V1** — decided 2026-07-16). Scope = the selected subset of tasks/criteria this run intends to
  deliver.
- **Links** — provenance-bearing relationships to existing domains: tickets, conversations,
  sessions/worktrees, workflow executions, merge jobs. Linked, never merged into one mega-entity.

**Handles** (decided 2026-07-16): slug-qualified short handles — `native-sdd/R3`,
`native-sdd/R3.2`, `native-sdd/D2`, `native-sdd/T7`, and (rev 5) `native-sdd/Q2`,
`native-sdd/A1`. Per-spec counters, globally unambiguous via the slug qualifier; bare handles
(`R3`) are valid shorthand inside an unambiguous spec context.

**Domain-model implications:** stable sub-spec identities (requirement/criterion/decision/task)
that survive revision changes; approvals and evidence keyed to those identities plus a revision;
a spec/revision split where immutability is a hard property of approved revisions; criterion
identity nests under its requirement; questions, assumptions, waivers, proof verdicts, and gate
admissions are addressable records under the same identity discipline; evidence is typed
references carrying producing execution and evaluated content state.

## 3. Affirmed invariants (product requirements)

The six storage-neutral invariants from the proposal report are **affirmed as product
requirements** (decided 2026-07-16). The domain model must satisfy them regardless of the
eventual storage choice, which remains deferred:

1. Spec and revision identity is stable and worktree-neutral.
2. Approved revisions are immutable and tamper-evident.
3. Every execution pins an exact revision and scope.
4. Approval, review, evidence, and run state are worktree-neutral.
5. Each concern has one authoritative representation; no silent bidirectional synchronization.
6. A portable, reviewable, recoverable repository representation or export always exists.

## 4. Lifecycle phases (decided 2026-07-17)

Product-level state enumeration. Phases are what users see on chips; the domain-model stage will
formalize the transitions.

**Spec phase** (derived from revision + execution state, never set directly):

| Phase | Meaning |
|---|---|
| Draft | Current revision editable; not yet proposed |
| In review | A revision is proposed; approvals pending |
| Approved | An approved revision exists; no active execution |
| Executing | An active execution runs against a pinned revision |
| Delivered | Every non-removed criterion of the current approved revision is proven-and-merged or explicitly waived, and no delivery is pending. Removal shrinks the contract — it is not delivery. A revision delivered entirely by waivers is legal but displayed as such |
| Abandoned | Closed without delivery (terminal, with reason) |

Amendment cycles are normal: proposing changes to an approved or delivered spec creates a new
draft revision and returns the spec to Draft/In review, while existing pins (running executions,
merged deliveries) keep pointing at the revisions they used.

Authoring and execution states coexist, so the phase is a **composite projection** with a
documented precedence, not a mutually exclusive enum (rev 5): while an execution is active,
`Executing` is the primary chip and concurrent authoring state is always shown as a secondary
facet — e.g. `Executing rev 3 · rev 4 in review · 7/12 criteria delivered`. A pending review or
active run is never hidden. Partial delivery is a roll-up/badge, not a stored phase.

**Revision state**: Draft (editable) → Proposed (content frozen for review; semantic change list
generated) → Approved (immutable, entered only by the explicit sign-off — B7) or Withdrawn.
Review actions are explicit (rev 5): **Comment** leaves the proposed revision frozen — an
annotation never thaws the review target; **Request changes** ends the review attempt and opens
a draft revision; **Approve item** records an element approval; **Sign off revision** is allowed
only when the configured approvals are in place, blocking comment threads are resolved, and no
rejected assumption is still cited (B6 lint).

**Execution state**: Definition review (generated workflow definition awaiting approval per the
execution-start dial) → Running (the existing graph-workflow lifecycle, including halts and
repairs) → Delivered or Abandoned. An execution in Definition review counts as the active
execution for the one-active-per-spec rule (B10), so definitions cannot queue against
conflicting revisions. Delivered is entered only after the merge succeeds — not when delivery is
requested or approved.

**Domain-model implications:** spec phase is a projection, not stored state, and the composite
projection's precedence rule is part of the product contract; revision and execution own the
real state machines; every transition is a publishable event.

## 5. Behaviors

### B1. Spec identity and addressing

Every spec is addressable by a per-project slug (e.g. `native-sdd`), the way tickets have
per-project IDs. Sub-parts use the slug-qualified handles from §2. These handles appear in the
UI, in reference chips, in `cctl` output, in workflow briefs, and in evidence — one vocabulary
everywhere.

Every spec, requirement, decision, and task has a deep link that opens Spec Studio scrolled to
that element.

**Domain-model implications:** per-project slug namespace where renames leave aliases — copied
references and deep links keep resolving; short-handle grammar that parsers, autocomplete, and
deep links all share.

### B2. Ways a spec comes into existence

- **From a prompt**: a `/spec` command (composer and CLI) starts spec authoring in a conversation.
  The agent elicits and drafts; the draft is a real spec object from the first save, visible in
  Spec Studio while still rough.
- **From an existing conversation**: "promote to spec" takes the conversation as intent input and
  links it as a source. The conversation does not become the spec — it feeds it.
- **From a ticket**: a ticket graduates into a spec (B9). The ticket stays a ticket, linked with
  provenance.

Promotion captures the **exact source versions** used — the specific messages and attachment
versions, not a link to a mutable container (the ticket system's snapshot-attachment precedent).
Source provenance must survive later edits to the source.

There is always exactly one authoritative spec object regardless of entry path. The existing
Kiro skills and `.kiro/specs` files are out of scope: they remain untouched, and native SDD does
not import from or write to them.

**Authoring home** (decided 2026-07-16): spec authoring happens in normal conversations; Spec
Studio is the review, approval, and browsing surface, not a second composer.

**Domain-model implications:** specs must be creatable in an incomplete state (draft phase with
partial sections) without violating lifecycle rules; source links (conversation, ticket, document)
are first-class provenance.

### B3. Spec references and autocomplete in prompt inputs

**Decided 2026-07-16: the existing `#` mention becomes a unified multi-type picker** —
conversations, specs, and tickets in one trigger, results grouped by type and type-filterable as
the query narrows. On top of that:

- Specs match on slug/name, scoped to the current project first.
- Selecting inserts a **spec chip**; on submit it serializes to a `<spec-ref …/>` tag the agent
  receives.
- Chips render in the transcript as live links: spec name + phase chip, click-through to Spec
  Studio. Peek/hover shows a summary (phase, requirement counts, approval state).
- Paste-to-chip: pasting a copied spec reference (from Spec Studio's copy-reference button) turns
  into the same chip, exactly like conversation/message refs today.
- The agent resolves a `<spec-ref/>` by reading the spec through `cctl spec` (B5) — the reference
  is an address, not an inlined dump. Context stays small until the agent pulls what it needs.

**Domain-model implications:** none beyond B1 identity; this is leverage on the existing ref
system (`<ticket-ref/>` already sets the multi-type precedent).

### B4. Requirement-level references and autocomplete

References drill below the spec:

- In the unified picker, selecting a spec then continuing to type (`#native-sdd/…`) offers its
  requirements, decisions, and tasks — matched on handle and statement text.
- A requirement chip (`native-sdd/R3 — "Approved revisions are immutable"`) serializes to a
  `<requirement-ref …/>` tag (similarly `<decision-ref/>`, `<task-ref/>`).
- Every requirement/decision/task row in Spec Studio has a copy-reference button (the
  message-level copy-reference pattern); pasting anywhere yields the chip.
- A reference records the revision observed when it was created; chips render live state with a
  **changed/stale indicator** when the element has since been revised.
- This makes review conversations precise: "I think `#native-sdd/R3` conflicts with `R7`" is
  addressable by both the human and the agent, and the agent can fetch exactly those two
  requirements rather than the whole spec.

**Domain-model implications:** requirement/decision/task lookup by handle must be cheap and
stable; references must survive revisions (a ref points at the identity, and resolution says
which revision you're seeing and whether it changed since the ref was made).

### B5. Agent surface: the `cctl spec` command family

Agents never edit spec state directly (no spec.json edits, no direct DB writes). All reads and
mutations go through a typed `cctl spec` family following the established CLI contract
(progressive-disclosure help, `--json` envelope, hint/reminder/instruction tiers, exit codes,
deterministic local validation before network).

Read verbs (illustrative, not final):

- `cctl spec list` / `cctl spec show <slug>` — inventory and full/summary views.
- `cctl spec status <slug>` — phase, gate states, pending approvals, open questions, coverage.
- `cctl spec get <slug>/R3` — one requirement/decision/task with its approval + evidence state.
- `cctl spec search <slug> <query>` — find requirements/decisions by text.
- `cctl spec export <slug>` / `cctl spec verify <slug>` — produce and integrity-check the
  portable, reviewable representation invariant 6 promises. The format is technical design; the
  behavior is V1 — an affirmed invariant with no user-visible behavior is a promise the product
  cannot demonstrate.

Write verbs (illustrative):

- `cctl spec draft …` — create/update draft-revision content (sections, requirements, decisions,
  tasks) while in an editable phase.
- `cctl spec propose <slug>` — submit a draft revision for review; produces the semantic change
  summary reviewers see (B6).
- `cctl spec answer …` / `cctl spec assume …` — resolve open questions, record assumptions for
  human confirm/reject.
- `cctl spec task complete <slug>/T7 --evidence …` — record a **work-completion claim** with
  typed evidence; bare claims and unresolvable evidence references are rejected. A claim does
  not itself prove the covered criteria — proof verdicts are per criterion (§2, B10).
- `cctl spec request-approval <slug> …` — route a gate to the human (B7). Agents request;
  only humans approve.

Gate enforcement is the contract's teeth: a mutation that violates the current gate policy fails
with exit 1, a machine-readable `code` (e.g. `gate_blocked`), the specific unmet condition, and an
instruction for the legitimate next step. An agent cannot mark implementation complete on an
unapproved revision — not "shouldn't," cannot.

Draft mutations use **element-granular optimistic concurrency** (rev 5): a write identifies the
element version it read; writes to different elements proceed independently and are visible live
via SSE; a same-element write based on stale content fails with a typed conflict carrying the
current content, so the agent can reconcile and retry. No hard locks, and no silent overwrite —
two conversations drafting the same spec is the normal CC condition, not an edge case, and
last-write-wins would silently discard durable work.

**Domain-model implications:** every lifecycle transition needs a server-side validity predicate
(state machine semantics at the domain level); mutations carry actor identity (which agent,
which conversation) for provenance; evidence is a required parameter of completion transitions,
not an afterthought — typed, resolvable references with producing execution and evaluated
content state; draft writes are element-granular and version-checked.

### B6. Spec Studio: viewing and reviewing

A project-scoped surface for specs (peer of tickets/conversations in navigation):

- **Spec list** — specs with phase chips, pending-approval badges, linked-work roll-ups.
- **Spec detail** — prose sections rendered as annotated markdown with inline comments (the
  existing document-feedback machinery); a structured rail listing requirements, decisions, and
  tasks with per-item status and approval state; live status via SSE (an agent updating the spec
  is visible in real time, like every other CC surface).
- **Review, not editing** (decided 2026-07-16): in V1 the human annotates and approves; content
  changes always flow through an agent producing a new draft (comment → agent revises →
  re-approve). Direct human editing of spec content is a later addition.
- **Review mode** — when a revision is proposed, the reviewer sees a **semantic change list**
  ("R3 criteria tightened", "R9 removed", "D2 reversed", "new tasks T11–T13"), not a raw line
  diff; each change links to the affected element with approve/comment controls inline. Raw diff
  remains available as a secondary view.
- **Per-item and bulk approval** — approve a single requirement or decision from its row or from
  the review flow, or approve in bulk: "approve all requirements" / "approve all remaining" at
  the section and revision level. Bulk approval records the same per-element approval state as
  individual approval — it is a UI affordance, not a different (coarser) kind of approval, so
  later amendments still invalidate only the elements they touch (B7).
- **Evidence view** — for each acceptance criterion: what proves it (diff hunks, test runs,
  validator verdicts, screenshots), or "nothing yet." The completion question is always "what
  proves this?", answered per criterion, not per task.
- **Traceability view** — requirement → decision → task → execution → evidence as a navigable
  graph, with lint findings (below) surfaced in place.

#### Spec lint

Linting is deterministic checking of the typed relationship graph — no agent judgment involved.
Because requirements, criteria, tasks, and their links are structured state, these are plain
computations:

| Check | Finding | Severity |
|---|---|---|
| Spec has ≥ 1 requirement with ≥ 1 criterion | "Empty spec — nothing to review" | Blocks `propose` |
| Every criterion is covered by ≥ 1 task | "R3.2 has no covering task" | Blocks `propose` |
| Every task traces to ≥ 1 requirement | "T9 traces to no requirement — possible scope creep" | Blocks `propose` |
| Task dependency graph is acyclic and complete | "T4 → T7 → T4 cycle", "T5 depends on removed T2" | Blocks `propose` |
| Internal handles resolve | "D2 cites R9, which was removed in this draft" | Blocks `propose` |
| Approval freshness | "R3 changed since its approval" (feeds B7 invalidation) | Advisory |
| Status consistency | "T7 marked complete but R3.2 has no evidence" | Blocks completion claim |
| Rejected assumptions are not cited | "A2 was rejected but D4 still cites it" | Blocks sign-off |
| Open questions before propose | "2 open questions unresolved" | Advisory |

Findings appear in a lint panel on the spec (each deep-linked to its element) and update as the
draft changes. `cctl spec propose` runs the blocking set server-side and refuses with the finding
list on failure — the same list the UI shows. Semantic checks (non-goal leakage into the plan,
terminology drift, contradicting sources) are agent-judgment work and deliberately out of V1;
the deterministic table above is the V1 linter.

**Domain-model implications:** the model must support semantic diffing between revisions
(element-level add/remove/modify with kind-aware summaries); inline comments anchor to elements
and prose ranges — unresolved threads stay visible across revisions with their original
revision/range preserved, re-anchored only when safely recoverable and otherwise presented as
stale/orphaned, never silently re-attached to changed text; lint rules are pure functions over
the relationship graph, shared by UI and CLI enforcement.

### B7. Approvals: granular and durable

- Approvals attach to individual requirements and decisions, to a revision as a whole, and to
  the execution plan — each independently. Bulk approval (B6) writes the same per-element state.
- **Explicit revision sign-off** (decided 2026-07-16): element approvals accumulate individually
  or in bulk, but the revision becomes approved-and-immutable only through a recorded
  revision-level sign-off. Freezing is never a side effect of approving the last element — it
  has a clear, auditable moment and author. Sign-off additionally requires resolved blocking
  comment threads and no rejected-cited assumptions (§4, B6 lint).
- **Approval is a human act** (rev 5): a transition that proceeds under a Notify or Off dial
  records a **gate admission** naming the admitting policy — never an approval. The fast-path
  combined approval (B8) is atomic: all element approvals plus the revision sign-off are
  recorded together, or none are.
- **Amendment-scoped invalidation**: approvals are invalidated only by changes to the element
  they cover. Concretely: an approval records which element it covers and the revision it was
  granted at. When a draft is proposed, the semantic change set (B6) classifies every element as
  unchanged, modified, or removed. Approvals on unchanged elements carry forward automatically;
  approvals on modified elements flip to **stale** (re-approval needed, with the element-level
  change shown side by side); approvals on removed elements are closed. What can be invalidated:
  per-requirement approvals (statement or criteria edited), per-decision approvals, and the plan
  approval (any task added/removed/re-scoped flips it). In V1, invalidation is strictly
  direct-change; "R3 changed and D2 *cites* R3" does not auto-invalidate D2's approval — it
  surfaces as the advisory lint finding instead. Dependency-propagated invalidation is the later
  change-impact feature.
- Approvals route through the existing attention machinery: a requested gate appears in Needs
  You / Active Work with a deep link to the exact decision; notifications fire per the user's
  settings. Approving from that surface unblocks the waiting agent (which sees the gate open via
  its next `cctl spec status`, or is nudged by the queued-turn mechanism).

**Domain-model implications:** approval is a record (subject element, revision granted at,
approver, validity state), not a boolean; invalidation is computed from element-level change
sets — another reason semantic diffs are a domain-model primitive; revision sign-off is its own
event, distinct from element approvals.

### B8. Configurable autonomy and gating

Gating is policy, not hardcoded workflow, and follows CC's cascading-configuration pattern — the
same shape as graph workflows, where a value set at the workflow level can be overridden per
context. Here the cascade is two levels: **preset at the spec level, per-gate override on any
individual gate.** There is no project-level policy layer.

Five gates, each with a dial: **Gate** (hard stop; human approval required), **Notify** (agent
proceeds; human notified, can review/revert post-hoc; recorded as a policy **gate admission**,
distinct from a human approval — §2), **Off** (transition free, still recorded as an admission).

#### Preset → dial matrix (decided 2026-07-17)

| Gate | Contract-bearing | Exploratory | Fast-path |
|---|---|---|---|
| Requirements approval | Gate | Notify | Combined Gate¹ |
| Design approval | Gate | Notify | Combined Gate¹ |
| Plan approval | Gate | Notify | Combined Gate¹ |
| Execution start (= workflow-definition approval, B10) | Gate | Notify | Notify |
| Delivery / merge | Gate | Gate² | Gate |

¹ Fast-path collapses requirements, design, and plan into **one combined approval** at
`propose` — a single human decision covers all three, recorded as per-element approvals plus the
revision sign-off in one **atomic** act: all recorded together, or none.
² Exploratory additionally refuses completion claims and merges outright while the preset is
active: spikes and prototypes run freely, but nothing exploratory ships. Switching the preset is
itself a gated action.

**Floor** (decided 2026-07-16; sharpened rev 5) — no preset or override can go below: executions
always pin (revision, scope); every in-scope criterion reaches merge with valid proof or a
human-recorded waiver — waivers are never grantable by agents or by policy; the delivery/merge
dial can be lowered to Notify but never Off.

The preset supplies the five dial values; an override changes one dial without leaving the
preset. Switching presets or loosening any gate — including on an in-flight spec — is always a
hard, non-bypassable human confirmation: prospective-only, and never retroactively creating
approvals. The elicitation layer obeys the same dial philosophy: question batches and checklists
are skippable, visible, and prunable — the complexity budget from the proposal.

**Domain-model implications:** gate policy is data attached to the spec (preset + sparse
overrides, resolved the way workflow cascades resolve), consulted by the same transition
predicates B5 enforces; every transition records *which* policy admitted it (human approval vs.
policy auto-admit) so post-hoc review is possible.

### B9. Tickets and specs

Tickets and specs stay distinct objects with linked lifecycles:

- **Link** — any ticket can link to a spec (and optionally to specific requirements/tasks).
  Ticket detail shows a spec chip with live phase; Spec Studio shows linked tickets. The existing
  `<ticket-ref/>` and new `<spec-ref/>` chips make the links citable in conversation.
- **Graduate** — "promote ticket to spec" creates a spec seeded from the ticket (description and
  attachments become intent input), links both ways, and leaves the ticket tracking
  delivery-level status.
- **Materialize** — approved spec tasks can optionally materialize as linked tickets (the
  start-work pattern the ticket system already has), so board views can track spec-driven work
  without duplicating state. If a later amendment removes or re-scopes a materialized task, the
  ticket (whose lifecycle stays ticket-owned) shows "source task removed/changed" via the same
  read-through display, and spec lint raises an advisory finding.
- **Mirroring is read-through, not synchronization.** The ticket persists only the link. Every
  spec-derived thing the ticket UI shows — phase chip, "7/12 criteria proven" progress, linked
  task status — is read from the spec through the link at query time. Nothing spec-derived is
  written into ticket fields, so there is no sync job, no staleness, and no conflict when both
  sides move. The ticket's own lifecycle (open/closed, board column) remains ticket-owned and
  human/agent-driven as today. If we later want spec events to advance ticket lifecycle
  (e.g. auto-close on delivery), that is an explicit, provenance-recorded system action on the
  ticket — an actor making a normal ticket mutation in response to an event, not a hidden sync.
  V1 ships read-through display only.

**Domain-model implications:** links carry direction and provenance (graduated-from,
materialized-from, references); spec-derived display state on tickets is always computed via the
link — one owner per concern.

### B10. From spec to execution (in V1 scope)

Execution compilation ships in V1 (decided 2026-07-16):

- Starting implementation **pins an exact (revision, scope)**: which revision, which tasks and
  criteria this run delivers. Partial scope is normal, not exceptional. **One active execution
  per spec in V1** (decided 2026-07-16), where Definition review counts as active (§4);
  concurrent disjoint-scope executions are a later extension.
- **Scope is validated deterministically at start** (rev 5): selected tasks are
  dependency-closed; every selected criterion has selected task coverage; every excluded
  criterion carries an explicit disposition (deferred, delivered-elsewhere, waived); partial
  task selection is rejected unless the plan defines a valid smaller unit.
- **The execution plan is a graph workflow definition — not a new artifact.** "Projection" means
  generation: the spec's approved plan (tasks, dependencies, criteria) is compiled into a
  standard workflow definition (task groups → contexts, dependencies → edges, acceptance
  criteria → validator briefs, narrow per-lane context packs). It is reviewed and edited in the
  existing graph-workflow UI and validated by the existing machinery; native SDD adds an
  approval state on the definition before start and provenance links from each context back to
  the spec tasks/criteria it implements. The definition carries two kinds of content (rev 5):
  **execution-only choices** (isolation, lane grouping, retries, budgets) remain freely editable
  and reviewable as today; **contract-derived content** (pinned revision/scope, task
  dependencies, task-to-criterion mappings, required validation strategy) is
  **provenance-locked** — read-only with a source link, offering "amend at source and recompile"
  instead of in-place editing. If approved-plan content were editable during a run, the plan
  gate would be decorative. All three additions are general workflow capabilities (approvable
  definitions, origin links, provenance-locked regions with an upstream owner), not spec-only
  special cases — consistent with the standing rule that workflow features stay general.
- Approving the spec is not the same as approving the run: the generated definition carries
  execution-only decisions (isolation, lanes, retries, budgets) the spec never contained, which
  is why it gets its own review (the execution-start dial in B8).
- Evidence flows back automatically to the criterion level: lane commits, validator verdicts,
  test results, and screenshots attach to the criteria they prove — as typed evidence records
  (§2) carrying the producing execution and evaluated content state.
- **Proof freshness follows fixed, evidence-kind applicability rules** (rev 5) — validity rules,
  not an autonomy dial (B8 dials govern human admission, never whether stale evidence counts):
  a pure rebase with an identical relevant tree does not stale proof; cheap deterministic
  validators rerun against the pre-merge candidate (the existing pre-merge validation
  machinery); commit/diff evidence must resolve into the candidate's history; non-deterministic
  evidence (screenshots, human sign-offs) records its captured surface and stales when that
  surface changes — then it is revalidated, recaptured, or explicitly waived. Evidence from an
  abandoned run remains an immutable fact but never automatically satisfies a later delivery; a
  later proof verdict may cite it only if applicability to that candidate is established, and
  `delivered-elsewhere` requires a successfully **merged** execution.
- A started execution's pin is **immutable for the life of the run** — neither revision nor
  scope ever mutates mid-run. Newly discovered work during execution becomes a **proposed scope
  amendment** on the spec — never silent expansion of the run. An approved amendment queues for
  a future execution; if the discovery genuinely blocks the current run, the honest operation is
  abandon-and-restart.
- **Delivery gates are scoped to what the run promised — and read the spec, never the workflow
  definition.** The gate's inputs are the spec's pinned (revision, scope) criteria; editing the
  compiled definition can therefore never weaken what delivery demands (rev 5). The merge gate
  asks "is everything this execution's scope selected proven?" — not "is the whole spec done?".
  Example: a spec has
  criteria R1.1–R5.2 (12 total); execution A pinned scope covers R1–R3 (criteria R1.1–R3.2);
  R4–R5 are deferred to a later run. At merge time the gate requires evidence for R1.1–R3.2
  only; the deferred criteria are visibly listed as out-of-scope but do not block. Likewise a
  criterion the human explicitly waived (with reason, recorded on the spec) does not block, and
  one already delivered by an earlier merged execution is shown as satisfied rather than
  re-demanded. Without this scoping, "all spec criteria complete" would block every partial
  delivery — the routine case — and the gate would train the user to bypass it.

**Domain-model implications:** (revision, scope) is the execution's identity anchor, immutable
for the run's lifetime; scope is a first-class selection object with a deterministic pre-start
validity predicate; evidence ingestion is an append-only flow from execution surfaces into
criterion buckets; criteria carry a per-scope disposition (in-scope, deferred, waived,
delivered-elsewhere) that the merge gate reads — from the spec, never from the definition;
contract-derived definition content is provenance-locked with an upstream owner; the
one-active-execution rule (including Definition review) is a transition predicate, not a UI
convention.

### B11. Liveness and attention

Standard CC behavior applies to specs as to every other domain: typed SSE events for phase, gate,
approval, and evidence changes; status chips that update live; Active Work rows for in-flight
spec work; Needs You entries for pending gates; notifications per settings. No polling, no stale
approval banners.

**Domain-model implications:** lifecycle changes are publishable events with stable names from
day one.

## 6. V1 scope

V1 is the full lifecycle spine, B1–B11 (confirmed 2026-07-17 — the reviewed thinning option was
declined; ticket materialization and the traceability visualization stay in): spec object with
identity and references, `cctl spec` including export/verify, Spec Studio review and approvals,
enforced gates with presets and dials, ticket links (read-through) with graduation and
materialization, execution compilation to graph workflow definitions, criterion evidence
flow-back, and scoped delivery gates. **Success-test instrumentation is V1 scope**: the counters
behind §6.1 are captured from CC's retained events from day one — cheap now, unreconstructable
later.

### 6.1 V1 falsifiable success test (decided 2026-07-17)

Two tests, both computable from CC's own events.

**Release acceptance (binary).** One real, medium-risk CC feature goes from prompt to merged
delivery on native spec state — no manual state edits, no fallback to Kiro skills, no
transcript-as-authority. An independent reviewer can navigate every in-scope criterion from
requirement → approved revision → task → changed code → valid proof → merge result. The teeth
are demonstrated, not assumed: tests show the server rejecting (a) execution start from an
unapproved revision, (b) task completion without acceptable evidence, and (c) merge with an
unmet in-scope criterion. Any illegal transition that succeeds, or any out-of-band repair,
fails the test.

**Product hypothesis (staged).** Native features versus matched Kiro history, with measure
definitions and thresholds frozen before the pilot:

| Measure | Definition |
|---|---|
| Requirement-caused rework | Reopened tasks / non-trivial revisions attributable to missed or changed intent — not every post-delivery edit |
| Approval friction | Active review time, intervention count, re-approval loops; idle waiting excluded |
| Traceability completeness | % of delivered in-scope criteria reconstructible (approval → implementation → proof → merge) without transcripts |
| Automatic evidence capture | % of evidence attached from execution surfaces rather than manually |

Directional checkpoint after **two** native features (early kill/adjust signal); full read after
**five** against the frozen thresholds: 100% traceability, zero integrity violations or manual
state repairs, median requirement-caused rework ≥ 30% below baseline, median active approval
time ≤ 15% above baseline. The staging is deliberate: a wedge that cannot fail for a quarter is
not falsifiable in practice, and a two-sample verdict is not credible — the checkpoint provides
the fast kill signal, the five-feature read the defensible verdict. Threshold percentages may be
adjusted before the pilot but are frozen once it starts.

## 7. Out of scope / deferred

Out of scope for this document and stage:

- Storage of authored content (SQLite vs repository vs hybrid) — deferred; the §3 invariants are
  the fixed requirements any answer must satisfy.
- Schemas, API shapes, repository design, component architecture.
- **Kiro skills and `.kiro/specs`** — out of scope entirely: no import, no migration, no changes
  to the existing skills.
- Drift detection, change-impact analysis, and the living-memory features (portfolio analytics,
  steering feedback) — fast-follows once the model exists.
- Multi-agent authoring choreography (collaboration-mode drafting) — composes later; nothing
  here precludes it.
- **Cross-spec links and dependencies** (a spec depending on or referencing another spec) —
  deliberately unmodeled in V1.

Deferred beyond V1 (direction endorsed, not in scope now):

- **Approved-with-conditions / obligations** — V1 uses the comment → revise → re-approve loop.
- **Specialist agent reviews** (security, UX, architecture, testability lenses) as advisory
  verdicts, human remaining sole approver.
- **Semantic lint checks** (non-goal leakage, terminology drift, source contradictions).
- **Spec-event-driven ticket lifecycle actions** (e.g. auto-close on delivery).
- **Direct human editing of spec content** in Spec Studio.
- **Concurrent disjoint-scope executions** per spec.

## 8. Open items

None. The V1 success test — the sole open item at rev 4 — was defined and approved 2026-07-17
(§6.1). Next artifact: `02-domain-model.md` (state-machine formalization, gate predicates,
scope/amendment mechanics).
