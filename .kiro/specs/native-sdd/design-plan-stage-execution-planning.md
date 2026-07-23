# Design addendum: the plan stage plans the execution graph

**Status:** APPROVED by Alex 2026-07-22 and folded into `requirements.md` (R23 + deltas), `design.md`, `tasks.md` (21.x), and product design rev 6 the same day — this document remains the decision record. (Direction approved 2026-07-22: one planning act · spec vocabulary · deterministic compilation; revised twice folding accepted findings from two Codex design-review rounds.)
**Motivated by:** Workflow design review 2026-07-22 — compilation is a zero-intelligence 1:1 mapping, so graph-workflow quality is exactly task-plan quality, yet nothing makes plan authoring graph-aware
**Extends:** `requirements.md` R2/R9/R17 + new R23; `design.md` Physical Data Model (task payload), LintEngine, ExecutionService + Compiler; `docs/design/native-sdd/01-product-design.md` B6, B10 (rev 6). Fold completed 2026-07-22: §5 deltas in `requirements.md`, §6 deltas in the product design, §8 tasks appended to `tasks.md`, design decisions integrated into `design.md`.
**Depends on:** `design-staged-authoring.md` — the plan stage defined there (SA2/SA3) is the authoring surface this addendum reshapes; approve staged authoring first (no staged-authoring-free variant is defined). The plan-stage guidance of SA8 and EP5 below should land as one text.
**Date:** 2026-07-22

## 1. The gap

Native SDD's execution plan is a graph workflow definition produced by `compileSpecExecutionPlan` (`compiler.ts:84`), and the compiler is deliberately pure and mechanical: each selected task becomes its own execution context ("Execution group N", a generic grouping shell), `dependsOnTaskElementIds` become the edges verbatim, criteria become validator briefs, and the charter is boilerplate assembled from handles. There is no grouping intelligence, no parallelization judgment, and no sizing decision anywhere between the approved plan and the running workflow.

The consequence: **the workflow's shape is the task graph, byte for byte — so the only planning act that determines execution quality is plan-stage task authoring, and nothing today frames that act as graph planning.** The task payload and the coverage lint (R9.3–9.5) push the author toward traceability thinking — every criterion covered, every task traced — which is necessary but says nothing about whether the graph executes well: whether tasks are sized for one agent's context, whether missing edges are genuine parallelism or forgotten ordering, whether parallel tasks will collide in the worktree, whether dependency caution has silently serialized the plan. Graph-workflow planning has an established discipline (the `graph-workflow-planning` skill); the plan stage never invokes it.

Two remedies considered and rejected before this design (see §9): making the compiler smart, and skipping the task layer to plan the workflow directly from the design. The first hides planning judgment inside a pure transform where no one reviews it. The second dismantles the domain: tasks are load-bearing for scope pinning and partial delivery (R16), completion claims and rework measures (R6.6, R20.1), ticket materialization (R15.3), the traceability graph (R8.9), and — via R18.1 — the firewall that keeps delivery demands readable from the spec and never weakenable by definition edits. A definition-as-plan also loses execution-neutrality: one approved plan serves many executions over time (partial scopes, restarts), which is subgraph selection today and would become re-planning.

## 2. The principle

> There is exactly one planning act, and it is the plan stage. The plan stage authors the execution graph in spec vocabulary — a task is a lane's worth of work, a dependency is ordering truth, and the absence of a precedence path between tasks in different lanes is a reviewed claim they can run concurrently. Compilation stays deterministic and judgment-free: it faithfully materializes the reviewed graph, never repairs it. Cross-lane alignment flows from approved spec content — the charter and every context pack are assembled from the same immutable revision every lane cites.

The plan review thereby *is* the workflow-plan review, and the execution-start definition review stays what R17.4 intends: a review of execution-only knobs, never a re-plan.

## 3. What changes for the planning agent

Plan-stage authoring (entered per `design-staged-authoring.md` with requirements and design already approved) is presented — in the `/spec` skill and `cctl spec` help — as execution-graph planning:

