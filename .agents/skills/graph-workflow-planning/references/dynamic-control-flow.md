# Dynamic Control Flow

Reference for [graph-workflow-planning](../SKILL.md). Read this when a plan needs conditional branches, a repeat-until loop, or a runtime fan-out whose branch count is unknowable at planning time.

Beyond the static DAG, three primitives let one plan express a shape it could not before: **conditional edges** (a branch runs only when the upstream verdict selects it), **loop groups** (a body repeats until a predicate is satisfied), and **runtime graph expansion** (a running implementer appends contexts it could not have known about at planning time).

All three are deterministic and engine-evaluated. Agents supply judgment ONLY as typed structured output — a captured `outputSchema` payload — and the engine decides. There is no agent-evaluated condition, no agent-declared loop, and no free-form routing instruction. Every routing, expansion, and loop decision is recorded durably and is readable afterwards.

Reach for them in this order: a static DAG when the shape is known; conditional edges when the shape is known but which parts run is not; a loop when the same work may need repeating an unknown number of times; expansion only when the NUMBER of parallel branches is genuinely unknowable until a context runs.

## Conditional Edges: Guards, Cardinality, and `else`

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

### Cardinality

By default a source's conditional branches are independent: zero, one, or many may activate. Declare a stricter contract on the SOURCE context — it is a property of the outgoing edge SET, not of one edge:

```json
{ "id": "triage", "title": "Triage", "acceptanceCriteria": "…", "routing": { "cardinality": "exactlyOne" } }
```

- `independent` — the meaning of an absent `routing` block; any number of branches may activate.
- `atLeastOne` — under-selection halts the run.
- `exactlyOne` — under- OR over-selection halts the run.

The halt is `routing_cardinality` and it is resumable: `cctl workflow live pause`, amend the guard set or the policy with `cctl workflow live edit`, `cctl workflow live resume`. The completed source is never re-run and never re-decided.

Pairing `exactlyOne` with an `else` edge is the Classify-And-Act shape: the `else` makes under-selection impossible, so a `routing_cardinality` halt can only mean two guards genuinely overlap — a real authoring bug rather than an unrouted value.

### The branch not taken

A context whose incoming route is inactive is **skipped**: a terminal status with a recorded reason, not a failure and not a retry. Skips propagate down the guarded subtree, and a skipped context's downstream agents are told the branch was not taken rather than being left to infer it.

An unconditional edge from a skipped source resolves as *omitted* — it drops out of the conjunction rather than skipping the target outright, so a fan-in with one live branch and several skipped ones still runs. A target whose incoming edges are ALL omitted has nothing left to wait for and skips too, which is how a skip carries down an unconditional chain.

Two authoring consequences:

- **Never guard away the only context that covers an acceptance criterion.** The engine refuses a live edit (and the spec compiler refuses a plan) that leaves a linked criterion with no context that runs on EVERY path. A guard on an ANCESTOR edge takes coverage away exactly as a guard on the covering context's own edge does.
- **Skipped is terminal.** There is no reroute and no un-skip. If a branch might be needed after all, guard it so it can activate, rather than planning to revive it.

## Loop Groups: Repeating a Body Until a Verdict

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

### Worker + judge bodies

The body worth reaching for first is two contexts: a **worker** that does the work, and an independent **judge** that assesses it. Make the judge the exit, so the verdict the loop settles on comes from the reviewer rather than the author:

- Give the judge a narrow `outputSchema` whose verdict field is machine-checkable — an enum, a bounded score, a required boolean. Never prose the engine would have to interpret.
- Write the judge's acceptance criteria as "assessed X against Y and emitted a verdict", not "X is correct". Its job is to judge, and a pass where it correctly says *not yet* is a successful pass.
- Keep the worker's and the judge's instructions independent. A judge told what the worker intended tends to grade the intent.

A one-context body is legal (entry and exit are the same context) and is right when the work and the check are genuinely the same act.

### The handoff field (the worked example)

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

## Runtime Graph Expansion

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
      "placement": { "lane": "candidate-a", "mode": "owned", "ownedPaths": ["src/candidate-a"] },
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

`placement` is required on every generated context and is never inherited from the invoker (`expansion-placement-missing`): sharing a lane is a claim about concurrency and ownership between two specific contexts, and a lane the generator did not choose is exactly the claim it cannot have meant to make. Write the generator's instructions to name a **new** lane per candidate — that is also what tournament fan-outs need, since candidates write the same paths by construction. Two spellings fail:

