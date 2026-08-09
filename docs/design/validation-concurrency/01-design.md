# Design: Granular Validation Commands and a Global Cost Budget

**Status:** Approved design, not yet implemented. Authored 2026-08-04 through a two-agent collaboration run; see `02-collaboration-audit.md` for how the contested decisions resolved.

Decisions Alex settled, which implementers must not re-litigate: oversized commands are **rejected** rather than clamped; the clean legacy cutover is **approved**; the seeded concurrency limit is **8**. Amended post-review at Alex's request with per-run timing accounting (§12) and lane-merge validation with final-only deferral (§6).

---

## 1. What this solves

Multiple agents — several graph workflows, each with parallel execution contexts, plus ad-hoc session work — run validation simultaneously. Vitest's worker pools are the dominant memory consumer, and the aggregate load stalls the machine.

The design makes **validation a first-class Command Center domain** with one server-owned boundary. Projects register arbitrarily many named validation commands, each with a declared integer cost. A single global weighted scheduler guarantees that the sum of running costs never exceeds a configured capacity, across every project, session, conversation, graph execution, and merge flow. Agents reach validation only through `cctl validate`, which is what makes tracking exact.

The load-bearing consequence: **every** validation path — the agent CLI, the graph script validator, Smart Merge, and Smart Commit — enters through the same service. A single remaining direct caller would be able to start an unaccounted vitest process and defeat the limit, so the old direct execution path is removed rather than left available.

---

## 2. Project configuration — the validation registry

`CommandCenter.json` gains a `validation` block. `preMergeCommand` is retired (§10).

```jsonc
{
  "validation": {
    "commands": {
      "format": {
        "command": {
          "full": "scripts/validate/format-full.sh",
          "changed": "scripts/validate/format.sh"
        },
        "cost": 1,
        "description": "Format project files",
        "pathArgs": "forbid"
      },
      "lint": {
        "command": {
          "full": "scripts/validate/lint-full.sh",
          "changed": "scripts/validate/lint.sh"
        },
        "cost": 2,
        "pathArgs": "forbid"
      },
      "typecheck": {
        "command": {
          "full": "scripts/validate/typecheck.sh"
        },
        "cost": 2,
        "pathArgs": "forbid"
      },
      "test": {
        "command": {
          "full": "scripts/validate/test-full-suite.sh",
          "changed": "scripts/validate/test.sh"
        },
        "cost": 8,
        "timeoutMs": 900000,
        "pathArgs": "paths"
      }
    },
    "preMerge": ["format", "lint", "typecheck", "test"]
  }
}
```

**Rules.**

- **Names** are arbitrary, stable, CLI-safe identifiers (`test`, `test-unit`, `typecheck`, `build`, …). Nothing is hard-coded to a fixed set; `test`/`lint`/`typecheck`/`format` are conventions the skills recommend so configuration composes across projects.
- **`command.full`** is required; **`command.changed`** is optional. Both are paths resolved from the **canonical project root** and invoked with `execFile` (shebang required) — never shell strings. Every wrapper has one fixed behavior and never parses Command Center's scope value.
- **Scope** is `changed` or `full` and defaults to changed at the agent boundary. A changed request selects `command.changed` when present; otherwise Command Center selects `command.full` and records effective scope full. A full request always selects `command.full`.
- **`cost`** is required and positive. Both variants share it, so it must cover the profile's maximum resource use. No default, no normalization — a project must state its weight. Convention: one unit for a single-process tool, roughly one unit per configured test worker, applied consistently across all projects on the machine so the numbers stay comparable.
- **`timeoutMs`** is optional per command, falling back to a global default. This matters: without it, one knob would have to cover both a 60-minute suite and a 2-minute lint, and a hung lint would hold its capacity reservation for an hour.
- **`description`** is optional and surfaces in `cctl validate list` and in generated agent prompts.
- **`pathArgs`** defaults to `"forbid"`. Setting `"paths"` permits `cctl validate run test --scope changed -- src/example.test.ts`: every forwarded value must be a non-option token that resolves inside the target worktree. Paths require a native changed executable; full requests and changed-to-full fallback reject them. Option tokens, absolute paths, and traversal are rejected. This makes the TDD inner loop workable while mechanically preventing worker/pool/config flags that would make real load exceed the declared cost. Containment is lexical, so a just-deleted or renamed file can still forward and the changed wrapper decides what to do with it.
- **`preMerge`** is the ordered command selection used by Smart Merge and Smart Commit. It is deliberately independent of graph script-validator selection.
- **`laneMerge`** (optional) is an ordered command selection specifically for graph-workflow lane merges — typically a cheaper subset (e.g. `["typecheck", "test"]` with scoping). When absent, lane merges fall back to `preMerge`. Workflow configuration can override either way (§6).

