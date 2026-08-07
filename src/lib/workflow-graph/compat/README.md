# Pre-D4 compatibility harness

D4 must be additive and dormant by default: a definition or persisted execution
that carries none of D4's fields has to parse at the floor (unconditional edges,
no loops, expansion disabled) and execute exactly as it did before D4 — same
scheduling decisions, same context status transitions, same typed event
sequence, modulo timestamps and generated identifiers.

This directory is the mechanical check for that claim.

## What is here

| Path | What it is |
|---|---|
| `fixtures/*.definition.json` | Authored definitions at the current non-D4 schema floor, with every D4 field omitted. |
| `fixtures/linear-chain.execution.json` | A persisted execution at the current non-D4 schema floor, with every D4 field omitted. |
| `recordings/*.json` | The three projections each fixture produced on the pre-D4 engine. |
| `engine-harness.ts` | Runs a fixture through the real engine with deterministic fake agents and records the projections. |
| `projections.ts` | The projection vocabulary and the timestamp/id normalization. |
| `floor.ts` | The D4 field inventory and the parse-floor probes. |
| `scenarios.ts` | The corpus: which fixtures exist, what each one's fake agent does, how recordings are read and written. |

## What the harness actually runs

Everything that decides control flow is production code:

- the execution loop;
- the workflow manager (so `getEligibleContextIds` and
  `classifyContextSchedulability` make the real scheduling calls);
- the **iteration orchestrator** — seeding, conversation resolution, task
  binding, task completion, context validation, and finalization all run through
  `createGraphWorkflowIterationOrchestrator`, not a stand-in;
- lane continuity over the durable `createGraphLaneStore`;
- the validation service;
- the execution repository over a real SQLite persistence fixture;
- the typed event publisher, the context-transition owner, and the join runner.

Only three things are faked, and each is deliberately outside the compatibility
claim: the implementer agent turn (a scripted `complete-next-task` /
`no-task-progress` decision, which reaches the engine only through the lane tool
server's `completeTask` — the same seam `cctl workflow task complete` drives),
the context-validator agent turn (a scripted verdict returned through the
production validation service), and the git side effects (worktree provisioning,
commits, merges).

## Scenarios

- **`linear-chain`** — a three-context chain, one context with two tasks. Covers
  solo scheduling, multi-iteration progress within a context, and the final
  publish join.
- **`parallel-fan-in`** — a diamond. Covers lane provisioning, a parallel batch,
  a `context_merge` join, and publication.
- **`iteration-halt`** — a context whose work never finishes. Covers iteration
  accounting, the `max_iterations` halt, drain, and a downstream context that
  must never become eligible.
- **`validator-reopen`** — a context whose validator refuses once. Covers task
  reopening, the consecutive-failure accounting, the retry iteration, and the
  eventual pass.

## Working on a D4 slice

Run `bun run test src/lib/workflow-graph/compat/` alongside your slice's own
tests. A green run means the slice is dormant on pre-D4 input.

If a recording breaks, the default assumption is that the slice is **not**
additive — a new field defaulted to something non-floor, a new event fired on an
unconditional path, or scheduling changed shape. Fix the slice.

Regenerating a recording is a deliberate claim that observable pre-D4 behaviour
genuinely and correctly moved. It needs a reviewer to agree, and it is done with:

```bash
CC_UPDATE_COMPAT_RECORDINGS=1 bun run test src/lib/workflow-graph/compat/observational-equivalence.test.ts
```

The fixtures under `fixtures/` are a semantic baseline, not byte-frozen legacy
artifacts. Rebaseline them deliberately when a foundational, non-D4 contract
changes (for example assignment identity or validator cohorts), while continuing
to omit every D4 field. Recording changes remain a separate claim about
observable behaviour and require the review process above.

## Adding a D4 field

Add it to `D4_ADDITIVE_FIELDS` in `floor.ts` in the same change that adds it to
the schema. A field the inventory does not name is invisible to the parse-floor
probes, so the floor test would pass without ever looking at it.

The floor is **semantic**, not omission-based: R14 requires a pre-D4 input to
parse as unconditional / no-loop / expansion-disabled, and a post-D4 schema is
free to materialize every additive field at its dormant default. `false`, `null`,
`[]` and `{}` all read as dormant; only a value that is actually turned on moves
the verdict.

Expansion authority is probed by value across the whole `mutability` block rather
than by one guessed key name, so it survives whatever the flag is called. It
recognises `true` (directly or nested). A slice that represents expansion
authority as something other than a boolean — an enum, a policy object with a
non-boolean "on" leaf — must teach `grantsExpansionAuthority` that shape in the
same change, or the probe reads it as dormant.

`projectTypedEvent` in `projections.ts` is an exhaustive switch over the typed
event union: a new event kind will not compile until it is projected, which is
what stops a new kind from silently escaping the recording.