1. Size each task for one agent lane: one coherent context-window's worth of work. The compiler groups tasks into shared contexts but never splits a task — an oversized task can only be fixed by re-planning, so split at authoring time.
2. Declare dependencies as ordering truth, not caution. An absent precedence path to a task in another lane is a parallelism claim the reviewer will read as such.
3. Declare the file surface a task touches (`touchedPaths`) so parallel-conflict risk is visible and lintable.
4. Declare intended lane sharing (`laneGroup`) where several small tasks belong to one agent.

## 4. Design decisions

### EP1 — The task payload carries plan-level execution knowledge

`taskElementPayloadSchema` (`schemas.ts:100`) gains two optional fields:

- `laneGroup?: string` — tasks sharing a key compile into one shared execution context. A plan-stage fact: "these belong to one agent," reviewed with the plan.
- `touchedPaths?: string[]` — repo-relative path prefixes the task expects to modify. V1 consumers are the graph-shape lint (EP4) and the plan review surfaces (task 21.7); the paths also ride into compiled task metadata for later workflow-surface use (builder display is explicitly deferred, not contracted).

Both are spec content: element payload changes mark the task modified, staling the plan approval per R10.7 — grouping and surface claims are re-reviewed exactly when they change. Absent fields mean today's behavior exactly (singleton contexts, no surface checks). Payload schemas stay `.strict()`; the element-payload contract fixtures extend maximally per house rule.

Determinism rules: `touchedPaths` entries are normalized repo-relative POSIX paths — absolute paths, `..` segments, and trailing separators are rejected at write time (deterministic CLI-local validation and the server both). Overlap compares whole path segments: `src/lib` overlaps `src/lib/specs`, not `src/library`. `laneGroup` keys are opaque strings, compared exactly.

### EP2 — The compiler honors the reviewed grouping and names things honestly

Grouping compiles through one pure **group-contraction primitive**, shared verbatim with the graph-shape lint (EP4): tasks partition by `laneGroup` (ungrouped tasks are singleton groups — the current 1:1 default); intra-group dependencies become intra-context task order (topological, ties broken by task handle); inter-group dependencies become deduplicated context edges. Group context ids derive from the group key, singleton ids stay task-derived; member and edge emission order sorts by handle, so compilation stays deterministic.

Context titles and descriptions come from content — the task handle and title for singletons ("T7 — Wire the association port"), the group key plus member handles for groups — replacing the "Execution group N" shells. Context acceptance criteria are **derived from the union of the member tasks' locked criterion briefs**, replacing the generic grouping-shell text. `touchedPaths` flow into task metadata beside the existing `spec*` keys, and task instructions additionally embed the approved content of each traced decision (title, chosen approach, reason) — `taskInstructions` today ignores `tracedDecisionElementIds`, so lane packs currently omit the very design decisions the task implements.

Task dependencies are **canonical**; contracted context edges and intra-context order are **derived** — after any regroup they are recomputed from the same task-level truth, never edited independently.

Grouping remains an **execution-only choice** (R17.4 unchanged) **before execution starts**: the plan's `laneGroup` is the reviewed default the definition opens with, not a locked region, and the workflow surface may regroup pre-start. Task content, criterion mappings, and edges stay provenance-locked as today, and four guards make that editability safe rather than etiquette. The guards that touch workflow machinery enter through registered composition seams (the delivery-gate-port precedent): unregistered, non-spec workflow behavior is byte-for-byte unchanged.

