# Workflow Vision Roadmap

This roadmap breaks the workflow direction in [VISION.md](./VISION.md) into separate
deliverables and proposes an implementation order. It is a planning document, not a
spec; each deliverable gets its own functional spec and technical design when picked up.

Ordering logic: land the in-flight mutation surface first (everything "dynamic" builds
on it), pull the highest-leverage-per-effort item forward (circuit-breaker plan repair),
build engine dynamism before cost-reduction, and defer the DSL decision until the real
building blocks exist to compile into.

## Deliverables

### D0 — Land the live-mutation surface (landed on main; verification closeout remains)

Both halves are already on `main` — the earlier "implemented, uncommitted" / "not
started" framing was stale:

- Doc 05 definition editing landed as `0ad3bf4f` (2026-07-07): `cctl workflow edit`,
  outline-by-default `get`, PATCH endpoints, `applyDefinitionEdits`.
- Doc 06 live editing landed as `476f2e8f` (2026-07-08), slices 1–4: lifecycle
  classifier, `applyLiveExecutionEdits` + frontier invariant, `liveRevision` guard,
  live-edit SSE, `cctl workflow live get|edit|pause|resume`, server-side live outline,
  and the inspector Config tab with live editing. Slice 5 (UI structural forms) was
  always phase 2 and is not part of D0.

What remains is verification, not implementation: production audit rows show the
lane-agent `add_task` path well exercised, but only one CLI live edit and zero UI
edits have ever been applied to a real execution — the canonical pause → edit →
resume loop, structural ops, dry-run, and revision-conflict recovery have no live
evidence. Closeout plan: [docs/plans/phase-0-closeout.md](./plans/phase-0-closeout.md).

### D1 — Circuit-breaker plan-repair agent

On a circuit-breaker trip (and optionally every validation failure), an agent reviews
the failure transcript and, if the root cause is a planning defect, patches the
charter/AC/plan artifacts via the D0 edit surface and resumes. A deliberately scoped
first slice of the "owning agent": it needs only D0, not the rest of the orchestration
vision, and it attacks the single biggest observed failure mode — impossible-to-satisfy
acceptance criteria burning iterations (see the native-SDD workflow audits).

### D2 — Structured output for execution contexts

An `outputSchema` on an execution context; the implementer's final output is validated
through the existing structured-output gate and persisted where downstream contexts
(and later, conditional edges) can consume it. Small: the gate, candidate extraction,
and the approved ticket #18 (Option B) design already exist. This is the data plane
that Classify-And-Act, Generate-And-Filter, and Tournament verdicts all require.

### D3 — Specialist validators and implementors

Multiple named context validators per context, each with a custom prompt/focus
(security, type safety, etc.), plus configurable implementor personas — extending the
existing `contextValidator`/`implementer` config cascade rather than new machinery.
Independent of everything else, an immediate quality win, and multiple adversarial
validators is already most of the Adversarial Verification pattern in first-class form.

### D4 — Dynamic graph primitives

The core engine work, three capabilities:

- **Conditional paths** — edges/contexts activated based on a D2 structured output
  (Classify-And-Act).
- **Runtime graph expansion** — generalize `mutability.allowAgentTaskAdd` from tasks to
  contexts, so an agent can fan out N candidate contexts or add a remediation branch
  (Generate-And-Filter, dynamic fan-out).
- **General loops** — a loop construct with an agent- or schema-evaluated exit
  condition, beyond the built-in validation/task-completion loop (Loop-Until-Done).

All of this must ride the loop-fence and frontier invariants — dynamic mutation goes
through the same choke point as D0, not around it.

### D5 — Lightweight parallelism

Same-worktree parallel lanes with a file-ownership list for coordination, and
agent-planned lane assignment replacing deterministic assignment. This changes the cost
model: Fanout-And-Synthesize with eight readers or a tournament bracket should not
require eight worktrees and eight fan-in merges. Also tests the vision's hypothesis
that agent-planned lanes execute more efficiently.

### D6 — Pattern proving ground

Author all six blog patterns (and one composite) as real templates/executions and fix
what breaks. An explicit milestone closing Phase 3 rather than an assumption — it is
the vision's stated goal, and it produces the evidence for "when is first-class pattern
support justified."

### D7 — Ephemeral, conversation-spawned workflows

An agent in a normal conversation creates and runs a workflow with no persistent
template — a `cctl` surface that accepts a definition inline, executes it (the
`workingDefinition` snapshot model already means executions don't structurally need a
saved template), and returns results to the spawning conversation. Sequenced after D5
because ephemeral workflows are only attractive once execution is light.

### D8 — Owning/orchestrating agent (full)

An agent owns an execution end-to-end: monitors progress, dynamically adjusts the graph
(D0 + D4), resolves halts, spawns sub-work (D7). The capstone — it composes every prior
deliverable, which is exactly why it goes last among the feature work.

### D9 — Workflow DSL (decision point, not a commitment)

Re-evaluate after D6/D7. The DSL's stated purpose is easing planning; the pattern
library, ephemeral creation, and the planning skill may have already addressed that
pain more cheaply. If planning is still the bottleneck, the DSL compiles pattern-level
constructs into the by-then-proven D4 building blocks.

## Proposed order

| Phase | Deliverables | Why here |
|---|---|---|
| 0 | D0 land doc 05 + doc 06 | Mutation surface everything dynamic depends on |
| 1 | D1 plan-repair, D2 structured output, D3 specialist validators | Mutually independent; highest value-per-effort; can run in parallel |
| 2 | D4 dynamic graph primitives | Needs D2 for branching; the pattern enabler |
| 3 | D5 lightweight parallelism → D6 pattern proving ground | D5 makes fan-out patterns affordable; D6 validates the vision's central goal |
| 4 | D7 ephemeral workflows | Worthwhile once execution is light |
| 5 | D8 orchestrating agent | Composes D0, D4, D7 |
| 6 | D9 DSL decision | Deferred until evidence exists either way |

Pattern coverage milestones:

- After Phase 2: Classify-And-Act, Generate-And-Filter, Loop-Until-Done, and
  Adversarial Verification (via D3) are expressible.
- After Phase 3: Fanout-And-Synthesize and Tournament become cost-effective; D6 proves
  all six.

## Open decision points and constraints

- **The one real fork — resolved (2026-07-29):** the charter-amendment seam is built
  (`docs/design/cc-cli/07-workflow-charter-amendments.md`): a live `amend-charter` op
  with a required rationale, a versioned metadata amendment log rendered into every
  future prompt and `charter.md`, and `cctl workflow live get --charter`. Combined
  with `update-context` (AC/tasks/prose/config) and resumable-editable
  `circuit_breaker` halts, the full halt → repair (plan artifacts *and* charter) →
  resume loop is scriptable today. D1 has no remaining mutation-surface dependency;
  its open design questions are trigger policy (breaker-trip only vs. every
  validation failure) and the repair agent's prompt/persona.
- D2 and D3 are good candidates to run as parallel specs; they touch disjoint
  config/engine areas.
- Everything here composes the existing primitives per the adoption matrix in
  `.kiro/steering/workflows.md` — no fourth orchestration shape; D4 stays inside the
  graph engine's deterministic loop and fencing.
- "Keep task-completion loop & context validators first-class" (VISION.md) is a
  constraint on D4, not a deliverable: general loops are additive, not a replacement.
