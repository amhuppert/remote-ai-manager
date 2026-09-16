---
name: graph-workflow-review
description: Review a graph workflow plan against its charter and sources, write actionable findings, and read or record the terminal verdict bound to that revision.
---

# Graph Workflow Plan Review

You are reviewing ONE plan revision and recording a terminal verdict bound to it. The planning rules live in the [graph-workflow-planning](../graph-workflow-planning/SKILL.md) skill; this skill is the reviewer's half only — which lenses to apply, what a finding must say, and how to record the result.

## The rubric is the planning skill

Do not invent a checklist. The completeness rubric is already written:

- The planning skill core's **Before submitting, confirm** list is the top-level pass. Every line is a checkable claim about the plan in front of you.
- Each reference file carries its own checklist for the machinery it owns (placement, dynamic control flow, validation and staffing, revision and recovery). Read the reference for machinery the plan actually uses; skip the rest.

Read, in order: the `plan.json`, its `definition.charter` (mission, invariants, sourcesOfTruth), and the sources it cites. Verify each source from the substrate its context will read. A committed path must resolve from the lane's base; a seeded document can be inspected in `definition.seededDocuments` and is materialized at launch. Report an unavailable source when neither mechanism supplies it.

Run `cctl workflow validate --file <plan.json>` before reading closely. Structural refusals and `warning:` lines are mechanical pre-clearing, and a plan too malformed to parse cannot be hashed — the review commands themselves reject it as an invalid plan. Spending review attention on what the validator already prints wastes the pass.

## Three lenses, weighted equally

**Completeness — does the plan deliver the objective?**

- *Missing outcome*: an objective in the governing sources that no context's acceptance criteria claim.
- *Dead handoff*: a context produces something (a contract, a schema, an output field, a shared document) that no downstream context consumes, or consumes something no upstream context produces. The sharpest case is unowned wiring — a capability whose consumer is specified while no context's criteria require the production call site.
- *Uncovered requirement*: a requirement, invariant, or deferral chain that terminates nowhere. Every "verified in context X" must land in a criterion record inside X.

**Executability and minimality — can the agents this plan staffs actually run it, and is this the smallest plan that does?**

- *Overloaded context*: criteria that no single validator round can weigh, or a context spanning subsystems that share no validation thesis.
- *Misplaced obligation*: a criterion homed where it cannot be satisfied — an end-state invariant binding a mid-migration context, wiring demanded of a context that does not own the call site, a whole-repo script gate on an intentionally invalid intermediate state.
- *Contradictory phase*: two attached sources, or two criteria, requiring incompatible states of the same surface. Execution has no arbiter; the disagreement resolves differently in each context and collides at a join.
- *Redundant criterion*: two records that can only pass or fail together, a criterion restating a charter invariant, or a criterion asking an LLM validator to re-judge what a script gate decides deterministically.
- *Process criterion*: a record or invariant that names how the work must be produced (a failing test first, a command order) rather than what must be true afterwards. Validators cannot verify process on the finished candidate, so honest work fails for lacking proof. Repair: move it to `charter.conventions`, or restate it as the outcome it protects.

Weigh executability alongside completeness: adding obligations without considering scope can make a complete plan impractical to execute.

**Feasibility — are the premises true and the proof surface bounded?**

- For every criterion that displays, reconstructs, audits, or asserts runtime state, open each cited source and confirm the premise against the authoritative record and field, the transition in the state machine, or state the embedder controls. A planner's **verified** label is a claim to check, not evidence by itself. An unreadable citation, a source that does not establish the claimed fact, or an inferred premise is a blocking finding: record `changes-requested` until it is verified or the criterion is repaired. This blocks review approval under the existing advisory review protocol; it adds no launch gate.
- For provider-owned or remote-mutable state, check that the criterion requires the strongest exposed control, enumerates higher-precedence sources, and discloses the residual. For intentionally introduced data or transitions, check the named producer's criterion and dependency instead of assuming the feature already exists.
- For several surfaces or verbs, require a surface-by-verb matrix with named tests or a split. A context with two authoritative data models or two proof strategies needs separate validation boundaries; a small record count does not discharge breadth.

This lens applies the planning skill's **Premise rule**.

## Findings are phrased as repairs

Prefer **move, delete, defer, split — before add.** Reach for an addition only when the completeness lens found a real gap and no existing context can absorb it.

Each finding names three things:

1. **Lens** — completeness, executability, or feasibility.
2. **Location** — the `contextId`, plus the `criterionId` when the finding is about one acceptance criterion; a charter-level finding names the invariant id or source id instead.
3. **Recommended repair** — concrete enough for the planner to apply without a follow-up conversation, in the move/delete/defer/split/add vocabulary.

Write the artifact as a markdown file under `.cc/temp/` (git-ignored) and pass it with `--findings`. It is the whole substance the planner sees: they may be a fresh session with no access to this conversation.

## Recording the verdict

Read the current state first — this exact revision may already carry one:

```
cctl workflow review --file .cc/temp/plan.json
```

Record a terminal verdict:

```
cctl workflow review --file .cc/temp/plan.json --verdict approved
cctl workflow review --file .cc/temp/plan.json --verdict changes-requested --findings .cc/temp/findings.md
```

- `--file <plan.json>` is required in both modes; the plan is posted whole and hashed server-side, so the CLI never computes an identity of its own.
- `--verdict approved|changes-requested` selects record mode. Without it the command reads.
- `--findings <path>` is record-mode only (passing it without `--verdict` is a usage error) and is **required for changes-requested** — a verdict without the artifact that justifies it is refused. It is kept on an approved verdict too, so approving with notes preserves them.
- `--reviewer <conversation-id>` defaults to `CC_CONVERSATION_ID`, so a review recorded from the reviewing conversation captures reviewer identity automatically. Pass it by hand only when recording from somewhere else.
- `--json` for the structured envelope.

Read mode prints the verdict, the reviewer, when it was reached, the revision hash, the findings artifact in full, and ready-to-run commands that open the reviewer's own conversation (`cctl conversation read <id> --outline`, plus `cctl conversation compaction get <id> --json` when a completed compaction exists) — that is how a planner in a fresh session recovers the deliberation behind a finding. An unreviewed revision reads back as `plan review: none recorded for this revision (advisory)` and exits 0: nobody having reviewed it is an ordinary answer, not a failure.

## Two hard rules

**Terminal verdicts only.** Record nothing until the review is finished. An aborted, interrupted, or partial review leaves NO record. There is no draft state or in-progress verdict; recording a verdict means the review of that revision is finished.

**Hash binding.** The verdict binds to the exact plan content reviewed. Reformatting or reordering the same plan finds the same review; changing one word finds none. Any repair therefore invalidates the review — the repaired plan is a different revision, and the final revision the planner submits is the one that needs a verdict on it. When review is requested for the revised plan, review that revision; a verdict never carries forward by hand.

## What the verdict does

- **Approved or unreviewed** blocks nothing. Review presence is never required.
- **Changes-requested** makes `cctl workflow create` and `cctl workflow replace` refuse that exact revision with code `review-changes-requested-unacknowledged` until the submitter passes `--acknowledge-review <hash>`. The refusal hands them the revision hash, your identity, the review time, and the command that retrieves your findings. `cctl workflow validate`, `cctl workflow run`, and `cctl workflow start` are never gated.
- The acknowledgement gate is a read receipt, not an approval gate: a planner may consciously acknowledge and proceed. The findings survive either way.
- The latest terminal verdict for a revision is the one that counts, so an approved review recorded afterward for the same hash clears the gate.
