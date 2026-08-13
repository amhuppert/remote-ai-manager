---
name: cc-cli
description: >-
  This skill should be used when an agent running inside Command Center needs
  to perform a CC action through the `cctl` CLI — asking the user questions,
  sending notifications, registering documents, managing dev servers, working
  with workflows, or reading other conversations and their compaction
  artifacts — or when a `cctl` command fails and the agent needs to interpret
  its exit code or recover. Use when the agent asks "how do I use cctl", "what
  CC CLI commands exist", "cctl exited with code 3", "how do I check the CC
  server connection", how to pull context from a referenced conversation, or
  needs the cctl conventions (flags, identity resolution, --json envelope,
  hints).
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

Cross-session **mutations** always require explicit `--project`/`--session`
flags — `cctl` never silently *acts on* a different session than its env
identity. The exception is the read-only `cctl conversation` group, which
auto-resolves a conversation's owning project/session from its **id** alone
(see that section), so reading a `<conversation-ref>` needs no flags.
`cctl ticket attach conversation <ticket> <id>` uses that same global lookup
for its read of the source conversation; the mutation still targets only the
ticket identified by `<ticket>`.

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
- `code` (string) — a machine-readable error code, when the server supplies one
  (e.g. `NO_DEV_SERVERS_CONFIGURED`).
- `issues` (array of `{ path, message }`) — structured validation issues on a
  usage/validation failure (exit `2`). Text mode renders the same issues one per
  line; the `--json` envelope keeps them structured — read them, don't parse the
  prose.
- `hint` (string) — see the three tiers below.
- `reminders` (array of strings) — see the three tiers below.
- Remaining fields are command-specific.

### The three output tiers

Command output carries up to three tiers with **distinct** obligations. Do not
collapse them — the whole point is that each means something different:

| Tier | Field | Semantics | Your obligation |
|---|---|---|---|
| Hint | `hint` (string) | Advisory next step | **Ignorable by contract** — never load-bearing |
| Reminders | `reminders` (string[]) | Invariants that stay binding while you keep working | **Keep them true** — not an action to do now |
| Instruction | `instruction` / `stopInstruction` (string) | Do this specific thing now | **Obey first**, before anything else |

- **Hints** are a purely advisory pointer at a likely next command. Protocol-
  critical instructions never travel in `hint`. In text mode a hint is the final
  line, prefixed `hint:`.
- **Reminders** are server-authored, state-conditional invariants (they fire from
  runtime state, not on every call) — the graph-workflow **lane verbs** are the
  commands that emit them (see that section). In text mode each renders as a `reminder:` line,
  after the primary body and before the `hint:` line; in `--json` they are the
  `reminders[]` array. A reminder is not a step to perform — it is something to
  keep true as you continue.
- **Instructions** are load-bearing do-now text: `ask` and `decisions propose`
  emit end-turn `instruction`s, while a lane `task complete` may emit a
  `stopInstruction` for mid-turn context rotation. They arrive as primary output
  and/or a dedicated field — obey them before the hint or your own next step.

Text rendering order on any command: primary body → detail/`issues` lines →
`reminder:` lines → `hint:` line.

Structured input beyond a couple of scalars goes through `--file <path>`
(JSON; `-` for stdin): write the payload to a file **under
`.cc/temp/`** — CC git-ignores that namespace, so a graph-workflow lane's
land-time `git add -A` never sweeps the throwaway payload into the branch (a
payload left at the worktree root derails the context validator). Then run the
command and iterate on the validation errors it returns (one issue per line).

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

## cctl version

Print the `cctl` build stamp (git sha + build time) — compare it against the
server build `cctl doctor` reports. Reading only; always exits `0`, needs no
server, and is **terminal (no hint)**. `doctor` is the fuller check.

```
cctl version          # → cctl <sha>-<build-time>
cctl --version        # the same, as a global flag
cctl version --json   # → { "ok": true, "cliBuild": "<sha>-<build-time>" }
```

## Discovering commands with `--help`

`cctl` is a progressive-disclosure graph: every subcommand is a node with its own
`--help`. Navigate node by node instead of front-loading — `--help` resolves the
**full** positional path, so it is subcommand-granular:

```
cctl --help                              # top-level usage: the command list + global flags
cctl workflow --help                     # the 'workflow' group index: one line per subcommand
cctl workflow create --help              # the leaf: description, usage, flags, examples, related, skills
cctl conversation compaction get --help  # 3-level paths resolve too
```

A leaf node's help is a mini-skill: `description`, `usage`, `flags`, `examples`
(which teach failure-prone shapes, e.g. `--message-range A:B`), a `related:` block
(sibling commands), and a `skills:` block ("load X when Y"). A group node renders
an index of its children. Help always exits `0`, works offline, and never prompts —
it is the recovery path, so reach for it whenever a command surprises you.

### `--help --json` — the structured help node

`cctl <command> --help --json` returns the node as structured data instead of
prose (no rendered-text duplicate):

```json
{ "ok": true, "help": {
    "command": "workflow create",
    "summary": "…", "description": "…",
    "usage": ["cctl workflow create --file plan.json [--json]"],
    "flags": [{ "name": "file", "kind": "value", "valuePlaceholder": "<path>", "description": "…" }],
    "examples": [{ "invocation": "…", "explanation": "…" }],
    "related": [{ "command": "workflow start", "oneLiner": "…" }],
    "skills": [{ "name": "graph-workflow-planning", "loadWhen": "…", "path": "…" }]
} }
```

The bare top-level `cctl --help --json` is the one exception: it returns the usage
text blob as `{ "ok": true, "usage": "…" }`, because the top-level usage is not a
single command node.

### `context:` — dynamic, live-state blocks

Some **leaf** commands' `--help` appends a `context:` section (a `context.blocks[]`
array in `--json`) with **live application state** — e.g. `cctl dev ensure --help`
surfaces this session's dev servers and their URLs; inside a workflow lane,
`cctl workflow task complete --help` surfaces the lane's current task, remaining
count, and iteration budget.

This context is **best-effort garnish**, not contract:

- It is fetched from the server with a short timeout and **silently omitted** on
  any failure — no server, no token, offline, or a slow response. Help still
  renders the static sections and still exits `0`.
- **Never infer anything from its absence.** A missing `context:` block means it
  was not fetched, not that the underlying state is empty. Read it when present;
  do not treat it as a source of truth.
- **Group-node text help is a pure index** and never carries `context:` — a bare
  `cctl <group> --help` (e.g. `cctl dev --help`) just lists its subcommands. Ask a
  leaf's `--help` for live blocks (a group's `--help --json` may still include them).

## Command groups

Each group's verbs, flags, and examples are documented in its own section below.

<!-- BEGIN GENERATED COMMAND REFERENCE -->
### Command reference

_Generated from the `cctl` help registry — do not edit by hand; run `bun scripts/cc-cli-skill-reference.ts`. Every command's `--help` is the authoritative, always-current node._

- `cctl ask` — ask the user a question batch, then end your turn
  - `cctl ask --file .cc/temp/questions.json`
  - `cctl ask --question "<text>" --option <label> --option <label> [--multi-select] [--header "<h>"] [--context "<c>"]`

