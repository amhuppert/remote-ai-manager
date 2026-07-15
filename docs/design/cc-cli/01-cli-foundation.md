# CC CLI Foundation (`cctl`)

**Status:** Implemented; retained as the migration design record. Current extension rules live in `.kiro/steering/cli.md`.

Phase 0 of the [CC CLI migration](./README.md). Everything in this document is prerequisite to
migrating any tool.

## 1. Name and shape

**The binary is `cctl`** (Command Center control, kubectl/systemctl convention).

> **Why not `cc`:** `cc` is the system C compiler (`/usr/bin/cc` → clang on macOS). The env
> contract prepends our bin dir to `PATH` inside every agent session; naming the CLI `cc` would
> shadow the compiler and silently break any native build an agent runs. This is non-negotiable.

Command shape is `cctl <group> <verb> [flags]`, non-interactive always (no prompts, no TTY
detection surprises). Groups: `ask`, `notify`, `docs`, `dev`, `workflow`, `charter`, `decisions`,
`agent`, `doctor`. The `workflow` group nests both authoring/lifecycle verbs and the
graph-workflow lane verbs (`workflow task complete`, `workflow shared-doc upsert`,
`workflow collab request`). Full command designs live in doc 02/03.

## 2. Environment contract

CC already has a single env-injection seam: `QuerySessionOptions.env`
(`src/lib/agent-backends/claude/query-session.ts:247`, populated from
`src/lib/workflows/conversation/actor-implementations.ts`). Phase 0 extends what CC injects when
spawning any agent session:

| Var | Value | Notes |
|---|---|---|
| `CC_SERVER_URL` | `http://127.0.0.1:<PORT>` | Server derives its own URL at startup from the `PORT` env (it has no runtime URL awareness today — `src/lib/config/loader.ts` resolves paths only). Recorded once in a module-level accessor at boot. |
| `CC_API_TOKEN` | instance token | §4 |
| `CC_PROJECT` | project name | identity |
| `CC_SESSION` | session name | identity |
| `CC_CONVERSATION_ID` | conversation id | identity |
| `CC_WORKFLOW_EXECUTION_ID`, `CC_WORKFLOW_CONTEXT_ID` | lane identity | only for graph-workflow lane conversations |
| `PATH` | `<configDir>/bin:` prepended | makes `cctl` resolvable |
| `BASH_MAX_TIMEOUT_MS` | e.g. `1800000` | raises the harness Bash ceiling so `--wait` flows (agent runs) don't hit the 10-minute default |

Resolution order in the CLI: explicit flags (`--server`, `--project`, `--session`,
`--conversation`, `--token`) > env vars > (token only) `<configDir>/api-token` file. With no
identity available, commands that need one fail with exit 2 and a message naming the missing
variable. This keeps the CLI usable by agents *outside* CC (the flexibility goal): they pass flags
or export the env themselves.

## 3. Build and distribution — the server owns the binary

**Problem this solves:** sessions run branch worktrees against one live server. A CLI built from
worktree code can drift from the running server's API — a failure class MCP structurally cannot
have. Therefore the *server* is the single source of the binary; worktree-built copies are never
used by sessions.

- **Bundle:** a single-file JS bundle (`bun build --target=node`, or esbuild) with a `#!/usr/bin/env node`
  shebang. Deliberately **not** a compiled native binary: `bun build --compile` output needs
  code-signing care on macOS (we already carry ad-hoc re-signing pain for the codex binary) and a
  plain JS file sidesteps it entirely. Node is guaranteed present (CC itself runs on it).
- **Build step:** `bun run build` gains a `build:cli` step after `next build`, emitting
  `.next/cctl/cctl.mjs` (or similar) stamped with the build id (§5).
- **Install step:** server startup (`src/instrumentation.node.ts` `register()`, after migrations)
  copies the bundle to `<configDir>/bin/cctl` (mode 0755), atomically (write temp + rename). The
  running server therefore always publishes exactly its own version. `<configDir>` resolves via the
  existing `resolveConfigDir()` (`src/lib/config/loader.ts:23-41`).
- **Dev mode:** `next dev` has no build artifact; a `predev` step (or the same `register()` path
  with an on-the-fly esbuild) installs a dev-stamped bundle. Dev and prod use different config dirs
  already (`CC_ENV=dev` → `cc-dev`), so they don't fight over `bin/cctl`.

## 4. Auth — instance token

Today the API has **no auth at all** (verified: no middleware, no token checks) and localhost trust
is the de-facto model. The CLI must not silently widen the writable surface, so:

- At first boot the server generates a random token, stored at `<configDir>/api-token` (0600).
- The CLI sends `Authorization: Bearer <token>` on every request.
- **Enforcement scope (Phase 0–3):** all *new* agent-facing endpoints require the token. Existing
  endpoints keep status-quo behavior (the browser UI has no token plumbing and gets none in this
  migration). This is honest scoping, not a security upgrade: the token is the *prerequisite* for
  the future state-mutation debug track, where enforcement becomes mandatory.
- Cross-session operations (acting on a session other than the env-derived one) additionally
  require the explicit `--project`/`--session` flags — the CLI never falls back to a *different*
  session than its env identity without them. This preserves the spirit of closure-scoped MCP
  tools and CC's worktree-isolation discipline.

## 5. Version handshake

- A prebuild step stamps the git SHA + build time into a generated module consumed by both the
  server and the CLI bundle (no such constant exists today; `package.json` version is static
  `0.1.0`).