- Placing a generated context on a lane whose join has already been planned is refused `lane_closed`. Lane membership freezes at join intent and there is no reopen verb, so dynamic work that arrives late targets a new lane.
- Placing it on an existing open lane alongside a member nothing sequences it against requires disjoint `ownedPaths` (`placement-owned-paths-overlap`), exactly as an authored plan does.

### Plan it half-static

A pure fan-out with no convergence point is not a plan, it is a leak. Author **Generate-And-Filter**: the planner declares the generator and the downstream consumer statically, and only the middle is dynamic.

- Declare the convergence context (the filter, the judge, the integrator) yourself, in `executionContexts`, unstarted and downstream of the generator. A generated context may only rejoin a context the planner already declared and that has not started.
- Write the generator's task instructions to carry the exact payload shape, including BOTH edges per generated context: `generator → candidate` so it becomes eligible, and `candidate → filter` so the fan-out converges. The engine refuses a candidate nothing in the batch reaches (`expansion-context-unreachable`), but it does NOT require the onward edge — a candidate with no edge into the filter runs and is then simply never read. The instruction has to carry that half.
- Write the filter's acceptance criteria against a set whose size is unknown — "considers every candidate that ran and names one winner", never "compares the three candidates".
- One expansion is one proposition. Instruct the generator to fan out in a single batch, not to append candidates as it thinks of them.

The generated children inherit the invoker's PROTECTED config — context validator, agent-validation command access, human approval gate, ask-user-questions, collaboration, plan repair, and mutability — and cannot override any of it, so an expansion can never weaken a child's gates. They may tune `implementer`, `iterationPolicy`, `circuitBreaker`, and `scriptValidator`, optionally seeded from an existing context via `configFromContextId`. An `implementer` override is a complete profile-bearing assignment, and a script override may add command names but may not remove any inherited command. Expansion authority itself always resolves OFF on a generated child: the fan-out is one level deep by construction. Scoped charter invariants carry over by logical identity: a generated child inherits the invariants scoped to its adding context.

### The caps

Every expansion is bounded, and the per-context and per-execution budgets are counted from permanent acceptance receipts — removing a generated context never returns budget:

- **Per request** — 5 contexts, 25 tasks, 40 edges, 64 KB of canonical JSON.
- **Per adding context** — 10 generated contexts, cumulative across everything that context has had accepted.
- **Per execution** — 25 generated contexts, cumulative. Seed contexts and loop-pass clones do not count against it.

Plan inside them: if a generator could plausibly want more than five branches, the fan-out needs a different decomposition, not a second batch.

`requestId` is single-use and is the idempotency key. Re-running the identical payload replays the original receipt and never fans out twice; a payload that CHANGED under a used `requestId` is refused. Tell the generator that in its instructions — a retrying agent that invents a new id on every attempt will fan out twice.

### What expansion is not for

- Adding work to the context's OWN backlog — that is `cctl workflow task add` under `mutability.allowAgentTaskAdd`.
- Reshaping the plan. Removing, re-pointing, or re-scoping existing contexts is an operator edit (`cctl workflow live edit` on a paused execution), never an agent one.
- Running inside a loop body. A context inside an active loop may not expand; loops are seed-authored only.

## Failure modes specific to dynamic control flow

- Guard on an unpublished shape: an edge guards on a field the source's `outputSchema` never declares. Refused at accept time, but the same mistake made loosely — guarding on a field the source declares and never populates — passes validation and silently routes nowhere.
- Prose verdicts: a loop's exit or a classifier emits a free-form recommendation instead of a machine-checkable field, so `until` and the guards can never be satisfied. The verdict is a `const`/`enum`/bounded number; the narrative goes in a separate handoff field.
- Criteria written against a known branch count: a Generate-And-Filter consumer whose acceptance criteria say "the three candidates" fails the moment the generator picks two.
- Unbounded loops by optimism: `maxPasses` set high "just in case". Exhaustion is a halt, so a generous cap converts a converging loop's failure into a late, expensive one; set it to the number of passes the work should plausibly need.

## Checklist for plans that use these primitives

- Every guarded edge's source declares an `outputSchema`, and every guard reads a field that source actually populates.
- Every conditional fan-out either covers its source's whole value set or carries an `else` edge, and no acceptance criterion's only covering context sits behind a guard.
- Every loop group has a machine-checkable exit verdict, a `maxPasses` matched to the work, and a handoff field on each body context the next pass builds on.
- Every expansion-authorized context has a statically declared, unstarted convergence target downstream, and a plausible fan-out fits inside the per-request cap.