- **Dependency embedding is validated where it matters.** A pure check — every locked task precedence (`specDependsOnTaskElementIds`) must embed in the edited definition's context graph and intra-context order — runs at definition approval and again at execution start, refusing with the violated precedence named. This closes a pre-existing hole (`move-task` re-parents a task with no dependency validation at all, `definition-edits.ts:537`) that a reviewed-default grouping would otherwise inherit.
- **Context contracts re-derive at edit time.** Pre-start regrouping re-derives each affected context's acceptance criteria from its members' locked brief metadata within the same edit application — deterministic and spec-free, since the briefs travel in locked task metadata — so the context contract is never stale when execution starts.
- **Grouping freezes at start for spec-origin executions.** Runtime live edits can move unstarted tasks mid-run (`runtime-edits.ts:992`), while evidence ingestion attributes lane commits and validator results to a context's criteria through the **static** compiled origin map (`evidence-ingest.ts:181`) — a mid-run move would leave criteria attributed to a lane whose later work no longer covers them, in the false-proof direction. Spec-origin executions therefore refuse `move-task` live edits once running — the R16.8 pin-immutability philosophy: nothing about a run's promises mutates mid-run.
- **Intra-context completion order is server-checked.** `completeTask` verifies context membership but not predecessor completion — intra-lane order is otherwise prompt guidance, as for every multi-task context today. A completion claim for a task whose declared intra-context predecessors are incomplete is refused with the incomplete predecessor named — one condition in the reducer that already validates membership, driven by the locked precedence metadata when present.

The delivery gate reading the spec, never the definition (R18.1), remains the floor beneath all four guards.

### EP3 — The charter is assembled from the approved spec, not boilerplate

Deterministic assembly — concatenation of approved content, never summarization (compilation stays judgment-free):

- `mission` — the existing scoped sentence, followed by the `intent_outcomes` section bodies.
- `nonGoals` — one entry per `intent_non_goals` section (title-prefixed body), plus the existing pinned-scope exclusion line.
- `invariants` — one entry per `intent_constraints` section, with a stable id derived from the section's element id (stable across revisions — never positional, so reordering sections cannot re-key an invariant). Invariants are the *active* charter channel — the validator prompt instructs checking each one and citing its id — where `conventions` is passive preamble; enforceable constraints belong in the active channel.
- `conventions` — the existing two entries, unchanged.
- `testStrategy`, `sourcesOfTruth` — unchanged (already spec-derived).

Every lane's alignment artifact is thereby the same approved prose the human signed off, cited by revision — the answer to cross-agent alignment is the spec itself, not per-run briefs.

### EP4 — Graph-shape lint

New deterministic rules over the typed graph, catalogued in R9 (severity per rule; constants are named and fixed in `lint.ts`):

| Rule | Severity | Fires when |
|---|---|---|
| `9.11.lane-group-cycle` | Blocks `propose` | The group-contraction primitive (EP2) yields a cyclic group graph — the declared grouping cannot compile |
| `9.12.serialized-plan` | Advisory | The draft has ≥ 3 tasks and the group-contracted graph admits no two concurrently-runnable contexts — a single chain, including the everything-in-one-group collapse |
| `9.12.overloaded-task` | Advisory | The draft has ≥ 3 tasks and one task covers more than half of all criteria in the draft |
| `9.12.conflicting-parallel-surfaces` | Advisory | Two tasks in different groups whose contexts have no dependency path between them in the contracted graph both declare `touchedPaths`, and a path of one equals or segment-prefixes a path of the other (same-group tasks are sequential, never in conflict) |

Every graph rule evaluates the **contracted** graph through the shared EP2 primitive — raw task reachability misrepresents concurrency once lane groups exist. Advisories surface in the plan-stage propose and the lint panel like every 9.9 finding — the reviewer sees the graph consequences of the plan; judgment stays human. `blocks_propose` scoping follows the staged-authoring amendment (these rules involve tasks, so they are vacuous before the plan stage).

### EP5 — Plan-stage guidance carries the discipline

The `/spec` skill's plan-stage section (SA8 in the staged-authoring addendum) and the `spec.help.ts` entries for `draft` and task authoring present §3 explicitly, referencing the graph-workflow-planning discipline. Guidance and server tell one story: the skill explains lane sizing and parallelism claims; lint and the compiler make the consequences visible and real.

### EP6 — Reviews keep their separate jobs

