## cctl workflow

Author, read, launch, and inspect **graph workflows** — the saved multi-context
task graphs and their live executions. Every verb and its invocation shape is in
[the command reference](command-reference.md) (`cctl workflow --help` for the live index),
including the one-off lifecycle trio `run`/`wait`/`abandon`.

**Authoring** is file-based — never emit a whole workflow
graph as inline tool arguments. Author a `plan.json` file
per the `graph-workflow-planning` skill (that skill owns the file shape and
the planning method), then walk the canonical chain: validate → create → start.

- `validate` — check a `plan.json` against the **exact** create-path rules (the
  create Zod parse plus graph structural checks: dependency cycles, unknown
  context refs, prerequisite sanity) **without saving anything**. On issues it
  exits `2` and prints one issue per line with its JSON path (e.g.
  `definition.tasks.2.contextId: …`) — fix the file and re-run. On success it
  hints the `create` command. Session-scoped (reads your `CC_SESSION`).
- `create` — save a new definition from a validated `plan.json`. Prints the new
  workflow id and hints `review it in the visual builder, then start it with
  'cctl workflow start <id>'`.
- `replace` — overwrite an existing definition (`<id>`) with a `plan.json`;
  submit the **complete** graph plus `expectedRevision` from `workflow get`, not
  a diff (the previous definition is fully overwritten). Re-validate first. For
  a targeted change, prefer `edit`. A stale revision refuses without writing. No hint
  — a revision is not a step in the author-then-start chain.
- `edit` — apply an ordered, **atomic** batch of domain operations to a saved
  definition, addressed by **stable ids** (never array indices) — cost
  proportional to the change, not the whole plan. `--file` is a JSON object
  `{ expectedRevision, operations[] }` (or `--file -` to read from stdin); take
  `expectedRevision` from what `cctl workflow get` shows (a stale value exits `1`
  `stale_workflow_definition` — re-read and retry). Ops apply sequentially (later ops see
  earlier ones — add a context, then its tasks, then its edges in one batch) and
  reject the whole batch on any per-op or post-batch validation error. Op verbs
  mirror the runtime task-edit vocabulary: `update-workflow`, `update-charter`,
  `update-workflow-config`, `add`/`update`/`remove-context`,
  `add`/`update`/`remove`/`move-task`, `reorder-tasks`, `add`/`remove-edge`,
  `add`/`update`/`remove-parameter`, `add`/`remove-prerequisite`. Task order is
  never written by hand — place a task with `position` `{"at":"start|end"}` /
  `{"after":"<id>"}` / `{"before":"<id>"}`. A config/override field set to `null`
  **clears** it (restores cascade inheritance). `workflow edit-preview` applies + validates +
  reports and persists nothing. A malformed ops file exits `2`; a rejected batch
  exits `1` with locator-first issues (`operations[i]: <code> — <detail>`).
  `--tier global` edits a global-library template.
- `status` — the workflow call you reach for most. Prints a compact per-context
  table for this session's active execution (`<context id>  <state>
  <completed>/<total>`), with the execution id and any halt reason on the header
  line; `--json` serializes that same projection. Two mutually-exclusive
  selectors open the rest: `--halt` returns the whole structured halt reason
  (every finding) and its plan-repair rounds, and `--full` returns the
  unstripped execution record. When nothing is running it says so plainly. No
  hint.
- `list` — this project's saved workflow definitions (`id  name (rev N)  —
  description`). Project-scoped; needs no session. No hint.
- `get` — print a saved definition's compact **outline** by default (structure,
  ids, per-context task counts + deps, and prose **sizes**, not bodies) — the
  navigation map for a targeted `cctl workflow edit`, including the current
  `revision`. Section selectors fetch **one** full-prose slice
  (`--context <ctx>` / `--task <task>` / `--charter` / `--config` / `--params`);
  `--full` prints the entire record (for a wholesale `replace`). At most one
  selector per invocation; `--tier global` reads a global-library template. An
  unknown id exits `2`. No hint.
- `start` — launch an execution from a saved definition id. `--inputs` supplies a
  JSON **object** of launch parameter values (the `{{inputs.<name>}}` a template
  declares); a missing/invalid/non-object file exits `2`. A guard rejection
  (a run already active, uncommitted worktree changes, unmet prerequisites)
  exits `1` with the reason. On success it hints `track progress with 'cctl
  workflow status'`.
- `delete` — permanently remove a saved definition by id. An unknown id exits
  `2`. Terminal — no hint.
