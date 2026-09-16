# CLI (`cctl`) Design Principles

`cctl` is the primary interface agents use to act on Command Center. Full design history lives in
`docs/design/cc-cli/` (especially `01-cli-foundation.md` §6, `04-progressive-disclosure.md`, and
`09-policy-ownership-hardening.md`, which records why each policy below has exactly one owner and
which audit finding earned it).

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
  that feeds code. For every query, it preserves the selected disclosure level and changes
  serialization, never volume or field selection. `src/cli/json-volume-exceptions.ts` is the
  declare-or-fail list of exceptions and holds exactly two: `validate run` (a pass's text relays a
  20-line output tail while the envelope carries the captured output in full) and `validate status`
  (the single-run text is a one-line status while the envelope carries the terminal result with its
  full output — the read the pass tail points at). An exception is a reviewed edit to that list,
  carrying the change that deletes it, and an entry naming a command the registry no longer has
  fails its contract test.
- `workflow status` and `spec status` are the worked examples of retiring a dump. Status defaults
  to the projection its own table renders; `workflow status --halt` returns the whole structured
  halt reason and its repair log, `workflow status --full` the unstripped execution record, and
  `spec status --full` every row of the sections the default bounds to ten. Each selector past the
  budget writes the artifact its manifest names rather than truncating a pipe.
- Every new or changed query defaults to a bounded digest or outline unless its leaf help names an
  established explicit detail selector. Its stable handles appear verbatim in outline rows and are
  accepted by their drill-down commands.
- Any omission in a new or changed query is explicit in text and JSON: state `total`, `returned`,
  and `truncated`, then name the exact follow-up command that reveals the omitted data. A cap
  without disclosure is a defect.
- **Bounded output goes through one primitive.** `src/cli/disclosure.ts` owns it.
  `boundedItems(items, cap, reveal)` caps any item set — structured payload rows included — and
  `boundedRows` is its rendered-string form. Both return the `Omission` fragment that spreads into
  the JSON envelope and renders as the same `N total, M shown — rest: <command>` line in text, so
  the two serializations cannot report different counts or point at different reads;
  `reveal` lives only on the truncated arm, so a silent cap does not typecheck. `emitLarge` decides
  inline-versus-artifact against a stdout budget (60_000 bytes by default) and returns the manifest
  — path, format, byte count, SHA-256 content digest, and reason — that stdout carries in place of
  the content. Do not hand-roll a cap, a spill, or a `total`/`shown` line; a row may be a
  multi-line block, and the cap counts rows rather than lines.
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
top-level usage, group dispatch, and the cc-cli generated command reference are all derived from it.**
Hand-syncing any of these is a defect: the 2026-07-06 audit found real drift (`conversation read`
flags missing from help) and derivation is what makes that class impossible.

Group dispatch goes through `dispatchGroup` (`src/cli/dispatch.ts`): it derives a group's valid
verbs from that group's registry children, routes to the matching handler, and renders the
"requires a subcommand: …" / "unknown … subcommand" usage failures from that same list — so no
group module hand-lists its verbs. `dispatchGroup` throws when its handler map disagrees with the
registry (a verb wired into dispatch without an entry, or an entry with no handler), and the
contract test drives every group node through it, so drift fails the suite instead of shipping.

**The root is a group too.** `dispatchCli` dispatches `group: []`, whose children are the
registry's level-1 entries — leaves (`ask`, `notify`, `doctor`, `version`) sit in the same handler
map as the groups, so a level-1 command can no longer exist in help while being unreachable from
dispatch, or vice versa. The root keeps its own two failure texts (a bare `cctl` prints the usage
index; an unrecognized first token is `unknown command`), and the contract test drives every
level-1 entry through `runCli`. `help` is intercepted before dispatch and has no registry entry.

**Load-bearing prose declares `fileSource: true`.** A `kind: "value"` flag whose content the shell
can corrupt — a task summary, a brief, a note body — sets that one bit on its `CommandHelpEntry`,
and the paired `--<name>-file <path>` (`-` reads stdin) is derived from it everywhere at once:
parser acceptance, the `checkFlags` allowlist, and the rendered flag list. The command reads the
value through `resolveProseArg` (`src/cli/shared.ts`), which refuses both sources at once, an
unreadable or empty file, and anything past 256 KiB with exit `2` before any request. Never
hand-add a second flag for the same content — that pair is what drifts.

**When adding or changing a command/subcommand/flag, you MUST:**

