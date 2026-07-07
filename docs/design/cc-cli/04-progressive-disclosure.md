# 04 — Progressive Disclosure & Output Tiers

**Status:** Implemented · 2026-07-06
**Scope:** Rebuild `cctl` help as a graph-shaped, context-aware progressive-disclosure surface backed
by a single structured registry; formalize the three-tier output contract (`hint` / `reminders` /
`instruction`); ship server-authored, state-conditional reminders for graph-workflow lanes; fix the
JSON-envelope structured-detail gaps found in the 2026-07-06 error-quality audit.
**Steering:** durable principles land in `.kiro/steering/cli.md` (same change as this doc).

---

## 1. Direction and concepts

### 1.1 The CLI as a disclosure graph

`cctl` is the primary interface agents use to act on Command Center. Today its guidance surfaces
are: a hand-written `USAGE` constant (`src/cli/shared.ts:54`), a hand-written per-command
`COMMAND_HELP` record (`src/cli/help.ts`), success/failure `hint` lines, and the `cc-cli` skill.
The audit (see `round-1/agent_one/final_answer/answer.md` in the collaboration artifacts, 2026-07-06)
found this works well for errors but has a structural weakness: help, flag allowlists, and the skill
doc are three hand-synced copies of the same facts, and they have already drifted
(`conversation read` accepts `--search`/`--max-bytes`/`--format` per `conversation.ts:391-393`;
`help.ts` omits all three).

The target model: **every subcommand is a node in a disclosure graph.** A node's help is a
mini-skill — description, usage, flags, examples, optional domain context, edges to related
commands, and edges out to skills ("load X when Y"). Agents navigate the graph pull-based
(`--help` per node) instead of front-loading one large document. Success/error hints already form
chain edges (`validate` → `create` → `start`, errors → `doctor`); this design adds lateral edges
(related commands) and outbound edges (skills), using one vocabulary across hints and help.

### 1.2 The three-tier output contract

Command output (not just help) carries three tiers with distinct semantics:

| Tier | Field | Semantics | Agent obligation |
|---|---|---|---|
| Hint | `hint?: string` | Advisory next step. | Ignorable by contract (doc 01 §6). |
| Reminders | `reminders?: string[]` | Invariants that remain binding while the agent continues. | Must keep true; not an action. |
| Instruction | `instruction?: string` (existing `stopInstruction` name retained where shipped) | Do this specific thing now. | Must obey before anything else. |