- Every CLI request carries `X-CC-CLI-Build: <stamp>`. A lightweight `GET /api/agent/handshake`
  returns the server's stamp, resolved identity (project/session/conversation), and token validity.
- Mismatch policy: server responds with a warning header; the CLI prints a one-line warning to
  stderr but proceeds (mismatch should only be transient across a server restart, since the server
  owns the binary). `cctl doctor` surfaces all of this explicitly and is the Phase-0 acceptance
  test.

## 6. CLI conventions

Designed to the same philosophy as the project's AI-validation-output guidance: terse, actionable,
machine-checkable.

- **Exit codes:** `0` success · `1` operation failed (server said no) · `2` usage/validation error
  (bad flags, invalid `--file` payload) · `3` connection/auth failure (server unreachable, bad
  token) · `4` version-mismatch hard failure (reserved; normally warn-only).
- **Output:** human-terse one-liners by default; `--json` for structured output on every command.
  Errors to stderr, single actionable line first, detail after. Never page, never color-depend.
- **Guidance hints — every command steers the next step.** A command's output may end with one
  brief advisory line pointing at the likely next command(s), so multi-step flows chain themselves
  (`workflow validate` → "valid — create it with `cctl workflow create --file plan.json`") and
  read commands remind the agent of their sibling verbs (`docs list` → how to register/delete).
  Text format: final output line, prefixed `hint:`. JSON format: reserved top-level `hint` string
  field in the CLI's `--json` envelope. Discipline: one line, ~25 words max, imperative, only
  where a likely next action exists — a hint is a reminder, not documentation; detail lives in the
  skill. Terminal actions get none (`cctl notify` has no next step).
- **Hints are advisory; protocol is not a hint.** Load-bearing instructions — the `ask` end-turn
  message, `stopInstruction` from task completion, halt reasons — are primary output and/or
  command-specific response fields, never demoted into `hint`. An agent must be able to ignore
  `hint` safely.
- **Hints are authored in the CLI**, colocated with command definitions, optionally interpolating
  response facts ("2 tasks remain in this context"). Server responses carry facts and protocol
  instructions, never CLI verb names — and since the server owns the binary (§3), hint text cannot
  skew from the actual command surface.
- **The three output tiers.** Command output (not just help) carries up to three tiers with distinct
  agent obligations. Tier misuse is a review-blocking defect: nothing load-bearing in `hint`,
  nothing actionable-now in `reminders`.

  | Tier | Field | Semantics | Agent obligation |
  |---|---|---|---|
  | Hint | `hint?: string` | Advisory next step | Ignorable by contract |
  | Reminders | `reminders?: string[]` | Invariants binding while work continues | Keep true; not an action |
  | Instruction | `instruction?: string` (legacy `stopInstruction` retained) | Do this now | Obey first |

  Text rendering order after the primary body: each reminder as a `reminder:` line, then the `hint:`
  line. The `--json` envelope carries `error`/`code`/`issues`/`reminders`/`hint` — structured detail
  is never text-mode-only. Full contract: `04-progressive-disclosure.md` §1.2/§5.
- **Structured input via files:** any payload beyond a couple of scalars is `--file <path>` (JSON),
  with `-` for stdin. Agents author payloads with the Write tool and iterate on validation errors —
  this is the planner-tool win and the pattern for `ask`, `charter`, `decisions` too.
- **Long operations:** job-shaped server endpoints plus `--wait [--timeout <dur>]` long-polling on
  the CLI. On Bash kill mid-wait, the job continues server-side; `cctl <group> status <id>` resumes
  observation. No fire-and-forget flags that hide failures.
- **Server-side validation is the source of truth.** The CLI does minimal local checking (flags,
  file readability, JSON well-formedness); Zod schemas at the route boundary produce the real
  errors, returned as `{ error, code?, issues? }` and rendered as one issue per line. The CLI
  forwards `code`/`issues` onto its `--json` failure envelope rather than flattening them into prose.

## 7. Skill and discovery

- One skill, `command-center:cc-cli`, documenting all command groups with examples, when-to-use,
  and failure recovery (what exit 3 means, how to re-run `cctl doctor`). Loaded on demand.
- One-line nudge in the session system prompt (where MCP tool guidance lives today), of the form:
  *"Command Center actions (notifications, questions, documents, dev servers, workflows) go through
  the `cctl` CLI — see the cc-cli skill."*
- Lane conversations don't rely on skill discovery: their prompt templates explicitly instruct the
  exact `cctl workflow task complete …` invocations (doc 02 §6).
- Guidance hints (§6) are the third discovery surface: the nudge gets the agent to the skill, the
  skill to the first command, and hints keep it on rails mid-flow without reloading the skill.

## 8. Testing strategy

Per project norms (DI, no `vi.mock` of internal modules, red-green TDD):

- **Route handlers:** unit tests with `createPersistenceFixture()` where round-trip durability
  matters; pure-function extraction for validation/formatting logic.
- **CLI:** the CLI core is a pure function `(argv, env, httpClient) → {exitCode, stdout, stderr}`
  with the HTTP client injected — tested without a server. A thin contract-test layer runs the real
  CLI against real route handlers in-process.
- **Handshake/install:** startup install step tested for atomicity + idempotency (re-running
  `register()` must be safe — it already is for migrations).
- **Live verification:** each phase ends with a `cc-live-feature-test` pass driving a real session
  (`cctl doctor`, one mutating command, one `--wait` command).