**Trust boundary (verified in code, not assumed).** Today's runner reads `CommandCenter.json` from the canonical `projectPath`, resolves the script relative to that root, and uses the lane/session worktree only as `cwd`. That is preserved: a candidate branch cannot validate itself with a validation script it modified. The consequence must be documented for agents — **an unmerged session cannot exercise edits to its own validation registry or wrapper scripts through the wrapper**; developing the wrapper itself is one of the narrow cases where a direct tool invocation is legitimate.

**Script environment.** Unchanged from the current pre-merge contract — `PROJECT_ROOT`, `WORKTREE_PATH`, `TARGET_BRANCH`, `SESSION_NAME`, `BRANCH_NAME`, `CONTEXT_ID` for lane worktrees — plus `CC_VALIDATION_RUN_ID`, `CC_VALIDATION_COMMAND`, and `CC_VALIDATION_COST` for correlation, worker-cap alignment, and the recursion guard (§4). `TARGET_BRANCH` is how scripts scope to the diff via `git merge-base`.

---

## 3. Global capacity

OS-level `config.json`:

```jsonc
{
  "validation": {
    "concurrencyLimit": 8,
    "defaultTimeoutMs": 600000
  }
}
```

The invariant, enforced against **configured** costs:

```
sum(cost of every running validation command) <= validation.concurrencyLimit
```

At a limit of 8: one cost-8 test suite, or two cost-4 builds, or eight cost-1 checks, may run concurrently. The seeded default is **8** per your confirmation. It is a prominent global setting — it cannot be inferred from CPU count, because memory pressure rather than CPU saturation is the failure mode.

**Oversized commands are rejected, not clamped** (your answer (b)). A command whose cost exceeds the limit is unrunnable configuration, not a temporarily-busy command: it fails with `validation_cost_exceeds_limit`, naming both numbers, **including under `--wait`**. This keeps the limit a hard capacity guarantee rather than a soft anti-pile-up heuristic. Three consequences follow:

- The error is caught at **preflight** — workflow create/replace/start/live-edit and CLI invocation — so it surfaces as a configuration problem before an execution is underway, not as a mid-run halt.
- The remedy is stated in the error: register a lower-worker profile, reduce the command's worker cap and its honest cost together, or raise the machine limit.
- If the global limit is **lowered**, active work finishes undisturbed; queued work whose cost now exceeds the limit becomes a configuration error rather than waiting forever.

---

## 4. Scheduling and job lifecycle

**Admission is strict weighted FIFO with no barging.** A fail-fast request starts only if it fits *and* no older waiter exists — newer cheap commands may not leapfrog a queued expensive one. This can briefly leave capacity idle, and that is the intended trade: it guarantees the cost-8 test suites that motivated this feature are never starved by a stream of cost-1 lint runs.

**Validation is job-shaped**, following the existing agent-run precedent rather than holding one HTTP request open for an unknown queue duration:

1. Submission returns a run ID plus a **private lease token issued only to the submitter**.
2. `cctl` polls status and queue position, rendering progress so a watching human or agent sees *why* nothing is happening.
3. Only the token holder can renew the lease or cancel. Read-only `status` calls by other agents or by a human cannot keep abandoned work alive.
4. `cctl` cancels explicitly on SIGINT/SIGTERM; **lease expiry is the fallback**, dequeuing a waiter or sending SIGTERM then SIGKILL to the process group. This is what stops a dead agent's cost-8 suite from holding the budget for its full timeout — precisely the leak this feature exists to prevent.
5. Capacity is released **only after the child process group is confirmed dead**.

Graph script validators and merge/commit jobs are **system-owned and lease-exempt**: their orchestrator lifecycle performs cancellation.

Further semantics:

