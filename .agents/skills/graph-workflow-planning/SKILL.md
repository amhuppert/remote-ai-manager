---
name: graph-workflow-planning
description: Use when creating, revising, or diagnosing graph workflow plans, especially before authoring a plan.json for cctl workflow validate/create/replace/run, decomposing work into execution contexts, writing acceptance criteria, aligning implementers and validators, deciding dependencies, or recovering from repeated validation failures.
---

# Graph Workflow Planning

This skill is the source of truth for planning graph workflows. Use it before authoring a workflow `plan.json` for `cctl workflow validate`/`create`/`replace`/`run`, and when a graph workflow keeps failing validation.

This core file covers the ordinary planning path end to end: decompose the objective into contexts, write the charter and acceptance criteria, place contexts on lanes, and submit the plan. Deeper machinery lives in read-on-demand references — load one only when the plan actually needs it:

| Reference | Read when |
|---|---|
| [references/dynamic-control-flow.md](references/dynamic-control-flow.md) | the plan needs conditional branches, a repeat-until loop, or a runtime fan-out whose branch count is unknowable at planning time |
| [references/placement-and-parallelism.md](references/placement-and-parallelism.md) | deciding lane sharing, `ownedPaths` for a tricky surface, what the write envelope lets agents do, parallel-vs-sequential calls, or answering a `placement-*` refusal |
| [references/validation-and-staffing.md](references/validation-and-staffing.md) | selecting script-gate commands, tuning agent command access or lane-merge validation, staffing non-default implementers or validator cohorts, or aligning validators with criteria in detail |
| [references/revising-and-recovery.md](references/revising-and-recovery.md) | revising a saved definition, editing a running execution, or understanding halts and automatic plan repair |

## Workflow Model