- `cctl notify` — send a push notification to the user
  - `cctl notify "<message>" [--title "<title>"]`

- `cctl docs` — register, list, and delete reference documents
  - `cctl docs <register|list|delete>`
- `cctl docs register` — register (or update) a reference document
  - `cctl docs register <path> --description "<why it matters>"`
- `cctl docs list` — list registered reference documents
  - `cctl docs list [--json]`
- `cctl docs delete` — deregister a reference document
  - `cctl docs delete <id>`

- `cctl dev` — list, ensure, and stop dev servers
  - `cctl dev <list|ensure|stop>`
- `cctl dev list` — show configured dev servers with status and URLs
  - `cctl dev list [--json]`
- `cctl dev ensure` — start a dev server and block until it is live
  - `cctl dev ensure [<serverName>]`
- `cctl dev stop` — stop a running dev server
  - `cctl dev stop <serverName>`

- `cctl fixture` — scaffold test sessions and run prompts against a dev server
  - `cctl fixture <session create|session delete|prompt|status>`
- `cctl fixture session` — create and delete throwaway test sessions
  - `cctl fixture session <create|delete>`
- `cctl fixture prompt` — run a real LLM turn in a test session
  - `cctl fixture prompt <project> <sessionName> --text "<prompt>" [--conversation <id>] [--wait [--timeout <sec>]]`
- `cctl fixture status` — list a test session's conversations and their status
  - `cctl fixture status <project> <sessionName>`
- `cctl fixture session create` — create a throwaway test session and pre-warm its routes
  - `cctl fixture session create <project> [--name <n>] [--dev <serverName>] [--target <url>] [--skip-warm]`
- `cctl fixture session delete` — tear down a throwaway test session
  - `cctl fixture session delete <project> <sessionName>`

- `cctl workflow` — list, inspect, start, and delete graph workflows
  - `cctl workflow <validate|create|replace|edit|list|get|status|start|delete|templates>`
  - `cctl workflow <task complete|task add|shared-doc upsert|collab request>  (lane verbs)`
- `cctl workflow validate` — check a plan.json without saving anything
  - `cctl workflow validate --file .cc/temp/plan.json [--tier global|project] [--json]`
- `cctl workflow create` — save a new definition from a validated plan
  - `cctl workflow create --file .cc/temp/plan.json [--json]`
- `cctl workflow replace` — overwrite an existing definition from a plan file
  - `cctl workflow replace <id> --file .cc/temp/plan.json [--json]`
- `cctl workflow list` — list this project's saved workflow definitions
  - `cctl workflow list [--json]`
- `cctl workflow get` — print a definition's outline (or one section, or the full JSON)
  - `cctl workflow get <id> [--full | --context <ctx> | --task <task> | --charter | --config | --params] [--tier global|project] [--json]`
- `cctl workflow edit` — apply targeted, atomic edits to a saved definition
  - `cctl workflow edit <id> --file .cc/temp/ops.json [--dry-run] [--tier global|project] [--json]`
- `cctl workflow status` — show this session's active execution
  - `cctl workflow status [--json]`
- `cctl workflow start` — launch an execution from a saved definition
  - `cctl workflow start <id> [--file .cc/temp/inputs.json] [--json]`
- `cctl workflow delete` — permanently remove a saved definition
  - `cctl workflow delete <id>`
- `cctl workflow templates` — list saved workflow templates across both tiers
  - `cctl workflow templates [--tier global|project] [--json]`
- `cctl workflow live` — act on this session's ACTIVE launched execution
  - `cctl workflow live <get|ledger|edit|amend|pause|resume|abort|release>`
- `cctl workflow task` — advance a running lane — complete or add tasks
  - `cctl workflow task <complete|add>`
- `cctl workflow graph` — grow the running graph from inside a lane
  - `cctl workflow graph expand --file .cc/temp/expansion.json`
- `cctl workflow shared-doc` — share a document with other lanes
  - `cctl workflow shared-doc upsert <relativePath> --file .cc/temp/doc.json`
- `cctl workflow collab` — request a second opinion from another agent
  - `cctl workflow collab request --brief "<question with context>"`
- `cctl workflow live get` — print the live outline of the active execution
  - `cctl workflow live get [--context <ctx> | --task <task> | --config <ctx> | --charter | --outputs | --full] [--json]`
- `cctl workflow live ledger` — print the active execution's loop ledger
  - `cctl workflow live ledger [--cursor <seq>] [--max-pages <n>] [--json]`
- `cctl workflow live edit` — apply live edits to the running execution's working copy
  - `cctl workflow live edit --file .cc/temp/live-ops.json [--dry-run] [--json]`
- `cctl workflow live amend` — add contexts, tasks, or edges to a running or paused delivery-plan run
  - `cctl workflow live amend --reason <rationale> --file <live-ops.json> [--json]`
- `cctl workflow live pause` — pause the active execution to unlock started contexts
  - `cctl workflow live pause [--json]`
- `cctl workflow live resume` — resume a paused or resumably-halted execution
  - `cctl workflow live resume [--json]`
- `cctl workflow live abort` — abort the active execution
  - `cctl workflow live abort --reason <reason> [--json]`
- `cctl workflow live release` — release the session's execution slot (explicit audited archive)
  - `cctl workflow live release --reason <reason> [--execution <id>] [--json]`
- `cctl workflow task complete` — mark the current lane task done (advances the workflow)
  - `cctl workflow task complete <taskId> --summary "<what changed, how verified>"`
- `cctl workflow task add` — append a newly-discovered task to this lane
  - `cctl workflow task add --title "<name>" --instructions "<self-contained steps>" [--slug <slug>]`
- `cctl workflow graph expand` — append new contexts, tasks, and edges to the running graph
  - `cctl workflow graph expand --file .cc/temp/expansion.json`
- `cctl workflow shared-doc upsert` — register or update a shared document for other lanes
  - `cctl workflow shared-doc upsert <relativePath> --file .cc/temp/doc.json`
- `cctl workflow collab request` — ask another agent to weigh in on an ambiguous decision
  - `cctl workflow collab request --brief "<question with context>"`

- `cctl charter` — submit the session's Alignment charter
  - `cctl charter write --file .cc/temp/charter.json`
- `cctl charter write` — submit the Alignment charter draft
  - `cctl charter write --file .cc/temp/charter.json`

- `cctl decisions` — propose decisions for the user's review
  - `cctl decisions propose --file .cc/temp/decisions.json`
- `cctl decisions propose` — propose a decision batch for review
  - `cctl decisions propose --file .cc/temp/decisions.json`

- `cctl agent` — run one-shot sub-agent jobs; read the agent profile library
  - `cctl agent <run|status|cancel|list|get>`
- `cctl agent run` — start an agent run (optionally waiting for it)
  - `cctl agent run --file .cc/temp/prompt.json [--wait [--timeout <dur>]] [--json]`
- `cctl agent status` — read a run's state (and recover its result)
  - `cctl agent status <runId> [--json]`
- `cctl agent cancel` — abort a live agent run
  - `cctl agent cancel <runId>`