1. Add/update the `CommandHelpEntry` (summary, description, usage, flags, ≥1 example for leaves).
2. Declare the flags on the entry — that is the whole wiring. `checkFlags(values, "<space-joined
   entry path>", json)` takes the registry key and derives the allowlist itself; there is no
   name-list parameter, so a hand-written allowlist is unrepresentable and a key naming no entry
   throws at the call rather than silently allowing nothing.
3. Add `related` edges both ways (the new node points at siblings; siblings point back when apt).
4. Add `skills` refs where a skill materially helps (repo-relative path — contract-tested).
5. Run the registry contract test (`help-registry.contract.test.ts`) — it enforces
   dispatch↔registry agreement (via `dispatchGroup`, see below), graph-edge resolution,
   skill-path existence, and boolean/value flag-name consistency.
6. Regenerate the `cc-cli` skill's generated blocks: `bun scripts/cc-cli-skill-reference.ts`
   (the `GENERATED COMMAND REFERENCE` block in `skills/cc-cli/references/command-reference.md`
   derives from the registry; the `GENERATED EXIT CODES` block in `skills/cc-cli/SKILL.md`
   derives from `EXIT_TAXONOMY`; both paths are inside `plugins/command-center/command-center/`).
   `bun run cli:skill-ref` and `cc-cli-skill-reference.test.ts` fail if either drifts. Per-group prose lives in the skill's references, and the same test lints
   SKILL.md and every Markdown reference: a
   `cctl …` line inside a fenced block outside the generated markers must name a real command and,
   when it carries placeholders, be one of that command's registry usage shapes VERBATIM. Prefer
   deleting a restated shape and pointing at the generated reference — a hand-copied verb list
   cannot be checked for the verb it omits.

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
facts in JSON as `error`/`issues`/`code`/`instruction`/`reminders`/`hint`. A refusal that states a
`rationale` renders it as a `why:` line between its unmet conditions and its `instruction`, so the
reason lands before the do-now text rather than after it. The legacy
`stopInstruction` spelling remains only where the workflow protocol still emits it, and
`stop-instruction.arch.test.ts` pins it to those files so a new command cannot spread it. One seam in
`src/cli/shared.ts` arbitrates the tiers for success and failure alike: an `instruction` suppresses
the `hint` in both modes, and the `hint` is flattened to the single line it promises.

The server authors reminders through directly tested state rules such as
`src/lib/workflow-graph/lane-reminders.ts`. The single exception is the enumerated
`CLIENT_ADVISORIES` constant in `src/cli/shared.ts`: invariants about the caller's own filesystem,
which no server can observe. Adding a client reminder means editing that list — with the recorded
failure that earned it — in review; everything else is server-authored and only rendered by the CLI.

