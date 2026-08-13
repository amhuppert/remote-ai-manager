# CLI (`cctl`) Design Principles

`cctl` is the primary interface agents use to act on Command Center. Full design history lives in
`docs/design/cc-cli/` (especially `01-cli-foundation.md` §6 and
`04-progressive-disclosure.md`).

## Principle ownership

Load the relevant agentic-engineering-principles skill before changing this surface:

- `agentic-engineering-principles:cli-tools-for-agents` owns the generic agent-CLI contract,
  including text-first output, exit classes, structured errors, file payloads, and long jobs.
- `agentic-engineering-principles:query-output-disclosure` owns progressive disclosure of data:
  bounded defaults, handles, omission metadata, drill-down, and file spillover.
- `agentic-engineering-principles:progressive-disclosure-tooling` owns help as a disclosure graph
  and derivation from one typed registry.
- `agentic-engineering-principles:agent-feedback-tiers` owns the hint/reminder/instruction
  vocabulary and reminder admission rule.

This document records only Command Center's concrete implementation and stricter local
invariants. Do not copy the generic principle prose back into it.

## Command Center output and query disclosure

- Render terse, line-oriented text by default for an agent to read. `--json` is opt-in for output
  that feeds code. For every new or changed query, it preserves the selected disclosure level and
  changes serialization, never volume or field selection. Legacy `workflow status --json` is the
  explicit exception: it still returns the full active-execution payload. Native SDD `spec status
  --json` is the other legacy exception: its text sections are bounded while its structured status
  projection carries every row. Both are migration debt, not patterns to copy.
- Every new or changed query defaults to a bounded digest or outline unless its leaf help names an
  established explicit detail selector. Its stable handles appear verbatim in outline rows and are
  accepted by their drill-down commands.
- Any omission in a new or changed query is explicit in text and JSON: state `total`, `returned`,
  and `truncated`, then name the exact follow-up command that reveals the omitted data. A cap
  without disclosure is a defect.
- Native SDD `spec show` uses a four-level ladder: `--summary` for counts, a bounded nested outline
  by default, one-element detail through `spec get`, and file-backed artifacts for `--rendered`
  and `--full`. Artifact stdout is a small manifest with the path, format, byte count, SHA-256
  content hash, and, when applicable, a bounded revision; it never embeds the full document.
- JSON envelopes use named payload fields rather than a generic blob. Response fields and revision
  semantics must remain inspectable offline through the owning `spec schema` leaf.

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

## Command Center feedback and error wiring

CC renders primary output → detail/issues → `reminder:` lines → `hint:` line and carries the same
facts in JSON as `error`/`issues`/`code`/`instruction`/`reminders`/`hint`. The legacy
`stopInstruction` spelling remains only where the workflow protocol still emits it. The server
authors reminders through directly tested state rules such as
`src/lib/workflow-graph/lane-reminders.ts`; the CLI only renders them.

CC implements the shared exit taxonomy as `0` success, `1` operation failure, `2` local usage or
validation failure, `3` connection/auth failure, and reserved `4` version mismatch. Exit-3 output
points at `cctl doctor`. Routes retain computed error detail as `{ error, code?, issues? }`; local
flag, identity, and payload checks fail before a network request.

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

**A command implementation belongs in `src/cli/commands/<name>.ts`.** The scan
attributes a session-env read to a command by source file, so a command
implemented anywhere else is attributed to that file's INFRASTRUCTURE entry and
becomes invisible to the ratchet — it can be missing from the inventory while the
test stays green. `doctor` is the worked example: it read the session env and
published the identity to `/api/agent/handshake` from inside `core.ts`, so it
carried no classification until it moved to `commands/doctor.ts`. Keep `core.ts`
to dispatch, help resolution, and the shared identity plumbing.

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