- `cctl agent list` — list the agent profile library across every tier
  - `cctl agent list [--json]`
- `cctl agent get` — read one agent profile, including its instructions
  - `cctl agent get <tier:id> [--json]`

- `cctl validate` — list and run registered validation under the global cost budget
  - `cctl validate <list|run|status|cancel>`
- `cctl validate list` — list commands, policy enablement, and current capacity
  - `cctl validate list [--json]`
- `cctl validate run` — run one registered validation command
  - `cctl validate run <name> [--scope changed|full] [--wait] [--json] [-- <validated paths>]`
- `cctl validate status` — inspect active validation or one run
  - `cctl validate status [run-id] [--json]`
- `cctl validate cancel` — cancel an owned validation run
  - `cctl validate cancel <run-id> [--json]`

- `cctl conversation` — read conversation transcripts and manage compaction artifacts
  - `cctl conversation <read|compact|compaction get|compaction list>`
- `cctl conversation read` — render a bounded window of a transcript
  - `cctl conversation read [<conversation-id>] [--outline] [--message N] [--message-range A:B] [--seq-range A:B] [--include-tools none|summary|full] [--include-thinking] [--search <regex>] [--max-bytes N] [--format json|markdown] [--json]`
- `cctl conversation compact` — create or refresh a compaction artifact
  - `cctl conversation compact <conversation-id> [--message N] [--force] [--wait] [--json]`
- `cctl conversation compaction` — read compaction artifacts
  - `cctl conversation compaction <get|list>`
- `cctl conversation compaction get` — fetch the newest matching compaction envelope
  - `cctl conversation compaction get <conversation-id> [--message N] [--format json|markdown] [--json]`
- `cctl conversation compaction list` — list a conversation's compaction artifacts
  - `cctl conversation compaction list <conversation-id> [--json]`

- `cctl ticket` — create, list, read, update, delete, start work on, and attach context to work tickets
  - `cctl ticket <create|list|get|update|delete|start|attach|attachment>`
- `cctl ticket create` — create a ticket in the ambient project
  - `cctl ticket create --title "<title>" --type <feature|bug|research|tech_debt|performance> [--description "<markdown>"] [--status <not_started|in_progress|done|blocked|closed>]`
- `cctl ticket list` — list tickets with filters
  - `cctl ticket list [--status <status>] [--type <type>] [--sort <created|updated>] [--all]`
- `cctl ticket get` — read one ticket in full
  - `cctl ticket get <number | project#number>`
- `cctl ticket update` — update a ticket's fields or status
  - `cctl ticket update <number | project#number> [--title "<title>"] [--description "<markdown>"] [--type <type>] [--status <status>]`
- `cctl ticket delete` — delete a ticket
  - `cctl ticket delete <number | project#number>`
- `cctl ticket start` — start work on a ticket in a new session
  - `cctl ticket start <number | project#number> --mode <agent|prepared> [--backend <claude|codex> --model <model> --effort <level>]`
- `cctl ticket attach` — attach described context to a ticket
  - `cctl ticket attach <file|conversation|session|ticket|note> <number | project#number> … --description "<what and why>"`
- `cctl ticket attachment` — read, edit, refresh, and remove ticket attachments
  - `cctl ticket attachment <get|update|refresh|remove> <number | project#number> <attachmentId>`
- `cctl ticket attach file` — attach a file snapshot
  - `cctl ticket attach file <number | project#number> <path> --description "<what and why>" [--media-type <mime>]`
- `cctl ticket attach conversation` — attach a conversation's compaction snapshot
  - `cctl ticket attach conversation <number | project#number> [<conversationId>] --description "<what and why>"`
- `cctl ticket attach session` — attach a live session pointer
  - `cctl ticket attach session <number | project#number> <sessionName> --description "<what and why>"`
- `cctl ticket attach ticket` — attach a related ticket
  - `cctl ticket attach ticket <number | project#number> <relatedNumber | project#number> --description "<how it relates>"`
- `cctl ticket attach note` — attach a markdown note
  - `cctl ticket attach note <number | project#number> "<markdown>" --description "<what and why>"`
- `cctl ticket attachment get` — retrieve an attachment's full content
  - `cctl ticket attachment get <number | project#number> <attachmentId>`
- `cctl ticket attachment update` — edit an attachment's description or note body
  - `cctl ticket attachment update <number | project#number> <attachmentId> [--description "<what and why>"] [--markdown "<note body>"]`
- `cctl ticket attachment refresh` — retry a conversation snapshot capture
  - `cctl ticket attachment refresh <number | project#number> <attachmentId>`
- `cctl ticket attachment remove` — remove an attachment
  - `cctl ticket attachment remove <number | project#number> <attachmentId>`

- `cctl spec` — author, review, execute, and verify durable specs
  - `cctl spec list`
  - `cctl spec measures`
  - `cctl spec show <slug>`
  - `cctl spec status <slug>`
  - `cctl spec comments <slug> [--element <handle>] [--open]`
  - `cctl spec reply <slug> --thread <threadId> --body <text>`
  - `cctl spec lint <slug>`
  - `cctl spec get <slug>/<handle>`
  - `cctl spec search <slug> <query>`
  - `cctl spec search --all <query>`
  - `cctl spec diff <slug> [--from <revisionId>] [--to <revisionId>] [--baseline governance]`
  - `cctl spec schema [<document>]`
  - `cctl spec delta <slug> [--since <executionId>] [--out <delta.json>]`
  - `cctl spec export <slug> [--out <bundle.json>] [--stdout]`
  - `cctl spec verify <slug> [--against <bundle.json>]`
  - `cctl spec create --slug <slug> --name <name> --preset <preset> --file <element.json>`
  - `cctl spec import --file <bundle.json> [--dry-run]`
  - `cctl spec amend <slug>`
  - `cctl spec draft <slug> --file <element.json>`
  - `cctl spec remove <slug> <handle...>`
  - `cctl spec propose <slug>`
  - `cctl spec advance <slug> --from <requirements>`
  - `cctl spec question <slug> --text <text> [--element <handle>]`
  - `cctl spec answer <slug>/Q2 --answer <text>`
  - `cctl spec assume <slug> --text <text> [--element <handle>]`
  - `cctl spec task complete <slug>/T7 --execution <id> --evidence <id>`
  - `cctl spec plan open <slug> [--seed-from last]`
  - `cctl spec plan edit <slug> --file <plan.json>`
  - `cctl spec plan propose <slug>`
  - `cctl spec plan reopen <slug> --reason <why>`
  - `cctl spec plan get <slug>`
  - `cctl spec plan status <slug>`
  - `cctl spec plan preview <slug> --stage draft|proposed`
  - `cctl spec plan sign-off <slug>`
  - `cctl spec start <slug> [--park]`
  - `cctl spec capture <slug> --file <task.json>`
- `cctl spec list` — list native specs in the current project
  - `cctl spec list`
- `cctl spec measures` — compute native SDD pilot measures
  - `cctl spec measures`
- `cctl spec show` — read a spec's full or summary view
  - `cctl spec show <slug> [--summary]`