Plan approval reviews the graph (decomposition, ordering, parallelism claims, grouping intent, surfaces). Definition approval at execution start reviews execution-only knobs (isolation, regrouping, retries, budgets) under the execution-start dial — unchanged R17.3. With a well-shaped plan the definition review approaches a formality, which is the design working, not a redundancy to collapse: the definition still carries per-run choices the spec never contained (B10), and partial-scope executions still compile fresh definitions from the same approved plan.

For the plan approval to actually review the graph, the review surfaces must show it: Spec Studio's plan review and semantic change list render each task's dependencies, lane group, touched surfaces, and criterion coverage, and the CLI reads (`cctl spec show`/`get`/`status`) expose the same fields (task 21.7).

## 5. Requirement deltas (fold into `requirements.md` on approval)

- **R2.11 — amend:** append "…and optionally its declared lane group and touched file surfaces (Requirement 23)."
- **R9 — add criterion 11:** "When a draft revision is proposed while the declared lane grouping contracts the task dependency graph into a cycle, the spec system shall refuse the proposal with a finding naming the cyclic groups."
- **R9 — add criterion 12:** "The spec system shall raise advisory, non-blocking graph-shape findings, evaluated on the lane-group-contracted graph: a plan of three or more tasks contracting to a single chain of contexts (fully serialized, including a single all-task group); a task covering more than half of the draft's criteria in a plan of three or more tasks; and two tasks in mutually independent contexts declaring overlapping touched file surfaces."
- **R17.1 — amend:** "…task groups become contexts" becomes "plan-declared lane groups become contexts (tasks without a group compile 1:1), titled from their task content, with context acceptance criteria derived from the member tasks' criterion briefs"; append "and the definition's charter shall be assembled deterministically from the approved intent sections (outcomes, non-goals, constraints) of the pinned revision, carrying constraints as active charter invariants."

### New Requirement 23: The plan stage plans the execution graph

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

## 6. Product-design deltas (fold into `01-product-design.md` as rev 6 on approval)

