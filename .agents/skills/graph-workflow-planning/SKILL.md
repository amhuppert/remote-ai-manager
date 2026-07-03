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
- Omit per-context `implementer`, `contextValidator`, `scriptValidator`, `iterationPolicy`, `circuitBreaker`, and `mutability` unless a non-default value is intentionally required.
- `acceptanceCriteria` is required on every execution context and must live on the context, not on the validator.
- Minimal payloads are preferred because global and workflow defaults cascade into each context at execution seed time.
- To opt out of inherited agent validation for a context, set `contextValidator: { kind: "disabled" }`.
- To override the inherited agent validator, set `contextValidator: { kind: "use", value: ... }` with a valid validator config.
- To override deterministic validation for a context, set `scriptValidator: { enabled: true }` or `scriptValidator: { enabled: false }`.
- If a running execution already exists, changing a saved workflow definition may not mutate that active execution. Tell the user when a fresh execution or reset is needed.
- Exception to the "use defaults unless explicitly directed otherwise" rule: Enable `scriptValidator` for the **final** execution context, unless there is a specific reason to disable it.

## Planning Procedure

1. Read the governing context.
   - Load the full objective, relevant specification files, relevant steering files, and any existing workflow definition being replaced.
   - Do not plan from only a narrow task excerpt when design semantics matter.
   - If enabling `scriptValidator`, confirm the project has a configured `preMergeCommand`.

2. Build a context inventory.
   - List major implementation surfaces: schemas, persistence, runtime lifecycle, adapters, API, UI, tests, migration, diagnostics.
   - Identify design contradictions before creating contexts.

3. Define contracts before tasks.
   - For each context, state what it produces, what it consumes from upstream contexts, and what it must not decide privately.
   - Put shared contracts in an upstream context when later contexts need the same state machine, support matrix, route contract, or data shape.
   - Do not split work so a downstream agent needs hidden assumptions from a different execution context.

4. Choose execution contexts around validation boundaries.
   - Each context should have one coherent validation thesis.
   - Split broad lifecycle work into smaller contexts such as contracts, mutation fanout, backend-specific lifecycle, turn-start behavior, diagnostics, and UI/API wiring.
   - Avoid contexts whose acceptance criteria require the validator to understand several unrelated subsystems at once.

5. Write self-contained task instructions.
   - Include what to change, why it matters, likely files/modules, and how the implementer can verify locally.
   - Include required documents the implementer must read, not just files to edit.
   - State upstream artifacts that are authoritative for this context.

6. Add dependency edges deliberately.
   - Use edges for hard dependencies and for helpful foundation dependencies when prior work materially reduces ambiguity.
   - Do not add edges between truly independent contexts.
   - Prefer a short foundation context before parallel branches when multiple implementers need the same contract.

## Acceptance Criteria

Acceptance criteria are the shared contract between implementer and validator. Draft them as context-local, observable outcomes that an LLM validator can judge by inspecting the work.

Good acceptance criteria:

- Name concrete state transitions, emitted data, files, APIs, or user-visible behavior.
- Include important negative cases and unsupported/gated behavior.
- Fit entirely inside the context's scope.
- Give the validator enough specificity to pass or reopen a task without inventing new edge cases.

Do not write acceptance criteria that:

- Depend on another context's private work.
- Mix contradictory design states, such as requiring runtime application for a feature also marked verification-gated or diagnostic-only.
- Ask the agent validator to enforce deterministic checks like tests, typecheck, lint, or build. Use `scriptValidator` only when the context should end in a fully valid state.
- Use vague phrases like "retryable diagnostics", "fully wired", or "complete lifecycle" without spelling out the exact states and paths.

## Validators

Graph workflows have two independent validators:

- `contextValidator`: an LLM validator that judges the intent of the context acceptance criteria. It respects context scope boundaries and should not fail a context for work intentionally assigned downstream.
- `scriptValidator`: a deterministic validator that runs the project's `preMergeCommand` after all tasks in the context complete. If it fails, the output is saved under `.cc/workflow/<executionId>/pre-merge-<timestamp>.log` and a remediation task is added.

Script validation runs before agent validation. If script validation fails, agent validation is skipped for that iteration. Both failures consume iteration budget and feed the circuit breaker.

Enabling `scriptValidator` without a configured `preMergeCommand` halts the workflow with `script_validator_missing_command`.

### Script Validator Decision Rule

Enable `scriptValidator` only when the codebase is expected to be fully valid after completing all tasks in that execution context.

Do not enable `scriptValidator` for a context intentionally planned to end in an invalid intermediate state, such as:

- A schema or type contract landed before all callers are migrated.
- A backend adapter contract changed before downstream runtime wiring exists.
- A partial implementation that is intentionally completed by a later context.
- A branch where tests, typecheck, lint, or build are expected to fail until a downstream integration context runs.

