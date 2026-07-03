---
name: cc-cli
description: >-
  This skill should be used when an agent running inside Command Center needs
  to perform a CC action through the `cctl` CLI — asking the user questions,
  sending notifications, registering documents, managing dev servers, or
  working with workflows — or when a `cctl` command fails and the agent needs
  to interpret its exit code or recover. Use when the agent asks "how do I use
  cctl", "what CC CLI commands exist", "cctl exited with code 3", "how do I
  check the CC server connection", or needs the cctl conventions (flags,
  identity resolution, --json envelope, hints).
---

# Command Center CLI (`cctl`)

`cctl` is the Command Center control CLI — the way agents inside CC trigger CC
actions (notifications, questions, documents, dev servers, workflows). It is a
thin client over token-gated HTTP endpoints on the CC server. The server owns
the binary: it installs `cctl` into `<configDir>/bin` at startup, and every CC
session gets that directory prepended to `PATH`, so `cctl` is always resolvable
and always matches the running server.

Command shape: `cctl <group> <verb> [flags]` — always non-interactive, never
prompts. Run `cctl --help` (or any command with bad flags) to see the current
command surface.

## Identity and environment resolution

Every CC session is spawned with the env contract already set:

| Variable | Meaning |
|---|---|
| `CC_SERVER_URL` | CC server base URL |
| `CC_API_TOKEN` | instance API token |
| `CC_PROJECT` / `CC_SESSION` / `CC_CONVERSATION_ID` | your identity |

Inside a CC session you never need flags — commands resolve everything from
the env. Resolution order when both are present:

1. Explicit flags: `--server`, `--token`, `--project`, `--session`, `--conversation`
2. Env vars (the contract above)
3. Token only: the `<configDir>/api-token` file (the server's own token store)

A command that needs identity and cannot resolve it exits `2` naming the
missing variable. Outside CC (a plain terminal), pass the flags explicitly.

Cross-session operations always require explicit `--project`/`--session`
flags — `cctl` never silently acts on a different session than its env
identity.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | success | proceed |
| `1` | operation failed — the server said no | read stderr; the first line is the actionable error |
| `2` | usage/validation error (bad flags, invalid `--file` payload) | fix the invocation or payload and re-run |
| `3` | connection/auth failure (server unreachable, bad token) | run `cctl doctor` — see recovery below |
| `4` | reserved for hard version-mismatch (mismatches today only warn) | re-run `cctl doctor` |

Errors go to stderr, one actionable line first, detail after.

## Output and the `--json` envelope

Default output is human-terse one-liners. Every command also supports
`--json`, which prints a single JSON envelope on stdout:

- `ok` (boolean) — success/failure.
- `error` (string) — present when `ok` is false.
- `hint` (string, reserved) — an optional, purely advisory one-line pointer at
  a likely next command. **Hints are ignorable by design**: protocol-critical
  instructions never travel in `hint` (they are primary output or dedicated
  response fields). In text mode the same hint appears as a final line
  prefixed `hint:`.
- Remaining fields are command-specific.

Structured input beyond a couple of scalars goes through `--file <path>`
(JSON; `-` for stdin): author the payload with the Write tool, run the
command, and iterate on the validation errors it returns (one issue per
line).

## `cctl doctor`

The connectivity/auth/version diagnostic. Run it first whenever any `cctl`
command exits `3`, or to sanity-check the environment.

```
cctl doctor
```

Success (exit 0) prints the server URL, server and CLI build stamps, your
resolved identity, and token validity:

```
server        http://127.0.0.1:3000
server build  b034865-2026-07-02T21:00:00.000Z
cli build     b034865-2026-07-02T21:00:00.000Z
identity      project=my-repo session=my-session conversation=abc123
token         valid (source: env)
```

A build-stamp mismatch prints a warning on stderr but still exits 0 — the
server owns the binary, so a mismatch is transient across a server restart
and resolves itself.

### Troubleshooting (exit 3 recovery)

- **`cannot reach the CC server … is the CC server running?`** — the server
  is down or `CC_SERVER_URL` points at the wrong place. Inside a CC session
  this means the server itself restarted or died; there is nothing to fix
  from the session — report it to the user.
- **`the server rejected the API token`** — the token in `CC_API_TOKEN` (or
  your `--token` flag) does not match the server's `<configDir>/api-token`.
  The doctor output names which source the token came from; fix that source.
- **`no API token`** — nothing resolved from flag, env, or the token file.
  Inside CC this should never happen (the env contract injects it); outside
  CC, pass `--token` or export `CC_API_TOKEN`.

## Command groups

Each group's verbs, flags, and examples are documented in its own section below.

## cctl notify

Send a push notification to the user (e.g. a long task finished, or you need
attention). Replaces the `send_notification` MCP tool.

```
cctl notify "<message>" [--title "<title>"]
```

- The message is the single positional argument — quote multi-word messages.
- `--title` sets the notification title; it defaults to a generic title when
  omitted.
- Exit `0` on delivery. If push notifications are unconfigured or disabled the
  command exits `1` with a one-line reason — treat that as **non-fatal**; it
  just means the user will not be paged.
- A notification is terminal: there is no follow-up command, so `notify`
  deliberately prints **no hint**.

```
cctl notify "Build finished — 0 failures" --title "CI"
```

## cctl docs

Manage this session's **reference documents** — files other conversations see
in their system prompt, with a note on when to read them. Replaces the
`register_document`, `list_documents`, and `delete_document` MCP tools.

```
cctl docs register <path> --description "<why it matters>"
cctl docs list [--json]
cctl docs delete <id>
```

- `register` — register (or update) a document. `<path>` is a single positional
  (quote paths with spaces); `--description` is required and explains when/why
  agents should read it. The path must resolve **inside the session worktree** —
  an escaping path exits `2`. Re-registering the same path is idempotent: it
  updates the description in place rather than creating a duplicate. Terminal —
  **no hint**.
- `list` — print every registered document (`id  path  —  description`). Ends
  with a hint pointing at `register`/`delete`. With `--json`, the documents are
  in the `documents` array and the hint is in the reserved `hint` field.
- `delete` — deregister by `<id>` (from `list`) and remove the file from disk.
  An unknown id exits `2`. Terminal — **no hint**.

```
cctl docs register docs/api-contract.md --description "read before touching any /api route"
cctl docs list
cctl docs delete 4f1d2797-...
```

## cctl dev

Manage this session's **dev servers** — the app processes CC spawns per worktree
(ports, local/remote URLs, liveness). Replaces the `get_dev_servers`,
`ensure_dev_server`, and `stop_dev_server` MCP tools.

```
cctl dev list [--json]
cctl dev ensure [<serverName>]
cctl dev stop <serverName>
```

- `list` — show every configured server with its status and the `local`/`remote`
  URLs (the fields you actually need). With `--json`, each entry carries a derived
  `localUrl`. When nothing is configured it prints a plain notice.
- `ensure` — start (or adopt) a server and **block until it is live** or a bounded
  timeout elapses, then print its resolved URLs. Omit `<serverName>` when the
  project configures exactly one server; pass a name to disambiguate — an
  ambiguous omission exits `2` and lists the names. If the project configures no
  dev servers it exits `1` pointing you at `CommandCenter.json`; a start failure
  exits `1` with the server's recent output. On success it hints the local URL to
  drive and how to re-check liveness.
- `stop` — stop a named server (ownership-verified, so externally owned listeners
  are never killed). Terminal — **no hint**.

Always run `cctl dev ensure` **before** driving Playwright, browser, visual, or
Next.js tools — never assume ports like 3000 or 6006 belong to your worktree;
parallel sessions run on different ports.

```
cctl dev ensure
# → web — running
#     local:  http://localhost:5010
#     remote: https://web.example.ts.net
#   hint: drive the app at http://localhost:5010; re-check liveness with 'cctl dev list'
```

## cctl workflow

Author, read, launch, and inspect **graph workflows** — the saved multi-context
task graphs and their live executions. Replaces the `list_graph_workflows`,
`get_graph_workflow`, `get_graph_workflow_status`, `delete_graph_workflow`,
`start_graph_workflow`, `list_templates`, `create_graph_workflow`, and
`replace_graph_workflow` MCP tools.

```
cctl workflow validate --file plan.json [--json]
cctl workflow create --file plan.json [--json]
cctl workflow replace <id> --file plan.json [--json]
cctl workflow status [--json]
cctl workflow list [--json]
cctl workflow get <id> [--json]
cctl workflow start <id> [--file inputs.json] [--json]
cctl workflow delete <id>
cctl workflow templates [--tier global|project] [--json]
```

**Authoring** replaces the worst old MCP interaction — emitting a whole workflow
graph as inline tool arguments. Instead, author a `plan.json` with the Write
tool per the `graph-workflow-planning` skill (that skill owns the file shape and
the planning method), then walk the canonical chain: validate → create → start.

- `validate` — check a `plan.json` against the **exact** create-path rules (the
  create Zod parse plus graph structural checks: dependency cycles, unknown
  context refs, prerequisite sanity) **without saving anything**. On issues it
  exits `2` and prints one issue per line with its JSON path (e.g.
  `definition.tasks.2.contextId: …`) — fix the file and re-run. On success it
  hints the `create` command. Session-scoped (reads your `CC_SESSION`).
- `create` — save a new definition from a validated `plan.json`. Prints the new
  workflow id and hints `start it with 'cctl workflow start <id>'`. The user
  reviews and edits it in the visual builder before starting.
- `replace` — overwrite an existing definition (`<id>`) with a `plan.json`;
  submit the **complete** graph, not a diff (the previous definition is fully
  overwritten). Re-validate first. No hint — a revision is not a step in the
  author-then-start chain.
- `status` — the workflow call you reach for most. Prints a compact per-context
  table for this session's active execution (`<context id>  <state>
  <completed>/<total>`), with the execution id and any halt reason on the header
  line. With `--json` it returns the **full** execution payload. When nothing is
  running it says so plainly. No hint.
- `list` — this project's saved workflow definitions (`id  name (rev N)  —
  description`). Project-scoped; needs no session. No hint.
- `get` — print a saved definition's full JSON, for inspection before a
  `cctl workflow replace`. An unknown id exits `2`. No hint.
- `start` — launch an execution from a saved definition id. `--file` supplies a
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
cctl workflow validate --file plan.json
# → plan is valid
#   hint: valid — create it with 'cctl workflow create --file plan.json'
cctl workflow create --file plan.json
# → created Add OAuth2 Support (id: wf-1)
#   hint: start it with 'cctl workflow start wf-1'
cctl workflow status
# → exec-4f1d2797  running
#     plan       completed  2/2
#     implement  running    1/4
#     verify     pending    0/1
cctl workflow start wf-1 --file inputs.json
# → started wf-1 (run exec-9c2a...)
#   hint: track progress with 'cctl workflow status'
```

### Lane verbs — inside a running graph workflow

These are a **separate** family from the authoring/lifecycle verbs above. They
are for the **implementer agent running one lane of a live execution** — the
context whose tasks you are working through — not for authoring or launching
workflows. They replace the `cc-graph-workflow` MCP tools (`complete_task`,
`add_task`, `upsert_shared_document`, `request_collaboration`).

They resolve the lane's execution + context from the env CC injects at spawn —
`CC_WORKFLOW_EXECUTION_ID` and `CC_WORKFLOW_CONTEXT_ID`. You never pass those;
run the verbs outside a lane and they exit `2` naming the missing variable.
Every lane verb runs the execution's **halt check first**: if the run has been
halted or is blocked on a pending collaboration, the command exits `1` printing
the halt reason verbatim — stop and end your turn.

```
cctl workflow task complete <taskId> --summary "<what changed, how verified>"
cctl workflow task add --title "<name>" --instructions "<self-contained steps>" [--slug <slug>]
cctl workflow shared-doc upsert <relativePath> --file doc.json
cctl workflow collab request --brief "<the question/decision, with context>"
```

- `task complete` — mark the current task done. **Call this after each task** —
  it is the only way the workflow advances. `<taskId>` is the task's id/slug from
  the task list; `--summary` records what you changed and how you verified it.
  On success it prints `completed <taskId>` and hints how many tasks remain in
  this context. If the server returns a **stop instruction** (a mid-turn context
  rotation — "CONTEXT LIMIT REACHED … End your turn now …"), that text is printed
  as primary output **instead of** the remaining-count hint: obey it and end your
  turn with a brief handoff note; the workflow resumes the rest in a fresh
  conversation. Exit `0` either way.
- `task add` — append a newly-discovered task to this context. Only allowed when
  the context enables agent-added tasks; if it does not, it exits `1` with the
  reason. No hint.
- `shared-doc upsert` — register (or update) a shared document other lanes will
  read. `<relativePath>` is the doc's path in the worktree (e.g.
  `.cc/graph-workflow-docs/api-contract.md`); `--file doc.json` is a JSON object
  `{ "description": "…", "readWhen": "…" }` (author it with the Write tool —
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
#   hint: 3 tasks remain in this context
cctl workflow task add --title "Handle token refresh" --instructions "Add refresh-token rotation to /api/auth; cover expiry in tests."
cctl workflow shared-doc upsert .cc/graph-workflow-docs/api-contract.md --file doc.json
cctl workflow collab request --brief "Store sessions in SQLite or Redis? Constraints: single-node, <10k sessions, must survive restart."
```

## cctl charter

Submit the session's **Alignment charter** — the free-text markdown document
that governs the whole session. Replaces the `write_session_charter` MCP tool.

```
cctl charter write --file charter.json
```

- The charter is structured, multi-paragraph markdown, so it is **file-only**:
  author `charter.json` as a JSON object `{ "content": "<full markdown>" }` with
  the Write tool, then submit. There is no inline text flag.
- The submission fills the session's open Alignment draft (the one `/align`
  creates); if none is open it defensively opens a gated one. The result is a
  **draft pending the user's approval** — the active charter is unchanged until
  they approve it.
- Approval stays **human-driven**: your submission lands in the existing
  Approve-Charter panel exactly as the MCP tool's did — approve/reject is the
  user's call, with no UI change. So `charter write` is terminal for you —
  **no hint**; exit `0` on submission.
- Attended-only: on an autonomous/optimistic turn, or with no live conversation
  turn to author against, the server refuses and the command exits `1`.

```
cctl charter write --file charter.json
# → charter draft submitted; pending the user's approval
```

## cctl decisions

Propose one or more **decisions** for the user to review. Non-blocking:
approved decisions fold into the Alignment charter. Replaces the
`propose_decisions` MCP tool.

```
cctl decisions propose --file decisions.json
```

- **File-only**: author `decisions.json` as a JSON object with a non-empty
  `decisions` array — each `{ "statement": "...", "rationale"?: "...",
  "context"?: "..." }` — with the Write tool.
- Non-blocking: the batch is persisted for review and your turn continues — do
  **not** wait for a response. The batch lands in the existing decision-review
  UI; **approve/reject stays human-driven** (approved → folded into the charter,
  rejected → returned to you with feedback), with no UI change.
- Terminal for you — **no hint**; exit `0` on submission. Attended-only, with
  the same refusals (exit `1`) as `charter`.

```
cctl decisions propose --file decisions.json
# → proposed 2 decisions for the user's review
```

## cctl codex

Run **OpenAI Codex** as a one-shot sub-agent in this worktree. Codex operates
autonomously with full access and does not persist conversation state. Replaces
the `run_codex` MCP tool. Because a run can take tens of minutes, it is
**job-shaped**: the server runs it and the CLI observes it.

```
cctl codex run --file prompt.json [--wait [--timeout <dur>]] [--json]
cctl codex status <runId> [--json]
cctl codex cancel <runId>
```

- `run` — start a codex run. **File-only input**: author `prompt.json` as a JSON
  object `{ "prompt": "<task>" }` with the Write tool. The body mirrors the old
  `run_codex` tool input, so optional fields are `model` and `reasoning_effort`
  (`minimal|low|medium|high|xhigh`) plus the job extras `timeoutMs` (server-side
  execution cap) and `workingDirectory` (defaults to the session worktree; must
  resolve **inside** it). Codex is instructed to write detailed output to files
  under `memory-bank/codex/` and return a short `summary` plus a
  `referenceDocuments` list — so **read the referenced files**, don't rely on the
  summary alone.
  - Without `--wait`: returns immediately with a `runId` and hints how to poll
    and cancel. The run continues server-side.
  - With `--wait`: long-polls until the run finishes and prints the same result
    shape the tool returned (`summary` + `referenceDocuments`). On completion
    with N>0 registered documents it hints you to read them. `--timeout <dur>`
    (`25m`, `90s`, `500ms`, or bare seconds like `1800`) bounds how long the CLI
    waits — **not** the run: if the budget elapses (or your Bash call is killed)
    the run keeps going; recover it with `cctl codex status <runId>`. A run that
    **failed or timed out server-side** exits `1` with the error.
- `status` — read a run's current state (`running`, or a terminal
  `succeeded`/`failed`/`timed_out`). A `succeeded` run reproduces the full
  result (summary + reference documents) — this is how you recover a run whose
  `--wait` was killed. Reading always exits `0`; the run's own outcome is in the
  output. An unknown runId exits `2`.
- `cancel` — abort a live run. Idempotent; an unknown runId exits `2`. Terminal
  — no hint.

Codex must be enabled in the CC config; if it is not, `run` exits `1` with a
one-line reason.

```
cctl codex run --file prompt.json --wait
# → found two bugs
#
#   reference documents:
#     memory-bank/codex/bugs.md  —  the bugs
#   hint: codex registered 1 reference documents — read them before building on the summary

cctl codex run --file prompt.json
# → started codex run run-4f1d2797
#   hint: poll with 'cctl codex status run-4f1d2797'; cancel with 'cctl codex cancel run-4f1d2797'
cctl codex status run-4f1d2797
```

## cctl ask

Ask the user one or more multiple-choice questions. Replaces the
`AskUserQuestion` MCP tool — and changes the interaction model: the question is
**registered, not awaited**. You end your turn after asking; the answer arrives
as your **next user message**, delivered through the normal prompt queue.

```
cctl ask --file questions.json
cctl ask --question "<text>" --option <label> --option <label> [--multi-select] [--header "<h>"] [--context "<c>"]
```

- `--file` — a JSON object `{ "questions": [ … ] }`, each question
  `{ "id"?, "question", "header"?, "context"?, "options": [{ "label", "description"? }],
  "multiSelect"?, "required"?, "allowNote"? }`. Author it with the Write tool.
- The `--question` form is sugar for a single question: repeat `--option` per
  choice (at least one); `--multi-select` allows picking several; `--header`
  and `--context` fill the panel's header and implications note.

On success it prints the registration and the end-turn instruction. With
`--json` the envelope is `{ ok, questionBatchId, instruction }` — `instruction`
is a dedicated field, **not** a `hint`, because it is load-bearing protocol:

```
cctl ask --question "Which migration order?" --option "Phases in order" --option "Fast path"
# → Question batch q_ab12 registered. The user has been notified.
#   End your turn now with a brief handoff note (what you asked, what you'll do with the answer).
#   The answer will arrive as your next user message.
```

### End-turn discipline

- Ask **only at real forks** — consequential, hard-to-reverse, or genuinely
  ambiguous decisions. Make sensible calls on trivial or reversible choices.
- **Batch related questions into one call** — only one batch can pend per
  conversation, and a batch already holds multiple questions.
- After `cctl ask` succeeds: write a **brief handoff note** — what you asked
  and what you will do with each possible answer — then **end the turn**. Do
  not start new work; anything you produce after asking may be invalidated by
  the answer.
- Exit `1` with `question batch q_… already pending`: you already asked — end
  your turn now; the pending batch reaches the user without a second call.
- Exit `1` with `autonomous conversation — proceed with best judgment`: this
  conversation has no interactive user; decide yourself and record the
  rationale.
- Exit `1` with `no turn is running`: `ask` only works from inside a live
  conversation turn.

### Reading the answer

The answer arrives in your next user message as a self-contained block:

```
<cc-question-answers batch="q_ab12">
{ "approach": { "selected": ["Phases in order"], "note": "but land 2.3 early",
                "skipped": false, "question": "Which migration order?" } }
</cc-question-answers>
```

Entries are keyed by question id: `selected` holds the chosen label(s), `note`
is the user's free-text addition (may qualify or override the selection —
read it), and `skipped: true` means the user declined that question —
**proceed with your best judgment**. A normal user message instead of an
answer supersedes the question: treat the new message as the user's direction.