- **B6 lint table:** add the four EP4 rows (one blocking, three advisory).
- **B10:** amend the compilation bullet — "task groups → contexts" becomes "plan-declared lane groups → contexts (1:1 default), titled from task content"; add that the charter is assembled from the approved intent sections; add one sentence framing the plan stage as the execution-graph planning act and the definition review as execution-only (already implied by rev 5's two-kinds-of-content split); note that for spec-origin executions, regrouping is a pre-start freedom — task placement freezes once the run starts, per the same pin philosophy as revision and scope.
- Record the decision date 2026-07-22 in the doc's decision log.

## 7. Compatibility and observability

- Both payload fields are optional: existing revisions, exports, and executions are unaffected, and a plan authored without them compiles to the same graph shape as today — defined as identical context ids and membership, identical task set, and identical edge set; instruction, criteria, and charter text intentionally differ (EP2/EP3), so graph shape, not bytes, is the parity property regressions pin. No migration; no new tables or columns.
- The delivery gate, evidence, freshness, scope validation, and merge machinery are untouched — this addendum changes what the plan says and how faithfully compilation renders it, not what delivery demands.
- Effect is observable through the existing §6.1 measures (rework, approval friction) plus workflow-side execution audits (`graph-workflow-audit`): better-shaped plans should show as fewer mid-run halts, less join contention, and fewer merge conflicts between lanes.

## 8. Tasks (append to `tasks.md` on approval; renumber if the staged-authoring 20.x block lands first)

- [ ] 21. Plan-stage execution planning
- [ ] 21.1 Task payload fields `laneGroup` / `touchedPaths`: schema, maximal element-payload contract fixtures, export/verify additive coverage
  - _Requirements: 2.11, 23.1_
- [ ] 21.2 Group-contraction primitive + graph-shape lint (TDD, pure): shared contraction (partition, intra-group topological order, deduplicated inter-group edges); `9.11.lane-group-cycle` blocking; `9.12.serialized-plan`, `9.12.overloaded-task`, `9.12.conflicting-parallel-surfaces` advisories on the contracted graph, with named constants and `touchedPaths` normalization
  - _Requirements: 9.11, 9.12, 23.5_
- [ ] 21.3 Compiler grouping: laneGroup → shared contexts via the contraction primitive, content-derived context titles/descriptions, context criteria derived from member briefs, traced-decision content in task instructions, `touchedPaths` in task metadata; graph-shape parity regression (identical contexts/tasks/edges) for plans without the new fields
  - _Requirements: 17.1, 23.2, 23.4, 23.7, 23.8_
- [ ] 21.4 Charter assembly from approved intent sections — constraints as active invariants with stable ids (deterministic concatenation, snapshot-tested)
  - _Requirements: 17.1, 23.3_
- [ ] 21.5 Guidance: `/spec` skill plan-stage section (one text with SA8) + `spec.help.ts` draft/task help carrying the §3 discipline
  - _Requirements: 23.6_
- [ ] 21.6 E2E: grouped-plan compile golden path; execution-surface regrouping preserves every locked task contract; graph-shape advisories surface at plan-stage propose
  - _Requirements: 23.2, 23.4, 23.5, 23.9_
- [ ] 21.7 Review surfaces: Spec Studio plan review and change list render dependencies, lane group, touched surfaces, and criterion coverage per task; `cctl spec show`/`get`/`status` expose the same fields
  - _Requirements: 23.10_
- [ ] 21.8 Dependency-embedding validation (TDD, pure + wiring): locked task precedences must embed in the context graph and intra-context order; enforced at definition approval and execution start; regression covering the pre-existing unvalidated `move-task` hole
  - _Requirements: 23.9_
- [ ] 21.9 Runtime guards behind registered composition seams (TDD): spec-origin executions refuse mid-run `move-task` live edits; `complete_task` refuses while a declared intra-context predecessor is incomplete; non-spec workflows byte-for-byte unchanged when unregistered
  - _Requirements: 23.11, 23.12_
- [ ] 21.10 Edit-time context-criteria re-derivation from member brief metadata in definition-edit application (deterministic, spec-free)
  - _Requirements: 23.9_

## 9. Rejected alternatives

- **Skip tasks; plan the workflow definition directly from the approved design** — dismantles five load-bearing domain roles (scope/partial delivery, claims/rework measures, ticket materialization, traceability, the R18.1 delivery firewall) and trades execution-neutral plans for per-run artifacts; partial scopes and restarts would re-plan instead of re-select. The intent behind it — one planning act with the graph in mind — is delivered by this design instead.
- **A separate agent step translating tasks into a workflow plan** — a second plan that can drift from the approved one, unclear authority between them, and planning cost paid twice; the tasks still weren't authored graph-aware, so the translator inherits a wrong-shaped decomposition.
- **An intelligent compiler (heuristic grouping, dependency inference, task splitting)** — buries planning judgment in a pure transform where nothing reviews it; violates the determinism that makes locked regions and provenance trustworthy. Judgment belongs at the plan stage, where it is approved.
- **Collapsing definition approval into plan approval** — the definition carries per-run, execution-only decisions the spec never contained (B10), and one approved plan serves many executions; the two reviews answer different questions.
- **Task splitting at compile time** — splitting changes the unit that claims, evidence, and tickets key on; the plan must own its granularity (hence the split-at-authoring guidance in EP5/R23.6).
- **Task-local canonical criteria with versioned working definitions** — proposed in review; unnecessary once grouping freezes at start (R23.11) and context contracts re-derive at edit time (R23.9). The R18.1 delivery firewall remains the floor; re-architecting evidence attribution buys nothing it doesn't already guarantee.
- **Prohibiting dependency-related tasks from sharing a lane group** — would gut laneGroup's primary use case (several small sequential tasks in one lane); the completion-order guard (R23.12) enforces the same safety without the prohibition.
