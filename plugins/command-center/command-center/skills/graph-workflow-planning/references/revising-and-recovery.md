# Revising Definitions, Monitoring Runs, and Recovery

Reference for [graph-workflow-planning](../SKILL.md). Read this when revising a saved definition after feedback, following a running execution, or understanding halts and the automatic plan-repair response.

## Revising a saved definition with targeted edits

Prefer **targeted edits** over resubmitting the whole plan — cost proportional to the change, not the whole graph:

1. `cctl workflow get <id>` — read the compact **outline** (context/task ids, deps, prose sizes, the current `revision`, and a `staffing (references)` block listing every authored assignment by scope, role, id, qualified profile ref, and runtime). Pull only the piece you will change with `--task <id>` / `--context <id>` / `--charter` / `--config` / `--params` (at most one selector per invocation).
2. Author `.cc/temp/ops.json` — `{ "expectedRevision": <the revision the outline showed>, "operations": [ … ] }` — using the domain ops. An op that carries `acceptanceCriteria` replaces the whole record list, so restate every record the context keeps; the ops are: `update-workflow`, `update-charter`, `update-workflow-config`, `add-context` / `update-context` / `remove-context`, `add-task` / `update-task` / `remove-task` / `move-task` / `reorder-tasks`, `add-edge` / `update-edge` / `remove-edge`, `add-parameter` / `update-parameter` / `remove-parameter`, `add-prerequisite` / `remove-prerequisite`. Operations apply sequentially (later ops see earlier ones — add a context, then its tasks, then its edges in one batch) and atomically (any validation error rejects the whole batch). Task order is never written by hand — place with `position` `{"at":"start"|"end"}` / `{"after":"<id>"}` / `{"before":"<id>"}`. A config or override field set to `null` CLEARS it and restores cascade inheritance.
3. `cctl workflow edit <id> --file .cc/temp/ops.json` (use `workflow edit-preview` for a server preflight, or `workflow edit-check` for local input admission). The batch lands behind the **same** accept-time validation as `create`, including profile-reference resolution — a batch that stages a dangling assignment is refused whole. A stale `expectedRevision` exits with `stale_workflow_definition` — re-read and retry.

Use `cctl workflow replace <id> --file .cc/temp/plan.json` only for a **wholesale recomposition** — get the current record first with `cctl workflow get <id> --full`, submit the complete graph, re-validate first.

Editing (or replacing) a saved definition does NOT mutate a running execution — an execution uses its own working copy. Tell the user when a fresh execution is needed to pick up a definition change.

## Monitoring a run

- `cctl workflow status` — compact per-context table for this session's active execution; `cctl workflow status <executionId> [--json]` addresses any run, including history.
- `cctl workflow wait <executionId> [--cursor <cursor>] [--timeout <dur>]` — block until the run's next needs-attention or terminal boundary; one invocation returns at most one boundary, and the printed cursor continues after it. A timeout leaves the run untouched and prints the reattach command.

## Live-editing a running execution

A running execution's working definition can be edited by the operator without abandoning the run:

- `cctl workflow live get` — what the execution actually resolved (assignments, config, revisions).
- `cctl workflow live pause` → `cctl workflow live edit` → `cctl workflow live resume` — structural edits (contexts, edges, guards, loop policies) require the pause; the edit vocabulary and validation mirror the saved-definition ops.
- `cctl workflow live ledger` — the durable record of routing, loop, and expansion decisions.

Charter amendments made mid-run are recorded in an amendment log written to `charter.md` and the durable record. It does not render into agent prompts: a resumed agent reads the amended rules themselves, not their history, so an amendment has to leave the charter text self-contained.

## Halts a planner should design against

A halt stops the execution durably with a typed reason; most are resumable after an operator (or plan repair) addresses the cause:

- `circuit_breaker` (`retry_exhaustion`) — a context accumulated consecutive validation failures (script or agent) up to its `circuitBreaker.consecutiveFailureThreshold` (seeded default 3).
- `max_iterations` — a context exhausted `iterationPolicy.maxIterations` (seeded default 20).
- `loop_limit_reached` — a loop exhausted `maxPasses` or the per-execution 25-pass backstop. Resume requires a decision-changing edit: an affordable cap increase or a justified predicate that accepts the existing captured exit. A template-only edit cannot clear exhaustion; the 25-pass backstop stays fixed.
- `infrastructure_blocked` — a readiness command exhausted its bounded retries. Restore the dependency or correct the command, then resume to rerun readiness; semantic failure counts remain intact.
- `routing_cardinality` — a conditional fan-out under- or over-selected against its declared cardinality.
- `ownership_violation` — a write in a shared worktree that no member's ownership covers.
- `candidate_unstable` — a context's validation rounds kept concluding with no verdict because the reviewed tree would not hold still (5 in a row). A mismatch charges nothing and re-opens the round at once, so this budget is the only thing that bounds the loop; the halt carries the last drift stage and the components that moved.
- `plan_defect` — a blocking validator seat refused the CONTRACT rather than the work: no task in the reviewed context can remedy what it found. The only halt raised by a validator's verdict rather than by a budget or a rule breach — nothing was retried, no task was reopened, and no failure was charged.

Design so halts mean something is genuinely wrong, not that the plan under-budgeted a converging remediation: a criteria surface that is bounded and inventoried converges in a round or two, while an open quantifier over an uninventoried surface closes one discovered site per round until the breaker fires mid-convergence.

## Automatic plan repair

When a halt of type `circuit_breaker`, `max_iterations`, `loop_limit_reached`, `ownership_violation`, `plan_defect`, or `candidate_unstable` lands and the `planRepair` policy is enabled (the seeded default), the engine automatically runs a bounded, read-only **plan-repair agent**:

- It receives the halt evidence, the tripped context's contract and task history, recent validation verdicts, validator advisories, and prior repair rounds — and diagnoses whether the halt reflects a planning defect.
- If it is a planning defect, the agent applies a narrow allowlisted operation set through the live-edit core — `amend-charter`, `update-context`, `add-task`, `update-task`, `remove-task`, `reorder-tasks`, `update-validator-assignment`, plus the loop-control ops (`raise-loop-max-passes`, `amend-loop-predicate`, `edit-loop-template`) for a loop halt — and the execution **resumes automatically**. It cannot weaken gates, restructure the graph, or touch completed work.
- If it declines (the plan is coherent and the halt is honest), the execution **stays halted** for the operator, with the diagnosis recorded in the halt summary and round log.
- Budgets: at most 2 attempts per context and 5 rounds per execution by default; configurable via the cascading `planRepair` block (`enabled`, `maxAttemptsPerContext`, optional custom `agent`).

Planner consequences:

- Do not pad `iterationPolicy` or `circuitBreaker` "just in case" — an honest halt plus repair-or-operator is the designed recovery path, and a padded budget converts a planning defect into a longer, more expensive failure.
- Read the repair prompt's editable/frozen context and task inventory before proposing operations. Append correction tasks after the completed prefix; completed tasks remain frozen. Verify the proposed operation count and diagnosis agree between runtime and the durable repair event.
- Repair edits plan artifacts only. A defect that needs implementation (a missing foundation, an unbuilt contract) still needs a human or a new context; repair cannot code its way out.
- Repair rewrites acceptance criteria through `update-context`, which replaces the WHOLE record list — there are no per-criterion operations at any tier. Ids that survive a repair keep their citations alive, so stable, well-named criterion ids are what make a repaired contract legible against the verdicts that provoked it.
- Context validators surface plan-shaped concerns as non-blocking `plan` advisories during normal rounds; those advisories become plan-repair evidence when a halt lands, so a validator that keeps flagging the same plan concern is signal worth acting on before the breaker fires.
- A `plan_defect` halt reaches repair differently from the rest: it is routed at **first detection**, not after a retry budget runs out, so the agent arrives with one typed finding (the contract in conflict, and why no task can remedy it) and the preserved candidate instead of a whole halted context to re-diagnose. Repaired resumes automatically; a decline or a failure leaves the run halted with the diagnosis in the halt summary, while with `planRepair` disabled no repair round runs at all and the halt simply stands for the operator. It is capped like every other repairable halt, per context — a defect the plan cannot answer would otherwise re-trip on every resume.
- A `candidate_unstable` halt is usually about placement, not about the work: the tree keeps moving because something outside the context writes into the same worktree, or because the context's scope renders a tree that is still changing. Give a context that runs long-lived processes, servers, or its own build output a placement that does not share a worktree with another writer.
- A validator reaching for `plan_defect` is reporting a **planning** error, not an implementation one. Read it as feedback on the plan: see [validation-and-staffing.md](validation-and-staffing.md) for the response's bounds — a concern outside the seat's mandate stays an advisory.