- **Queue time never consumes the execution timeout**; the timeout starts at process spawn.
- **Policy-disabled no-ops resolve before admission** — they consume no capacity and no queue position, and spawn nothing.
- **Nested wrapper calls are rejected** via `CC_VALIDATION_RUN_ID`: a registered command invoking `cctl validate run` would hold capacity while waiting for capacity.
- **Capacity waiting is orchestration state, not validation failure.** It must never open a remediation task, consume a graph validation iteration, trip a circuit breaker, or render to an agent as an error.
- Reservations release on **every** terminal path: pass, fail, timeout, cancellation, spawn error, shutdown.

**Crash safety requires durable ownership.** Validation children are spawned *detached* precisely so the whole group can be killed together — which means an abrupt server death can skip abort handlers and leave vitest workers alive while a restarted in-memory scheduler reports zero usage and admits a fresh full budget on top of them. That recreates the exact overload being solved. So a **minimal SQLite operational ledger** holds run ID, source, command/cost snapshot, queue order, owner/lease data, status, strong process identity, and timestamps:

- A short transaction performs FIFO claim/admission; no transaction is ever held open while an external process runs. Process handles stay in memory.
- Process identity uses a per-run supervisor/nonce, not a bare PID — PIDs are reused.
- Graceful shutdown cancels tracked groups before releasing reservations.
- After an unclean restart, **admission stays closed until recovery reconciles and terminates owned process groups**, then marks affected jobs `interrupted`. v1 does not auto-resume them.

This ledger is operational state for ownership and recovery first; terminal rows are additionally retained as the per-run timing record (§12). No history UI ships in v1.

---

## 5. The CLI surface

```
cctl validate list
cctl validate run <name> [--scope changed|full] [--wait] [--json] [-- <validated paths>]
cctl validate status [run-id]
cctl validate cancel <run-id>
```

`list` shows names, costs, descriptions, whether each command is enabled for the caller's current role and context, and current global capacity. It deliberately **does not print the underlying executable** — showing the raw tool invocation would hand agents a copy-paste path around the wrapper.

`run` is fail-fast by default and synchronous from the agent's perspective once admitted.

| Outcome | Exit | Behavior |
|---|---|---|
| Passed | 0 | Script output (already AI-optimized by the wrapper) |
| Validation failed | 1 | Failure output; `code: validation_failed` |
| Refused for capacity | 1 | Snapshot + instruction to re-run with `--wait`; `code: capacity_unavailable` |
| Cost exceeds limit | 1 | `code: validation_cost_exceeds_limit`, names both values and the remedy |
| **Disabled by policy** | **0** | Pure no-op, nothing spawned, no capacity consumed |
| Unknown command / bad invocation | 2 | Lists registered names |
| Connection failure | 3 | Points at `cctl doctor` |

A refusal reads:

```
Validation "test" was not started: it costs 8, but 3 of 8 capacity units are in use.
Run `cctl validate run test --wait` to queue it.
```

When an **older waiter** rather than raw free capacity is what blocks admission, the message says so and reports queue depth — otherwise the agent would see free capacity and conclude the tool is broken.

Tier discipline: a capacity refusal is a **hint** (retrying with `--wait` is genuinely optional). A policy-disabled result is an **instruction** (the agent must not retry or bypass). The underlying tool's exit code belongs in the JSON payload and never redefines `cctl`'s own stable process contract. All flags, examples, exit behavior, and machine codes originate in the CLI help registry and flow into the generated `cc-cli` reference, so parser behavior and agent documentation cannot drift.

---

## 6. Graph workflow configuration — two independent selectors

Script-gate selection and agent permissions cascade **separately**, exactly as you specified: an implementer doing TDD must be able to run tests even when the script validator will also run them.

```jsonc
{
  "scriptValidator": {
    "commands": ["typecheck", "test"]
  },
  "agentValidation": {
    "implementer":     { "commands": { "mode": "all", "except": ["format"] } },
    "contextValidator": { "commands": { "mode": "only", "commands": [] } }
  }
}
```

The discriminated selector — `{mode:"all", except:[…]}` or `{mode:"only", commands:[…]}` — makes your motivating case (*turn formatting off*) a one-line expression instead of enumerating every other command, while making meaningless combinations unrepresentable.

