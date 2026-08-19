---
name: graph-workflow-review
description: Use when reviewing a graph workflow plan — judging a plan.json against its charter and cited sources before it is created or replaced, writing the findings artifact, or recording the terminal verdict with cctl workflow review. Triggers on "review this graph workflow plan", "review the plan.json", "record a plan review verdict", or checking which verdict a plan revision already carries.
---

# Graph Workflow Plan Review

You are reviewing ONE plan revision and recording a terminal verdict bound to it. The planning rules live in the [graph-workflow-planning](../graph-workflow-planning/SKILL.md) skill; this skill is the reviewer's half only — which lenses to apply, what a finding must say, and how to record the result.

## The rubric is the planning skill

Do not invent a checklist. The completeness rubric is already written:

- The planning skill core's **Before submitting, confirm** list is the top-level pass. Every line is a checkable claim about the plan in front of you.
- Each reference file carries its own checklist for the machinery it owns (placement, dynamic control flow, validation and staffing, revision and recovery). Read the reference for machinery the plan actually uses; skip the rest.

Read, in order: the `plan.json`, its `definition.charter` (mission, invariants, sourcesOfTruth), and the sources it cites. A source locator you cannot open is itself a finding — no agent in a lane worktree will open it either.

Run `cctl workflow validate --file <plan.json>` before reading closely. Structural refusals and `warning:` lines are mechanical pre-clearing, and a plan too malformed to parse cannot be hashed — the review commands themselves reject it as an invalid plan. Spending review attention on what the validator already prints wastes the pass.

## Two lenses, weighted equally

**Completeness — does the plan deliver the objective?**

- *Missing outcome*: an objective in the governing sources that no context's acceptance criteria claim.
- *Dead handoff*: a context produces something (a contract, a schema, an output field, a shared document) that no downstream context consumes, or consumes something no upstream context produces. The sharpest case is unowned wiring — a capability whose consumer is specified while no context's criteria require the production call site.
- *Uncovered requirement*: a requirement, invariant, or deferral chain that terminates nowhere. Every "verified in context X" must land in a criterion record inside X.

**Executability and minimality — can the agents this plan staffs actually run it, and is this the smallest plan that does?**

- *Overloaded context*: criteria that no single validator round can weigh, or a context spanning subsystems that share no validation thesis.
- *Misplaced obligation*: a criterion homed where it cannot be satisfied — an end-state invariant binding a mid-migration context, wiring demanded of a context that does not own the call site, a whole-repo script gate on an intentionally invalid intermediate state.
- *Contradictory phase*: two attached sources, or two criteria, requiring incompatible states of the same surface. Execution has no arbiter; the disagreement resolves differently in each context and collides at a join.
- *Redundant criterion*: two records that can only pass or fail together, a criterion restating a charter invariant, or a criterion asking an LLM validator to re-judge what a script gate decides deterministically.

The second lens is not the junior partner. A review that can only add obligations inflates the plan it was meant to make executable — that one-sided incentive is the incident this protocol corrects.

## Findings are phrased as repairs

Prefer **move, delete, defer, split — before add.** Reach for an addition only when the completeness lens found a real gap and no existing context can absorb it.

Each finding names three things:

1. **Lens** — completeness or executability.
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

**Terminal verdicts only.** Record nothing until the review is finished. An aborted, interrupted, or partial review leaves NO record — a canceled review passed off as a completed verdict is the incident that earned this skill. There is no draft state and no in-progress verdict, by design: the only thing worse than an unreviewed plan is a plan everyone believes was reviewed.

**Hash binding.** The verdict binds to the exact plan content reviewed. Reformatting or reordering the same plan finds the same review; changing one word finds none. Any repair therefore invalidates the review — the repaired plan is a different revision, and the final revision the planner submits is the one that needs a verdict on it. Re-review that revision; a verdict never carries forward by hand.

## What the verdict does

- **Approved or unreviewed** blocks nothing. Review presence is never required.
- **Changes-requested** makes `cctl workflow create` and `cctl workflow replace` refuse that exact revision with code `review-changes-requested-unacknowledged` until the submitter passes `--acknowledge-review <hash>`. The refusal hands them the revision hash, your identity, the review time, and the command that retrieves your findings. `cctl workflow validate`, `cctl workflow run`, and `cctl workflow start` are never gated.
- The acknowledgement gate is a read receipt, not an approval gate: a planner may consciously acknowledge and proceed. The findings survive either way.
- The latest terminal verdict for a revision is the one that counts, so an approved review recorded afterward for the same hash clears the gate.