The instruction tier already exists informally (`ask`'s end-turn `instruction`, `task complete`'s
`stopInstruction`, `collab request`'s stop text as primary output). This design names it and adds
the middle tier. Tier misuse is a review-blocking defect: nothing load-bearing in `hint`, nothing
actionable-now in `reminders`.

### 1.3 Non-goals

- Server-overridable help *prose* (binary-embedded registry is authoritative; revisit only if prose
  churn demonstrably hurts — see §9 D6).
- Fuzzy matching / "did you mean" on unknown commands.
- Generating the `cc-cli` SKILL.md from the registry (deferred; manual sync + checklist for now).
- Reminders outside graph-workflow lane verbs (admission rule §6.2 gates expansion).
- Localization, paging, color.
- `cctl state …` debug commands (unchanged prior non-goal).

---

## 2. The help registry — single source of truth

### 2.1 Types

New file `src/cli/help-types.ts` (pure types + tiny helpers, **no imports from `shared.ts`** — this
keeps the import graph acyclic: `shared.ts` → `help-registry.ts` → `*.help.ts` → `help-types.ts`):

```ts
export interface FlagSpec {
  name: string;                      // without leading "--"
  kind: "value" | "boolean";
  valuePlaceholder?: string;         // e.g. "<path>", value kind only
  description: string;               // one line
  repeatable?: boolean;              // e.g. ask --option
}

export interface HelpExample {
  invocation: string;                // full command line incl. cctl
  explanation: string;               // one line: what it does / when to use it
}

export interface RelatedRef {
  command: string;                   // space-joined path, e.g. "workflow start"
  oneLiner: string;
}

export interface SkillRef {
  name: string;                      // skill invocation name, e.g. "graph-workflow-planning"
  loadWhen: string;                  // one line, e.g. "before authoring plan.json"
  path: string;                      // repo-relative SKILL.md path — contract-tested to exist
}

export interface CommandHelpEntry {
  path: string[];                    // ["workflow","create"]; length ≥ 1; length 1 may be a group node
  summary: string;                   // one line — feeds parent index + top-level usage
  description: string;               // 1–4 lines
  usage: string[];                   // invocation shapes
  flags: FlagSpec[];                 // command-specific flags only (global flags are implied)
  examples: HelpExample[];           // ≥ 1 for leaf nodes; may be empty for group nodes
  domainContext?: string;            // ≤ 4 lines of CC domain-model context, only when it earns its place
  related: RelatedRef[];             // lateral graph edges
  skills?: SkillRef[];               // outbound graph edges
  dynamicContext?: boolean;          // whether --help queries /api/agent/help-context (§4)
}
```

### 2.2 Location and aggregation

- Each command module gets a colocated sibling: `src/cli/commands/<command>.help.ts` exporting
  `entries: CommandHelpEntry[]` (all nodes for that command, group node + leaves). Rationale:
  colocation per `structure.md`; `workflow.ts` is already 1066 lines — inline prose would bloat
  logic files, a separate directory would break colocation.
- `src/cli/help-registry.ts` imports every `*.help.ts`, builds a `Map<string, CommandHelpEntry>`
  keyed by `path.join(" ")`, and **throws at module init** on duplicate paths or a leaf whose
  parent group node is missing — so a malformed registry fails every test run, not at runtime
  in an agent session.
- `doctor` and `version` entries live in a small `src/cli/commands/meta.help.ts` (they have no
  command module of their own).

### 2.3 Everything derives from the registry

| Derived surface | Today | After |
|---|---|---|
| Per-command flag allowlists | Hand-written arrays at each `checkFlags` call site | `checkFlags(values, flagNamesFor("workflow create"), json)` — `flagNamesFor(pathKey)` reads the registry |
| Boolean-flag parse set | Hand-written `BOOLEAN_ONLY_FLAGS` (`shared.ts:108-116`) | `booleanFlagNames()` — union of `kind: "boolean"` flags across the registry, computed once at module init |
| Top-level `USAGE` | Hand-written constant (`shared.ts:54`) | Generated from level-1 entries' `summary` lines + the (still hand-written) global-flags block |
| Per-command help text | Hand-written `COMMAND_HELP` (`src/cli/help.ts`) | Rendered from the entry (§3); `help.ts` is **deleted** |
| JSON help envelope | `{ok, usage: "<text blob>"}` | `{ok, help: {…structured entry…}}` (§3.3) |

Because the allowlist **is** the registry, the audit's drift class (command accepts a flag help
doesn't show) becomes structurally impossible. The parser constraint carries over: a flag name
must not be declared `boolean` in one command and `value` in another (parse-time booleans are
global, `parseArgv` `shared.ts:126`); the registry contract test enforces this (§7.1).

### 2.4 Migration inventory

All current nodes get entries (leaf count 34 + group nodes ~8), ported from `help.ts`, the
`cc-cli` SKILL.md, and each command's actual `checkFlags`/`values` reads:

`ask` · `notify` · `docs {register,list,delete}` · `dev {list,ensure,stop}` ·
`fixture {session create, session delete, prompt, status}` ·
`workflow {validate,create,replace,list,get,status,start,delete,templates}` ·
`workflow task {complete,add}` · `workflow shared-doc upsert` · `workflow collab request` ·
`charter write` · `decisions propose` · `codex {run,status,cancel}` ·
`conversation {read,compact}` · `conversation compaction {get,list}` · `doctor` · `version`.

Porting fixes the known gaps in the same stroke (`conversation read` flags; any others surfaced by
the contract tests). Example content discipline: prefer examples that teach failure-prone shapes —
the conversation-tool A/B review found `--message-range A:B` syntax the #1 friction — over examples
that restate the usage line.

---

## 3. Help resolution and rendering

### 3.1 Resolution

- Help interception stays where it is (`core.ts:206-219`, before dispatch, so `--help` never trips
  `checkFlags`), extended to pass the **full positional path**: `cctl workflow create --help`,
  `cctl help workflow create`, `cctl conversation compaction get -h` all resolve the node
  `["workflow","create"]` / `["conversation","compaction","get"]` by **longest-prefix match**.
- A matched group node renders an index: its `summary`, `description`, one line per child
  (`summary`), plus its own `related`/`skills`. This is the graph's "hub" behavior.
- An unknown path under a matched parent → exit 2 `usageFailure` whose hint lists the parent's
  child commands. An entirely unknown root stays the current `unknown command "x"` failure.
- Bare `cctl` remains an exit-2 missing-command failure printing the (now generated) usage to
  stderr — unchanged semantics, per the audit's D3 correction.

### 3.2 Text rendering (leaf node)

Section order — most load-bearing first, graph edges last:

```
cctl workflow create — create a graph workflow from a plan file

<description>

usage:
  cctl workflow create --file plan.json [--json]

flags:
  --file <path>    plan JSON produced per the graph-workflow-planning skill

examples:
  $ cctl workflow validate --file plan.json
      always validate first — exit 2 lists issues one per line
  $ cctl workflow create --file plan.json
      returns the workflow id; start it with 'cctl workflow start <id>'

context:
  <domainContext, when present>
  <dynamic blocks, when fetched — §4>

related:
  workflow validate — pre-flight a plan without creating anything
  workflow start    — start a created workflow
  workflow replace  — overwrite an existing definition from a plan file

skills:
  graph-workflow-planning — load before authoring or revising plan.json
    (.claude/skills or plugin path, as registered)

global flags: run 'cctl --help'
```

Global flags are **not** repeated per node (one pointer line instead) — keeps leaf nodes terse and
the token cost of graph-walking low.

### 3.3 JSON rendering

`cctl <path> --help --json` returns the structured node:

```json
{ "ok": true, "help": {
    "command": "workflow create",
    "summary": "…", "description": "…",
    "usage": ["…"], "flags": [{…}], "examples": [{…}],
    "domainContext": "…",
    "related": [{"command": "workflow start", "oneLiner": "…"}],
    "skills": [{"name": "…", "loadWhen": "…", "path": "…"}],
    "context": { "blocks": [{"title": "…", "body": "…"}] }
} }
```

This **replaces** the current `{ok, usage: "<text>"}` shape. Deliberately not backward compatible
(consumers are agents + the skill doc, both updated in the same phase; project rule: no
back-compat without explicit approval — approved by this design). No `rendered` text duplicate in
the JSON path: structured callers don't pay for prose twice.

---

## 4. Dynamic help context (context-aware disclosure)

### 4.1 Split of responsibility

**Everything durable is compiled into the binary** (description, usage, flags, examples, related,
skills). Two reasons: (a) help must work offline/unauthenticated — it is the recovery path; (b) help
describes the *parser's* flags and must come from the same build as the parser (the build-parity
problem `doctor` exists to detect). **Dynamic context is server-rendered** and appended
best-effort, so content can evolve with application state without redistributing the CLI.