- `cctl spec status` — inspect a spec's phase and gate readiness
  - `cctl spec status <slug>`
- `cctl spec comments` — read reviewer comments as typed rows
  - `cctl spec comments <slug> [--element <handle>] [--open]`
- `cctl spec reply` — answer a review thread in place
  - `cctl spec reply <slug> --thread <threadId> --body <text>`
- `cctl spec lint` — read every deterministic lint finding on the open draft
  - `cctl spec lint <slug>`
- `cctl spec get` — read one spec element with approval and evidence state
  - `cctl spec get <slug>/<handle>`
  - `cctl spec get <slug> <handle>`
- `cctl spec search` — search requirement and decision text in one spec or across all
  - `cctl spec search <slug> <query>`
  - `cctl spec search --all <query>`
- `cctl spec diff` — read the semantic changelog between two revisions
  - `cctl spec diff <slug>`
  - `cctl spec diff <slug> --baseline governance`
  - `cctl spec diff <slug> --from <revisionId> --to <revisionId>`
- `cctl spec schema` — print the schema of every input document this family accepts
  - `cctl spec schema`
  - `cctl spec schema <document>`
- `cctl spec delta` — compare the approved spec against a delivered execution
  - `cctl spec delta <slug> [--since <executionId>] [--out <delta.json>]`
- `cctl spec export` — write a canonical portable spec bundle
  - `cctl spec export <slug>`
  - `cctl spec export <slug> --out <bundle.json>`
  - `cctl spec export <slug> --stdout`
- `cctl spec verify` — recompute spec integrity and report consistency findings
  - `cctl spec verify <slug> [--against <bundle.json>]`
- `cctl spec create` — create a durable spec from its first draft save
  - `cctl spec create --slug <slug> --name <name> --preset <contract-bearing|exploratory|fast-path> --file <element.json>`
- `cctl spec import` — create a new spec in one act from an external source bundle
  - `cctl spec import --file <bundle.json>`
  - `cctl spec import --file <bundle.json> --dry-run`
- `cctl spec amend` — reopen authoring on an approved spec as an amendment draft
  - `cctl spec amend <slug>`
- `cctl spec draft` — save a draft element at the version it replaces
  - `cctl spec draft <slug> --file <element.json>`
  - `cctl spec draft <slug> --file <elements.json>`
  - `cctl spec draft <slug> --file <batch.json>`
- `cctl spec remove` — take evergreen draft elements out in one transaction
  - `cctl spec remove <slug> <handle...>`
- `cctl spec propose` — propose the current authoring stage for review
  - `cctl spec propose <slug>`
  - `cctl spec propose <slug> --notes <notes.md>`
- `cctl spec withdraw-proposal` — take back your own proposal and reopen it as a draft
  - `cctl spec withdraw-proposal <slug> --revision <revision-id>`
- `cctl spec dismiss-superseded` — the human act that ends a proposal an approval forked past
  - `cctl spec dismiss-superseded <slug> --revision <revision-id> --reason <text>`
- `cctl spec advance` — conclude a Notify/Off authoring stage explicitly
  - `cctl spec advance <slug> --from <requirements>`
- `cctl spec question` — open a visible spec question for human answer
  - `cctl spec question <slug> --text <text> [--element <handle>]`
- `cctl spec answer` — answer an open spec question
  - `cctl spec answer <slug>/Q2 --answer <text>`
- `cctl spec assume` — propose a visible authoring assumption
  - `cctl spec assume <slug> --text <text> [--element <handle>]`
- `cctl spec plan` — author the delivery plan attempt that becomes the executed graph
  - `cctl spec plan open <slug> [--seed-from last]`
  - `cctl spec plan edit <slug> --file <plan.json>`
  - `cctl spec plan propose <slug>`
  - `cctl spec plan reopen <slug> --reason <why>`
  - `cctl spec plan get <slug>`
  - `cctl spec plan status <slug>`
  - `cctl spec plan preview <slug> --stage draft|proposed`
- `cctl spec task` — act on a task from a legacy approved spec plan
  - `cctl spec task complete <slug>/T7 --execution <id> --evidence <id>`
- `cctl spec request-approval` — route a spec gate to the user
  - `cctl spec request-approval <slug> --gate <gate> [--subject <handle-or-label>]`
- `cctl spec start` — launch the approved delivery-plan candidate, exactly as approved
  - `cctl spec start <slug> [--park]`
- `cctl spec capture` — record work discovered during a running execution as a durable discovery
  - `cctl spec capture <slug> --file <task.json> [--execution <id>] [--blocking-reason <reason>]`
- `cctl spec rename` — rename a spec's slug, keeping the old slug as an alias
  - `cctl spec rename <slug> --to <new-slug> [--name <name>]`
- `cctl spec abandon` — abandon one execution, or retire the whole spec as a human
  - `cctl spec abandon <slug> --reason <reason>`
  - `cctl spec abandon <slug> --execution <id> --reason <reason>`
- `cctl spec plan open` — open a delivery plan attempt against the approved revision
  - `cctl spec plan open <slug> [--seed-from last]`
- `cctl spec plan edit` — write the whole plan document at the draft revision you read
  - `cctl spec plan edit <slug> --file <plan.json>`
- `cctl spec plan propose` — freeze the plan as an immutable snapshot with a plan hash
  - `cctl spec plan propose <slug>`
- `cctl spec plan sign-off` — approve the stored candidate and admit the execution_start gate
  - `cctl spec plan sign-off <slug> [--candidate <id> --plan-hash <hash> --compiled-hash <hash>]`
- `cctl spec plan reopen` — return an unlaunched attempt to draft, invalidating its approval
  - `cctl spec plan reopen <slug> --reason <why>`
- `cctl spec plan get` — read the plan document the attempt carries
  - `cctl spec plan get <slug>`
- `cctl spec plan status` — read the attempt's state, findings, and the act it owes next
  - `cctl spec plan status <slug>`
- `cctl spec task complete` — claim task completion with evidence
  - `cctl spec task complete <slug>/T7 --execution <id> --evidence <evidence-id> [--evidence <evidence-id> ...]`
- `cctl spec plan preview` — render a delivery-plan attempt's materialized graph
  - `cctl spec plan preview <slug> --stage draft|proposed [--expected-draft-revision <n>]`

- `cctl doctor` — check connectivity, auth, and build parity with the CC server
  - `cctl doctor`

- `cctl version` — print the cctl build stamp
  - `cctl version`

<!-- END GENERATED COMMAND REFERENCE -->

## cctl validate

List and execute the project's registered validation commands through the server-owned ValidationService and its global cost budget.

```
cctl validate list [--json]
cctl validate run <name> [--scope changed|full] [--wait] [--json] [-- <validated paths>]
cctl validate status [run-id] [--json]
cctl validate cancel <run-id> [--json]
```

