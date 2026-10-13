---
name: run-planning
description: Plan, launch and steer supervised runs (`cctl run`). Use when delegating a bounded task to a supervised agent, planning a workflow of several contexts, steering a run you own (its questions, halts and amendments), or saving and launching run templates.
---

# Run Planning

A **run** is supervised agent work in your session. Each **context** in it has an implementer seat that does the work, optional checks and reviewer seats that judge it, and an accepted result that later contexts receive. The conversation that launches a run **owns** it: the run reports to you, and you answer its questions and clear its halts until it succeeds or you cancel it. A run never fails on its own; it halts and waits.

New delegated or multi-context work uses runs. Managed spec delivery still uses graph workflows (`cctl workflow` and the graph-workflow-planning skill).

This file carries the ordinary path: choose the launch, write what each seat needs, check, launch, steer. Read a reference only when the run needs it:

| Reference | Read when |
|---|---|
| [references/placement.md](references/placement.md) | contexts write at the same time, a context works in a lane, or a check refuses a scope, lane or check |
| [references/control-flow.md](references/control-flow.md) | work runs only when an earlier result says so, or repeats until a result says it is done |
| [references/amending.md](references/amending.md) | a running workflow must change: a halted route or loop, new work, or corrected documents |
| [references/templates.md](references/templates.md) | saving a run for the user to configure and launch again, or launching a saved one |

The cc-cli skill's runs reference covers command mechanics: receipts, wakes and refusals. `cctl run <verb> --help` owns exact fields.

## Choose the launch

- **`cctl run launch`**: one agent, one task. The file needs only `brief`.
- **`cctl run workflow`**: several contexts that build on each other's results, run side by side, work in lanes or branch. Use it for a single context too when you may need to change the run while it runs, or when its implementer should publish documents for later work: an agent run cannot be amended, and only workflow contexts publish documents.
- **`cctl run template launch`**: a saved template already describes the work.

Launch from an ordinary conversation of the session. A seat cannot launch runs, and a project conversation has no session to launch into.

## What a seat sees

Each seat is a fresh conversation. It does not see yours: not the planning discussion, the user's messages or the files you read. Its first order carries only:

- the context's title and `brief`;
- the charter's mission, the invariants and sources meant for this context and the non-goals, with the context's charter in full at `.cc/run-docs/<context-id>/charter.md`;
- the accepted results of the contexts it depends on, as JSON;
- its tasks (`t1`, `t2`, … by position) and acceptance criteria (`ac-1`, `ac-2`, …);
- the documents meant for it, as read-only copies under `.cc/run-docs/<context-id>/`;
- how to work: the commands to complete, reopen and add tasks, which `cctl validate` commands it may run, `cctl ask` while owner questions are on, `cctl context doc publish` in a workflow, and that a structured result is due when it has an `outputSchema`.

A reviewer sees the brief, the same charter part, inputs and criteria, the implementer's result and closing report, and the check results. It is told to edit nothing, and runs no validation commands.

So the brief carries everything else: the objective and why it matters, the files and modules involved, decisions already made and their reasons, what is out of scope, and how to verify locally. Leave out the mechanics listed above; the seat is told them.

## Planning procedure