### 4.2 Endpoint

New domain `src/lib/agent-help/` (per `structure.md`: `schemas.ts`, `providers.ts`, `service.ts`,
`route-handlers.ts`, colocated tests) + thin route re-export
`src/app/api/agent/help-context/route.ts`.

```
GET /api/agent/help-context?command=<space-joined path>
    &project=&session=&conversation=&executionId=&contextId=
```

Token-gated like every agent endpoint. Response (Zod in `schemas.ts`):

```ts
{ blocks: Array<{ title: string; body: string }> }   // ≤ 3 blocks, each ≤ ~10 lines
```

### 4.3 Providers (v1 — the four that clear the bar)

Registered as a prefix → provider map in `providers.ts`; each reads existing services/repos, never
mutates, and returns `[]` when it has nothing worth saying (absence of context must not render an
empty section):

| Prefix | Content | Source |
|---|---|---|
| `dev` | The calling session's configured dev servers: name, status, localUrl/remoteUrl | dev-server service runtime state |
| `workflow` | Lane identity, current task, remaining task count, iteration count vs circuit-breaker threshold — **only when `executionId`/`contextId` params are present**; also surfaces that lane-only verbs exist | workflow-graph execution state |
| `conversation` | Caller's conversation id; whether compaction artifacts exist for it (and staleness) | conversations + compaction repos |
| `fixture` | Whether a dev server is currently running (fixture is useless without one) | dev-server service |

Anything beyond these (deeper app-state customization) is **deferred** until a concrete need is
observed — unpredictable help is worse for agents than static help, and every provider adds a
dependency to a surface that must stay boring.

### 4.4 CLI behavior — help never fails

- The CLI calls the endpoint only when the resolved entry has `dynamicContext: true` **and** a
  server URL + token resolve from flags/env. Lane identity (`CC_WORKFLOW_EXECUTION_ID`/`_CONTEXT_ID`)
  is forwarded as query params when present in env.