- `list` shows stable command names, declared costs, descriptions, path-scope support, caller enablement, and current global capacity. It intentionally does not reveal executable paths.
- `run` submits one registered name. Admission is fail-fast by default; `--wait` joins the strict weighted FIFO queue. A capacity refusal means systemic capacity or an older waiter currently blocks admission, not that the validation tool failed. A command whose declared cost exceeds the machine limit is invalid configuration and is rejected even with `--wait`.
- Values after `--` may only narrow a command registered with path scoping. The server rejects option tokens, absolute paths, traversal, and worktree escapes, so callers cannot override workers, heap, pool, or configuration. Omit `--` entirely for a command that forbids scope arguments.
- A command disabled for the caller's graph role exits successfully as a policy no-op, consumes no capacity, and spawns nothing. Do not retry it or bypass the policy.
- `status` without an id lists active queued/running jobs and capacity; with an id it reports that run's queue or terminal state. `cancel` requires the submitter's private lease. A blocking `run` renews its lease and attempts cancellation on SIGINT/SIGTERM; lease expiry is the fallback for a dead client.

Run registered validation only through `cctl validate run <name>`. Scope defaults to changed; use `--scope full` when full-project evidence is required. Full-only commands fall back automatically. Paths after `--` narrow native changed runs only. Do not invoke Vitest, ESLint, TypeScript, formatters, builds, their package-script aliases, or registered validation scripts directly. Never bypass the wrapper to avoid a queue or an execution-context policy. A direct invocation is allowed only for a narrow diagnostic the registered commands cannot express — state the reason first and use the smallest possible scope. If it is resource-intensive or repeatable, register a command instead.

Use `cctl validate list` before assuming a conventional name such as `test`, `lint`, or `typecheck`; projects may register arbitrary kebab-case names. Use the `project-setup` skill when adding or changing registry entries and wrappers.

## cctl notify

Send a push notification to the user (e.g. a long task finished, or you need
attention).

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
in their system prompt, with a note on when to read them.

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

## cctl ticket

Manage Command Center **tickets** — durable work items owned by one project,
identified as `<project>#<number>`.

```
cctl ticket create --title "<title>" --type <feature|bug|research|tech_debt|performance> [--description "<markdown>"] [--status <status>]
cctl ticket list [--status <status>] [--type <type>] [--sort <created|updated>] [--all]
cctl ticket get <number | project#number>
cctl ticket update <number | project#number> [--title …] [--description …] [--type …] [--status …]
cctl ticket delete <number | project#number>
cctl ticket attach <file|conversation|session|ticket|note> <number | project#number> … --description "<what and why>"
cctl ticket attachment <get|update|remove> <number | project#number> <attachmentId>
```

**Identifier forms.** A bare `<number>` resolves through the ambient project
scope (`--project` / `CC_PROJECT`); the `<project>#<number>` form addresses any
project's tickets from any conversation — including graph-workflow lanes — and
needs no ambient project. Unknown tickets exit `1` with `ticket_not_found`
naming the reference; malformed references, missing flags, and invalid enum
values exit `2` **before any network call**.

**The attachment index.** `list` and `get` always render each ticket's typed
attachment index — id, kind, description, and the exact retrieval/follow
command per entry — in both text and `--json` output (`attachmentIndex` in the
envelope). `list` bounds descriptions with an explicit `…`; `get` renders them
in full. Retrieve any entry's content with the command shown in its index line
(`cctl ticket attachment get <ticket> <id>`); related-ticket entries also carry
a `cctl ticket get <project>#<number>` follow command.

- `attach` — five kinds, each with a **required** `--description` (the
  descriptions are the index): `file <path>` snapshots bytes at attach time
  (survives source deletion; `--media-type` optional); `conversation
  [<conversationId>]` snapshots the conversation's compaction (defaults to the
  current conversation from `CC_CONVERSATION_ID`; an explicit id globally
  resolves its owning project and session, so no `--session` flag is needed);
  `session <sessionName>` and `ticket <ref>` are live pointers; `note
  "<markdown>"` is inline markdown.
- `attachment get` — resolve full content per kind (file content, compaction
  markdown with read commands, session state, related-ticket detail plus its
  own index, note body). `attachment update` edits `--description` (any kind)
  and `--markdown` (notes). `attachment remove` deletes the entry. All three
  work in any ticket status.

```
cctl ticket create --title "Flaky pre-merge gate" --type bug
# → created cc#12  Flaky pre-merge gate
cctl ticket attach file 12 logs/ci-failure.txt --description "full CI log of the flaky run"
cctl ticket get 12
# → cc#12  Flaky pre-merge gate
#   status: not_started  type: bug  created: …  updated: …
#   attachments:
#   - id-7 file — full CI log of the flaky run — cctl ticket attachment get cc#12 id-7
cctl ticket update 12 --status in_progress
```

Related: `cctl conversation compaction get` reads a compaction directly once a
conversation attachment names it; `cctl ticket get` is the follow command every
related-ticket entry embeds.

## cctl conversation

Read **conversation transcripts** in bounded windows and work with **compaction
artifacts** — dense, structured context handoffs generated from a conversation's
history. This is how an agent pulls context from another conversation (or its
own earlier history) referenced via a `<conversation-ref>`.

A `<conversation-ref>` carries ready-to-run commands for exactly this — a
`read-command` (always) and a `compaction-command` (when a compaction exists):
copy either verbatim, no flags needed. A `<message-ref>` is the same idea
scoped to one message (its `message-index` attribute): its `read-command`
reads just that message and its `compaction-command` (present when
`compacted="true"`) fetches that message's compaction.

```
cctl conversation read <conversation-id> [--outline] [--message N] [--message-range A:B]
                       [--seq-range A:B] [--include-tools none|summary|full]
                       [--include-thinking] [--search <regex>] [--max-bytes N]
                       [--format json|markdown] [--json]
cctl conversation compact <conversation-id> [--message N] [--force] [--wait] [--json]
cctl conversation compaction get <conversation-id> [--message N] [--format json|markdown] [--json]
cctl conversation compaction list <conversation-id> [--json]
```

**Windows & coordinates.** Ranges are `A:B` (e.g. `--message-range 2:3`;
`A-B`, `A,B`, and a bare `N` for `N:N` are also accepted). Two coordinate
systems, don't mix them: the `#N` unit headers in read output are **message
indexes** (`--message` / `--message-range`), while the `[sN]` line markers are
**seq coordinates** — raw JSONL lines, windowed with `--seq-range`. Compaction
source refs carry both (`messageIndex` + `seqStart`/`seqEnd`).

**Output sizes — read whole, don't pre-truncate.** An outline is typically
1–3 KB, a compaction envelope 10–20 KB, and windowed reads are bounded by
`--max-bytes` (default 256 KiB) server-side. Every output is already bounded,
so do **not** wrap `cctl` in `2>&1 | head -c N` — the pipe hides the exit
code, and errors already lead with their one actionable line.

**Identity:** `<conversation-id>` is positional and defaults to
`CC_CONVERSATION_ID` when omitted — reading your own history is valid. **You
normally pass only the id: for a conversation that isn't in your own session,
cctl auto-resolves its owning project + session from the id** (via the global
conversation lookup) and reads that scope — so reading any `<conversation-ref>`
needs no `--project`/`--session`. Flags stay an override: an explicit
`--project`/`--session` is honored as given (and `--project` **without**
`--session` targets the project-scoped endpoints, for conversations that live at
project scope). Auto-resolution is skipped for your own conversation id (already
in scope) and whenever you pass those flags; a truly unknown id exits `2`.