If script validation is enabled for an intentionally invalid intermediate state, the workflow will either halt or pressure the implementer to expand scope into later contexts. Put deterministic validation on a later integration or final verification context instead.

## Validator Alignment Checklist

Before creating or replacing a workflow, check every context:

- The validator and implementer receive the same essential context (acceptance criteria are automatically provided to both the implementer and validator).
- Every criterion maps to at least one task in that same context.
- Every task has enough context to satisfy the criteria without relying on conversation-only knowledge.
- Validator scope cannot require downstream integration work to already be done.
- A failed criterion can reopen a specific task in the same context.

If the validator would need the whole design to judge a narrow context, either add a context-local design summary task or move that criterion to a final verification context.

## Parallelization Guidance

Parallel contexts run in isolated git worktrees, one branch per context, so they cannot interfere with each other mid-flight. Branches are merged automatically at join points and at final publish, and merge conflicts are **resolved automatically** by an LLM resolver (the same machinery as Smart Merge), with the project's pre-merge validation running after every join merge. Do not plan as if all merge conflicts must be avoided.

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

## Common Failure Modes

Guard against these before starting execution:

- Implementer/validator misalignment: acceptance criteria judge behavior the implementer was not instructed to build.
- Ambiguous criteria: validator keeps discovering new edge cases because the state contract was underspecified.
- Contradictory criteria: design says a capability is gated, while acceptance criteria require it to work as runtime-applied.
- Missing context: implementer gets only a task slice while validator expects whole-design behavior.
- Overbroad contexts: one context owns mutation routing, lifecycle hooks, backend adapters, diagnostics, and retry semantics.
- Parallelism without foundation: independent-looking contexts secretly need the same unresolved contract.
- Script validator deadlock: deterministic validation is enabled for a context that intentionally ends in an invalid intermediate state.

## Final Verification Context

For substantial workflows, add a final verification context after all implementation contexts. Its job is to review the design end to end, verify wiring across contexts, and add remediation tasks (mutability must be enabled for this context in order for it to add tasks).

The final context should:

- Read the full design and requirements, not only prior summaries.
- Verify that each implemented surface is connected to the runtime path the user will exercise.
- Check that gated or unavailable behavior is honestly represented.
- Use `scriptValidator` only if the whole workflow should be in a valid state at that point.

## Authoring and Submitting the Plan

Author the workflow as a `plan.json` file with the Write tool, then submit it with the `cctl` CLI. Never paste a whole workflow graph as inline tool arguments — a file you can iterate on is the interface.

### plan.json shape

A plan is a JSON object the validate, create, and replace endpoints all accept:

```json
{
  "name": "Add OAuth2 Support",
  "description": "What this workflow achieves (optional).",
  "definition": {
    "charter": { "mission": "…", "sourcesOfTruth": [ /* ranked entries */ ] },
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
- Each task needs an explicit `order` (1-based, per context, in the sequence tasks should run inside that context) and a unique `id`. Each edge needs a unique `id`.
- `schemaVersion`, `workflowConfig`, `parameters`, `prerequisites`, and every optional per-context/per-task field default when omitted — keep the payload minimal (see [Defaults and Payloads](#defaults-and-payloads)).
- `layout` is required, but positional detail is not: `{ "workflowId": "plan", "contextPositions": {} }` is enough. The builder arranges nodes and the real workflow id is assigned on create.
- Author a global cross-project template (`{{inputs.<name>}}`-parameterized) through the Templates UI, not this project-scoped create flow.

### Submit flow

Run these from the session (the CLI reads its project/session identity from the environment):

1. `cctl workflow validate --file plan.json` — runs the exact create-path checks (schema parse + dependency cycles, unknown context refs, prerequisite sanity) and persists nothing. On issues it exits non-zero and prints one issue per line with its JSON path (e.g. `definition.tasks.2.contextId: …`). Fix the file and re-run until it prints the create hint.
2. `cctl workflow create --file plan.json` — saves the definition and prints its id. The user reviews and edits it in the visual builder before starting.
3. `cctl workflow start <id>` — starts execution.

To revise a definition after user feedback, edit `plan.json` and run `cctl workflow replace <id> --file plan.json` (submit the complete graph; the previous definition is fully overwritten). Re-validate first. If a running execution already exists, replacing the saved definition may not mutate that active execution — tell the user when a fresh execution or reset is needed.

### Before submitting, confirm

- The `graph-workflow-planning` skill was used.
- No known design contradictions remain unresolved.
- Every context has non-empty, context-local acceptance criteria.
- Optional implementer and validator settings are omitted unless the user requested them or a specific context requires them.
- Any enabled `scriptValidator` runs only after contexts expected to leave the codebase valid.
- Essential context is included in task instructions or produced as an upstream shared artifact.
- Parallel branches are truly independent or have an explicit foundation edge.
- `cctl workflow validate` passes on the final `plan.json`.