- Timeout **500 ms**. `FetchInit` gains optional `timeoutMs`; `index.ts` implements it via
  `AbortSignal.timeout`; injected test hosts ignore it. (`CliHost` shape change is additive.)
- **Any failure — no server, no token, timeout, non-2xx, schema mismatch — silently omits the
  dynamic blocks.** Static help renders identically; exit code is unaffected; nothing is written to
  stderr. Help output must be deterministic-ish and must never train agents to fear `--help`.
- Server-side provider failures are logged (`createLogger("agent-help")`, event
  `agent-help.provider_failed`) — observability lives server-side, not in the agent's face.

---

## 5. Output contract v2 (envelope changes)

Bundled here because reminders, structured issues, and `code` touch the same two functions
(`render`, `failure` in `shared.ts`) — one coherent envelope change. These also close audit
findings #1 (JSON detail loss) and #5 (missing-identity hint inconsistency).

### 5.1 Envelope and rendering

```ts
export interface JsonEnvelope {
  ok: boolean;
  error?: string;
  hint?: string;
  reminders?: string[];            // NEW — tier 2 (§1.2)
  issues?: RequestIssue[];         // NEW — structured validation issues, when the server supplies them
  code?: string;                   // NEW — machine-readable error code, when supplied
  [key: string]: unknown;
}
```

- `render()` (`shared.ts:213`): after the human body, render each reminder as a `reminder: <text>`
  line, then the `hint:` line. JSON path passes the envelope through (it already does).
- `failure()` (`shared.ts:234`): `FailureInput` gains `issues?`, `code?`, `reminders?`. Text order:
  message → detail/issue lines → `reminder:` lines → `hint:`. JSON envelope now carries
  `issues`/`code`/`reminders` alongside `error`/`hint`.
- `failureFromRequest()` (`shared.ts:697`): 400/422 keeps the existing one-issue-per-line text
  `detail` **and** passes the structured `issues` + `code` into `failure()`. Other statuses pass
  `code` when present. Connection/auth branches unchanged. The classifier already extracts
  `issues`/`code` (`shared.ts:575-602`) — today they're dropped at this seam; that stops.
- Error responses that carry `reminders` (lane 409s, §6.4) flow through the same seam:
  `classifyErrorBody` additionally coerces a `reminders?: string[]` field.

### 5.2 Missing-identity failures join the usage-hint path

The context resolvers (`resolveProjectContext` etc., `shared.ts:317-464`) switch from bare
`failure({exitCode: EXIT_USAGE, …})` to `usageFailure(...)` so `no server URL — pass --server or
set CC_SERVER_URL` gains the standard `hint: run 'cctl --help' …` line, consistent with parse-time
usage errors. Message texts unchanged.

### 5.3 Route normalization: `workflow create`/`replace`

`definition-route-handlers.ts` stops flattening the already-computed issues into the legacy
`Invalid request: <path>: <message>; …` string (`invalidRequestBody`, `:59-62`) and returns
`{ error: "Workflow plan is invalid", issues }` — byte-compatible with the validate route
(`validate-route-handlers.ts:80`). The `error` field remains, so any UI consumer rendering the
string degrades to a shorter message; the implementation task includes a grep for consumers of
these two routes' error bodies and, if the workflow-builder UI displays them, rendering `issues`
there too. (Per project rule, the legacy shape is not kept behind a flag — normalization replaces it.)

### 5.4 Instruction tier naming

New commands emitting tier-3 content use the field name `instruction`. Shipped names stay:
`ask`'s `instruction`, lane `stopInstruction` (more specific, already documented in the skill;
a rename is churn with no behavioral value). The tier table (§1.2) is documented in doc 01 §6 and
`.kiro/steering/cli.md`.

---

## 6. Lane reminders (server-authored, state-conditional)

### 6.1 Where they attach

Graph-workflow lane verbs only, v1: `task complete`, `task add`, `shared-doc upsert`,
`collab request` — the protocol-heaviest, longest-running agent context in CC. The computation
site already exists: `lane-route-handlers.ts` builds the success body with `remainingTaskCount` +
`stopInstruction` (`:184-204`) and the halt 409 in `prepareContext` (`:142-155`).

### 6.2 The admission rule (durable principle — also in steering)