### Three-tier escalation — read in this order

1. **Compaction first.** `cctl conversation compaction get <id> --format
   markdown` renders the full envelope (agent brief, current state, decisions,
   files, commands, open questions, blockers) as prose with exact
   `messageIndex`/`seq` source refs — typically 10–20 KB, read it whole. This
   is almost always all the context you need, at zero token cost to generate.
   Use `--json` instead when you need the refs' verbatim quotes or
   machine-readable fields.
2. **Windowed read second.** When the compaction points you at something (or is
   stale/absent), pull a *bounded* window: `read --outline` for the table of
   contents, then `read --message-range A:B` or `--seq-range A:B` for the exact
   slice. Use `--search <regex>` to find matching units.
3. **Full transcript read — never.** Do not fetch an entire transcript
   unwindowed; `--max-bytes` (default 256 KiB) will truncate it anyway, and an
   unbounded read wastes your context on tool noise the compaction already
   distilled.

- `read` — render a window of the transcript. `--outline` returns user prompts +
  assistant headlines only (the TOC); `--message N`, `--message-range A:B`, and
  `--seq-range A:B` are mutually exclusive windows (`messageIndex` = merged
  visible message; `seq` = raw JSONL line). `--include-tools` defaults to
  `summary`; `--include-thinking` defaults off. `--format markdown` prints a
  compact fenced document instead of JSON-derived text. After `--outline` it
  hints the next escalation — and tells you whether a compaction exists to
  fetch, is still generating, or must be created first. With `--json`, the
  rendered output is in the `transcript` field for the default format, and in
  the `markdown` field when `--format markdown` is set. Invalid options exit
  `2` with one issue per line; an unknown conversation exits `2`. An empty
  window (e.g. message indexes that don't exist) reports the conversation's
  real coordinate bounds so you can re-aim.
- `compact` — create or refresh a compaction artifact (the whole conversation,
  or one message with `--message N`). Without `--wait` it returns immediately:
  `{ ok, artifactId, status: "pending", hint }` — the artifact generates in the
  background. With `--wait` it polls until the artifact completes (exit `0`),
  fails (exit `1` with the generation error), or a bounded timeout elapses.
  `--force` regenerates even when the existing artifact is fresh. If the
  artifact is already fresh it returns it directly with `hint: already fresh`.
- `compaction get` — fetch the newest matching artifact's **full envelope**
  (`--message N` selects that message's artifact; otherwise the
  conversation-level one). `--format markdown` renders the envelope as prose
  (brief, current state, decisions, files, commands, blockers — with their
  `#N sA–B` source refs) instead of raw JSON — usually the right form to read;
  the JSON envelope additionally carries the refs' verbatim quotes. With
  `--json` the markdown is in the `markdown` field. When stale it still
  succeeds (`stale: true`, `staleBehindMessages: N`) with `hint: refresh with:
  cctl conversation compact <id>`. When absent it exits `1` with `hint: create
  with: cctl conversation compact <id>` — create it, then re-get.
- `compaction list` — one line per artifact (id, kind, status, covered seq
  range, freshness). Ends with a hint pointing at `compaction get`.

Exit-code nuance: an unknown *conversation* is a caller mistake (exit `2`), but
an existing conversation with **no artifact yet** is exit `1` + the create hint —
distinguish them by the hint/stderr, not just the code.

```
cctl conversation compaction get 0197a3c2-... --json
# → exit 1, hint: create with: cctl conversation compact 0197a3c2-...
cctl conversation compact 0197a3c2-... --wait --json
# → { "ok": true, "artifact": { "status": "complete", "payload": { "agentBrief": ... } } }
cctl conversation read 0197a3c2-... --outline
# → #0 [seq 0-2] user ...
#   hint: narrow with --message-range A:B / --seq-range A:B, or fetch the compaction: cctl conversation compaction get 0197a3c2-...
#   (with no artifact: "…; no compaction exists — create one (background LLM generation) with: cctl conversation compact 0197a3c2-...")
cctl conversation read 0197a3c2-... --message-range 4:6 --include-tools summary
cctl conversation compaction get 0197a3c2-... --format markdown
```

## cctl dev

Manage this session's **dev servers** — the app processes CC spawns per worktree
(ports, local/remote URLs, liveness).

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

## cctl fixture

Scaffold **live-test state** — throwaway sessions and real LLM turns — for
verifying features in the running app. Every verb targets the session's
**worktree dev server** (auto-resolved through `cctl dev`'s registry), never
the managing CC instance: fixtures create and delete real sessions, and an
explicit `--target` equal to the managing server is refused.

```
cctl fixture session create <project> [--name <n>] [--dev <serverName>] [--target <url>] [--skip-warm]
cctl fixture session delete <project> <sessionName>
cctl fixture prompt <project> <sessionName> --text "<prompt>" [--conversation <id>] [--wait [--timeout <sec>]]
cctl fixture status <project> <sessionName>
```

- `<project>` is the project **on the dev server** (use a scratch project set
  aside for testing). An unknown name exits `2` listing the projects the dev
  server actually has.
- `session create` — creates the session and returns everything a live test
  needs in one envelope: `sessionName`, a ready `conversationId`, deep-link
  `urls` (session page + `/conversations?c=<id>`), and the dev instance's
  `dbPath`/`transcriptPath` for backend verification. It also **pre-warms**
  the returned routes (dev mode compiles each route on first hit, ~5–10s), so
  the first browser navigation lands warm; `--skip-warm` opts out.
- `session delete` — tears the session down (encodes the
  `DELETE …/sessions?sessionName=` query-param contract so you never have to).
- `prompt` — runs a **real LLM turn** in the conversation (defaults to the
  session's only conversation; pass `--conversation` when there are several).
  With `--wait` it blocks by reading the prompt SSE stream until the server's
  `done`/`error` event — no hand-rolled status polling; `--timeout <sec>` caps
  the wait (the turn keeps running server-side on timeout). Without `--wait`
  it returns immediately with `turn: "started"`.
- `status` — one-shot list of the session's conversations with their `status`
  (`new | awaiting | running | waiting_for_input`; a finished turn settles at
  `awaiting`).
- `--dev <serverName>` disambiguates when several dev servers are running.

```
cctl dev ensure
cctl fixture session create scratch-project --json
# → {"ok":true,"sessionName":"fx-...","conversationId":"...","urls":{...},"transcriptPath":"..."}
cctl fixture prompt scratch-project fx-... --text "reply with exactly: marker-7" --wait --json
grep "marker-7" <transcriptPath>   # verify against durable state, not the UI
cctl fixture session delete scratch-project fx-...
```

## cctl workflow

Author, read, launch, and inspect **graph workflows** — the saved multi-context
task graphs and their live executions.

```
cctl workflow validate --file .cc/temp/plan.json [--json]
cctl workflow create --file .cc/temp/plan.json [--json]
cctl workflow replace <id> --file .cc/temp/plan.json [--json]
cctl workflow edit <id> --file .cc/temp/ops.json [--dry-run] [--tier global|project] [--json]
cctl workflow status [--json]
cctl workflow list [--json]
cctl workflow get <id> [--full | --context <ctx> | --task <task> | --charter | --config | --params] [--tier global|project] [--json]
cctl workflow start <id> [--file .cc/temp/inputs.json] [--json]
cctl workflow delete <id>
cctl workflow templates [--tier global|project] [--json]
```

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
  workflow id and hints `start it with 'cctl workflow start <id>'`. The user
  reviews and edits it in the visual builder before starting.
- `replace` — overwrite an existing definition (`<id>`) with a `plan.json`;
  submit the **complete** graph, not a diff (the previous definition is fully
  overwritten). Re-validate first. For a targeted change, prefer `edit`. No hint
  — a revision is not a step in the author-then-start chain.
- `edit` — apply an ordered, **atomic** batch of domain operations to a saved
  definition, addressed by **stable ids** (never array indices) — cost
  proportional to the change, not the whole plan. `--file` is a JSON object
  `{ baseRevision, operations[] }` (or `--file -` to read from stdin); take
  `baseRevision` from what `cctl workflow get` shows (a stale value exits `1`
  `revision_conflict` — re-read and retry). Ops apply sequentially (later ops see
  earlier ones — add a context, then its tasks, then its edges in one batch) and
  reject the whole batch on any per-op or post-batch validation error. Op verbs
  mirror the runtime task-edit vocabulary: `update-workflow`, `update-charter`,
  `update-workflow-config`, `add`/`update`/`remove-context`,
  `add`/`update`/`remove`/`move-task`, `reorder-tasks`, `add`/`remove-edge`,
  `add`/`update`/`remove-parameter`, `add`/`remove-prerequisite`. Task order is
  never written by hand — place a task with `position` `{"at":"start|end"}` /
  `{"after":"<id>"}` / `{"before":"<id>"}`. A config/override field set to `null`
  **clears** it (restores cascade inheritance). `--dry-run` applies + validates +
  reports and persists nothing. A malformed ops file exits `2`; a rejected batch
  exits `1` with locator-first issues (`operations[i]: <code> — <detail>`).
  `--tier global` edits a global-library template.
- `status` — the workflow call you reach for most. Prints a compact per-context
  table for this session's active execution (`<context id>  <state>
  <completed>/<total>`), with the execution id and any halt reason on the header
  line. With `--json` it returns the **full** execution payload. When nothing is
  running it says so plainly. No hint.
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
cctl workflow validate --file .cc/temp/plan.json
# → plan is valid
#   hint: valid — create it with 'cctl workflow create --file .cc/temp/plan.json'
cctl workflow create --file .cc/temp/plan.json
# → created Add OAuth2 Support (id: wf-1)
#   hint: start it with 'cctl workflow start wf-1'
cctl workflow status
# → exec-4f1d2797  running
#     plan       completed  2/2
#     implement  running    1/4
#     verify     pending    0/1
cctl workflow start wf-1 --file .cc/temp/inputs.json
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
# author .cc/temp/ops.json: { "baseRevision": 7, "operations": [ { "type": "update-task", "taskId": "impl-tokens", "instructions": "…" } ] }
cctl workflow edit wf-1 --file .cc/temp/ops.json
# → edited "Add OAuth2 Support": 1 operation applied, revision 8
```

### Live execution editing — the running run

`workflow edit` edits a **saved definition**; `workflow live` edits the
**session's running (or paused/resumably-halted) execution** in place — its
working copy, not the definition it launched from. `workflow execution …` and
`workflow exec …` are aliases rewritten to `live` before dispatch and help
lookup. Session-scoped (reads your `CC_SESSION`); no execution running exits `2`.

```
cctl workflow live get [--context <ctx> | --task <task> | --config <ctx> | --charter | --full] [--json]
cctl workflow live edit --file .cc/temp/live-ops.json [--dry-run] [--json]
cctl workflow live pause [--json]
cctl workflow live resume [--json]
```

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
  amendment log), `--full` (every context expanded). An amended charter also
  shows in the outline header as `charter amended ×N`.
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
  `--dry-run` validates and reports without persisting.
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
#       "agent": { "backend": "claude", "model": "opus", "reasoningEffort": "high" } } } ] }
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
them true as you keep working (see the three output tiers above).

```
cctl workflow task complete <taskId> --summary "<what changed, how verified>"
cctl workflow task add --title "<name>" --instructions "<self-contained steps>" [--slug <slug>]
cctl workflow shared-doc upsert <relativePath> --file .cc/temp/doc.json
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
#   hint: 3 tasks remain in this context
cctl workflow task add --title "Handle token refresh" --instructions "Add refresh-token rotation to /api/auth; cover expiry in tests."
cctl workflow shared-doc upsert .cc/graph-workflow-docs/api-contract.md --file .cc/temp/doc.json
cctl workflow collab request --brief "Store sessions in SQLite or Redis? Constraints: single-node, <10k sessions, must survive restart."
```

## cctl charter

Submit the session's **Alignment charter** — the free-text markdown document
that governs the whole session.

```
cctl charter write --file .cc/temp/charter.json
```

- The charter is structured, multi-paragraph markdown, so it is **file-only**:
  author `.cc/temp/charter.json` as a JSON object `{ "content": "<full markdown>" }`,
  then submit. There is no inline text flag.
- The submission fills the session's open Alignment draft (the one `/align`
  creates); if none is open it defensively opens a gated one. A normal `/align`
  draft remains pending in the **Approve Charter** panel and leaves the active
  charter unchanged. A draft opened after the user approves decisions activates
  immediately on submission; the decision review is already its human gate.
- The command reports the actual result: either `charter draft submitted;
  pending the user's approval` or `charter activated as version <n>`. Never ask
  for a second approval after decision incorporation. Either way `charter write`
  is terminal for you — **no hint**; exit `0` on submission.
- Attended-only: on an autonomous/optimistic turn, or with no live conversation
  turn to author against, the server refuses and the command exits `1`.

```
cctl charter write --file .cc/temp/charter.json
# → charter draft submitted; pending the user's approval
```

## cctl decisions

Propose one or more **decisions** for the user to review. Review is
asynchronous; approved decisions fold into the Alignment charter.

```
cctl decisions propose --file .cc/temp/decisions.json
```

- **File-only**: author `.cc/temp/decisions.json` as a JSON object with a
  non-empty `decisions` array — each `{ "statement": "...", "rationale"?: "...",
  "context"?: "..." }`.
- The batch is persisted for human review. Write a brief handoff note, then end
  your turn immediately; do not begin more work. One complete result covering
  every approved or rejected decision and any rejection feedback arrives as the
  next user message, never in the proposing turn.
- The UI presents Approve/Reject as one explicit selection per decision, plus
  optional rejection feedback. `cctl` returns a load-bearing `instruction`
  field in JSON and the same instruction in text output. Attended-only, with the
  same refusals (exit `1`) as `charter`.

```
cctl decisions propose --file .cc/temp/decisions.json
# → proposed 2 decisions for the user's review
#   Decision review is pending. Write a brief handoff note, then end your turn now;
#   do not start new work. The complete decision review result will arrive as the
#   next user message.
```

## cctl agent

Run a backend agent (e.g. **OpenAI Codex**) as a one-shot sub-agent in this
worktree. The sub-agent operates autonomously with full access and does not
persist conversation state. Because a run can take tens of minutes, it is
**job-shaped**: the server runs it and the CLI observes it.

```
cctl agent run --file .cc/temp/prompt.json [--wait [--timeout <dur>]] [--json]
cctl agent status <runId> [--json]
cctl agent cancel <runId>
```

- `run` — start an agent run. **File-only input**: author `.cc/temp/prompt.json`
  as a JSON object `{ "backend": "codex", "prompt": "<task>" }`.
  `backend` is required (`codex` or `claude`); optional fields are `model`
  and `reasoning_effort` (`minimal|low|medium|high|xhigh`) plus the job extras
  `timeoutMs` (server-side execution cap) and `workingDirectory` (defaults to
  the session worktree; must resolve **inside** it). The agent is instructed to
  write detailed output to files under `memory-bank/agent-runs/` and return a
  short `summary` plus a `referenceDocuments` list — so **read the referenced
  files**, don't rely on the summary alone.
  - Without `--wait`: returns immediately with a `runId` and hints how to poll
    and cancel. The run continues server-side.
  - With `--wait`: long-polls until the run finishes and prints the result
    shape (`summary` + `referenceDocuments`). On completion with N>0 registered
    documents it hints you to read them. `--timeout <dur>`
    (`25m`, `90s`, `500ms`, or bare seconds like `1800`) bounds how long the CLI
    waits — **not** the run: if the budget elapses (or your Bash call is killed)
    the run keeps going; recover it with `cctl agent status <runId>`. A run that
    **failed server-side** (including a server-side timeout) exits `1` with the
    error.
- `status` — read a run's current state (`running`, or a terminal
  `completed`/`failed`). A `completed` run reproduces the full
  result (summary + reference documents) — this is how you recover a run whose
  `--wait` was killed. Reading always exits `0`; the run's own outcome is in the
  output. An unknown runId exits `2`.