1. **Read the governing context**: the full objective, the specs and design documents, the code. Resolve contradictions between sources now. Seats receive your plan, not the debate, and nothing at run time arbitrates between two sources.
2. **Inventory the surfaces** (schemas, persistence, lifecycle, adapters, API, UI, tests, migrations, diagnostics) and the contracts between them.
3. **Define contracts before tasks.** For each context, state what it produces, what it consumes and what it must not decide privately. Home a shared contract (a schema both sides validate, a state machine) in a context every consumer depends on, never in one of two parallel siblings.
4. **Close capability ownership.** For every capability the work introduces (a route, an event, a listener, a UI control), name the context whose criteria require its production call site. A deferring context's criteria name the owner, and the owner's criteria carry the obligation.
5. **Write the charter**: cross-cutting rules once, scoped honestly.
6. **Cut contexts around one validation thesis each**: one data model and one proof strategy. Count the independently failable obligations; a context that owes a dozen is several contexts.
7. **Write self-contained briefs and tasks** of 10–30 minutes each. Name the documents to read and the upstream results that are authoritative. Before writing "follow file X", check X against the invariants: seats copy precedent faithfully. For a banned pattern, give a concrete pre-completion check, such as a search.
8. **Add dependencies deliberately**: for hard needs, and for a foundation that removes ambiguity. Independent contexts get none.
9. **Place every context** after the dependencies exist ([Placement](#placement)). A dependency is often the cheaper fix for an overlap.

A started context keeps its brief, tasks, criteria, checks and seats until it ends, and once any member of a loop starts, every member does: get them right before launching.

## The launch file

Write it under `.cc/temp/`; omit every field you do not need.

| Field | Default | Meaning |
|---|---|---|
| `brief` | required | The work, self-contained |
| `title` | the brief's first line | The context's title |
| `tasks` | none | `[{title, instructions?}]`; the implementer completes each one and may add tasks |
| `acceptanceCriteria` | none | Strings; what the work must make true |
| `outputSchema` | none | The structured result later work and routes read; without one, the result is `{summary}`, the implementer's closing message |
| `checks` | none | Registered validation command names, run on the result |
| `reviewers` | none | `[{authority, focus?, profile?, backend?, modelSelection?}]` |
| `humanApproval` | `false` | The user approves the result in Command Center |
| `ownerQuestions` | `true` | Seats may ask you with `cctl ask` |
| `profile` | `{"tier": "builtin", "id": "standard-agent"}` | The implementer's agent profile (`cctl agent list`) |
| `backend`, `modelSelection` | configured default | The implementer's backend (`claude`, `codex`, `cursor`) and model |
| `timeoutMs` | none | A limit per backend invocation, not for the run |
| `documents` | none | See [Documents](#documents) |

A workflow file has a `title` (required), `contexts`, and optional `loops`, `lanes`, `documents` and `charter`. Each context takes the fields above (documents excepted) plus a `key` (1–48 lowercase letters, digits, `-` or `_`, starting with a letter or digit), `dependsOn`, `scope`, `lane` and `routing`. A context starts once every context it depends on succeeded.

```json
{
  "brief": "Add a --dry-run flag to the export command (src/cli/export.ts). With it, the command prints each file it would write and writes nothing. Parse it the way the existing --verbose flag is parsed. Other commands are out of scope. Verify with the export tests in src/cli/export.test.ts.",
  "acceptanceCriteria": [
    "export --dry-run prints the path of every file a normal export writes, and creates, changes or deletes no file",
    "export without --dry-run writes the same files as before"
  ],
  "checks": ["test"],
  "reviewers": [{ "authority": "blocking" }]
}
```

A workflow where two writers work side by side in owned directories and a third assembles them:

```json
{
  "title": "Report export",
  "charter": {
    "mission": "Users can download a report as CSV or JSON from the report page.",
    "invariants": [
      { "id": "server-formats", "statement": "The server produces the file; the page only downloads what the API returns." }
    ],
    "sourcesOfTruth": [
      { "rank": 1, "id": "export-design", "label": "Export design", "type": "document", "locator": "docs/export-design.md", "description": "Formats, columns and error cases." }
    ],
    "nonGoals": ["Scheduled or emailed exports"]
  },
  "documents": [
    { "path": "decisions.md", "from": ".cc/temp/export-decisions.md", "description": "Decisions made while planning the export", "readWhen": "Before choosing column order or file names" }
  ],
  "contexts": [
    {
      "key": "csv-writer",
      "brief": "Write the CSV writer in src/export/csv: it turns a Report into CSV bytes with the columns the export design lists. Unit-test it beside the code.",
      "scope": { "mode": "owned", "paths": ["src/export/csv"] },
      "acceptanceCriteria": ["writeCsv returns one header row and one row per report line, in the design's column order"],
      "checks": ["test"]
    },
    {
      "key": "json-writer",
      "brief": "Write the JSON writer in src/export/json: it turns a Report into the JSON document the export design specifies. Unit-test it beside the code.",
      "scope": { "mode": "owned", "paths": ["src/export/json"] },
      "acceptanceCriteria": ["writeJson returns a document that parses and holds every report line"],
      "checks": ["test"]
    },
    {
      "key": "export-route",
      "brief": "Add GET /api/reports/:id/export?format=csv|json using the two writers, and a download button on the report page.",
      "dependsOn": ["csv-writer", "json-writer"],
      "acceptanceCriteria": [
        "The route answers each format with the writer's bytes and a matching content type",
        "An unknown format is refused with 400 and names the supported formats",
        "The report page's download button calls the route"
      ],
      "checks": ["test", "typecheck"],
      "reviewers": [{ "authority": "blocking" }]
    }
  ]
}
```

Check names come from `cctl validate list` in the target project; `test` and `typecheck` above are placeholders.

## Acceptance criteria

Criteria are the contract between implementer and reviewers. A blocking reviewer cites the failing criterion's id (`ac-1`, …) in its findings.

- **One independently failable obligation per string.** A criterion that can pass in one half and fail in the other is two criteria.
- **Observable outcomes**: state transitions, emitted data, files, APIs, user-visible behaviour, and the important negative and refused cases.
- **Runtime reachability**: for every capability the context introduces, name the production composition site (route handler, service factory, listener registration, UI control) and require evidence through it. Existence ("is exported", "types are defined") is satisfied by dead code.
- **Bounded**: name the cases, or the decision rule for the indeterminate one ("a failed probe reports Unknown"). "Every call site", "complete parity" and "fully wired" need a task that first inventories the surface, or each review round finds one more site.
- **Within the context's scope**, never dependent on another context's private work. Deferral is valid only when the named owner's criteria carry the obligation.
- **Outcomes, not process.** A reviewer judges the finished work and cannot verify "a failing test was written first". Write the outcome ("a regression test fails when the change is reverted") and put process rules in the brief.
- **Leave deterministic gates to checks.** Tests, type checks, lint and builds belong in `checks`, not in criteria.

**Premise rule.** For a criterion that displays, reconstructs, audits or asserts runtime state, check its premises before launching:

- **Data:** open the authoritative record and field, and confirm it is retained and available where the criterion needs it. A record that keeps only the latest result cannot support a history without a storage deliverable.
- **Lifecycle:** read the transition in the state machine, including whether a revision updates a record or replaces it.
- **Control:** assert only state the code controls. For provider-owned or remote state, require the strongest control available, and disclosure of what remains.

Label each premise **verified**, with the file, symbol and observed fact, or **inferred**, in the brief or a document. An inferred premise is not ready: verify it or change the criterion. For a record or transition the work must add, name the context that adds it. For a criterion over several surfaces or verbs, enumerate the surface-by-verb matrix with named tests, or split it.

## The charter

A workflow's optional `charter` governs every context: `mission` (required), `invariants` (`[{id, statement, appliesTo?}]`), `sourcesOfTruth` (`[{rank, id, label, type, locator, description, appliesTo?}]`, `type` one of `code`, `config`, `document`, `spec`, `other`), and `nonGoals`, `conventions`, `vocabulary`, `testStrategy` and `knownAmbiguities`.

- Each context's first order carries the mission, the invariants and sources meant for it (rank 1 first; the higher rank governs a conflict) and the non-goals. Conventions, vocabulary, test strategy and known ambiguities are only in its `charter.md`.
- An invariant or source without `appliesTo` is meant for every context. Give it `appliesTo: [context keys]` when it binds specific contexts: reviewers check every invariant they receive, so an end state only the last context reaches belongs in that context's criteria, not in a global invariant.
- Ranks and ids are unique. Resolve conflicts between sources yourself, write the decision where seats read it (the mission, an invariant, a criterion), and say in the losing source's `description` what it no longer governs.
- A `locator` is read where it stands, in the seat's working directory, and never frozen. To give seats material that is uncommitted, outside the repository or likely to change, declare a document instead.
- Put the envelope's exclusions in `nonGoals`. Implementers decline work that only a non-goal would need, and reviewers report it as advice, not a blocking finding.
- Invariants and criteria state outcomes. `conventions` reach a seat only through its `charter.md`, which it reads on demand, so a rule the seat must follow belongs in the brief or an invariant.

## Documents

`documents: [{path, from or contents, description, readWhen?, appliesTo?}]` freezes reference material for the seats.

- `from` is a file path relative to the session worktree's root, read once at launch; `contents` is the text itself. Give exactly one.
- `path` is where the copy appears under `.cc/run-docs/<context-id>/`; a relative path, not `charter.md`.
- At most 256 KB each, and 1 MB for the run's documents together.
- `appliesTo: [context keys]` (workflow only) limits who receives it; every context does otherwise. `readWhen` tells the seat when to open it.
- A context freezes the documents' latest revisions when it starts. In a workflow, its implementer can publish a new document, or a new revision of one, with `cctl context doc publish` for work that starts later.

## Validation

By default, with no checks, reviewers or human approval, a result is accepted once the implementer finishes its tasks and its result is captured; a structured result that does not match its `outputSchema` still halts it. Add what the work needs:

- **`checks`**: registered validation commands run on the result, over the workspace's changes against its target branch, which include other contexts' changes. A failing check sends the work back. A check that rewrites the files under review fails, so select checks that only read, never a formatter that writes.
- **`reviewers`**: a `blocking` reviewer's `fail` sends the work back with its findings; its `plan_defect`, which says a criterion contradicts a higher-ranked source or cannot be met, halts the context for you. An `advisory` reviewer's advice reaches the implementer after the blocking review passes; the implementer addresses, declines or defers each item, and changed work goes through the checks and blocking reviewers again. `focus` narrows a reviewer's lens; `profile` defaults to `{"tier": "builtin", "id": "general-reviewer"}`. Add a specialist only when the context needs that lens.
- **`humanApproval: true`**: after checks and reviews pass, the user approves the result in Command Center, or rejects it with notes that send the work back. Agents cannot approve.
- **Allowances**: a context gets 2 extra work turns while tasks remain open and 3 rework turns after failed checks or blocking reviews. Spent, it halts; you grant more when the work is converging ([Steer the run](#steer-the-run)).

## Placement

Without `scope` or `lane`, a context writes the whole session worktree.

- Contexts that can run at the same time in one worktree need disjoint owned scopes: `"scope": {"mode": "owned", "paths": ["src/export/csv"]}`. Prefer directories to files, since implementers create files you did not foresee. Order contexts that share a surface with `dependsOn` instead.
- A reader that changes nothing takes `"scope": {"mode": "readOnly"}`. It cannot run beside a writer in the same worktree; give it an `outputSchema` when later work or a route reads its result.
- A whole-tree check of a context that has a writer alongside it is not run for that context. A later context that depends on it, runs whenever it runs and selects the same check covers it, as `export-route` does above; the check verb refuses a check nothing covers.
- A context with `"lane": "<key>"` works in its own worktree and branch, and the lane publishes into the session branch when its contexts are done. Lanes isolate risky or long work. They have ordering rules of their own: read [references/placement.md](references/placement.md) before using one.
- Session contexts leave their changes uncommitted in the session worktree; nothing commits them for you.

## Dynamic control flow

A dependency can be taken only when the source's accepted result matches a schema (`{"key": "triage", "when": {"schema": {…}}}`), or when no guarded sibling matched (`{"when": {"else": true}}`). A context whose route is not taken is skipped. A `loops` entry reruns a body of contexts until the exit's result matches `until`, at most `maxPasses` times. Reach for a static graph first, routes when the shape is known but which part runs is not, and a loop when the same work may need repeating. Authoring rules, cardinality and examples: [references/control-flow.md](references/control-flow.md).

## Check and launch

```
cctl run launch-check --file .cc/temp/run.json
cctl run launch --file .cc/temp/run.json
cctl run workflow-check --file .cc/temp/workflow.json
cctl run workflow --file .cc/temp/workflow.json
```

The check verbs run locally on the file. They apply the shape and every topology rule, with located issues: dependencies, scopes, lanes, routes, loops and check coverage. The launch then checks what only the server knows: each check name against the project's registered commands, each seat's profile, backend and model, the documents' paths, files and sizes, the session's state and your conversation's eligibility to own the run. Fix each issue and check again before launching.

The receipt names the run id. From launch you follow the run: each question, approval, halt and its result wakes you as a subscription update.

## Steer the run

Until the result arrives, edit no file the run may change; a context without `scope` may change every file in its worktree. Your edits are not isolated from the run: they join the result under review, an edit made while a check runs fails that check, and files that keep changing halt the context. Read, plan or end your turn; a wake brings you back. Each wake names the run, what happened and the command that answers it. `cctl run show <run-id>` prints the run's progress, each context's state, tasks, open questions, halt occurrence and result, lanes, loops, documents and recent boundaries.

- **A question:** `cctl run answer <run-id> --question <question-id> --text "<answer>"`. Answer from the brief's intent. When only the user can decide, ask them with `cctl ask`, then relay their answer. The run page shows the user the question, but only you answer it.
- **An approval:** only the user decides it, in Command Center. Tell them the run, context and result awaiting them.
- **A context halt:** read the halt and its occurrence in `cctl run show`, then resume with one of the dispositions it accepts:

  ```
  cctl run resume <run-id> --context <context-id> --occurrence <occurrence> --disposition continue
  cctl run resume <run-id> --context <context-id> --occurrence <occurrence> --disposition grant --allowance validationRetries --count 2 --reason "<why it is converging>"
  ```

  | Halt | Meaning | Dispositions |
  |---|---|---|
  | `retries_exhausted` | tasks still open, or checks and blocking reviews still failing, with the allowance spent | `grant` (`--allowance unfinishedTaskRetries` or `validationRetries`, `--count` 1–10, `--reason`) |
  | `plan_defect` | a blocking reviewer says the contract cannot be met as written | `rereview --reason`: the reviewer judges the same result again, and reads your reason |
  | `unavailable` | a check could not run, or a blocking reviewer could not answer | `retry` |
  | `output_invalid` | the structured result did not match the `outputSchema` | `retry_capture` |
  | `candidate_unstable` | the reviewed files kept changing before acceptance | `continue` |
  | `advice_invalid` | the implementer's response to advice was invalid | `retry_advice` |
  | `turn_failed`, `interrupted` | an agent turn failed or was interrupted | `continue`; `replace_seat` for a fresh conversation; `confirm_effect --evidence` |
  | `effect_uncertain` | whether a step took effect is unknown | `continue`, or `confirm_effect --evidence "<what you checked>"` |
  | `reconcile_failed`, `workspace_refused` | the run could not record or place a step | `continue` |

  Any `run resume`, with or without a disposition, also lifts the run's pause; if the user paused the run, clear a halt only when they ask.

  Grant only when the findings are shrinking; a context that fails the same way again needs a different contract, not more turns. A started context's brief and criteria cannot change, so a real `plan_defect` means cancelling and relaunching corrected work.
- **A fault** (the run could not be reconciled): `cctl run resume <run-id>` retries.
- **A lane that cannot provision or publish:** fix what stopped it, then `cctl run retry <run-id> --lane <key>` ([references/placement.md](references/placement.md)).
- **A halted route or exhausted loop, or work to add:** amend the workflow ([references/amending.md](references/amending.md)).
- **Pause and cancel:** `cctl run pause <run-id>` starts nothing new while admitted work finishes; `cctl run resume <run-id>` continues. `cctl run cancel <run-id>` stops every context; session contexts' partial work stays in the session worktree, and a lane's unpublished work stays on its branch. If the user paused the run, leave it paused unless they ask you to resume it. After a server restart, a run is paused until someone resumes it.

The user sees the run on its run page in Command Center, and acts there beside you: approvals, pause, resume, cancel, halt dispositions and lane retries.

When the run succeeds, the wake carries the result of every context that ran. Review the changes, commit what session contexts left uncommitted when the work calls for it, and report.

## Common failure modes

- **Brief without context**: the brief assumes the planning conversation, so the implementer guesses, and reviewers judge against what you meant.
- **Misaligned contract**: criteria judge behaviour the brief never asked for, or contradict a gated or deferred design.
- **Unbounded criteria**: the reviewer finds a new edge case every round because the state contract or the envelope was never written down. State the cases, and put exclusions in `nonGoals`.
- **Unowned wiring**: every context passes alone while no criteria require the production caller.
- **Deferral dead end**: a criterion says "verified in X", and X's criteria never carry it.
- **Criteria as a blob**: one string holds a paragraph of obligations.
- **Process as acceptance**: a criterion demands proof of how the work was produced.
- **Conflict shipped to the run**: two sources disagree and each context resolves it its own way.
- **Unreadable source**: a locator names material the seat's worktree does not hold.
- **Global invariant over phased work**: an end-state rule binds intermediate contexts that cannot meet it yet.
- **Precedent that breaks an invariant**: a brief says "follow file X", and X breaks the charter.
- **Check on an unfinished state**: a check selected for a context that leaves the tree intentionally incomplete; move it to the context that completes it.

## A final verification context

For substantial workflows, end with a context that depends on all implementation work. Its brief reads the full design and requirements, not only earlier results; it verifies that each surface is connected to the runtime path the user exercises and that gated behaviour is represented honestly, and it selects the checks the whole change must pass. Bound its criteria: enumerate the surfaces to check rather than "every surface". It is defence in depth for wiring, not the primary proof: each capability context proves its own production wiring. When the work ships user-visible behaviour, give one context a task and a criterion to drive the real running feature end to end; otherwise say plainly that the feature ships untested end to end.

## Before launching, confirm

- Each brief stands alone for an engineer who never saw this conversation, and names its out-of-scope work.
- Each criterion is one observable, bounded outcome; runtime-state criteria pass the premise rule.
- Every capability has a context whose criteria require its production call site, and every deferral ends in a criterion that carries it.
- Cross-cutting rules are in the charter once, each global or scoped with `appliesTo`; no two sources conflict.
- Checks are registered names from `cctl validate list`, selected only where the tree should pass them.
- Profiles come from `cctl agent list`; optional settings appear only where the work needs them.
- The check verb passes on the final file.