A reminder ships only when **all** hold:

1. **Earned by an observed failure** — it cites a real incident/failure class (workflow-audit
   finding, memory entry, bug), not a speculated risk. Same discipline as `PERFORMANCE.md`.
2. **State-conditional** — it fires from a runtime-state predicate, not unconditionally on a
   command. An always-on reminder is system-prompt content in the wrong place.
3. **A true tier-2** — violable *after* this command succeeds; not a do-now (instruction), not an
   optional next step (hint).
4. **Capped** — ≤ 2 reminders per response, priority-ordered.

### 6.3 Rule engine

New `src/lib/workflow-graph/lane-reminders.ts`:

```ts
export type LaneVerb = "task-complete" | "task-add" | "shared-doc-upsert" | "collab-request";

export interface LaneReminderInput {
  verb: LaneVerb;
  iterationCount: number;               // execution-state.ts contextState
  circuitBreakerThreshold: number;      // contextDef.circuitBreaker.consecutiveFailureThreshold (execution-loop.ts:1450)
  remainingTaskCount: number;
  halted: string | null;                // halt reason when the verb hit the 409 path
}

export interface LaneReminderRule {
  id: string;
  verbs: LaneVerb[];
  evidence: string;                     // REQUIRED pointer to the observed failure that earned it
  when(input: LaneReminderInput): boolean;
  text(input: LaneReminderInput): string;
}

export function computeLaneReminders(input: LaneReminderInput): string[];
// filters rules by verb, evaluates `when`, returns first ≤ 2 texts in rule-array order
```

Pure function, direct unit tests, no mocking (engineering-principles: extract pure functions).

### 6.4 v1 rule set (three rules, each evidence-backed)

| id | Fires when | Text (shape) | Evidence |
|---|---|---|---|
| `iteration-budget` | `verb = task-complete` and `circuitBreakerThreshold − iterationCount ≤ 2` | "This context has used N of M iterations — the circuit breaker halts the workflow at M. Fix root causes before re-completing; script validators run before agent validators, so make the build/tests pass first." | Circuit-breaker halts in real executions (graph-workflow-audit findings; breaker exists because loops happened) |
| `halted-stop` | any verb, halt 409 path (`halted !== null`) | "This workflow is halted: <reason>. Do not continue task work; end your turn — the workflow resumes via repair/user action." | Join-conflict halt→repair→resume flow (memory: join-conflict-recovery) showed lanes need explicit stop guidance at halt |
| `lane-autonomy` | `verb = task-complete` and `iterationCount ≥ 2` | "This lane is autonomous — `cctl ask` is unavailable here. If genuinely blocked, send `cctl workflow collab request --brief \"<specific question>\"` and stop." | Lanes stalling instead of collaborating; collab machinery exists for this (collab memories, 2026-06) |

Wiring: `completeTask` success body and the halt 409 body gain `reminders?: string[]`
(additive — older CLIs ignore unknown fields; matches the additive-schema discipline in
`tech.md`). Log event `graph-workflow-lane.reminders_emitted` with `{contextId, verb, ruleIds}`
per the logging requirement.

CLI side: lane-verb response schemas add optional `reminders`; `render()`/`failure()` (§5.1)
display them. No CLI-authored reminders — the CLI stays a dumb renderer of server judgment.

### 6.5 Measurement before expansion

After ~5 real executions with reminders live, run the `graph-workflow-audit` skill and compare
protocol-violation classes (silent stalls, breaker trips, scope creep) against pre-reminder
executions in the execution log. Expansion of the rule set or to non-lane commands requires that
evidence — this is the enforcement of §6.2 rule 1.

---

## 7. Testing strategy (red-green per methodology)

### 7.1 Registry contract test (`src/cli/help-registry.contract.test.ts`)

The drift-prevention backstop; failure of any assertion is the new "help is wrong" signal:

1. Every dispatchable command path (a hard-coded mirror of `core.ts` dispatch + each command's
   subcommand switch — the test IS the mirror, reviewed on change) has a registry entry.
2. Every leaf entry has ≥ 1 example; every entry has a non-empty summary/description/usage.
3. Every `related.command` resolves to a registry entry (no dangling graph edges).
4. Every `skills[].path` exists on disk (repo-relative).
5. No flag name is declared `boolean` in one entry and `value` in another (parser constraint §2.3).
6. Every level-1 entry appears in the generated top usage; group nodes list all their children.