- `templates` — list saved templates across **both** tiers: the cross-project
  `global` library and this project's `project` library, each row tier-tagged
  (`<tier>  <id>  <name>`). `--tier global|project` filters to one tier. No hint.

```
cctl workflow validate --file .cc/temp/plan.json
# → plan is valid
#   hint: valid — create it with 'cctl workflow create --file .cc/temp/plan.json'
cctl workflow create --file .cc/temp/plan.json
# → created Add OAuth2 Support (id: wf-1)
#   hint: review it in the visual builder, then start it with 'cctl workflow start wf-1'
cctl workflow status
# → exec-4f1d2797  running
#     plan       completed  2/2
#     implement  running    1/4
#     verify     pending    0/1
cctl workflow start wf-1 --inputs .cc/temp/inputs.json
# → started wf-1 (run exec-9c2a...)
#   hint: track progress with 'cctl workflow status'
```

Targeted revision — read the outline, edit one piece (never resubmit the whole graph):

```
cctl workflow get wf-1
# → workflow wf-1 "Add OAuth2 Support" rev 7
#   contexts (3):
#     plan       "Plan the approach"  deps=-      tasks=2
#     implement  "Implement"          deps=plan   tasks=4
#     verify     "Verify"             deps=implement  tasks=1
#   tasks:
#     implement  1 impl-tokens  "Migrate tokens"  (1.4k chars)
#   …
cctl workflow get wf-1 --task impl-tokens        # pull just that task's full instructions
# author .cc/temp/ops.json: { "expectedRevision": 7, "operations": [ { "type": "update-task", "taskId": "impl-tokens", "instructions": "…" } ] }
cctl workflow edit wf-1 --file .cc/temp/ops.json
# → edited "Add OAuth2 Support": 1 operation applied, revision 8
```

### Live execution editing — the running run

`workflow edit` edits a **saved definition**; `workflow live` edits the
**session's running (or paused/resumably-halted) execution** in place — its
working copy, not the definition it launched from. `workflow execution …` and
`workflow exec …` are aliases rewritten to `live` before dispatch and help
lookup. Session-scoped (reads your `CC_SESSION`); no execution running exits `2`.

The group's verbs — `get`, `ledger`, `edit`, `amend`, `pause`, `resume`,
`abort` — and their invocation shapes are in [the command reference](command-reference.md).

- `get` — print the active execution's **live outline**: a header
  (`executionId`, `liveRevision`, status, seed `id@revision`, whether it is
  editable), per-context rows (status, editability tier — **frozen** /
  **editable** / **pause-to-edit** — from the shared lifecycle classifier, deps,
  task + iteration progress), per-task rows (id, order, status, title,
  instruction **size** — prose is never inlined), and a one-line config summary
  per context. The header's `liveRev` is the value your edit's
  `baseLiveRevision` must match. Selectors (at most one): `--context <ctx>`
  (full prose + resolved config for one context), `--task <task>` (full
  instructions), `--config <ctx>` (one context's **full resolved config** —
  implementer, validator, gates, iteration policy, circuit breaker, mutability,
  collaboration), `--charter` (the current charter document with its live
  amendment log), `--outputs` (every schema-declaring context's capture status
  with the captured payload and its parse provenance), `--full` (every context
  expanded). An amended charter also shows in the outline header as
  `charter amended ×N`.
- The `amend-charter` op (in `live edit`'s `operations[]`) partial-merges
  charter content (mission, conventions, non-goals, vocabulary, test strategy,
  known ambiguities, invariants, sources of truth) with a **required
  `rationale`** recorded in the amendment log; completed contexts keep the
  charter version they ran under. Quiescence-gated like structural ops —
  pause (or a resumable halt) first.
- `edit` — apply an ordered, **atomic** batch of live edits to the working copy,
  addressed by **stable ids**. `--file` (or `-` for stdin) is a JSON object
  `{ "executionId", "baseLiveRevision", "source": "cli", "operations": [ … ] }`
  stored under `.cc/temp/`; the CLI always sends `source "cli"`. `baseLiveRevision`
  must equal the header's `liveRev` (a stale value exits `1` `revision_conflict`
  — re-read and retry). **Completed** contexts are frozen; **not-started**
  contexts are editable while the run continues; **started** contexts need a
  `pause` first (pause-to-edit). A code-bearing rejection
  (`execution_mismatch` / `revision_conflict` / `not_editable` / `frozen` /
  `requires_pause` / `invalid_edit`) exits `1` with the code on the `--json`
  envelope and issues one per line; a malformed/unreadable file or missing
  execution exits `2` (deterministic local checks run before any network call).
  `workflow live edit-preview` validates and reports without persisting; `workflow live edit-check` performs input admission.