**Seeded defaults:** script validator `[]`; implementer `{mode:"all", except:[]}`; context validator `{mode:"only", commands:[]}`.

The context-validator default is deliberate and evidence-based: the validator prompt in `src/lib/workflow-graph/validator-runner.ts:221` already instructs it *"Do not enforce deterministic checks… those concerns are handled separately… not your responsibility."* Defaulting it to no commands mechanizes an instruction the system already gives, rather than granting access that recreates the redundancy you want to eliminate. A workflow that wants validator-run evidence grants `test` (or anything else) explicitly.

**Cascade semantics.**

- Global defaults → workflow overrides → execution-context overrides. Omission means inherit.
- Resolution is **per leaf**, and each provided selector replaces only its corresponding inherited selector. Whole-block replacement would let a context's implementer override silently erase a workflow's context-validator setting.
- A provided list replaces as a unit; lists are never unioned.
- `mode:"all"` intentionally opts into future registrations (after exclusions); `mode:"only"` is stable and fail-closed. **Both expand to explicit names when an execution is seeded**, so later registry edits never broaden a running execution's permissions.
- Unknown command names fail at the earliest project-bound boundary — create, replace, start, live-edit — as located configuration errors, never as runtime no-ops.
- A live edit affects future submissions only; a queued or running job keeps the command, cost, policy, and target it was submitted with.

The workflow UI replaces the script-validator on/off toggle with an inheritable command multi-select, adds the two role allowlists, and shows whether each effective value came from global, workflow, or context configuration.

**Script-gate execution.** For each attempt: resolve the execution's snapshotted ordered list; submit each command sequentially with queueing enabled; acquire and release capacity **per command** rather than reserving the group sum (so an agent's quick typecheck can interleave between a workflow's lint and test phases); stop at first failure; persist which command failed with its run ID, cost, output artifact, and before/after tree identity; create a remediation task naming the failed command; and after remediation **rerun the complete ordered list** so mutating checks and downstream checks are both revalidated.

**Lane-merge validation** *(added post-review at Alex's request)*. Parallel lanes fan in through a join that merges each source lane **serially** into the target (the join runner's loop over its remaining source lanes, under the per-session merge mutex, each pass through the full merge machine). Today every one of those merges runs full pre-merge validation — N lanes cost N suite runs back-to-back, and that serial validation time, not memory, dominates workflow wall-clock. Two changes:

```jsonc
"laneMergeValidation": {
  "strategy": "final-only",                 // default; or "every-merge"
  "commands": { "mode": "project" }         // default; or { "mode": "only", "commands": ["typecheck", "test"] }
}
```

- **Command selection.** `{mode:"project"}` (default) resolves to the project's `validation.laneMerge` list when configured, else its `preMerge` list — so a project can set a cheaper lane-merge profile once without touching workflow definitions. `{mode:"only", commands:[…]}` overrides per workflow; `{mode:"only", commands:[]}` disables lane-merge validation entirely. Explicit names are preflighted at create/replace/start/live-edit like the script gate; `{mode:"project"}` resolves at merge submission against current project config.
- **Cascade tier.** Global `workflowDefaults` → workflow only — deliberately **not** per-context, a documented deviation from the three-tier pattern: this gate guards the shared fan-in target and, under `final-only`, validates the integration of *many* contexts at once, so resolving it from any single context would be ambiguous. Per-context granularity is a possible extension if evidence demands it.
- **`final-only` strategy** (default): validation is skipped for every merge in a join series except the last. The join runner knows its complete source-lane set and merges serially, so "last" is deterministic — it passes the merge machine an explicit per-run validation mode (skip vs run-with-selection); session-level Smart Merge/Commit inputs are untouched. `"every-merge"` restores today's per-lane validation for workflows that want integration failures isolated to a single lane.

Semantics under `final-only`:

- Intermediate merges still do everything else — conflict detection, conflict resolution, commit. Only the validation phase is skipped, and each deferral is logged (`graph-workflow.join.validation_deferred`) so the join timeline shows why intermediate merges are fast.
- Solo merges (single-source joins, sequential contexts) are trivially "last" and always validate. The terminal `finalPublish` fan-in always validates.
- The final validating merge records the **lane set it covers**. If its validation fails, the existing auto-fix / halt→repair→resume machinery runs with that full series context — the failure may originate in any covered lane, not just the last-merged one, and the fix turn's brief must say so. This attribution spread is the accepted cost of the speedup.
- The merge machine's formatter/auto-fix commit behavior operates where validation runs — at the final merge, on the integrated tree.
- If a join halts mid-series, already-merged-but-unvalidated lanes sit on the target branch as **validation debt**; the debt settles when the join resumes and its final merge validates. If an execution is abandoned with debt outstanding, the session→main Smart Merge's `preMerge` gate remains the outer backstop.
- Lane-merge validation runs are system-owned (source `graph_lane_merge`), queue automatically under the global budget, and appear in timing accounting (§12) — which is also what will quantify the wall-clock this saves.

---

## 7. Role enforcement

Prompts do not enforce policy — the server does. The validation endpoint derives the effective role from its own project/session/workflow state:

- Ordinary project conversations and non-graph sessions: all registered commands enabled.
- Graph implementers and context validators: their resolved allowlists.
- The internal script validator ignores agent allowlists and uses its own selection.
- **Workflow IDs and roles sent by the CLI are never authoritative.** Missing, stale, mismatched, or ambiguous graph identity **fails closed**, not open to unrestricted access.

A known-but-disabled command returns exit 0, emits a `policy_skipped` event, consumes no capacity, and spawns nothing. An unknown command remains an error — "not executed" must never mean both "deliberately disabled" and "misconfigured."

The message is composed from resolved configuration and **only claims another component handles it when that is true**:

```
Skipped "format": formatting is disabled for the implementer in context "api".
Do not attempt to run code formatting in this execution context; it is handled by the script validator.
```

If `format` is not in the context's script-gate selection, the message instead says workflow policy disables it. Command Center must not tell an agent something will be handled elsewhere when nothing will run it.

---

## 8. Agent instructions

Agents can still type `bun vitest` in a shell, so this is a strong workflow guardrail, not a sandbox — which is why the rule ships at every entry point rather than in one repository file:

> Run registered validation only through `cctl validate run <name>`. Do not invoke Vitest, ESLint, TypeScript, formatters, builds, their package-script aliases, or registered validation scripts directly. Never bypass the wrapper to avoid a queue or an execution-context policy. A direct invocation is allowed only for a narrow diagnostic the registered commands cannot express — state the reason first and use the smallest possible scope. If it is resource-intensive or repeatable, register a command instead.

Surfaces: root/system instructions and `AGENTS.md`, the CLI instructions and `validate` help nodes, TDD guidance, the project-conversation prompt, and the implementer and context-validator prompts. Graph prompts additionally list that context's effective enabled commands, disabled commands, and script-validator selection. The current context-validator line claiming one pre-merge script handles every deterministic check becomes selection-aware.

**No new reminder-tier text ships in v1.** Server reminders must be earned by an observed failure; if workflow audits later show agents bypassing the wrapper, that evidence funds a reminder rule.

---

## 9. Setup skills — scoped by default

The project-setup skill registers one logical command per tool or resource profile, with separate fixed full and changed executables where both modes are sound. Its guidance is to:

- format only changed files where the formatter permits it;
- lint only changed files or affected packages where safe;
- use Vitest `--changed`, Jest `--changedSince`, or an equivalent affected-tests mode, scoped against `TARGET_BRANCH` via `git merge-base`;
- keep full TypeScript/build checks only where dependency analysis cannot make scoping sound;
- **cap test workers and heap explicitly in the wrapper**, never via forwarded flags;
- make the declared cost match the configured worker/resource profile;
- keep output colorless, quiet on success, complete on failure.
- omit the changed executable when sound scoping is unavailable so Command Center performs the full fallback.

The skill explains that cost is a **reservation weight, not measured usage**, and that consistency across projects on one machine is what makes the numbers meaningful. Graph-workflow planning guidance keeps agent permissions separate from script selection and preserves implementer test access for TDD. The canonical plugin sources for project setup, `cc-cli`, agent context, and workflow planning are updated and their derived references regenerated.

---

## 10. Migration — approved clean cutover

You approved removing the legacy path entirely. There must be no intermediate state in which `preMergeCommand` still executes outside the scheduler.

