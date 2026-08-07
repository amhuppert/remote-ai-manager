---
name: graph-workflow-planning
description: Use when creating, revising, or diagnosing graph workflow plans, especially before authoring a plan.json for cctl workflow validate/create/replace, decomposing work into execution contexts, writing acceptance criteria, aligning implementers and validators, deciding dependencies, or recovering from repeated validation failures.
---

# Graph Workflow Planning

This skill is the source of truth for planning graph workflows. Use it before authoring a workflow `plan.json` for `cctl workflow validate`/`create`/`replace`, and when a graph workflow keeps failing validation. The planning methodology below is unchanged by how the plan is submitted; see [Authoring and Submitting the Plan](#authoring-and-submitting-the-plan) for the file shape and CLI flow.

## Workflow Model

- A graph workflow is a DAG of execution contexts.
- Each execution context runs as an independent agent session.
- Tasks inside one context run sequentially, in array order, inside that same agent session.
- Each task should be achievable in roughly 10-30 minutes of focused work.
- Dependency edges make one context wait for another context to complete.
- Context IDs and task IDs should be stable, kebab-case, and content-specific, such as `runtime-apply-contracts` or `wire-route-handlers`.
- The executing agent sees the workflow definition and codebase, **not the planning conversation**. Task instructions must be self-contained.

## Defaults and Payloads

Create workflows with default implementer and validator settings unless the user explicitly asks for different settings or a context has a specific, justified need.

- Omit top-level `workflowConfig` unless non-default workflow-wide settings are requested.
- Omit per-context `implementer`, `contextValidator`, `scriptValidator`, `agentValidation`, `iterationPolicy`, `circuitBreaker`, and `mutability` unless a non-default value is intentionally required.
- `acceptanceCriteria` is required on every execution context and must live on the context, not on the validator.
- Minimal payloads are preferred because global and workflow defaults cascade into each context at execution seed time.
- To opt out of inherited agent validation for a context, set `contextValidator: { "enabled": false, "assignments": [] }`.
- To staff a context's reviewers explicitly, set `contextValidator` to an enabled cohort of assignments — see [Staffing Assignments](#staffing-assignments-from-the-agent-profile-library).
- To override deterministic validation for a context, set `scriptValidator: { commands: ["typecheck", "test"] }`; an empty `commands` list disables that gate.
- Override agent command access separately with `agentValidation.implementer` and `agentValidation.contextValidator`; never infer agent permissions from the script-gate selection.
- `laneMergeValidation` is global/workflow configuration for the shared fan-in target, not a per-context override.
- If a running execution already exists, changing a saved workflow definition may not mutate that active execution. Tell the user when a fresh execution or reset is needed.
- Exception to the "use defaults unless explicitly directed otherwise" rule: select the appropriate registered commands in `scriptValidator.commands` for the **final** execution context unless there is a specific reason to leave the gate empty.

## Validation Policy

Graph workflows have three distinct validation configuration blocks. Keep their decisions independent.

### Script gate: `scriptValidator.commands`

`scriptValidator.commands` is the ordered registered-command selection run after an implementer finishes the context's tasks. It cascades global defaults → workflow → execution context; each provided list replaces the inherited list, and `[]` disables the script gate. The seeded default is `[]`.

```json
{
  "scriptValidator": {
    "commands": ["typecheck", "test"]
  }
}
```

Every name must exist in the project's `validation.commands` registry. Select commands only for a context expected to leave that check green; do not create an intentionally invalid intermediate state and then gate it with checks that can pass only after downstream work.

### Agent access: `agentValidation`

Agent permissions cascade separately, per role and per leaf, through global defaults → workflow → execution context:

```json
{
  "agentValidation": {
    "implementer": {
      "commands": { "mode": "all", "except": ["format"] }
    },
    "contextValidator": {
      "commands": { "mode": "only", "commands": [] }
    }
  }
}
```

`{ "mode": "all", "except": [...] }` opts into all registered commands except explicit exclusions. `{ "mode": "only", "commands": [...] }` is a stable allowlist. The seeded implementer default is all commands with no exclusions; the seeded context-validator default is no commands.

Implementer test access stays enabled even when the script gate also runs tests. The implementer needs focused test runs for red-green TDD, while `scriptValidator.commands` independently defines the deterministic end-of-context gate. Never remove implementer access merely to avoid duplicate-looking selections.

### Lane merges: `laneMergeValidation`

`laneMergeValidation` cascades global defaults → workflow only because it protects the shared fan-in target rather than one execution context:

```json
{
  "laneMergeValidation": {
    "strategy": "final-only",
    "commands": { "mode": "project" }
  }
}
```

`strategy` is `final-only` by default, which defers validation until the last merge in a serial join; `every-merge` validates each source-lane merge. `{ "mode": "project" }` uses the project's `validation.laneMerge` selection or falls back to `validation.preMerge`. `{ "mode": "only", "commands": [...] }` supplies a workflow-specific selection, and an empty `commands` list disables lane-merge validation.

## Planning Procedure

1. Read the governing context.
   - Load the full objective, relevant specification files, relevant steering files, and any existing workflow definition being replaced.
   - Do not plan from only a narrow task excerpt when design semantics matter.
   - When selecting `scriptValidator.commands`, confirm every name is registered in the project's `validation.commands` block.

2. Build a context inventory.
   - List major implementation surfaces: schemas, persistence, runtime lifecycle, adapters, API, UI, tests, migration, diagnostics.
   - Identify design contradictions before creating contexts.

3. Define contracts before tasks.
   - For each context, state what it produces, what it consumes from upstream contexts, and what it must not decide privately.
   - Put shared contracts in an upstream context when later contexts need the same state machine, support matrix, route contract, or data shape.
   - Do not split work so a downstream agent needs hidden assumptions from a different execution context.

4. Close capability ownership (producer and consumer).
   - For every runtime capability the plan introduces — an event publication, route, notification, adapter, UI control — name both the producer context and the consumer context, and decide which context's acceptance criteria require the **production call site**.
   - A capability with a specified consumer and no specified producer is a planning error: each contributing context can pass its own validation while the composed runtime path is dead.
   - If wiring is deferred to another context, the deferring context's acceptance criteria must name that downstream owner explicitly. Context validators treat unnamed deferral of wiring as a failure.
   - If the answer to "which context requires the production caller?" is the final verification context, the plan is deferring reachability — assign it to the owning context instead.

5. Derive charter invariants.
   - While reading the governing context, extract the recurring cross-cutting rules: any rule that constrains **how** multiple contexts implement (not **what** one context builds) belongs in `charter.invariants`, declared once — not repeated inconsistently or omitted per-context.
   - Typical invariant classes: server-side enforcement of gates (never UI-only), evidence bound to its producing execution, pinned/approved-revision targeting (never latest), approval carry-forward semantics, production-shaped test fixtures.
   - For any plan with approval, gate, or attribution semantics, include an evidence-legality invariant: integration evidence must flow through production-legal, human-attributed paths — no fixture shortcuts through service internals, no unauthenticated stand-in calls.
   - Invariants are rendered to every implementer and validator; validators actively check each applicable invariant and cite its id in issues, so keep ids stable and statements one line.

6. Choose execution contexts around validation boundaries.
   - Each context should have one coherent validation thesis.
   - Split broad lifecycle work into smaller contexts such as contracts, mutation fanout, backend-specific lifecycle, turn-start behavior, diagnostics, and UI/API wiring.
   - Avoid contexts whose acceptance criteria require the validator to understand several unrelated subsystems at once.

7. Write self-contained task instructions.
   - Include what to change, why it matters, likely files/modules, and how the implementer can verify locally.
   - Include required documents the implementer must read, not just files to edit.
   - State upstream artifacts that are authoritative for this context.

8. Add dependency edges deliberately.
   - Use edges for hard dependencies and for helpful foundation dependencies when prior work materially reduces ambiguity.
   - Do not add edges between truly independent contexts.
   - Prefer a short foundation context before parallel branches when multiple implementers need the same contract.

Steps 4 and 5 encode an audited failure mode: in a 21-context execution, three release blockers (a gate with no production grant path, events no production code ever published, notification adapters no runtime component imported) shipped past green per-context validation because every acceptance criterion was satisfiable by exported, unit-tested code — and five NO-GO classes recurred independently across contexts because the shared rules lived only in deep spec documents.

## Acceptance Criteria

Acceptance criteria are the shared contract between implementer and validator. Draft them as context-local, observable outcomes that an LLM validator can judge by inspecting the work.

Good acceptance criteria:

- Name concrete state transitions, emitted data, files, APIs, or user-visible behavior.
- Include important negative cases and unsupported/gated behavior.
- Fit entirely inside the context's scope.
- Give the validator enough specificity to pass or reopen a task without inventing new edge cases.
- Require **runtime reachability** for every capability the context introduces: name the production composition site (route handler, service factory, listener registration, UI control) and demand evidence through it — a composition-level smoke test or a typed wiring deliverable. If the wiring intentionally lands downstream, name the owning context in the criterion.
- Number their clauses when a context has several independently-failable criteria, so validator issues and remediation can cite exact clauses. If the clause count grows past a handful, treat that as the signal to split the context (one coherent validation thesis).

Do not write acceptance criteria that:

- Depend on another context's private work.
- Mix contradictory design states, such as requiring runtime application for a feature also marked verification-gated or diagnostic-only.
- Ask the agent validator to enforce deterministic checks like tests, typecheck, lint, or build. Use `scriptValidator` only when the context should end in a fully valid state.
- Use vague phrases like "retryable diagnostics", "fully wired", or "complete lifecycle" without spelling out the exact states and paths.
- Use existence verbs — "exists", "is exported", "types are defined", "adapters surface" — for capabilities that must be runtime-reachable. Existence is satisfiable by dead code with green unit tests; require the production caller, or name the downstream context that owns the wiring.

## Staffing Assignments from the Agent Profile Library

Who runs a context is an **assignment**: a stable use-site id, a reference to a profile in the shared agent profile library, an optional focus, and the concrete runtime. A context has exactly one implementer assignment and an ordered **cohort** of validator assignments.

A profile is prompt identity only — a name, a description, and instructions. It carries no backend, model, effort, or tool policy; those live on the assignment, so the same profile can be staffed at different runtimes at different use sites.

### Discover profiles before staffing

The library is machine-discoverable — never invent a reference:

1. `cctl agent list` — every profile reachable from this project across all three tiers, each with its qualified `tier:id`, name, description, revision, advisory `recommendedFor`, and tags. Pick by reading descriptions.
2. `cctl agent get <tier:id>` — one profile's full instructions, when the description is not enough to judge fit. The qualified spelling is mandatory; a bare id is refused.

Tiers are sibling scopes, not a shadowing chain: `builtin:reviewer`, `global:reviewer`, and `project:reviewer` are three different profiles. `recommendedFor` is advisory — prefer a profile recommended for the role, but never refuse one on that basis alone.

### The assignment shape

```jsonc
{
  "implementer": {
    "id": "implementer",                                   // stable, kebab-case, unique at its use site
    "profile": { "tier": "builtin", "id": "general-implementer" },
    "focus": "state-store persistence",                    // optional use-site steer
    "agent": { "backend": "claude", "model": "opus", "reasoningEffort": "high" }
  },
  "contextValidator": {
    "enabled": true,
    "assignments": [
      {
        "id": "security",                                  // unique WITHIN the cohort
        "profile": { "tier": "global", "id": "security-reviewer" },
        "strategy": "conversation",
        "agent": { "backend": "codex", "model": "gpt-5.6", "reasoningEffort": "high" }
      }
    ]
  }
}
```

- The assignment `id` is the durable use-site identity findings are grouped under. Keep it stable across revisions; renaming it is a new use site, not a rename.
- `focus` narrows a general profile at one use site ("auth boundaries", "hot paths"). Durable behaviour belongs in the profile itself — if every use site repeats the same focus, the profile is wrong.
- `strategy` is validator-only and independent of backend: `conversation` or `task`.
- Two assignments may name the SAME profile under different ids and focuses. That is the normal way to get two specialist passes from one general reviewer.

### Cohort rules

- An enabled cohort needs at least one assignment — validation over an empty cohort would pass vacuously, so it is refused.
- Assignment ids must be unique within a cohort.
- A disabled cohort **retains** its assignments. Turning validation off and back on is lossless, so do not strip assignments to disable a context's review. Retained assignments still show up on the staffing surfaces, marked `(cohort disabled)`, and their references are still checked at save — a dangling one is refused even though nothing dispatches it.
- Assignments replace as **whole units** at every cascade boundary (global → workflow → context). A context that sets `contextValidator` replaces the inherited cohort entirely; there is no field merging. Restate every assignment you want.
- Keep the default single general reviewer unless a context genuinely needs a second specialist lens. Every extra assignment is another full review of the same candidate.

### Reference scope

A **global-scope** document (a cross-project template, or the global `workflowDefaults`) may reference only `builtin` and `global` profiles. A `project`-tier reference is unresolvable in every other project and is refused — validate with `--tier global` to catch that before saving rather than at save time.

## Validators

Graph workflows have two independent validators:

- `contextValidator`: an ordered cohort of LLM validator assignments that judge the intent of the context acceptance criteria. Every enabled assignment reviews the same frozen candidate and all must pass; findings stay grouped by assignment id. Validators respect context scope boundaries and should not fail a context for work intentionally assigned downstream.
- `scriptValidator`: a deterministic gate that runs its ordered registered-command selection after all tasks in the context complete. Each command enters ValidationService separately under the global budget; the gate stops at the first failure and records the run evidence before adding a remediation task.

Script validation runs before agent validation. If a command fails, agent validation is skipped for that iteration. After remediation the complete ordered list reruns. A capacity wait is orchestration state and does not consume an iteration or trip the circuit breaker.

Unknown command names and costs above the global limit fail preflight rather than becoming runtime no-ops.

### Script Validator Decision Rule

Select commands in `scriptValidator.commands` only when the codebase is expected to satisfy them after completing all tasks in that execution context.

Do not enable `scriptValidator` for a context intentionally planned to end in an invalid intermediate state, such as:

- A schema or type contract landed before all callers are migrated.
- A backend adapter contract changed before downstream runtime wiring exists.
- A partial implementation that is intentionally completed by a later context.
- A branch where tests, typecheck, lint, or build are expected to fail until a downstream integration context runs.

If script commands are selected for an intentionally invalid intermediate state, the workflow will either halt or pressure the implementer to expand scope into later contexts. Put those deterministic commands on a later integration or final verification context instead.

## Validator Alignment Checklist

Before creating or replacing a workflow, check every context:

- The validator and implementer receive the same essential context (acceptance criteria are automatically provided to both the implementer and validator).
- Every criterion maps to at least one task in that same context.
- Every task has enough context to satisfy the criteria without relying on conversation-only knowledge.
- Validator scope cannot require downstream integration work to already be done.
- Any wiring intentionally deferred downstream is named in the acceptance criteria — validators fail existence-only evidence for a capability whose wiring has no named owner.
- A failed criterion can reopen a specific task in the same context.

If the validator would need the whole design to judge a narrow context, either add a context-local design summary task or move that criterion to a final verification context.

## Parallelization Guidance

Parallel contexts run in isolated git worktrees, one branch per context, so they cannot interfere with each other mid-flight. Branches are merged automatically at join points and at final publish, and merge conflicts are **resolved automatically** by an LLM resolver (the same machinery as Smart Merge). Lane-merge validation follows `laneMergeValidation`: the default `final-only` strategy validates the integrated tree on the last merge in a serial join, while `every-merge` validates each source-lane merge. Do not plan as if all merge conflicts must be avoided.

Plan for aligned intent, not file disjointness:

- Two contexts needing to touch the same file does **not** by itself preclude running them in parallel. Logically independent edits to a shared file merge cleanly or resolve straightforwardly.
- Do not serialize contexts merely to avoid merge conflicts, and do not contort context boundaries to keep write surfaces disjoint.
- What parallel contexts must share is intent: contracts, conventions, and vocabulary declared up front — in the charter or a short foundation context — so their changes compose.

Parallelize when all of these are true:

- Contexts make logically independent changes, aligned by shared contracts, even if their file sets overlap.
- No context needs another context's implementation details to make good decisions.
- Validation can be judged locally for each context.

Stay sequential when contexts are semantically coupled — when running them in parallel would mean two agents independently designing the same behavior:

- Contexts change the same state machine, runtime lifecycle, adapter contract, or persistence schema in ways that must compose behaviorally. Automatic resolution fixes textual conflicts; it cannot make two independently designed changes to one design surface coherent.
- A backend support decision is still unverified.
- One context's implementation would be useful foundation context for another agent, even without a hard dependency.
- Diagnostics, retries, and status semantics span several contexts and need a single authoritative vocabulary.

A conflict the resolver cannot handle halts the workflow at the join, so heavy overlap on a coupled surface still carries risk; prefer a short foundation context that lands the shared contract first, then parallelize freely on top of it.

## Dynamic Control Flow

Beyond the static DAG, three primitives let one plan express a shape it could not before: **conditional edges** (a branch runs only when the upstream verdict selects it), **loop groups** (a body repeats until a predicate is satisfied), and **runtime graph expansion** (a running implementer appends contexts it could not have known about at planning time).

All three are deterministic and engine-evaluated. Agents supply judgment ONLY as typed structured output — a captured `outputSchema` payload — and the engine decides. There is no agent-evaluated condition, no agent-declared loop, and no free-form routing instruction. Every routing, expansion, and loop decision is recorded durably and is readable afterwards.

Reach for them in this order: a static DAG when the shape is known; conditional edges when the shape is known but which parts run is not; a loop when the same work may need repeating an unknown number of times; expansion only when the NUMBER of parallel branches is genuinely unknowable until a context runs.

### Conditional Edges: Guards, Cardinality, and `else`

An edge may carry an activation guard over its source context's captured output, on `edges[].when`:

```json
{
  "edges": [
    {
      "id": "edge-triage-hotfix",
      "sourceContextId": "triage",
      "targetContextId": "hotfix",
      "when": { "schema": { "properties": { "severity": { "const": "critical" } }, "required": ["severity"] } }
    },
    {
      "id": "edge-triage-backlog",
      "sourceContextId": "triage",
      "targetContextId": "backlog",
      "when": { "else": true }
    }
  ]
}
```

- `{ "schema": … }` — a JSON-Schema-subset document. The edge activates exactly when the source's captured output validates against it.
- `{ "else": true }` — the fallback: active when no schema-guarded sibling from the same source activated. At most one per source, and it is resolved over the source's whole outgoing set, so declaration order does not matter.
- No `when` at all — unconditional, which is every edge in a pre-D4 plan.

The guard document uses the same supported subset as `outputSchema`: `type`, `enum`, `const`, `oneOf` at any node; `properties` / `required` / `additionalProperties` on objects; `items` / `minItems` / `maxItems` on arrays; `minLength` / `maxLength` / `pattern` on strings; `minimum` / `maximum` on numbers. `$ref`, `anyOf`, `allOf`, `not`, and `if`/`then`/`else` are refused — express the branch positively.

`cctl workflow validate` refuses a mis-authored guard with a located issue:

| code | what to fix |
|---|---|
| `guard-source-without-output-schema` | the SOURCE context needs an `outputSchema` — a guard reads a captured payload, and a source that declares no shape produces none |
| `unsupported-guard-schema` | the guard uses a keyword outside the subset above |
| `incompatible-guard-schema` | the guard can never match the source's declared output (a misspelled property, a value outside the declared enum) |
| `duplicate-else-edge` | one source carries two `else` edges |

It also **warns** (exit code 0 — the plan is still creatable) when every guard from one source constrains the same single enum field and the branches leave some values unrouted. Add the missing branch, or add an `else`.

#### Cardinality

By default a source's conditional branches are independent: zero, one, or many may activate. Declare a stricter contract on the SOURCE context — it is a property of the outgoing edge SET, not of one edge:

```json
{ "id": "triage", "title": "Triage", "acceptanceCriteria": "…", "routing": { "cardinality": "exactlyOne" } }
```

- `independent` — the meaning of an absent `routing` block; any number of branches may activate.
- `atLeastOne` — under-selection halts the run.
- `exactlyOne` — under- OR over-selection halts the run.

The halt is `routing_cardinality` and it is resumable: `cctl workflow live pause`, amend the guard set or the policy with `cctl workflow live edit`, `cctl workflow live resume`. The completed source is never re-run and never re-decided.

Pairing `exactlyOne` with an `else` edge is the Classify-And-Act shape: the `else` makes under-selection impossible, so a `routing_cardinality` halt can only mean two guards genuinely overlap — a real authoring bug rather than an unrouted value.

#### The branch not taken

A context whose incoming route is inactive is **skipped**: a terminal status with a recorded reason, not a failure and not a retry. Skips propagate down the guarded subtree, and a skipped context's downstream agents are told the branch was not taken rather than being left to infer it.

An unconditional edge from a skipped source resolves as *omitted* — it drops out of the conjunction rather than skipping the target outright, so a fan-in with one live branch and several skipped ones still runs. A target whose incoming edges are ALL omitted has nothing left to wait for and skips too, which is how a skip carries down an unconditional chain.

Two authoring consequences:

- **Never guard away the only context that covers an acceptance criterion.** The engine refuses a live edit (and the spec compiler refuses a plan) that leaves a linked criterion with no context that runs on EVERY path. A guard on an ANCESTOR edge takes coverage away exactly as a guard on the covering context's own edge does.
- **Skipped is terminal.** There is no reroute and no un-skip. If a branch might be needed after all, guard it so it can activate, rather than planning to revive it.

### Loop Groups: Repeating a Body Until a Verdict

A loop group repeats a body of one or more contexts until a designated exit context's captured output satisfies a predicate. Declare it at `definition.loopGroups`:

```json
{
  "loopGroups": [
    {
      "id": "refine",
      "title": "Refine until the reviewer approves",
      "bodyContextIds": ["draft-fix", "review-fix"],
      "entryContextId": "draft-fix",
      "exitContextId": "review-fix",
      "until": { "schema": { "properties": { "verdict": { "const": "approved" } }, "required": ["verdict"] } },
      "maxPasses": 5
    }
  ]
}
```

The body is declared **by reference**: `draft-fix` and `review-fix` are ordinary entries in `executionContexts`, with ordinary `tasks` and an ordinary edge between them. At seed the engine snapshots them as an immutable body template and materializes pass 1 in their place; every later pass is a fresh clone — new contexts, new conversations, ids in the reserved `<loopGroupId>__p<K>__<authoredId>` namespace.

Shape rules, all refused by `cctl workflow validate`:

| code | what to fix |
|---|---|
| `loop-exit-without-output-schema` | the exit context needs an `outputSchema` — it produces the verdict |
| `unsupported-loop-predicate` / `incompatible-loop-predicate` | `until.schema` is outside the subset, or can never match the exit's declared output |
| `multi-entry-loop-body` / `multi-exit-loop-body` | the body must be single-entry and single-exit: every non-entry body context needs an internal in-edge, every non-exit body context an internal out-edge |
| `external-edge-bypasses-loop-entry` / `-exit` | edges from outside may enter only at the entry, and leave only from the exit |
| `non-reconverging-loop-branch` | the exit must run on every path inside the body — a guarded branch that can skip the exit leaves a pass with no verdict |
| `disconnected-loop-body` | every body context must be reachable from the entry through internal edges |
| `nested-loop-body` / `overlapping-loop-bodies` | v1 has no nesting and no overlap: one context belongs to at most one loop |
| `unknown-loop-body-context` | a `bodyContextIds` entry the definition does not declare |
| `loop-entry-not-in-body` / `loop-exit-not-in-body` | `entryContextId` and `exitContextId` must both be members of `bodyContextIds` |
| `duplicate-loop-group-id` | two groups share an `id` |
| `reserved-loop-instance-id` / `reserved-loop-group-id` | no authored id may contain `__p<K>__` |
| `loop-max-passes-exceeds-backstop` | `maxPasses` is mandatory and may not exceed the 25-pass backstop |

Two budgets bound a loop, and exhausting either raises a resumable `loop_limit_reached` halt — there is no "give up and carry on" mode, by decision:

- the group's own `maxPasses`, which an audited plan-repair round may amend upward;
- a per-execution **25-pass backstop** across every loop, which nobody — operator or repair agent — can raise.

Because a pass instance is a fresh context, per-context iteration and circuit-breaker budgets reset each pass, and validators and approval gates run on every pass exactly as they would on an ordinary context.

#### Worker + judge bodies

The body worth reaching for first is two contexts: a **worker** that does the work, and an independent **judge** that assesses it. Make the judge the exit, so the verdict the loop settles on comes from the reviewer rather than the author:

- Give the judge a narrow `outputSchema` whose verdict field is machine-checkable — an enum, a bounded score, a required boolean. Never prose the engine would have to interpret.
- Write the judge's acceptance criteria as "assessed X against Y and emitted a verdict", not "X is correct". Its job is to judge, and a pass where it correctly says *not yet* is a successful pass.
- Keep the worker's and the judge's instructions independent. A judge told what the worker intended tends to grade the intent.

A one-context body is legal (entry and exit are the same context) and is right when the work and the check are genuinely the same act.

#### The handoff field (the worked example)

Nothing an agent "remembers" survives a pass boundary: pass K+1 is new contexts with new conversations, and there is deliberately no loop-scoped store or message bus. Only two channels carry a pass forward, and both are typed:

- **The exit's `outputSchema`** — the payload `until` is evaluated against.
- **The Loop History section** — pass K+1's ENTRY prompt (only the entry) receives the prior passes' per-context captured outputs with each pass's verdict and outcome. It is bounded: the most recent 3 passes, 2 KB per context capture, 16 KB per section.

So anything the next pass must know has to be IN a body context's captured output. The convention is an explicit **handoff field**: one string property carrying the narrative, alongside the machine-checkable fields.

Worked example — the `refine` loop above, both body contexts:

```jsonc
// draft-fix (entry, the worker) — outputSchema
{
  "type": "object",
  "properties": {
    "changed": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Files this pass changed"
    },
    "handoff": {
      "type": "string",
      "maxLength": 1200,
      "description": "What the next pass must know: what was attempted this pass, what did not work, and what to try next"
    }
  },
  "required": ["changed", "handoff"],
  "additionalProperties": false
}
```

```jsonc
// review-fix (exit, the judge) — outputSchema
{
  "type": "object",
  "properties": {
    "verdict": {
      "type": "string",
      "enum": ["approved", "changes-requested"],
      "description": "approved ends the loop; the until predicate reads this field only"
    },
    "handoff": {
      "type": "string",
      "maxLength": 1200,
      "description": "For changes-requested: exactly what must change, specific enough to act on without re-reviewing"
    }
  },
  "required": ["verdict", "handoff"],
  "additionalProperties": false
}
```

With `until: { "schema": { "properties": { "verdict": { "const": "approved" } }, "required": ["verdict"] } }`, pass 2's `draft-fix` prompt opens with a Loop History section carrying pass 1's `changed` and `handoff` from the worker, the judge's `verdict` and `handoff`, and the pass outcome — so the worker starts from what the reviewer actually asked for.

Rules of thumb:

- Put a handoff field on every body context whose work the next pass builds on — for worker+judge, on both: the worker says what it tried, the judge says what must change.
- Keep the narrative in ONE prose field. Scattering it across several free-form fields truncates unpredictably when a capture exceeds the per-context bound; one field truncates predictably.
- Never put the verdict in the handoff field. The verdict is what `until` reads and belongs in its own machine-checkable property.
- Keep payloads small and bound them (`maxLength`). A body context producing a large artifact should write it to the worktree or register it with `cctl workflow shared-doc upsert`, and carry only its path in the handoff.

Read the whole ledger — every pass's decision, including passes an amended predicate re-decided — with `cctl workflow live ledger`.

### Runtime Graph Expansion

When a context cannot know at planning time HOW MANY parallel branches its work needs, grant it expansion authority and let it append them at runtime:

```json
{ "id": "generate", "title": "Generate candidates", "acceptanceCriteria": "…", "mutability": { "allowAgentContextAdd": true } }
```

The flag is default-off, cascades like its `allowAgentTaskAdd` sibling, and is exercisable only by the context's currently bound implementer. The lane then submits ONE payload:

```json
{
  "requestId": "expand-candidates-1",
  "rationale": "One context per distinct approach in the brief",
  "contexts": [
    {
      "handle": "candidate-a",
      "title": "Candidate: approach A",
      "acceptanceCriteria": "…",
      "outputSchema": { "type": "object", "properties": { "score": { "type": "number" } }, "required": ["score"], "additionalProperties": false }
    }
  ],
  "tasks": [
    { "contextHandle": "candidate-a", "title": "Build candidate A", "instructions": "<self-contained>" }
  ],
  "edges": [
    { "from": "generate", "to": "candidate-a" },
    { "from": "candidate-a", "to": "filter" }
  ]
}
```

submitted with `cctl workflow graph expand --file .cc/temp/expansion.json`. `handle` is the lane's local name; the server mints the real ids and returns them. The vocabulary is append-only — there is no remove, update, move, or reorder — and one envelope violation refuses the whole batch.

#### Plan it half-static

A pure fan-out with no convergence point is not a plan, it is a leak. Author **Generate-And-Filter**: the planner declares the generator and the downstream consumer statically, and only the middle is dynamic.

- Declare the convergence context (the filter, the judge, the integrator) yourself, in `executionContexts`, unstarted and downstream of the generator. A generated context may only rejoin a context the planner already declared and that has not started.
- Write the generator's task instructions to carry the exact payload shape, including BOTH edges per generated context: `generator → candidate` so it becomes eligible, and `candidate → filter` so the fan-out converges. The engine refuses a candidate nothing in the batch reaches (`expansion-context-unreachable`), but it does NOT require the onward edge — a candidate with no edge into the filter runs and is then simply never read. The instruction has to carry that half.
- Write the filter's acceptance criteria against a set whose size is unknown — "considers every candidate that ran and names one winner", never "compares the three candidates".
- One expansion is one proposition. Instruct the generator to fan out in a single batch, not to append candidates as it thinks of them.

The generated children inherit the invoker's PROTECTED config — context validator, agent-validation command access, human approval gate, ask-user-questions, collaboration, plan repair, and mutability — and cannot override any of it, so an expansion can never weaken a child's gates. They may tune `implementer`, `iterationPolicy`, `circuitBreaker`, and `scriptValidator`, optionally seeded from an existing context via `configFromContextId`. An `implementer` override is a complete profile-bearing assignment, and a script override may add command names but may not remove any inherited command. Expansion authority itself always resolves OFF on a generated child: the fan-out is one level deep by construction.

#### The caps

Every expansion is bounded, and the per-context and per-execution budgets are counted from permanent acceptance receipts — removing a generated context never returns budget:

- **Per request** — 5 contexts, 25 tasks, 40 edges, 64 KB of canonical JSON.
- **Per adding context** — 10 generated contexts, cumulative across everything that context has had accepted.
- **Per execution** — 25 generated contexts, cumulative. Seed contexts and loop-pass clones do not count against it.

Plan inside them: if a generator could plausibly want more than five branches, the fan-out needs a different decomposition, not a second batch.

`requestId` is single-use and is the idempotency key. Re-running the identical payload replays the original receipt and never fans out twice; a payload that CHANGED under a used `requestId` is refused. Tell the generator that in its instructions — a retrying agent that invents a new id on every attempt will fan out twice.

#### What expansion is not for

- Adding work to the context's OWN backlog — that is `cctl workflow task add` under `mutability.allowAgentTaskAdd`.
- Reshaping the plan. Removing, re-pointing, or re-scoping existing contexts is an operator edit (`cctl workflow live edit` on a paused execution), never an agent one.
- Running inside a loop body. A context inside an active loop may not expand; loops are seed-authored only.

## Common Failure Modes

Guard against these before starting execution:

- Implementer/validator misalignment: acceptance criteria judge behavior the implementer was not instructed to build.
- Ambiguous criteria: validator keeps discovering new edge cases because the state contract was underspecified.
- Contradictory criteria: design says a capability is gated, while acceptance criteria require it to work as runtime-applied.
- Missing context: implementer gets only a task slice while validator expects whole-design behavior.
- Overbroad contexts: one context owns mutation routing, lifecycle hooks, backend adapters, diagnostics, and retry semantics.
- Parallelism without foundation: independent-looking contexts secretly need the same unresolved contract.
- Script validator deadlock: deterministic commands are selected for a context that intentionally ends in an invalid intermediate state.
- Unowned wiring: a capability's consumer is fully specified while no context's criteria require the production caller — every context passes locally and the composed runtime path is dead until (at best) final verification.
- Invariants by rediscovery: cross-cutting rules live only in deep spec documents, so each implementer independently misses them and validators re-teach the same lesson context after context. Declare them once in `charter.invariants`.
- Guard on an unpublished shape: an edge guards on a field the source's `outputSchema` never declares. Refused at accept time, but the same mistake made loosely — guarding on a field the source declares and never populates — passes validation and silently routes nowhere.
- Prose verdicts: a loop's exit or a classifier emits a free-form recommendation instead of a machine-checkable field, so `until` and the guards can never be satisfied. The verdict is a `const`/`enum`/bounded number; the narrative goes in a separate handoff field.
- Criteria written against a known branch count: a Generate-And-Filter consumer whose acceptance criteria say "the three candidates" fails the moment the generator picks two.
- Unbounded loops by optimism: `maxPasses` set high "just in case". Exhaustion is a halt, so a generous cap converts a converging loop's failure into a late, expensive one; set it to the number of passes the work should plausibly need.

## Final Verification Context

For substantial workflows, add a final verification context after all implementation contexts. Its job is to review the design end to end, verify wiring across contexts, and add remediation tasks (mutability must be enabled for this context in order for it to add tasks).

The final context should:

- Read the full design and requirements, not only prior summaries.
- Verify that each implemented surface is connected to the runtime path the user will exercise.
- Check that gated or unavailable behavior is honestly represented.
- Select `scriptValidator.commands` only if the whole workflow should satisfy those checks at that point.

The final verification context is **defense in depth** for reachability, not the primary proof — each capability context proves its own production wiring or names its downstream owner (Planning Procedure step 4). Bound the review's acceptance criteria: enumerate the surfaces to check rather than writing "every implemented surface", and route large gaps into remediation tasks with their own bounded criteria. An unbounded audit-and-remediate predicate is a scope ratchet — each fix adds new surface to which the same standard applies — and a fixed circuit-breaker threshold will eventually halt a converging loop.

## Authoring and Submitting the Plan

Author the workflow as a `.cc/temp/plan.json` file — keep it under `.cc/temp/`, which CC git-ignores, so the throwaway plan is never committed — then submit it with the `cctl` CLI. Never paste a whole workflow graph as inline tool arguments — a file you can iterate on is the interface.

### plan.json shape

A plan is a JSON object the validate, create, and replace endpoints all accept:

```json
{
  "name": "Add OAuth2 Support",
  "description": "What this workflow achieves (optional).",
  "definition": {
    "charter": {
      "mission": "…",
      "invariants": [ { "id": "server-side-enforcement", "statement": "…" } ],
      "sourcesOfTruth": [ /* ranked entries */ ]
    },
    "parameters": [],
    "executionContexts": [
      { "id": "auth-setup", "title": "Authentication Setup", "acceptanceCriteria": "…" }
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

- `definition.charter` is required: a non-empty `mission` plus a ranked `sourcesOfTruth` list (each entry: `rank`, `id`, `label`, `type`, `locator`, `description`, `accessPolicy`) declaring the source-of-truth precedence hierarchy.
- `definition.charter.invariants` is optional but expected for multi-context plans (Planning Procedure step 5): a list of `{ "id", "statement" }` entries with unique kebab-case ids. Invariants render into every implementer and validator prompt, and validators check each applicable invariant, citing its id in issues.
- Each task needs an explicit `order` (1-based, per context, in the sequence tasks should run inside that context) and a unique `id`. Each edge needs a unique `id`.
- The dynamic-control-flow declarations are all optional and all omitted by default: `edges[].when` (guards), per-context `routing.cardinality`, per-context `outputSchema`, per-context `mutability.allowAgentContextAdd`, and `definition.loopGroups`. Omit each unless the plan actually needs it — see [Dynamic Control Flow](#dynamic-control-flow).
- `schemaVersion`, `workflowConfig`, `parameters`, `prerequisites`, and every optional per-context/per-task field default when omitted — keep the payload minimal (see [Defaults and Payloads](#defaults-and-payloads)).
- `layout` is required, but positional detail is not: `{ "workflowId": "plan", "contextPositions": {} }` is enough. The builder arranges nodes and the real workflow id is assigned on create.
- Author a global cross-project template (`{{inputs.<name>}}`-parameterized) through the Templates UI, not this project-scoped create flow.

### Submit flow

Run these from the session (the CLI reads its project/session identity from the environment):

1. `cctl workflow validate --file .cc/temp/plan.json` — runs the exact create-path checks (schema parse + dependency cycles, unknown context refs, prerequisite sanity) plus resolution of every agent profile reference the plan names, and persists nothing. On issues it exits non-zero and prints one issue per line with its JSON path (e.g. `definition.tasks.2.contextId: …`). Assignment issues read the same way whichever check produced them: the path locates the offending field (`definition.executionContexts.2.contextValidator.assignments.1.profile`) and the message names the qualified `tier:id` and the exact use site. Fix the file and re-run until it prints the create hint. Add `--tier global` when the plan is destined for the cross-project template library, so the global-document reference rule is applied here rather than at save.
2. `cctl workflow create --file .cc/temp/plan.json` — saves the definition and prints its id. The user reviews and edits it in the visual builder before starting.
3. `cctl workflow start <id>` — starts execution.

To revise a saved definition after user feedback, prefer **targeted edits** — cost proportional to the change, not the whole plan:

1. `cctl workflow get <id>` — read the compact **outline** (context/task ids, deps, prose sizes, the current `revision`, and a `staffing (references)` block listing every authored assignment by scope, role, id, qualified profile ref, strategy, and runtime). Pull only the piece you will change with `--task <id>` / `--context <id>` / `--charter` / `--config` / `--params`.
2. Author `.cc/temp/ops.json` — `{ "baseRevision": <the revision the outline showed>, "operations": [ … ] }` — using the domain ops (`update-task`, `add-context`, `add-task` with a relative `position`, `add-edge`, `update-workflow-config`, a config field set to `null` clears an override, …). The batch is ordered, atomic, and lands behind the **same** accept-time validation as `create` — including profile-reference resolution, so a batch that stages a dangling assignment is refused whole, with the same located `tier:id` and use site `validate` would have printed.
3. `cctl workflow edit <id> --file .cc/temp/ops.json` (add `--dry-run` to pre-flight a risky batch). A stale `baseRevision` exits with `revision_conflict` — re-read and retry.

Use `cctl workflow replace <id> --file .cc/temp/plan.json` only for a **wholesale recomposition** — get it first with `cctl workflow get <id> --full`, submit the complete graph, re-validate first. Editing (or replacing) a saved definition does NOT mutate a running execution — it uses its own working copy; tell the user when a fresh execution or reset is needed.

### Before submitting, confirm

- The `graph-workflow-planning` skill was used.
- No known design contradictions remain unresolved.
- Every context has non-empty, context-local acceptance criteria.
- Every runtime capability the plan introduces has a producer context whose acceptance criteria require the production call site, or a criterion naming the downstream context that owns the wiring.
- Cross-cutting rules are declared once in `charter.invariants` rather than repeated inconsistently (or omitted) across contexts.
- Optional implementer and validator settings are omitted unless the user requested them or a specific context requires them.
- Every agent profile reference was read from `cctl agent list`, not invented, and a context that overrides a cohort restates every assignment it wants (assignments replace whole, never merge).
- Any selected `scriptValidator.commands` run only after contexts expected to leave those checks valid.
- Agent command access is intentional per role; implementers retain the test command access needed for TDD even when the script gate selects tests.
- `laneMergeValidation` is set only at the workflow tier when the project-level lane-merge policy is not appropriate.
- Essential context is included in task instructions or produced as an upstream shared artifact.
- Parallel branches are truly independent or have an explicit foundation edge.
- Every guarded edge's source declares an `outputSchema`, and every guard reads a field that source actually populates.
- Every conditional fan-out either covers its source's whole value set or carries an `else` edge, and no acceptance criterion's only covering context sits behind a guard.
- Every loop group has a machine-checkable exit verdict, a `maxPasses` matched to the work, and a handoff field on each body context the next pass builds on.
- Every expansion-authorized context has a statically declared, unstarted convergence target downstream, and a plausible fan-out fits inside the per-request cap.
- `cctl workflow validate` passes on the final `.cc/temp/plan.json`, and any warnings it prints are answered rather than ignored.