- `cancel` — abort a live run. Idempotent; an unknown runId exits `2`. Terminal
  — no hint.

The Codex backend must be enabled in the CC config; if it is not, a
`"backend": "codex"` run exits `1` with a one-line reason.

```
cctl agent run --file .cc/temp/prompt.json --wait
# → found two bugs
#
#   reference documents:
#     memory-bank/agent-runs/bugs.md  —  the bugs
#   hint: the agent registered 1 reference documents — read them before building on the summary

cctl agent run --file .cc/temp/prompt.json
# → started agent run run-4f1d2797
#   hint: poll with 'cctl agent status run-4f1d2797'; cancel with 'cctl agent cancel run-4f1d2797'
cctl agent status run-4f1d2797
```

### The agent profile library

`list` and `get` read a different thing from the run verbs: the **agent profile
library** — the prompt identities (name, description, instructions, advisory
`recommendedFor`, tags) a conversation or a workflow assignment can be staffed
with. A profile is prompt identity only; it carries no backend, model, effort,
or tool policy.

```
cctl agent list [--json]
cctl agent get <tier:id> [--json]
```

- `list` — every profile reachable from this project across all three tiers:
  the curated `builtin` set, `global` profiles shared by every project on this
  install, and this project's own `project` profiles. This is the
  machine-discoverable selection surface: pick by reading descriptions.
  `recommendedFor` is **advisory** — filter and warn on it, never refuse on it.
  A stored record that fails to parse is reported under `diagnostics` instead of
  failing the listing. **Instruction text is never in a listing.**