- A graph workflow is a DAG of execution contexts.
- Each execution context runs as an independent agent session.
- Tasks inside one context run sequentially, in array order, inside that same agent session.
- Each task should be achievable in roughly 10-30 minutes of focused work.
- Dependency edges make one context wait for another context to complete.
- Every context declares where it runs and what it may write: a lane, a grade, and — for an owning context — its owned paths. Several contexts can share one lane. See [Placement Essentials](#placement-essentials).
- Context IDs and task IDs should be stable, kebab-case, and content-specific, such as `runtime-apply-contracts` or `wire-route-handlers`.
- The executing agent sees the workflow definition and codebase, **not the planning conversation**. Task instructions must be self-contained.
- A plan launches two ways: saved (`validate` → `create` → `start`, reusable and reviewable in the builder) or one-off (`cctl workflow run` on the plan file directly). See [Authoring and Submitting the Plan](#authoring-and-submitting-the-plan).

## Planning Procedure

1. Read the governing context.
   - Load the full objective, relevant specification files, relevant steering files, and any existing workflow definition being replaced.
   - Do not plan from only a narrow task excerpt when design semantics matter.
   - Resolve design contradictions between sources NOW, during planning. Executing agents receive the plan, not the debate, and no prompt carries a rule for arbitrating between two sources — an unresolved conflict shipped into the charter or the criteria becomes contradictory instructions two agents resolve differently. See [Resolving source conflicts at plan time](#resolving-source-conflicts-at-plan-time).

2. Build a context inventory.
   - List major implementation surfaces: schemas, persistence, runtime lifecycle, adapters, API, UI, tests, migration, diagnostics.
   - Identify design contradictions before creating contexts.

3. Define contracts before tasks.
   - For each context, state what it produces, what it consumes from upstream contexts, and what it must not decide privately.
   - Put shared contracts in an upstream context when later contexts need the same state machine, support matrix, route contract, or data shape.
   - Cross-context contract schemas (a shared request/response schema in a domain's `schemas.ts`, a shared type both sides validate against) get their canonical home in a context every consumer depends on — a predecessor both parallel siblings build on, never one of the siblings. Homing the canonical file in sibling A while parallel sibling B consumes it forces B to invent a local copy, take a NO-GO, and collide at the join.
   - Do not split work so a downstream agent needs hidden assumptions from a different execution context.

4. Close capability ownership (producer and consumer).
   - For every runtime capability the plan introduces — an event publication, route, notification, adapter, UI control — name both the producer context and the consumer context, and decide which context's acceptance criteria require the **production call site**.
   - A capability with a specified consumer and no specified producer is a planning error: each contributing context can pass its own validation while the composed runtime path is dead.
   - If wiring is deferred to another context, the deferring context's acceptance criteria must name that downstream owner explicitly, AND the named owner's acceptance criteria must carry the matching obligation. Context validators fail unnamed deferral of wiring; a deferral whose target never carried the obligation silently evaporates.
   - If the answer to "which context requires the production caller?" is the final verification context, the plan is deferring reachability — assign it to the owning context instead.

5. Derive charter invariants and sources — and scope both.
   - While reading the governing context, extract the recurring cross-cutting rules: any rule that constrains **how** multiple contexts implement (not **what** one context builds) belongs in `charter.invariants`, declared once — not repeated inconsistently or omitted per-context.
   - Scope each invariant honestly (see [The Charter](#the-charter)): leave it global only when every context's validator should actively check it; give it `appliesTo.contextIds` when it binds specific surfaces. An end-state property only the final integration or cutover context can satisfy is that context's acceptance criterion, not a global invariant — a global invariant is checked against every intermediate state, and mid-migration contexts will honestly fail it.
   - Scope sources the same way and for the same reason: an unscoped source renders into every context's prompts on every iteration. Attach each source to the contexts whose agents must actually consult it, and materialize anything living outside the worktree before citing it at all.
   - For any plan with approval, gate, or attribution semantics, include an evidence-legality invariant: integration evidence must flow through production-legal, human-attributed paths — no fixture shortcuts through service internals, no unauthenticated stand-in calls.

6. Choose execution contexts around validation boundaries.
   - Each context should have one coherent validation thesis.
   - Split broad lifecycle work into smaller contexts such as contracts, mutation fanout, backend-specific lifecycle, turn-start behavior, diagnostics, and UI/API wiring.
   - Avoid contexts whose acceptance criteria require the validator to understand several unrelated subsystems at once.
   - Count the independently-failable obligations in each context's criteria, not the paragraphs. A context whose criteria hide a dozen separately checkable requirements is several contexts wearing one id.

7. Write self-contained task instructions.
   - Include what to change, why it matters, likely files/modules, and how the implementer can verify locally.
   - Include required documents the implementer must read, not just files to edit.
   - State upstream artifacts that are authoritative for this context.
   - Before writing "mirror file X" in instructions, check X against the charter invariants: faithful implementers copy precedent verbatim, including its violations. If the exemplar itself breaches an invariant, say so and name exactly what to deviate from.
   - When the charter bans code patterns (type escapes, forbidden imports), give the implementer a concrete pre-completion check in the instructions — e.g. grep new/changed test code for the banned pattern before the final `cctl workflow task complete`. One grep is cheaper than the validator NO-GO cycle it prevents.

8. Add dependency edges deliberately.
   - Use edges for hard dependencies and for helpful foundation dependencies when prior work materially reduces ambiguity.
   - Do not add edges between truly independent contexts.
   - Prefer a short foundation context before parallel branches when multiple implementers need the same contract.

9. Place every context on a lane.
   - Decide each context's grade — see [Placement Essentials](#placement-essentials). Placement is required and never inferred, and `ownedPaths` belongs only on contexts that run concurrently with a write-capable member of the same lane.
   - Group contexts that implement disjoint blocks of one change onto a shared lane; keep same-file competition, dependency-mutating work, and self-verifying contexts on their own.
   - Do this AFTER the edges exist: only same-lane members that nothing orders must be disjoint, so a dependency edge is often the cheaper fix for an overlap — and a member ordered against every lane-mate needs no `ownedPaths` at all (`full`).

Steps 4 and 5 encode an audited failure mode: in a 21-context execution, three release blockers (a gate with no production grant path, events no production code ever published, notification adapters no runtime component imported) shipped past green per-context validation because every acceptance criterion was satisfiable by exported, unit-tested code — and five NO-GO classes recurred independently across contexts because the shared rules lived only in deep spec documents.

## The Charter

`definition.charter` is required and is the plan's governing context for every executing agent. Its mission, the invariants that apply to a context, and the sources scoped to that context render into that context's implementer and validator prompts, so anything left global is paid for on every iteration — keep it small and load-bearing.

- `mission` (required) and `testStrategy` (optional) are strings.
- `conventions`, `nonGoals`, `vocabulary`, and `knownAmbiguities` are optional string arrays, never prose strings.
- `sourcesOfTruth` (required, at least one): the ranked reference list agents consult. Each entry: `rank` (unique positive integer, ordering the list), `id`, `label`, `type` (`code`/`config`/`document`/`spec`/`other`), `locator`, `description`, and optional `appliesTo` (`{ "contextIds": [...] }` — the same structured scope invariants take).
- `invariants` (optional): cross-cutting rules as `{ "id", "statement", "appliesTo"? }` entries with unique kebab-case ids and one-line statements. Validators actively check each rendered invariant and cite its id in issues.

### Compact maximal charter example

```json
{
  "mission": "Ship a trustworthy workflow.",
  "conventions": ["Use red-green-refactor."],
  "nonGoals": ["Do not redesign the UI."],
  "vocabulary": ["candidate: the tree under review"],
  "testStrategy": "Run focused tests, then the integration gate.",
  "knownAmbiguities": ["The adapter name is implementation-local."],
  "invariants": [{ "id": "tests-first", "statement": "Behavior changes start with a failing test." }],
  "sourcesOfTruth": [{ "rank": 1, "id": "runtime", "label": "Workflow runtime", "type": "code", "locator": "src/lib/workflow-graph", "description": "Governs runtime behavior." }]
}
```

Charter amendments made mid-run are recorded in an amendment log that lands in `charter.md` and the durable record; it does not render into any prompt. An amended rule therefore has to stand on its own in the charter text — a statement that only makes sense against its own change history is not finished.

### Scoping invariants and sources

An invariant or a source with no `appliesTo` is global: it renders into EVERY context's implementer and validator prompts. Scope it instead with authored context ids — one shape, both entry kinds:

```json
{
  "id": "lease-consumers-use-projection",
  "statement": "Every consumer of execution-lease state reads the projection, never the raw table.",
  "appliesTo": { "contextIds": ["lease-consumers", "cutover"] }
}
```

- The engine renders a scoped entry only into the prompts of the contexts it names; other contexts never see it.
- Scoping follows logical authored identity: loop-pass clones and runtime-expanded children of a named context inherit its scoped invariants and sources automatically.
- A scope naming a context id the definition does not declare is refused at accept time (`unknown-invariant-scope-context` for an invariant, `unknown-source-scope-context` for a source), as is free-form prose where a source's scope belongs (`legacy-source-applies-to`) — only context ids resolve against the graph.
- Duplicate ids and duplicate `contextIds` entries within one scope are refused.

Default to few, genuinely global entries plus scoped ones for specific surfaces. A rule that needs prose to explain *when* it applies is not global — scope it, or make it the owning context's acceptance criterion.

### Resolving source conflicts at plan time

`rank` orders the list; it is not a runtime tiebreak. No prompt tells an agent to defer to a higher-ranked source, so two attached sources that contradict each other reach every implementer and validator as contradictory instructions, resolved differently by each.

- Conflicts among sources are **resolved at plan time**, by you. Decide which statement governs, write the decision where agents actually read it (the mission, an invariant, or the owning context's criteria), and record in the losing source's `description` what it no longer governs.
- An unresolved conflict between two attached sources is a **blocking plan-review finding**, not something execution absorbs.
- Attach only sources the contexts you scope them to can actually read. There is no permission-gated source grade: material living outside the worktree — another repository, a URL, a database-resident document — must be **materialized into the worktree** (a committed export, a shared document) before it may be cited as a source at all. Every locator must resolve from a lane worktree; one that does not is flagged absent in every verdict that names it.

## Acceptance Criteria

Acceptance criteria are the shared contract between implementer and validator. `acceptanceCriteria` is an ordered list of `{ "id", "statement" }` records — the same shape as charter invariants, for the same reason: a blocking validator cites `criterionId` in its issues, so every obligation needs a stable name to be cited by.

```json
"acceptanceCriteria": [
  { "id": "publishes-on-commit", "statement": "The commit handler calls publishLeaseEvent for every accepted write." },
  { "id": "refuses-unowned-write", "statement": "A write outside the context's ownedPaths is refused with ownership_violation." }
]
```

- Ids are kebab-case and unique within the context. Keep them stable across revisions — verdicts, repair diagnoses, and remediation all address criteria by id, so a renamed id orphans every citation that named it.
- **One independently-failable obligation per record.** If a record can pass in one half and fail in the other, it is two records. The old advice to number your clauses is now the schema, not a formatting preference.
- **Record count is the context-split signal.** A coherent validation thesis is a handful of records; a context carrying a dozen-plus is several contexts wearing one id. Density is visible while you author now — read it before you submit, because the validator reads it after.
- Prose is still accepted on the authored write paths and wraps as exactly one record, `ac-1`. That is a migration affordance, not a second dialect: one record holding a paragraph of obligations reproduces exactly the blob records exist to remove.
- Live-edit and plan repair replace the WHOLE list (`update-context`); there are no per-criterion operations. Such an edit must restate every record the context keeps, verbatim.

Draft each statement as a context-local, observable outcome an LLM validator can judge by inspecting the work.

Good acceptance criteria:

- Name concrete state transitions, emitted data, files, APIs, or user-visible behavior.
- Include important negative cases and unsupported/gated behavior.
- Fit entirely inside the context's scope.
- Give the validator enough specificity to pass or reopen a task without inventing new edge cases.
- Require **runtime reachability** for every capability the context introduces: name the production composition site (route handler, service factory, listener registration, UI control) and demand evidence through it — a composition-level smoke test or a typed wiring deliverable. If the wiring intentionally lands downstream, name the owning context in the criterion.
- Preserve **deferral integrity**: an obligation one context defers ("verified in context X") is only validly deferred when X's acceptance criteria contain the matching obligation. Audit every deferral chain at planning time — each "verified later" claim must terminate in a criterion record that states it.

Do not write acceptance criteria that:

- Depend on another context's private work.
- Mix contradictory design states, such as requiring runtime application for a feature also marked verification-gated or diagnostic-only.
- Ask the agent validator to enforce deterministic checks like tests, typecheck, lint, or build. Use `scriptValidator` only when the context should end in a fully valid state.
- Use vague phrases like "retryable diagnostics", "fully wired", or "complete lifecycle" without spelling out the exact states and paths.
- Use existence verbs — "exists", "is exported", "types are defined" — for capabilities that must be runtime-reachable. Existence is satisfiable by dead code with green unit tests; require the production caller, or name the downstream context that owns the wiring.
- Sweep an unbounded surface — "every call site", "all legacy paths", "complete parity" — without a task that first inventories that surface mechanically. An open quantifier over an uninventoried surface converges one discovered site per validation round.

## Placement Essentials

Every execution context declares `placement`: which **lane** it runs on, and what it may write there. There is no default and no inference — a plan whose contexts do not all carry placement is refused. A lane is one git worktree on one branch; a lane hosting N contexts costs one worktree and one fan-in join for the whole group.

| grade | may write | use for |
|---|---|---|
| `readOnly` | nothing — scratch only; requires `outputSchema` since captured output is all it delivers | fan-out readers, judges, classifiers, reviewers |
| `owned` | exactly its `ownedPaths`, shared lane with other members | unordered write-capable members of a shared lane — the only case that needs a list |
| `full` | the whole tree, lane to itself while it runs | every other write-capable context: alone on its lane, or ordered against every lane-mate |

Core rules:

- Put readers on the `session` lane: `{ "lane": "session", "mode": "readOnly" }` costs no worktree and no merge.
- `ownedPaths` is a concurrency mechanism, not a scoping mechanism: declare `mode: "owned"` only for two-plus write-capable members of one lane that no dependency edge orders. A context alone on its lane, ordered against every lane-mate, or parallel with contexts on OTHER lanes takes `full` — a list where no race exists buys no parallelism, and its first unforeseen legitimate write is a denied tool call or an `ownership_violation` halt.
- Share a lane to save worktrees and joins: ordered `full` members for sequential work, disjoint `owned` members for genuinely parallel blocks of one change. Give a context its own lane for same-file competition, dependency-mutating work (lockfiles, codegen), or a verification boundary it must own.
- Where ownership does apply, prefer **directory-grain ownership** (`src/lib/state-store`, not eleven file paths inside it): red-green implementers create files that did not exist when you planned, and a file-grain entry denies exactly those writes mid-task.
- Same-lane members that nothing orders must own pairwise-disjoint prefixes; a shared surface (a barrel, a lockfile, a shared `schemas.ts`) has exactly one owner — home it upstream or dependency-order the members.
- The envelope is mechanical: agents cannot commit (never write task instructions asking an implementer to commit, stash, or rebase), and an enveloped context's whole-repo verification happens at its lane's join, not per context.

Full grade semantics, lane-sharing decision rules, the write envelope, accept-time `placement-*` refusal codes, and parallel-vs-sequential guidance: [references/placement-and-parallelism.md](references/placement-and-parallelism.md).

## Defaults and Payloads

Create workflows with default implementer and validator settings unless the user explicitly asks for different settings or a context has a specific, justified need.

- Omit top-level `workflowConfig` unless non-default workflow-wide settings are requested.
- Omit every optional per-context block unless a non-default value is intentionally required: `implementer`, `contextValidator`, `scriptValidator`, `agentValidation`, `iterationPolicy`, `circuitBreaker`, `mutability`, `planRepair`, `collaboration`, `humanApprovalGate`, `askUserQuestions`, `outputSchema`, `routing`.
  - `humanApprovalGate: { "enabled": true }` pauses the finished, validated context for explicit human approval before it completes.
  - `askUserQuestions: { "enabled": true }` lets the context's agents ask the user questions mid-run (one toggle covers implementer and validator).
  - `collaboration` pairs the implementer with a second agent (`secondAgent`, `negotiationRounds`, `autonomousResolutionThreshold`).
  - `planRepair` tunes the automatic plan-repair response to halts (default ON — see [references/revising-and-recovery.md](references/revising-and-recovery.md)).
- `acceptanceCriteria` is required on every execution context, lives on the context rather than the validator, and is authored as ordered `{ id, statement }` records — see [Acceptance Criteria](#acceptance-criteria).
- `placement` is required on every execution context too, and it does not default or cascade — decide it deliberately per context.
- Both mutability flags default to `false`. A final verification context that may add remediation tasks but must not expand the graph uses exactly `{"allowAgentTaskAdd":true,"allowAgentContextAdd":false}`.
- Minimal payloads are preferred because global and workflow defaults cascade into each context at execution seed time.
- Exception to the "use defaults" rule: select the appropriate registered commands in `scriptValidator.commands` for the **final** execution context unless there is a specific reason to leave the gate empty.

## Validation Essentials

Three independent validation surfaces exist; keep their decisions separate. The full policy, cascade semantics, and staffing model live in [references/validation-and-staffing.md](references/validation-and-staffing.md).

- `contextValidator` — an ordered cohort of LLM validator assignments judging the intent of the context's acceptance criteria. Default staffing (a single general reviewer) is right for most contexts; staff a specialist cohort only when a context genuinely needs a second lens. That default seat judges the criteria themselves, so each of its blocking issues cites the failing criterion's id; a specialist cites its own assigned mandate instead and names a criterion only when its finding also contradicts one.
- `scriptValidator.commands` — the deterministic registered-command gate run after the context's tasks complete. Select commands only for a context expected to leave those checks green; never gate an intentionally invalid intermediate state (a schema landed before its callers migrate) — put the deterministic thesis on a later integration context or the lane's merge barrier instead. Every name must exist in the project's `validation.commands` registry.
- `laneMergeValidation` — the deterministic barrier protecting the shared fan-in target; global/workflow tier only. For contexts sharing a lane this barrier IS where whole-repo verification happens, and an enveloped context's `scriptValidator.commands` must be empty or a subset of it.

Script validation runs before agent validation; a failed command skips agent validation for that iteration. Validators respect context scope boundaries and do not fail a context for work intentionally assigned downstream — provided the deferral is named as [Planning Procedure](#planning-procedure) step 4 requires.

## Dynamic Control Flow

Three engine-evaluated primitives extend the static DAG: **conditional edges** (a branch runs only when the upstream verdict selects it), **loop groups** (a body repeats until a predicate is satisfied), and **runtime graph expansion** (a running implementer appends contexts it could not have known about at planning time). Agents supply judgment only as typed structured output; the engine decides, durably and inspectably.

Reach for them in this order: a static DAG when the shape is known; conditional edges when the shape is known but which parts run is not; a loop when the same work may need repeating an unknown number of times; expansion only when the NUMBER of parallel branches is genuinely unknowable until a context runs.

Authoring any of them — guard syntax, cardinality, loop bodies, handoff fields, expansion payloads and caps, and their accept-time refusal codes and checklist: [references/dynamic-control-flow.md](references/dynamic-control-flow.md).

## Common Failure Modes

Guard against these before starting execution:

- Implementer/validator misalignment: acceptance criteria judge behavior the implementer was not instructed to build.
- Ambiguous criteria: validator keeps discovering new edge cases because the state contract was underspecified.
- Contradictory criteria: design says a capability is gated, while acceptance criteria require it to work as runtime-applied.
- Missing context: implementer gets only a task slice while validator expects whole-design behavior.
- Overbroad contexts: one context owns mutation routing, lifecycle hooks, backend adapters, diagnostics, and retry semantics.
- Parallelism without foundation: independent-looking contexts secretly need the same unresolved contract.
- Unowned wiring: a capability's consumer is fully specified while no context's criteria require the production caller — every context passes locally and the composed runtime path is dead until (at best) final verification.
- Invariants by rediscovery: cross-cutting rules live only in deep spec documents, so each implementer independently misses them and validators re-teach the same lesson context after context. Declare them once in `charter.invariants`.
- Criteria as a blob: one record carrying a paragraph of obligations, so nobody can count what the context actually owes, and a validator citing that id is pointing at everything at once.
- Conflict shipped to runtime: two attached sources disagree and the plan ships the disagreement. Nothing arbitrates between them at execution time, so each context resolves it its own way and the results only collide at a join.
- Unreadable source: a source whose material never entered the worktree, so every agent scoped to it reports it absent and judges the work without it.
- Global invariants over phased work: an end-state invariant left unscoped binds every mid-migration context, so honest validators fail states the plan itself scheduled. Scope it with `appliesTo` or move it to the owning context's criteria.
- Deferral dead-end: a validator GO records "deferred to context X" but X's acceptance criteria never carried the obligation, so it evaporates and the workflow completes without it — most dangerously for live end-to-end verification, which no per-context validation replaces.
- Charter-violating exemplar: a task says "mirror file X" and X itself violates a charter invariant, so the implementer faithfully reproduces the violation and burns a NO-GO cycle on precedent the plan pointed them at.
- Script validator deadlock: deterministic commands are selected for a context that intentionally ends in an invalid intermediate state.

Placement, loop, guard, and expansion failure modes live with their machinery in the references.

## Final Verification Context

For substantial workflows, add a final verification context after all implementation contexts. Its job is to review the design end to end, verify wiring across contexts, and add remediation tasks (mutability must be enabled for this context in order for it to add tasks).

The final context should:

- Read the full design and requirements, not only prior summaries.
- Verify that each implemented surface is connected to the runtime path the user will exercise.
- Check that gated or unavailable behavior is honestly represented.
- Select `scriptValidator.commands` only if the whole workflow should satisfy those checks at that point.
- Own live end-to-end verification explicitly when the workflow ships user-visible or end-to-end behavior: a task plus an acceptance criterion that require driving the real running feature, not static code tracing. If no context owns a live pass, the plan is declaring the feature will ship untested end to end — make that trade-off consciously, not by omission.

The final verification context is **defense in depth** for reachability, not the primary proof — each capability context proves its own production wiring or names its downstream owner. Bound the review's acceptance criteria: enumerate the surfaces to check rather than writing "every implemented surface", and route large gaps into remediation tasks with their own bounded criteria. An unbounded audit-and-remediate predicate is a scope ratchet a circuit breaker will eventually halt mid-convergence.

## Authoring and Submitting the Plan

Author the workflow as a `.cc/temp/plan.json` file — keep it under `.cc/temp/`, which CC git-ignores, so the throwaway plan is never committed — then submit it with the `cctl` CLI. Never paste a whole workflow graph as inline tool arguments — a file you can iterate on is the interface.

### plan.json shape

A plan is a JSON object the validate, create, replace, and run endpoints all accept:

```json
{
  "name": "Add OAuth2 Support",
  "description": "What this workflow achieves (optional).",
  "definition": {
    "charter": {
      "mission": "…",
      "invariants": [ { "id": "server-side-enforcement", "statement": "…" } ],
      "sourcesOfTruth": [ /* ranked entries, each global or `appliesTo`-scoped */ ]
    },
    "executionContexts": [
      { "id": "auth-setup", "title": "Authentication Setup",
        "acceptanceCriteria": [ { "id": "token-exchange", "statement": "…" } ],
        "placement": { "lane": "auth", "mode": "full" } }
    ],
    "tasks": [
      { "id": "create-user-schema", "contextId": "auth-setup", "order": 1, "title": "…", "instructions": "…" }
    ],
    "edges": [
      { "id": "edge-setup-to-wire", "sourceContextId": "auth-setup", "targetContextId": "wire-routes" }
    ]
  },
  "layout": { "workflowId": "plan", "contextPositions": {} }
}
```

- `definition.charter` is required — see [The Charter](#the-charter) for its shape and invariant scoping.
- Every execution context needs `placement`; every read-only context also needs `outputSchema`.
- Each task needs an explicit `order` (1-based, per context) and a unique `id`. Each edge needs a unique `id`.
- The dynamic-control-flow declarations (`edges[].when`, `routing`, `outputSchema`, `mutability`, `loopGroups`) are all optional and omitted by default.
- `schemaVersion`, `workflowConfig`, and every optional per-context/per-task block default when omitted — keep the payload minimal (see [Defaults and Payloads](#defaults-and-payloads)).
- `layout` is required, but positional detail is not: `{ "workflowId": "plan", "contextPositions": {} }` is enough.
- `approvalRequired: true` on the definition parks each launched execution for explicit human approval before any context runs.

### Launch parameters and prerequisites

- `definition.parameters` declares typed launch inputs (`string`, `text`, or `enum` — each with `name`, `label`, `required`, optional `default` and constraints) so one plan can be launched repeatedly with run-specific values. Reference them as `{{inputs.<name>}}` — the only valid token form — inside task instructions, context titles/descriptions/acceptance criteria, and charter text fields; values substitute at execution seed time. A malformed token or a reference to an undeclared parameter is refused at accept time.
- `definition.prerequisites` declares environment requirements checked before launch: `{ "kind": "path", "path": "<worktree-relative>" }` for a file/directory that must exist, or `{ "kind": "skill", "skill": "<name>", "backend"? }` for an agent skill the project must provide. An unmet prerequisite rejects the launch rather than failing mid-run.
- Author a global cross-project template (`{{inputs.<name>}}`-parameterized) through the Templates UI, not this project-scoped create flow.

### Submit flow

Run these from the session (the CLI reads its project/session identity from the environment):

1. `cctl workflow validate --file .cc/temp/plan.json` — runs the exact create-path checks (schema parse, dependency cycles, unknown context refs, placement, guard/loop/parameter/prerequisite validation, invariant scopes) plus resolution of every agent profile reference the plan names, and persists nothing. On issues it exits non-zero and prints one issue per line with its JSON path (e.g. `definition.tasks.2.contextId: …`). Fix the file and re-run until it prints the create hint; answer any `warning:` lines rather than ignoring them. Add `--tier global` when the plan is destined for the cross-project template library.
2. `cctl workflow create --file .cc/temp/plan.json` — saves the definition and prints its id. The user reviews and edits it in the visual builder before starting.
3. `cctl workflow start <id>` — starts execution. Pass declared parameter values with `--file .cc/temp/inputs.json` (a JSON object of `{{inputs.<name>}}` bindings). Track progress with `cctl workflow status`.

For a single-use plan that should not become a saved definition, launch it directly: `cctl workflow run --file .cc/temp/plan.json` (add `--inputs .cc/temp/inputs.json` for declared parameters, `--wait --timeout 10m` for a bounded observation wait). The run is detached by default; follow it with `cctl workflow status` or `cctl workflow wait <executionId>`. Prefer `create` + `start` when the user should review the graph in the builder first or the plan will be reused.

To revise a saved definition after feedback, use targeted edits (`cctl workflow get` + `cctl workflow edit`) rather than resubmitting the whole plan — see [references/revising-and-recovery.md](references/revising-and-recovery.md). Editing a saved definition never mutates a running execution; tell the user when a fresh execution is needed.

### Semantic authoring lints

Alongside the structural checks, `validate` runs four semantic lints over the plan and prints each hit as `warning: <json path>: lint/<id>: <detail>`. `create` and `replace` print the same lines above their own output, so going straight to create never hides them. They are **warning tier only**: no lint can refuse a plan or change an exit code.

| lint id | catches |
|---|---|
| `lint/criteria-density` | a context with more than 12 acceptance-criteria records, or one statement longer than 600 characters — a contract no single validator round can weigh, or a prose blob wearing one record's id |
| `lint/open-quantifier` | `every`, `all`, `complete`, or `maximal` in a criterion statement — a sweep over a surface the plan never inventories, discovered one site per round |
| `lint/source-locator-unresolvable` | a charter source whose locator is not a contained worktree-relative path, or is absent from the committed session tree when a verified session substrate is available |
| `lint/oversized-prose` | task instructions longer than 8000 characters, or a context description longer than 2000 — durable reference material that belongs in a shared document |

Those numbers are dials, not judgments: each is the point past which a real execution's plan stopped being reviewable, and a plan can cross one for a good reason. The `lint/` prefix marks advice, so it is never mistaken for a structural warning.

Exact UI/output copy containing a quantifier must be syntactically quoted with balanced straight quotes, curly quotes, or backticks. Suppression is match-local: only a quantifier match inside its own proven literal span is discharged; unmatched delimiters suppress nothing, and lexical phrase allowlists are forbidden.

Source existence is context-dependent. Project-only authoring can reject an uncontained locator shape but cannot claim a relative path is missing. When the server has verified a session, the named verified resolution substrate is that session's worktree, branch, and HEAD commit; session validation and launch check the committed tree and name the substrate in any warning.

Semantic warnings are recomputed for each response from the applicable plan and resolution substrate. They remain response advisories, not saved rationale or acknowledgments, and never change plan validity or gate save or launch.

Answer each one rather than ignoring it — the same rule the submit checklist already applies to every `warning:` line. Answering means repairing the plan or having a specific reason the warning does not apply to this plan; scrolling past is neither.

### Getting the plan reviewed

Review is advisory and never required — an unreviewed plan validates, creates, replaces, and starts freely. When a plan IS reviewed, the verdict binds to the exact revision (the plan's canonical content hash, computed server-side), so get the revision you actually intend to submit reviewed, not an intermediate draft.

- Hand the reviewer the final `.cc/temp/plan.json` and point them at the `graph-workflow-review` skill. The review protocol — the two lenses, the findings artifact, the recording flags — lives there, not here.
- Check the verdict yourself with `cctl workflow review --file .cc/temp/plan.json`. It reads rather than records unless `--verdict` is passed, and exits 0 either way. A reviewed revision prints the verdict, the reviewer conversation, when it was reached, the revision hash, the findings artifact in full, and ready-to-run commands that open the reviewer's own conversation (`cctl conversation read <id> --outline`, plus `cctl conversation compaction get <id> --json` when a completed compaction exists) — that is how you recover findings in a fresh session. An unreviewed one prints `plan review: none recorded for this revision (advisory)`.
- `cctl workflow create` and `cctl workflow replace` each print one advisory line for the revision they just saved: none recorded, `approved`, or `changes_requested` with the reviewer and the time. It is a status line; it never changes the exit code.

**The acknowledgement gate** is the only blocking behavior in the whole mechanism. `create` and `replace` refuse a revision carrying an *unacknowledged changes-requested* review with the code `review-changes-requested-unacknowledged`; approved and unreviewed revisions are never gated, and `validate`, `run`, and `start` are never gated at all. The refusal names the revision hash, the reviewer, the review time, and the command that retrieves the findings. Two ways out:

1. **Repair the plan** — the ordinary path. Read the findings (`cctl workflow review --file .cc/temp/plan.json`), fix what they name, re-validate. Repairing changes the plan's hash, so the gate clears on its own — and the new revision carries no verdict at all, so it needs its own review.
2. **Acknowledge and proceed** — re-run with `--acknowledge-review <hash>` (the flag exists on both `create` and `replace`), passing the hash the refusal printed. That is a read receipt, not an approval: it records that you saw the findings and submitted anyway.

**Any repair invalidates the review.** A revised plan is a different revision and no verdict carries forward by hand, so the reviewer re-records against the exact final revision. Budget for that round trip instead of reviewing a draft you already know will change.

### Before submitting, confirm

- The `graph-workflow-planning` skill was used, and the relevant references were read for any machinery the plan uses.
- No known design contradictions remain unresolved.
- Every context's `acceptanceCriteria` is a list of `{ id, statement }` records with stable kebab-case ids, one independently-failable obligation each, and few enough of them to be one validation thesis.
- Every runtime capability the plan introduces has a producer context whose acceptance criteria require the production call site, or a criterion naming the downstream context that owns the wiring — and the named owner's criteria carry the matching obligation.
- Cross-cutting rules are declared once in `charter.invariants`, and sources are scoped the same way: each entry is either honestly global or carries `appliesTo.contextIds`.
- No conflict between two attached sources is left for execution to arbitrate, and every source locator resolves from a lane worktree — external material was materialized into it before being cited.
- Optional implementer and validator settings are omitted unless the user requested them or a specific context requires them; any selected `scriptValidator.commands` run only after contexts expected to leave those checks valid.
- Every agent profile reference was read from `cctl agent list`, not invented (`cctl agent get <tier:id>` for full instructions), and a context that overrides a cohort restates every assignment it wants.
- Every context carries `placement`, every read-only context carries an `outputSchema`, no write-capable context sits on the `session` lane, and unordered same-lane members own pairwise-disjoint directory-grain prefixes — `mode: "owned"` appears only where such an unordered pair exists, and every other write-capable context is `full`.
- No task instruction asks an implementer to commit, stash, rebase, or clean the tree.
- If the plan uses guards, loops, or expansion: the checklist in [references/dynamic-control-flow.md](references/dynamic-control-flow.md) passes.
- `cctl workflow validate` passes on the final `.cc/temp/plan.json`, and any warnings it prints are answered rather than ignored.
- If the plan was reviewed, the revision being submitted is the revision that was reviewed — every repair since then invalidated the verdict and earns a re-review.
