## cctl agent

Run a backend agent (e.g. **OpenAI Codex**) as a one-shot sub-agent in this
worktree. The sub-agent operates autonomously under its configured permissions and does not
persist conversation state. Because a run can take tens of minutes, it is
**job-shaped**: the server runs it and the CLI observes it.

```
cctl agent run --file .cc/temp/prompt.json [--wait [--timeout <dur>]] [--json]
cctl agent status <runId> [--json]
cctl agent cancel <runId>
```

- `run` — start an agent run. **File-only input**: author `.cc/temp/prompt.json`
  as a JSON object `{ "backend": "codex", "prompt": "<task>" }`.
  `backend` is required (`codex` or `claude`). The optional `modelSelection`
  is one complete `{ "modelId": "...", "parameters": { "...": "..." } }`
  variant from that backend's effective catalog; omit it to use the configured
  atomic default. Job extras are `timeoutMs` (server-side execution cap) and
  `workingDirectory` (defaults to the session worktree; must resolve **inside**
  it). The agent is instructed to write detailed output to files under
  `memory-bank/agent-runs/` and return a short `summary` plus a
  `referenceDocuments` list — so **read the referenced files**, don't rely on
  the summary alone.
  - Without `--wait`: returns immediately with a `runId` and hints how to poll
    and cancel. The run continues server-side.
  - With `--wait`: long-polls until the run finishes and prints the result
    shape (`summary` + `referenceDocuments`). On completion with N>0 registered
    documents it hints you to read them. `--timeout <dur>`
    (`25m`, `90s`, `500ms`, or bare seconds like `1800`) bounds how long the CLI
    waits — **not** the run: if the budget elapses (or your shell call is interrupted)
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