1. Reserve the registry name `pre-merge`; register each project's current monolithic script under it with an explicit, project-local, honest cost — so overload protection exists **before** any script is split.
2. Preflight that every project referenced by a stored workflow has that registration.
3. Map persisted `scriptValidator.enabled: true` → `commands: ["pre-merge"]`, and `false` → `[]`.
4. Point Smart Merge/Commit at `validation.preMerge: ["pre-merge"]`.
5. Migrate seeded defaults, coercion, config-UI form state, CLI outlines, and live-edit field allowlists in the same cutover.
6. Route every caller through the validation service, then **delete `preMergeCommand` and `executeRepoValidationCommand`**.
7. Split the monolith into granular commands project by project and update the two independent selections.

An architecture test prevents any future module from importing the low-level process runner directly, so the bypass cannot reappear.

---

## 11. Integration surfaces

The change touches a specific, known set of sites that must move together or contract tests fail:

- **Cascade siblings:** config resolution, runtime and definition live-edit field allowlists, builder draft state, test fixtures, workflow inspector and context-config panels, config-UI script-validator fields and form state, CLI workflow outlines (rendering `script: typecheck+test` rather than `script on`), and graph derivation.
- **CLI:** help-registry entry with flags wired through the registry, bidirectional `related` edges, skill references, the registry contract test, scope classification in the session-env inventory (project-supported, with both-direction conversation-scope coverage), the project-route wiring arch test, and regeneration of the `cc-cli` SKILL.md command reference.
- **Events** through the typed publication seam only — `requested`, `rejected`, `queued`, `started`, `completed`, `cancelled`, `interrupted`, `policy_skipped`.
- **Logging** via `createLogger("validation")` with stable event names and structured fields (`runId`, `name`, `cost`, `inUse`, `limit`, `queueDepth`, project, conversation, `exitCode`, `queueMs`, `execMs`, `timedOut`, `requestedScope`, `effectiveScope`, `scopedPathCount`). Bounded output or a tail in state; complete output to a validation artifact — never unbounded test output in structured logs.
- **Persistence:** the ledger carries nullable requested/effective scopes for legacy rows and non-null snapshots for every new run, plus the standard repository mapping, maximal round-trip contract fixture, and migration floor obligations.

---

## 12. Timing accounting

Every run's timing is captured at the three transitions the scheduler already owns — `submittedAt` on request arrival, `startedAt` at process spawn, `finishedAt` when group death is confirmed — yielding two durations that are **always kept separate**: `queueMs` (contention) and `execMs` (what the command itself costs). Conflating them would corrupt both statistics: queue wait measures whether the global limit is too tight; execution time measures the command.

Each terminal run records, in one place: command name, project, declared cost, source (`agent_cli` / `graph_script_validator` / `graph_lane_merge` / `smart_merge` / `smart_commit`), outcome, exit code, session/conversation, workflow execution/context/role when applicable, requested scope, effective scope, and forwarded path count. Requested and effective scope distinguish a native changed run, changed-to-full fallback, and explicit full run without guessing from path presence. Legacy rows remain nullable where the old ledger cannot prove scope.

Storage and query:

- **Terminal ledger rows are retained**, not deleted. The ledger already writes these timestamps for crash recovery, so durable accounting costs nothing extra to collect. This deliberately amends the round-1 "operational state only" scope guard: the concrete consumer that decision was waiting for now exists (this requirement). Rows are one-per-run and tiny; no pruning in v1. The table's repository and round-trip contract obligations cover the timing fields like any other persisted field.
- The `validation.run_completed` **structured log event** carries the same fields (`queueMs`, `execMs`, outcome, `requestedScope`, `effectiveScope`, `scopedPathCount`, source, project), so the existing DuckDB-over-logs performance-analysis path works immediately, alongside direct SQL over the ledger.
- **No history UI in v1**, but list and status expose native/fallback support and requested/effective scope without executable paths. The data also answers per project × command execution-time distributions by effective scope, queue-wait distributions, outcome mix, and agent wall-clock spent on validation.
- Fast-follow enabled by the data (not v1 scope): `cctl validate list` can annotate typical durations ("test: ~4m in this project") through the existing best-effort dynamic help-context garnish, giving agents a real basis for choosing fail-fast, `--wait`, or doing other work first.