The guidance prefixes are the six enumerated in `src/cli/guidance-prefixes.ts` — `instruction:`,
`reminder:`, `hint:`, `next:` (the machine-composed drill-down pointer), `context:` (help
garnish), and `why:` (a refusal's server-authored reason, rendered only by `failure`). A seventh
spelling does not add a meaning, it makes the other six ambiguous, so
`guidance-prefix.arch.test.ts` fails on a line that opens with a competing one. A `label: value`
line inside a command's own body is data, not guidance. `hint-tokens.arch.test.ts` resolves the
`cctl …` paths named in CLI text against the registry, so renaming a verb breaks the guidance that
still points at the old one.

CC implements the shared exit taxonomy as `0` success, `1` operation failure, `2` local usage or
validation failure, `3` connection/auth failure, and `4` build skew — the binary and the server are
different builds. The "nothing changed" promise is scoped to the paths that earn it: a gated server
refuses a mutation before its handler runs and a read's response is discarded unread, but a server
that predates the gate runs a skewed mutation and only stamps the header, so that exit-4 text warns
the mutation may have committed and to verify before retrying. That table is data (`EXIT_TAXONOMY` in `src/cli/exit-taxonomy.ts`, with each
code's meaning and recovery pointer): the `cctl exit-codes` command, its help node's rendered body,
and the cc-cli SKILL.md exit-code table all derive from it rather than restating it, so a
correction lands in one place instead of three. `exit-taxonomy.ts` sits below `shared.ts` in the
import graph precisely so a `*.help.ts` entry can derive from it. Exit 3 is constructed only by
`connectionFailure`, which appends the `cctl doctor` pointer; `workflow wait`'s disconnect is the
one approved survivor, because its cursor-carrying `continue:` receipt recovers the still-running
execution and a healthy-server diagnosis would not. Routes retain computed error detail as
`{ error, code?, issues? }`; local flag, identity, and payload checks fail before a network request.

## Blocking on a server-side job goes through one waiter

`src/cli/job-wait.ts` (`awaitJob`) owns the policy every blocking wait shares: a client budget, a
poll cadence, a consecutive-parse-failure tolerance, an optional cancellation hook, and forensic
pointers appended to whatever failure the waiter authors. A command supplies only what it alone
knows — how to fetch one status, what counts as terminal, and what to say when the budget runs out.
Do not hand-roll a poll loop; four of them drifted into four contracts, one of which turned an
unreadable status body into an endless poll. Two documented survivors sit outside `awaitJob`:
`conversation compact --wait` hand-rolls its `awaitArtifact` poll (migration pending), and `fixture
prompt --wait` blocks on the turn's SSE stream rather than a poll, delivering its forensic pointers
through `withForensics`. **Every `onTimeout` names the continuation command that
recovers the still-running job** (`workflow wait`'s cursor-carrying receipt is the reference
implementation); the budget bounds the client wait only, never the server-side run.

`validate run` always blocks to a verdict. Its `--queue-if-busy` flag changes only admission:
without it a busy scheduler refuses immediately; with it the submission joins the strict FIFO
queue. `agent run --wait` and `workflow run --wait` retain `--wait` because those flags decide
whether the client blocks at all. Ticket `remote-ai-manager#12` recorded duplicate validation
commands caused by the former naming collision, providing the observed failure that earned this
breaking rename.

**Build parity has exactly one exemption, and it is a property of the TARGET, not of the
verb.** Every command addresses the single CC instance that owns the caller's session, so the gate's
question — "is this binary the surface that server published?" — is answerable. `fixture` addresses a
SECOND instance (a worktree dev server running the branch, while the binary comes from the installed
build), so the two differ by construction and no binary satisfies both hops: the gate forbade the
command instead of protecting anything, and `cctl fixture` had no working invocation from a branch
worktree at all. Requests that cross into another instance therefore set
`CliRequestParams.unstamped` and are read as ordinary API clients — the same thing the browser and
this command's own pre-warm fetches already are. It is bounded to callers using only the plain
project/session/conversation REST surface, and what replaces the gate is that every response is
schema-parsed and a parse failure is REPORTED rather than degraded into a plausible empty result
(reading a drifted dev-servers envelope as "none running" is the failure this clause exists to
prevent). A server's own build identity is pinned for the life of its process
(`pinBuildIdentity`), so the binary it publishes at boot cannot be orphaned by a regenerated stamp;
`cctl dev doctor` is where an agent sees both instances and their state directories at once.

`validate run` discloses what its verdict actually covers: a pass prints one verdict line with the
resolved scope and, when the server resolved a file list, the matched-file count. A zero-match pass
says so and still exits `0`, because merge gates depend on green semantics; `--require-match` is the
opt-in ratchet that turns it into exit `1`.

## `cctl logs` is an adapter, not an analyzer

Log analysis belongs to `src/lib/logging/log-analysis`: which records parse, what counts as slow,
how a trace is reconstructed, where the default log lives, and what the report says are all its
decisions, and `bun run logs:analyze` runs the same engine. `src/cli/commands/logs.ts` owns only
what the CLI contract owns — registry-declared flags forwarded to the engine's option names through
one mapping table, the exit taxonomy, and egress through `render`/`failure` and the disclosure
primitive. It must not reason about a log record, re-rank a finding, or learn a storage detail; a
new analysis capability is a new engine verb the adapter exposes, never analysis written in the CLI.

Two mappings are the CLI's own and deliberate. The engine's exit `3` ("nothing to analyze" — an
empty filter result, an absent trace) becomes CC exit `1`, because CC reserves `3` for
connection/auth failures whose recovery is `cctl doctor`. And because the command contacts no
server, every global identity flag is refused with the record filter that was meant instead
(`--session` → `--session-name`), rather than accepted as a silent no-op that would report on
records the caller believes were excluded.

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

**A read may widen its own scope; a mutation never does.** `cctl` otherwise demands explicit
`--project`/`--session` to touch another session, and the `conversation` group is the one
carve-out: handed a bare conversation id its own scope answers 404 for, it resolves the owning
project and session from the id alone (`GET /api/conversations/<id>`) and retries there. That is
intended policy — a `<conversation-ref>` an agent is handed carries no scope, so requiring flags
would make the reference unusable by the agent that received it. It is bounded three ways: only on
a wrong-scope 404, only when the caller passed no explicit `--project`/`--session` (an explicit
flag is an override to respect), and only for reads. `ticket attach conversation` uses the same
lookup to READ its source conversation while the mutation still targets only the named ticket. A
new command adopts the widening only inside those three bounds.

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