- `pause` / `resume` — pause the running execution (so started contexts become
  editable) and resume it afterward. A server `409` (e.g. nothing to pause/resume)
  renders as exit `1`.

The canonical loop for a running context that is not editable in place is
**get → pause → edit → resume**:

```
cctl workflow live get
# → exec-7  liveRev 4  running  (seed wf-1@8)
#     plan       completed  frozen         2/2
#     implement  running    pause-to-edit  1/4   iter 1/3
#     verify     pending    editable       0/1
cctl workflow live pause
cctl workflow live edit --file .cc/temp/live-ops.json
# live-ops.json: { "executionId": "exec-7", "baseLiveRevision": 4, "source": "cli",
#   "operations": [ { "type": "update-context", "contextId": "verify",
#     "implementer": { "id": "implementer",
#       "profile": { "tier": "builtin", "id": "general-implementer" },
#       "agent": { "backend": "claude", "modelSelection": {
#         "modelId": "opus", "parameters": { "effort": "high" } } } } } ] }
cctl workflow live resume
```

### Lane verbs — inside a running graph workflow

These are a **separate** family from the authoring/lifecycle verbs above. They
are for the **implementer agent running one lane of a live execution** — the
context whose tasks you are working through — not for authoring or launching
workflows.

They resolve the lane's execution + context from the env CC injects at spawn —
`CC_WORKFLOW_EXECUTION_ID` and `CC_WORKFLOW_CONTEXT_ID`. You never pass those;
run the verbs outside a lane and they exit `2` naming the missing variable.
Every lane verb runs the execution's **halt check first**: if the run has been
halted or is blocked on a pending collaboration, the command exits `1` printing
the halt reason verbatim — stop and end your turn.

Lane-verb output may also carry tier-2 **reminders** (`reminder:` lines, or a
`reminders[]` array in `--json`) — server-authored, state-conditional invariants
such as "you are near the iteration budget; fix root causes before re-completing"
or, on the halt path, "the workflow is halted — end your turn." They fire only
from runtime state, they are capped, and they are **not steps to perform**: keep
them true as you keep working (see [the output tiers](../SKILL.md#output-tiers)).

```
cctl workflow task complete <taskId> --summary "<what changed, how verified>"
cctl workflow task add --title "<name>" --instructions "<self-contained steps>" [--slug <slug>]
cctl workflow shared-doc upsert <relativePath> --file .cc/temp/doc.json
cctl workflow collab request --brief "<question with context>"
```

- `task complete` — mark the current task done. **Call this after each task** —
  it is the only way the workflow advances. `<taskId>` is the task's id/slug from
  the task list; `--summary` records what you changed and how you verified it.
  On success it prints `completed <taskId>` and how many tasks remain in
  this context. If the server returns a **stop instruction** (a mid-turn context
  rotation — "CONTEXT LIMIT REACHED … End your turn now …"), that text is printed
  **instead of** the remaining-count line: obey it and end your
  turn with a brief handoff note; the workflow resumes the rest in a fresh
  conversation. Exit `0` either way.
- `task add` — append a newly-discovered task to this context. Only allowed when
  the context enables agent-added tasks; if it does not, it exits `1` with the
  reason. No hint.
- `shared-doc upsert` — register (or update) a shared document other lanes will
  read. `<relativePath>` is the doc's path in the worktree (e.g.
  `.cc/graph-workflow-docs/api-contract.md`); `--file .cc/temp/doc.json` is a JSON object
  `{ "description": "…", "readWhen": "…" }` (author it under `.cc/temp/` —
  both fields are prose). No hint.
- `collab request` — request a structured second opinion from another agent on a
  genuinely ambiguous, high-impact decision. `--brief` states the problem and the
  context (do **not** include your preferred solution). The collaboration runs in
  the **background**: the command returns immediately with a workflow id — **stop
  work on this turn and wait** for the follow-up that delivers the outcome. Only
  allowed when the context enables collaboration; otherwise exits `1`.

```
cctl workflow task complete implement-auth --summary "Added OAuth2 route + tests; bun test green"
# → completed implement-auth
#   3 tasks remain in this context
cctl workflow task add --title "Handle token refresh" --instructions "Add refresh-token rotation to /api/auth; cover expiry in tests."
cctl workflow shared-doc upsert .cc/graph-workflow-docs/api-contract.md --file .cc/temp/doc.json
cctl workflow collab request --brief "Store sessions in SQLite or Redis? Constraints: single-node, <10k sessions, must survive restart."
```
