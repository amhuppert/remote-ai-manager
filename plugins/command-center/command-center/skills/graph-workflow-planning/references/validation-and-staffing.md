# Validation Configuration and Staffing

Reference for [graph-workflow-planning](../SKILL.md). Read this when selecting script-gate commands, tuning agent command access or lane-merge validation, staffing non-default implementers or validator cohorts, or aligning validators with acceptance criteria in detail.

Graph workflows have three distinct validation configuration blocks. Keep their decisions independent. Command names in examples are illustrative: select the target project's actual registered names with `cctl validate list`.

## Script gate: `scriptValidator.commands`

`scriptValidator.commands` is the ordered registered-command selection run after an implementer finishes the context's tasks. It cascades global defaults → workflow → execution context; each provided list replaces the inherited list, and `[]` disables the script gate. The seeded default is `[]`.

Placement mode—not lane member count—controls the context script gate:

| placement mode | context-completion behavior |
|---|---|
| `full` | Runs the selected commands after all context tasks and before agent validation, including on a single-member lane or an ordered shared lane. A failure skips agent validation for that iteration. |
| `owned` | Skips the context script gate and defers repository gating to `laneMergeValidation`. Selected commands must be empty or barrier-covered; uncovered selected commands are refused at preflight. |
| `readOnly` | Skips repository script gating because the context writes no repository candidate. Usually select no commands and leave repository gates to a downstream write-capable context; any inherited selection must still be covered by the lane barrier. |

The lane barrier is separate from the context-completion gate: it validates the integrated lane tree at a join according to `laneMergeValidation`, while a `full` context's gate validates that context before its agent validator runs.

```json
{
  "scriptValidator": {
    "commands": ["typecheck", "test"]
  }
}
```

Every name must exist in the project's `validation.commands` registry. Select commands only for a context expected to leave that check green; do not create an intentionally invalid intermediate state and then gate it with checks that can pass only after downstream work.

### Script validator decision rule

Select commands by placement grade and the candidate the context will leave:

- Every `full`-grade context expected to leave the tree valid carries cheap deterministic gates from `cctl validate list`, such as compilation and architecture checks when the project registers them. Use a workflow default when most contexts share that selection, then override exceptions explicitly. This is an authoring default; the engine's seeded selection remains `[]`.
- `owned` and `readOnly` contexts follow the lane barrier coverage rule above. A `full` context on an ordered shared lane still runs its own selected gate.
- Select the project's registered test command at contexts with a bounded diff and once at final verification. Give implementers access to the registered test command for file-scoped red-green loops independently of the context gate.

Check the target project's registered scope behavior before scheduling broad runs: `cctl validate run <test-command> --scope changed` can cover the whole feature if its wrapper compares against the target-branch merge base, approaching full-suite cost. Use an explicit single test-file path during TDD when the command supports path scoping; otherwise choose the narrowest registered check. Reserve broader runs for context checkpoints and an explicit `--scope full` pass at final verification. The script gate selects command names, not CLI flags; put the full-scope invocation in the final task's verification instructions.

The final context's [baseline policy](../SKILL.md#final-verification-context) determines who owns pre-existing failures.

Do not enable `scriptValidator` for a context intentionally planned to end in an invalid intermediate state, such as:

- A schema or type contract landed before all callers are migrated.
- A backend adapter contract changed before downstream runtime wiring exists.
- A partial implementation that is intentionally completed by a later context.
- A branch where tests, typecheck, lint, or build are expected to fail until a downstream integration context runs.

If script commands are selected for an intentionally invalid intermediate state, the workflow will either halt or pressure the implementer to expand scope into later contexts. Put those deterministic commands on a later integration or final verification context instead.

## Infrastructure readiness

For discovery, authentication, or external-tool readiness, place a `full` context **before** refinement loops and select registered commands with `scriptValidator: { "commands": ["figma-ready"], "purpose": "infrastructure" }`. Register the command in the target project first; the name here is illustrative.

Each command emits exactly one JSON object: `{ "status": "ready", "warnings": [], "summary": "Inventory complete" }`. Report partial discovery as `status: "blocked"` or include its warnings. Exit code 0 alone is insufficient: readiness requires a valid report, `ready`, and no warnings. The engine retries a blocked report, malformed output, or failed command up to three attempts, retaining each command log. Exhaustion produces resumable `infrastructure_blocked`, without semantic remediation or failure-count spend. Restore the dependency and resume to check it again. Unknown registrations still require correcting the command selection.

