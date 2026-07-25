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
**Help text, per-command flag allowlists (`checkFlags`), the parse-time boolean-flag set, the
top-level usage, group dispatch, and the SKILL.md command reference are all derived from it.**
Hand-syncing any of these is a defect: the 2026-07-06 audit found real drift (`conversation read`
flags missing from help) and derivation is what makes that class impossible.

Group dispatch goes through `dispatchGroup` (`src/cli/dispatch.ts`): it derives a group's valid
verbs from that group's registry children, routes to the matching handler, and renders the
"requires a subcommand: …" / "unknown … subcommand" usage failures from that same list — so no
group module hand-lists its verbs. `dispatchGroup` throws when its handler map disagrees with the
registry (a verb wired into dispatch without an entry, or an entry with no handler), and the
contract test drives every group node through it, so drift fails the suite instead of shipping.

**When adding or changing a command/subcommand/flag, you MUST:**

1. Add/update the `CommandHelpEntry` (summary, description, usage, flags, ≥1 example for leaves).
2. Wire flags through the registry — never a literal allowlist at the `checkFlags` call site.
3. Add `related` edges both ways (the new node points at siblings; siblings point back when apt).
4. Add `skills` refs where a skill materially helps (repo-relative path — contract-tested).
5. Run the registry contract test (`help-registry.contract.test.ts`) — it enforces
   dispatch↔registry agreement (via `dispatchGroup`, see below), graph-edge resolution,
   skill-path existence, and boolean/value flag-name consistency.
6. Regenerate the `cc-cli` SKILL.md command reference: `bun scripts/cc-cli-skill-reference.ts`
   (the block between the `GENERATED COMMAND REFERENCE` markers is derived from the registry;
   `bun run cli:skill-ref` and `cc-cli-skill-reference.test.ts` fail if it drifts). The
   rich per-group prose stays hand-authored.

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

## Conversation scope: identity is scope-discriminated, never sentinel-shaped

An agent's environment declares its scope: `CC_CONVERSATION_SCOPE` is `session` or
`project`, and a project conversation's `CC_SESSION` is an explicitly neutralized
`""` (present, not omitted — the env contract merges over `process.env`).

Two rules follow, and both are enforced by tests:

- **Every env session read is a falsy check** — `readSessionEnv(env)` from
  `src/cli/shared.ts`, never `env["CC_SESSION"] ?? fallback`. `??` passes the
  neutralized `""` straight through and builds `/sessions//conversations/…`, which
  is silent misrouting rather than a visible failure.
- **Every command that reads the session env is classified** in
  `src/cli/session-env-inventory.ts` as `project-supported` or `session-only`, with
  a reason. Project-supported commands select a project route at project scope
  (build paths with `conversationTargetApiBase`, or the session-agnostic
  `resolveProjectConversationContext` when the endpoint is project-scoped and only
  needs to know which conversation is speaking). Session-only commands fail with
  the ordinary `no session — pass --session or set CC_SESSION` usage error — that
  loud failure is the point of the neutralization. `session-env-inventory.arch.test.ts`
  fails on an unclassified new reader and on a stale entry.

Classifying a command session-only is a statement about the SERVER surface: the
capability needs a session branch, worktree, or graph execution, so there is no
project-scoped route to select. Adding a session-env reader without an inventory
entry fails the build; migrating a command onto a project route means adding the
route in the same change, or project agents lose a command that worked.

**Classify at the granularity the command actually splits at.** Entries resolve
longest-prefix-first, so a group and its leaves can differ, and a group whose
verbs disagree MUST list the exceptions. `workflow` is the worked example:
definition authoring (`create`, `replace`, `list`, `get`, `edit`, `delete`,
`templates`) resolves project context only and is project-supported, while
execution and lane operations (`validate`, `status`, `start`, `live *`, `task *`,
`shared-doc *`, `collab *`) pin to a session. Group defaults are session-only so
a NEW subcommand fails loudly rather than being silently advertised.

The arch test classifies by SOURCE FILE, so it sees groups, not leaves — a
group-level entry satisfies it even when the verbs disagree. The behaviour test
in `src/cli/conversation-scope.test.ts` is what closes that gap, and it asserts
BOTH directions: every session-only command refuses at project scope with the
`CC_SESSION` usage error, and every project-supported command routes without
demanding a session. Exercise each classified verb, not one representative per
group — a single sample is how a project-supported verb hides inside a
session-only group.

**A CLI test cannot prove the route exists.** `CliHost.fetch` is a test double
that answers any path with 200, so a project-supported command that points at a
route nobody wrote still passes every test above — that is exactly how `cctl ask`
shipped a project path with no server route behind it.
`src/cli/project-route-wiring.arch.test.ts` is the backstop: it enumerates
`src/app/api/**/route.ts`, drives each project-supported command through the real
dispatch, and asserts the constructed path matches a real route file *and* that
the route exports the HTTP method the command uses (an existing route missing the
method 405s in production). Dynamic segments deliberately do not match an empty
segment, so a non-neutralized `CC_SESSION` producing `/sessions//…` is a miss
rather than a match. Add a project-supported command here in the same change that
adds its route.