---

## 13. Verification

Unit and contract coverage, using injected scheduler/runner dependencies and real production policy logic rather than mocking internal modules:

- registry validation, stable command identity, unknown names, and cost-greater-than-limit rejection at every preflight boundary;
- leaf-level cascade, list replacement, seed-time selector expansion, independent script/agent selectors;
- weighted admission under simultaneous requests, strict FIFO, no leapfrogging, starvation resistance, live limit changes, release on every terminal path;
- scope dispatch — native changed, changed-to-full fallback, and explicit full select the immutable registered executable snapshot;
- `pathArgs` validation — full/fallback paths, option tokens, absolute paths, and traversal rejected; valid relative paths forwarded only to native changed runs;
- lease renewal restricted to the token holder, expiry cancellation, cancellation of queued and running jobs, process-group timeout and descendant cleanup, queue time excluded from timeout;
- timing capture: `submittedAt`/`startedAt`/`finishedAt` recorded at the correct transitions, `queueMs` and `execMs` derived separately, requested/effective scopes retained, terminal ledger rows retained, and the `run_completed` event carrying the same fields as the row;
- policy-disabled commands proving the scheduler and process runner were never called;
- fail-closed behavior for stale or mismatched graph identity;
- CLI text/JSON parity, stable exit codes, capacity hints, policy instructions;
- project-root, session-worktree, and graph-lane target resolution;
- sequential script-gate execution, stop-on-first-failure, full-list rerun after remediation, and capacity waiting not consuming a validation iteration;
- join-series behavior: under `final-only` exactly one validation per multi-lane join (at the last remaining lane), solo and `finalPublish` merges always validate, `every-merge` restores per-lane validation, deferred merges still run conflict resolution and log the deferral, the final run records its covered-lane set, and mid-series halt leaves debt that the resumed join settles;
- Smart Merge auto-fix and tree-state behavior with aggregate command identity;
- an architecture assertion that graph and merge modules cannot import the low-level runner.

**Live acceptance.** With the limit set to 4, start commands from two different projects/sessions. A cost-3 command runs; a second cost-3 command fails fast, then queues with `--wait` and starts only after the first releases. A cost-1 command behind that waiter must not leapfrog. Recorded active cost never exceeds 4 throughout. A disabled `format` returns its instruction with no process created. A cost-5 command is rejected outright, including with `--wait`. The same scenario runs through the agent CLI, a graph script validator, and Smart Merge to prove none has a bypass. Finally, kill the server mid-run and confirm recovery terminates the orphaned group before reopening admission.

---

## 14. Deliberate non-goals

- **Cost is declared, not measured.** Command Center cannot know real memory or thread usage; honest configuration and wrapper-pinned worker caps remain necessary.
- v1 does not adapt capacity to live RAM pressure, preempt running commands, or reprioritize the queue.
- Strict FIFO favors predictability and starvation-freedom over perfect utilization.
- Arbitrary option passthrough is excluded permanently; typed path scopes and separately registered profiles are the extension mechanism.
- The guarantee covers one Command Center control plane. Tools started manually, by pre-commit hooks, or by a separate CC installation are unmetered — this design caps the dominant agent-initiated source, not the OS.
- Per-worktree mutual exclusion is a separate correctness concern and is not bundled into the resource scheduler without evidence that concurrent mutating commands in one worktree actually occur.
- No run-history UI in v1. Terminal ledger rows are retained as the timing record (§12), but nothing renders them yet.

---

## 15. Recommended build order

1. Validation domain: registry schema, global capacity settings, target/policy resolution, the ledger, and the weighted FIFO scheduler behind one service interface.
2. `cctl validate` as a thin job-shaped client, fully help-registry wired.
3. Migrate the graph script validator, Smart Merge, and Smart Commit onto the service; add the architecture test; delete the legacy runner and config field.
4. Workflow cascade: `scriptValidator.commands`, the two `agentValidation` role selectors, and `laneMergeValidation` (selector + `final-only` join deferral), with every sibling surface and the UI.
5. Instruction and skill updates; regenerate derived references.
6. Split this repository's monolithic pre-merge script into granular scoped registrations and run the live acceptance scenario.

Steps 1–3 deliver the overload protection; step 6 delivers the scoping win.