### 7.2 Unit tests

- Registry aggregation: duplicate-path and orphan-leaf init throws.
- `helpEntryFor` longest-prefix resolution incl. 3-level paths; unknown-subpath usage failure lists
  siblings.
- Text renderer snapshot-style assertions per section; group-node index rendering.
- JSON help envelope shape (Zod-parsed in the test).
- `render`/`failure` tier ordering: detail → reminders → hint, both modes; envelope carries
  `issues`/`code`/`reminders`.
- `failureFromRequest` 400/422 passes structured issues through (existing tests extended).
- `computeLaneReminders`: each rule's predicate boundary (threshold−2, halt, iteration ≥ 2), cap
  at 2, verb filtering — pure-function tests, no mocks.
- `agent-help` route handlers: token gate, unknown command → empty blocks, provider outputs — DI
  per engineering-principles (providers injected; no `vi.mock` of internal modules).
- CLI dynamic-context behavior: fake host fetch — success renders blocks; timeout/failure renders
  static help byte-identically (the "never fails" property is an explicit test).

### 7.3 Live verification (post-merge, per `post-merge-live-verification.md` conventions)

- `cctl workflow create --help` inside a real session: static sections + dev/workflow context blocks.
- Kill the server; same command renders static help, exit 0.
- A real lane execution driven to iteration threshold−2: reminder appears in `task complete` output
  and in the transcript; `graph-workflow-lane.reminders_emitted` in logs.
- `cctl workflow create --file bad-plan.json --json` → envelope contains `issues[]`.

---

## 8. Implementation plan

Phases are independently shippable; A is the foundation, B the contract, C and D are independent
after B, E is the sweep. Suggested kiro slicing: one spec for A+B, one for C, one for D (+E folded
into whichever lands last).

**Phase A — Registry foundation (size M)**
1. `help-types.ts`; `help-registry.ts` (aggregation, validation, `helpEntryFor`, `flagNamesFor`,
   `booleanFlagNames`, `renderTopUsage`). TDD: contract test + aggregation tests first.
2. Author all `*.help.ts` entries (§2.4 inventory), porting `help.ts` + SKILL.md content and
   fixing known gaps (`conversation read` flags).
3. Rewire: `parseArgv` boolean set, `USAGE`, every `checkFlags` call site → registry-derived;
   extend `core.ts` help interception to full-path resolution; text renderer.
4. Delete `src/cli/help.ts`. Gate: contract test green; existing command tests green
   (help-text assertions updated).

**Phase B — Output contract v2 (size S)**
1. Envelope/`FailureInput` fields + `render`/`failure` tier rendering (§5.1); `classifyErrorBody`
   coerces `reminders`. TDD on tier ordering.
2. JSON structured help (§3.3).
3. Context resolvers → `usageFailure` (§5.2).
4. `definition-route-handlers.ts` create/replace → `{error, issues}` (§5.3) + consumer grep/UI check.

**Phase C — Lane reminders (size M)**
1. `lane-reminders.ts` rule engine + v1 rules (TDD, pure).
2. Wire into `lane-route-handlers.ts` success + halt bodies; log event; extend the lane
   `*.contract.test.ts` round-trip fixtures.
3. CLI: lane response schemas + rendering (mostly free after Phase B).
4. Post-merge: live lane verification (§7.3); schedule the §6.5 audit checkpoint.

**Phase D — Dynamic help context (size M)**
1. `src/lib/agent-help/` domain: schemas, provider map, service, route-handlers (DI; TDD) + route
   re-export.
2. Four v1 providers (§4.3), each reading existing services.
3. CLI: `FetchInit.timeoutMs` + `index.ts` AbortSignal implementation; `--help` best-effort fetch +
   silent-omit rendering; `dynamicContext: true` on dev/workflow/conversation/fixture entries.
4. Live verification: server-up and server-down help parity (§7.3).

**Phase E — Docs sweep (size S)**
1. Update `cc-cli` SKILL.md: three-tier table, `--json` help shape, dynamic-context note,
   per-command reference synced to registry (manual; generation deferred).
2. Doc 01 §6: add the tier table; note `issues`/`code` in the envelope.
3. This doc → Status: implemented; README index already updated.

---

## 9. Decision log