- `get` — one profile by its **qualified** `tier:id`, including its
  instructions. Tiers are sibling scopes, not a shadowing chain:
  `global:reviewer` and `project:reviewer` are two different profiles, so a bare
  id is refused (exit `2`) before any request rather than guessed at. An unknown
  tier, a malformed id, and a reference that resolves to nothing each exit `2`
  with a typed refusal code naming the reference.

```
cctl agent list
# → 6 agent profiles
#   builtin:security-reviewer (rev 1)  Security Reviewer — Reviews a change for exploitable defects: …
#       for: workflow_validator  tags: review, security  read-only
#   hint: read one profile's full text with 'cctl agent get <tier:id>'

cctl agent get security-reviewer
# → Agent profile reference "security-reviewer" is unqualified. Write it as tier:id, …
#   hint: list the qualified references with 'cctl agent list'
cctl agent get builtin:security-reviewer
```

## cctl ask

Ask the user one or more multiple-choice questions. Unlike a built-in
question tool, the question is
**registered, not awaited**. You end your turn after asking; the answer arrives
as your **next user message**, delivered through the normal prompt queue.

```
cctl ask --file .cc/temp/questions.json
cctl ask --question "<text>" --option <label> --option <label> [--multi-select] [--header "<h>"] [--context "<c>"]
```

- `--file` — a JSON object `{ "questions": [ … ] }`, each question
  `{ "id"?, "question", "header"?, "context"?, "options": [ … ],
  "multiSelect"?, "required"?, "allowNote"? }`. Each option is
  `{ "label", "description"?, "recommended"?, "tradeoff"?: { "pro"?, "con"? } }`:
  `recommended` renders a "Suggested" badge (with a one-click "Accept all
  suggested" action), `tradeoff` renders as `+ pro` / `− con` lines under the
  option, and the question-level `context` supports markdown-lite (`**bold**`,
  `` `code` ``, `- ` bullets). Author the file under `.cc/temp/` with the Write
  tool.
- The `--question` form is sugar for a single question: repeat `--option` per
  choice (at least one); `--multi-select` allows picking several; `--header`
  and `--context` fill the panel's header and implications note. Options are
  bare labels here — use `--file` when options warrant descriptions, a
  recommended pick, or trade-offs (they usually do at a real fork).

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

### Asking from graph-workflow lanes

Graph-workflow **implementer** and **context-validator** lane agents may use
`cctl ask` when the workflow's `askUserQuestions` toggle resolves enabled
(three-tier cascade: global `workflowDefaults` → workflow → per-context;
default **disabled**; one value covers both roles). The mechanics differ from
ordinary conversations:

- Asking **parks the execution context** in `awaiting_user_input` until the
  user answers — the pause is real, not free. It burns no iterations and no
  failure count, sibling contexts keep running, and the workflow cannot
  complete while any context is parked, but your context makes zero progress
  until the answer lands. Ask only at consequential, hard-to-reverse, or
  genuinely ambiguous forks; batch related questions; end your turn after
  asking.
- The answer does **not** arrive through the message queue. The workflow
  resumes the asking conversation (even when continuity is off; a scheduled
  context-window rotation instead delivers the answers in the replacement
  conversation's first prompt) with the standard `<cc-question-answers>`
  block embedded in the resumed turn's prompt. `skipped: true` still means
  proceed with best judgment.
- When the toggle is disabled — and always for the planner session and
  collaboration second-agents — the ask is refused with the existing
  `autonomous conversation — proceed with best judgment` error: decide
  yourself and record the rationale.

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
