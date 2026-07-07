# CLI (`cctl`) Design Principles

`cctl` is the primary interface agents use to act on Command Center. Its design target is a
**calling agent**, not a human: machine-checkable exit codes, terse actionable text, and output
that steers the next step. Full design history: `docs/design/cc-cli/` (esp. `01-cli-foundation.md`
§6 and `04-progressive-disclosure.md`).

## The CLI is a progressive-disclosure graph

Every subcommand is a node in a disclosure graph, and its `--help` is a mini-skill: description,
usage, flags, examples, optional domain context, **edges to related commands** (one-liners), and
**edges out to skills** ("load X when Y"). Agents navigate pull-based, node by node, instead of
front-loading one large document. Hints, error messages, and help share one vocabulary — a hint
that names a command should match that command's help node.

- Keep high-traffic nodes (top usage, group indexes) terse; richness lives at the leaves the agent
  deliberately navigates to.
- Examples earn their place: teach failure-prone shapes (e.g. range syntax, file payload shapes),
  don't restate the usage line.
- `domainContext` is optional and ≤ 4 lines — only when a CC domain-model fact genuinely helps.

## Single source of truth: the help registry

All command metadata lives in typed `CommandHelpEntry` objects (`src/cli/help-types.ts`), authored
in colocated `src/cli/commands/<command>.help.ts` files and aggregated by `src/cli/help-registry.ts`.
**Help text, per-command flag allowlists (`checkFlags`), the parse-time boolean-flag set, and the
top-level usage are all derived from it.** Hand-syncing any of these is a defect: the 2026-07-06
audit found real drift (`conversation read` flags missing from help) and derivation is what makes
that class impossible.

**When adding or changing a command/subcommand/flag, you MUST:**

1. Add/update the `CommandHelpEntry` (summary, description, usage, flags, ≥1 example for leaves).
2. Wire flags through the registry — never a literal allowlist at the `checkFlags` call site.
3. Add `related` edges both ways (the new node points at siblings; siblings point back when apt).
4. Add `skills` refs where a skill materially helps (repo-relative path — contract-tested).
5. Run the registry contract test (`help-registry.contract.test.ts`) — it enforces entry coverage,
   graph-edge resolution, skill-path existence, and boolean/value flag-name consistency.
6. Update the `cc-cli` SKILL.md command reference (manual sync until generation exists).

## Help never fails, and is static-first

Help is the recovery path — it must work offline, unauthenticated, instantly, exit 0. Durable
content is compiled into the binary (it must match the binary's own parser). **Dynamic context is
server-rendered garnish**: fetched best-effort (500 ms timeout) from `/api/agent/help-context`,
appended as `context:` blocks, and **silently omitted on any failure**. Never let a server
dependency change help's exit code or write to stderr. New context providers go in
`src/lib/agent-help/providers.ts`, return `[]` when they have nothing worth saying, and stay
read-only.

## The three-tier output contract

| Tier | Field | Semantics | Agent obligation |
|---|---|---|---|
| Hint | `hint?: string` | Advisory next step | Ignorable by contract |
| Reminders | `reminders?: string[]` | Invariants binding while work continues | Keep true |
| Instruction | `instruction?: string` (legacy `stopInstruction` retained) | Do this now | Obey first |

Tier misuse is a review-blocking defect: **nothing load-bearing in `hint`, nothing actionable-now
in `reminders`.** Text rendering order: primary output → detail/issues → `reminder:` lines →
`hint:` line. The `--json` envelope carries `error`/`issues`/`code`/`reminders`/`hint` — structured
detail must never be text-mode-only.

## Reminders: server-authored, state-conditional, earned

Reminders exist to reinforce critical invariants at the decision point (recency beats system-prompt
distance). Their power comes from scarcity. A reminder ships only when ALL hold:

1. **Earned by an observed failure** — cites a real incident/failure class (workflow-audit finding,
   memory, bug), never a speculated risk. Same discipline as `PERFORMANCE.md`.
2. **State-conditional** — fired by a runtime-state predicate, not unconditionally per command.
   Always-on text belongs in a skill or system prompt, not here.
3. **Tier-true** — violable *after* the command succeeds (else it's an instruction or a hint).
4. **Capped** — ≤ 2 per response, priority-ordered.

The server computes reminders (e.g. `src/lib/workflow-graph/lane-reminders.ts` — pure,
directly-tested rule engine with a required `evidence` field per rule); **the CLI is a dumb
renderer and never authors reminders.** Expanding the rule set or reaching beyond lane verbs
requires post-hoc evidence from `graph-workflow-audit` that existing reminders reduce violations.

## Error contract (unchanged floor — keep it)

Exit codes: `0` OK · `1` operation failed (server said no) · `2` usage/validation · `3`
connection/auth · `4` version mismatch (reserved). One actionable line first on stderr, naming the
missing/offending flag/file/identity; validation issues one per line (`  <path>: <message>`);
exit-3 failures point at `cctl doctor`. Deterministic local checks (flags, `--file` parse,
identity) fail at exit 2 **before** any network round-trip. Server routes return
`{ error, code?, issues? }` — never flatten computed issues into a prose string.