| # | Decision | Alternatives rejected — why |
|---|---|---|
| D1 | One typed registry, colocated `*.help.ts` per command, aggregated centrally | Inline in command files (bloats 1000-line modules); central help dir (breaks colocation); markdown files parsed at build (loses type safety + derivation) |
| D2 | `checkFlags` allowlists + parse-time boolean set + top USAGE all derive from the registry | Keeping hand-written lists with a sync test — test can only compare two hand-written copies; derivation deletes the copy |
| D3 | Subcommand-granular nodes, longest-prefix resolution, group nodes as indexes | Command-level only (status quo) — too coarse for graph disclosure; per-flag nodes — absurd granularity |
| D4 | JSON help = structured object, replacing `{ok, usage}`; no back-compat | Dual shape (violates no-back-compat rule); text blob in JSON (keeps machine callers parsing prose) |
| D5 | Durable help compiled into the binary; only context blocks are server-rendered | Fully server-rendered help — breaks offline recovery + can skew against the binary's parser; fully static — no context-awareness |
| D6 | Dynamic context: 1 endpoint, prefix providers, ≤3 blocks, 500 ms timeout, silent fail-open | stderr warning on failure (noise in the recovery path); separate `cctl context` verb (splits discovery); server-push (no channel) |
| D7 | Deep app-state help customization deferred | Speculative (YAGNI); unpredictable help is worse than static help for agents |
| D8 | Three named output tiers; `reminders: string[]` between `hint` and `instruction` | Overloading `hint` (destroys its ignorable-by-contract property); single `messages[]` with severity (weaker contract, easier misuse) |
| D9 | Reminders are server-authored + state-conditional; CLI renders only | CLI-side static reminders — boilerplate at the wrong layer, can't see state, requires rebuilds to tune |
| D10 | Admission rule: evidence-required, state-conditional, tier-true, cap 2 | Unrestricted authoring — instruction dilution kills the channel's power (scarcity is the mechanism) |
| D11 | v1 reminders = 3 lane rules (iteration-budget, halted-stop, lane-autonomy) | Advancement-invariant reminder on non-workflow commands — requires cross-command lane awareness; deferred until evidence demands it |
| D12 | Keep `stopInstruction` field name; new commands use `instruction` | Global rename — churn across schemas/skill/tests for zero behavior |
| D13 | Bundle audit fixes (issues/code in envelope, identity usage-hint, create/replace normalization) into Phase B | Separate effort — same files, same contract; splitting doubles review |
| D14 | Registry contract test hard-codes the dispatch mirror | Reflecting over dispatch at runtime — the dispatch is `if`-chains, not data; making dispatch data-driven is a bigger refactor than this design needs (YAGNI; revisit if dispatch grows) |
| D15 | `FetchInit.timeoutMs` on the existing host seam | New `CliHost.fetchWithTimeout` (widens the seam); global timeout on all requests (would time out `--wait` flows) |

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Registry porting introduces subtle help regressions | Low | Contract test §7.1; command tests assert key phrases, updated deliberately in Phase A review |
| JSON help shape change breaks an unnoticed consumer | Low | Grep for `"usage"` consumers of the help envelope; skill updated same phase; agents re-read help |
| Legacy `Invalid request:` string consumers (builder UI) | Med | Explicit consumer grep task in Phase B; `error` field retained so display degrades, not breaks |
| Reminder desensitization / channel dilution | Med | §6.2 admission rule + cap; §6.5 audit checkpoint gates expansion |
| Dynamic-context flakiness erodes trust in `--help` | Med | Fail-open + 500 ms timeout + byte-identical static fallback (tested §7.2); server-side-only logging |
| Boolean/value flag-name collision across commands | Low | Contract test §7.1(5) fails the suite before it can ship |
| Bundle growth from embedded prose | Low | Tens of KB of strings; measure in `build:cli` output once, no budget needed |

---

## 11. Steering and documentation updates (shipped with this design)

- **NEW `.kiro/steering/cli.md`** — durable principles: CLI-as-disclosure-graph, registry as single
  source of truth, the three-tier output contract, reminder admission rule, static/dynamic split,
  help-never-fails, and the add-a-command checklist. Read-on-demand steering, referenced from
  CLAUDE.md.
- **CLAUDE.md** — `.kiro/steering/cli.md` added to the Additional steering list with a
  read-before-touching-`src/cli` trigger.
- **`docs/design/cc-cli/README.md`** — this doc added to the index.
- **Phase E** carries the SKILL.md + doc 01 §6 sync (they follow implementation, not design).