For inventory generation, write to a temporary sibling, verify completeness and warnings, then atomically rename into the published path. Consumers use the published artifact's content digest. A failed discovery leaves the prior complete artifact intact; an incomplete inventory never becomes the reviewed input. Put generation and promotion in the registered producer command so the same checks govern every retry.

## Agent access: `agentValidation`

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

Implementer test access stays enabled even when the script gate also runs tests. The implementer needs focused test runs for red-green TDD, while `scriptValidator.commands` independently defines the deterministic end-of-context gate. Never remove implementer access merely to avoid duplicate-looking selections. Never infer agent permissions from the script-gate selection.

## Lane merges: `laneMergeValidation`

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

This selection is also the **barrier** for every enveloped context: those contexts run no automatic whole-repo gate of their own (their agents may still run their granted commands), so the lane's join is where the plan's deterministic gate actually fires. An enveloped context's `scriptValidator.commands` must be empty or a subset of it — see [placement-and-parallelism.md](placement-and-parallelism.md).

Set `laneMergeValidation` only at the workflow tier when the project-level lane-merge policy is not appropriate; it is never a per-context override.

## Staffing assignments from the agent profile library

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
    "focus": "database persistence",                    // optional use-site steer
    "agent": {
      "backend": "claude",
      "modelSelection": {
        "modelId": "opus",
        "parameters": { "effort": "high" }
      }
    }
  },
  "contextValidator": {
    "enabled": true,
    "assignments": [
      {
        "id": "security",                                  // unique WITHIN the cohort
        "profile": { "tier": "global", "id": "security-reviewer" },
        "agent": {
          "backend": "codex",
          "modelSelection": {
            "modelId": "gpt-5.4",
            "parameters": { "reasoning": "high", "fast": "false" }
          }
        }
      }
    ]
  }
}
```

- The assignment `id` is the durable use-site identity findings are grouped under. Keep it stable across revisions; renaming it is a new use site, not a rename.
- `focus` narrows a general profile at one use site ("auth boundaries", "hot paths"). Durable behaviour belongs in the profile itself — if every use site repeats the same focus, the profile is wrong.
- Every validator assignment runs as one durable conversation per assignment; there is no per-assignment execution strategy to choose.
- Two assignments may name the SAME profile under different ids and focuses. That is the normal way to get two specialist passes from one general reviewer.

### Cohort rules

- An enabled cohort needs at least one assignment — validation over an empty cohort would pass vacuously, so it is refused.
- Assignment ids must be unique within a cohort.
- A disabled cohort **retains** its assignments. Turning validation off and back on is lossless, so do not strip assignments to disable a context's review. To opt a context out of inherited agent validation, set `contextValidator: { "enabled": false, "assignments": [] }`. Retained assignments still show up on the staffing surfaces, marked `(cohort disabled)`, and their references are still checked at save — a dangling one is refused even though nothing dispatches it.
- Assignments replace as **whole units** at every cascade boundary (global → workflow → context). A context that sets `contextValidator` replaces the inherited cohort entirely; there is no field merging. Restate every assignment you want.
- Keep the default single general reviewer unless a context genuinely needs a second specialist lens. Every extra assignment is another full review of the same candidate.

### Reference scope

A **global-scope** document (a cross-project template, or the global `workflowDefaults`) may reference only `builtin` and `global` profiles. A `project`-tier reference is unresolvable in every other project and is refused — validate with `--tier global` to catch that before saving rather than at save time.

## How the two validators run

- `contextValidator`: an ordered cohort of LLM validator assignments that judge the intent of the context acceptance criteria. Every enabled assignment reviews the same frozen candidate and all must pass; findings stay grouped by assignment id. Validators respect context scope boundaries and should not fail a context for work intentionally assigned downstream — a deferral is honored when the deferring context's criteria name the downstream owner, or the downstream owner's criteria carry the matching obligation.
- `scriptValidator`: a deterministic gate that runs its ordered registered-command selection after all tasks in the context complete. Each command enters ValidationService separately under the global budget; the gate stops at the first failure and records the run evidence before adding a remediation task.

Script validation runs before agent validation. If a command fails, agent validation is skipped for that iteration. After remediation the complete ordered list reruns. A capacity wait is orchestration state and does not consume an iteration or trip the circuit breaker.

Unknown command names and costs above the global limit fail preflight rather than becoming runtime no-ops.

Validators also actively check every charter invariant rendered into their prompt — global invariants plus those scoped to the context under review — and cite invariant ids in issues. Sources of truth are filtered the same way, so a validator sees only the references its context was scoped to and is never asked to arbitrate a conflict between two of them: that resolution happened while planning (see [The Charter](../SKILL.md#the-charter)). Scope both honestly at planning time, so a validator is never held to a rule the plan did not mean it to enforce or asked to check material its context cannot read.

Both seats judge the candidate as it stands. An invariant or criterion that describes a process (a failing test first, a command order) is unverifiable after the fact; the validator contract treats it as satisfied whenever the outcome it protects holds, and never fails a context for missing process evidence. Author process rules as `conventions`, never as validator-checked text.

### What each seat cites

Every seat in a cohort receives the context's acceptance criteria as a numbered record list — the criteria are the context's scope contract, and each seat needs them to respect scope boundaries and honor deferrals whatever else it judges. What differs is the **basis a blocking finding must cite**:

| seat | blocking basis | criterion id |
|---|---|---|
| the acceptance seat (the default blocking general reviewer) | the acceptance criteria themselves | required on every issue |
| a blocking specialist | its own assigned mandate (`focus` plus profile standard) | only when the finding also contradicts a specific criterion |
| an advisory seat | none — advisories block nothing | never required |

A specialist is deliberately **not** asked to map its standard onto criterion ids: forcing that mapping would file mandate findings under criteria that never claimed them. A finding a seat's mandate does not clearly cover is an advisory, and a contract the context cannot satisfy at all is a `planDefects` entry — see below.

Planner consequence: the acceptance seat can only cite what you gave it names for. Criteria authored as one giant record leave every blocking issue pointing at the same id, which is the pre-records blob with extra syntax.

### The third blocking response: `planDefects`

A blocking seat has three responses, not two. Beside a pass (empty `issues`) and a fail (issues that reopen the named tasks), it may return `planDefects` — the verdict for a contract the reviewed context **cannot satisfy at all**: contradictory, requiring work owned by a downstream context, or omitting ownership its criteria require.

- A plan defect carries **no** `taskId`. Every entry must state why the defect is not locally remediable and name the criterion clause, boundary, dependency, or governance rule it conflicts with. Both are required — a classification nobody can review is rejected.
- **It reopens no task and charges no failure.** The context halts with a `plan_defect` reason carrying the finding, and the engine sends it straight to plan repair; the reviewed work is untouched. See [revising-and-recovery.md](revising-and-recovery.md).
- **Its bound is the seat's mandate.** A concern the seat's mandate does not clearly cover is an advisory, exactly as before — never a plan defect. The third response exists for a mandate this context cannot satisfy, not as a route around a mandate the seat would rather not judge.
- A seat may report both; the plan defect decides the outcome and its issues travel with it as evidence.
- Plan repair may reject the classification and rule the work ordinary implementation, so the response is for a contract that cannot be satisfied — not one that is merely difficult, unfamiliar, or larger than the validator expected.

Planner consequence: a plan defect is the honest report of a **planning** error, so read it as feedback on the plan rather than on the implementer. The shapes that produce them are contexts whose criteria name work no task in that context owns, and deferrals with no receiving criterion — which is exactly what the alignment checklist below prevents at authoring time.

## Validator alignment checklist

Before creating or replacing a workflow, check every context:

- The validator and implementer receive the same essential context — the same numbered criterion records render into both prompts, automatically.
- Every criterion record maps to at least one task in that same context, and each states one independently-failable obligation the seat can pass or fail on its own.
- Every task has enough context to satisfy the criteria without relying on conversation-only knowledge.
- Validator scope cannot require downstream integration work to already be done.
- Any wiring intentionally deferred downstream is named in the acceptance criteria — validators fail existence-only evidence for a capability whose wiring has no named owner.
- Every deferral declared anywhere in the plan ("deferred to context X", "verified in final verification") has a matching acceptance criterion in the receiving context. A validator GO that records a deferral whose target never carried the obligation is an invalid GO.
- A failed criterion can reopen a specific task in the same context — the acceptance seat's issue carries both the `taskId` it reopens and the `criterionId` it failed.
- No criterion contradicts a charter invariant or a source scoped to the same context. There is no runtime precedence rule to fall back on, so a contradiction here is a plan defect waiting to be reported.

If the validator would need the whole design to judge a narrow context, either add a context-local design summary task or move that criterion to a final verification context.
