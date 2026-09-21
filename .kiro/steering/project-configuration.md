# Project Configuration (`CommandCenter.json`)

Per-project config at repo root. Optional — all fields nullable. Read on demand by `readRepoConfig()`, not persisted in state.

## Key files

- `src/lib/config/schemas.ts` — `perRepoConfigSchema` (Zod): `initScriptPath`, `validation`, `devServers`, `agentBackends`
- `src/lib/projects/repo-config.ts` — `readRepoConfig()`
- `src/lib/validation/singleton.ts` — process-wide `ValidationService` entry point
- `src/lib/sessions/service.ts` — init script execution lives **in `createSession()`**, not in `repo-config.ts`
- `src/lib/workflow-graph/parallel-worktrees.ts` — `provision()` runs the same init script after each graph-workflow parallel-context worktree is created
- `src/lib/dev-server/registry.ts` — spawn/stop, CC-assigned port injection (`CC_ASSIGNED_PORT`/`PORT`)
- `src/lib/dev-server/port-selection.ts` — port scan + ownership (`selectPort`)
- `src/lib/dev-server/liveness.ts` — liveness polling
- `src/lib/shared/child-env.ts` — `buildChildEnv()` strips `NODE_ENV`, `__NEXT_*`, `__TURBOPACK_*`
- `docs/project-configuration.md` — user-facing docs

## Configuration areas

### `initScriptPath` — Worktree init

- Runs after worktree creation in `createSession()` **and** after each graph-workflow parallel-context worktree is created in `parallel-worktrees.ts:provision()`
- Direct exec (`execFile`, **shebang required**)
- cwd = worktree, no timeout (relies on script's own bounding)
- Failure → rollback: session path removes worktree and deletes session state; parallel-context path disposes the worktree (and branch) so the next iteration can retry
- Idempotent re-provision of an existing parallel-context worktree on the matching branch **skips** the init script (it ran on the first provision)
- Parallel-context invocations set an additional `CONTEXT_ID` env var; presence of `CONTEXT_ID` distinguishes parallel-context init from regular session init

### `validation` — Registered validation commands

- `validation.commands` maps stable command names to `{ command: { full, changed? }, cost, timeoutMs?, description?, pathArgs? }`.
- `cost` is either a positive integer charged for every scope, or a table `{ full, changed?, paths?: { base, perPath } }` pricing each narrower execution separately. This repository derives each weight from the measured peak resident memory of the command's whole process tree, one unit per 512 MB, so the sum admitted against the global limit is a memory budget; `PERFORMANCE.md` records the measurements behind the current weights and the one deliberate under-reservation (a cold native typecheck). Three refinements: a `paths` block requires `pathArgs: "paths"`, `changed` must not exceed `full`, and `paths.base` must not exceed the changed weight (`changed ?? full`).
- `resolveSubmissionCost()` in `validation/cost-resolution.ts` collapses the table into one weight at submission: `full` scope charges `full`; changed with no explicit paths charges `changed ?? full`; N explicit paths charge `min(base + perPath * N, changed ?? full)`, so narrowing can never cost more than not narrowing. The resolved number is snapshotted onto the run record, and every stage after admission (scheduler, ledger, SSE, run-row APIs) still sees a plain integer.
- `validation.preMerge` selects the ordered commands used by Smart Merge and Smart Commit.
- `validation.laneMerge` optionally selects graph lane-merge commands and falls back to `preMerge` when absent.
- Graph context `scriptValidator.commands` is an independent ordered selection. An empty list disables the deterministic context gate.
- Every consumer submits registered names through `getValidationService()`; feature code never executes the scripts directly.
- Every invocation requests `changed` or `full`; agent omission defaults to changed and orchestrator callers pass changed explicitly.
- The service selects `command.changed` for a changed request or falls back to `command.full`, resolves that path from the canonical project root, runs it with the target worktree as cwd, enforces the global weighted budget, and captures combined output.
- Explicit paths can narrow only a native changed execution whose profile declares `pathArgs: "paths"`; wrappers implement one fixed mode and never parse the Command Center scope.
- Graph script-validator failures are written to `.cc/workflow/<executionId>/<command>-<timestamp>-<runId>.log` and reopen a remediation task. Unknown names fail closed with `script_validator_unknown_command`.

### `devServers` — Dev server declarations

- Array of `{ name, command, port: { base, range? }, cwd? }` — started on demand through the UI or `cctl dev ensure`, not automatically at session creation. `port` is required.
- Spawned with `shell: true` (unlike init and validation wrappers)
- **CC owns port assignment.** CC scans `port.base`‥`port.base + port.range − 1` (`range` default 100), picks the first port already owned by this worktree (adopt) or free, and injects it as `CC_ASSIGNED_PORT` and `PORT` (plus any optional `port.env` alias). The `command` references `$CC_ASSIGNED_PORT`/`$PORT` directly — there is no `CC_PORT` stdout protocol and no helper scripts.
- Readiness = TCP connect on the assigned port; 60s timeout (`READINESS_TIMEOUT_MS` in `dev-server/config.ts`) → `error`
- Liveness polling every 5s once the server is listening
- Remote URL via Tailscale Serve or LAN IP (`dev-server/registry.ts`)

### `agentBackends.cursor.disabledModels` — Cursor opt-out model list

- Optional `string[]`; omitted (or `"cursor": {}`) means nothing is disabled and the whole generated catalog is offered. Strict block: only `disabledModels` is accepted, and `supportedModels`/`model`/`reasoningEffort`/`apiKey` are rejected by name, `supportedModels` naming its replacement.
- The generated catalog (`agent-backends/cursor/generated-model-catalog.json`) is the source of what exists; `bun run build` refreshes it from `Cursor.models.list()` through `cursor-models:sync`, falling back to `--check` without a credential or network.
- The Cursor adapter's model policy (`agent-backends/cursor/model-policy.ts`) is the validation authority. It reads this list through `createCursorDisabledModelsReader(readRepoConfig)` using `ConversationBackendCreateInput.projectPath`, and refuses a disabled model before any worker spawns — never substitutes.
- Route-level refusal goes through the backend-neutral model-catalog and complete-selection validation facets; no caller reconstructs model/parameter compatibility.
- An id absent from the generated catalog is inert, so a vendor retirement never makes a project's config unreadable. A list naming every catalog model permits nothing; a malformed list is a bounded refusal, not a thrown error.
- `GET /api/projects/[name]/model-options` (`agent-backends/project-model-options-route-handlers.ts`) projects the project-effective catalog, atomic default, provenance, and diagnostics for creation surfaces. Surfaces render a value outside the projection as an explicit invalid selection.

## Env var differences

| Variable | Init (session) | Init (parallel context) | Validation |
|---|---|---|---|
| `PROJECT_ROOT` | Original repo root | Original repo root | **Worktree path** |
| `CLAUDE_PROJECT_DIR` | Original repo root | Original repo root | Original repo root |
| `WORKTREE_PATH` | Worktree | Parallel-context worktree | Worktree |
| `PARENT_WORKTREE_PATH` | Parent session worktree, or `PROJECT_ROOT` when branched off main | Session worktree (lane branched from it) | — |
| `SESSION_NAME` | Session name | Parent session name | Session name |
| `BRANCH_NAME` | `csm/<name>` | `csm/<sessionDir>-<contextId>` | `csm/<name>` |
| `CONTEXT_ID` | — | Parallel context id | — |
| `TARGET_BRANCH` | — | — | Branch the work merges into (optional) |

`PROJECT_ROOT` differs intentionally for validation: it validates code in the target worktree.

`TARGET_BRANCH` lets the validation script scope checks (prettier/eslint/tests) to the diff against the merge target via `git merge-base`. All three validation paths pass it: the merge and commit workflows pass `session.targetBranch` (precise for stacked sessions); the graph script validator passes the session branch for worktree-isolated contexts (their fan-in target) and the session's own target for solo contexts. When absent, the script falls back to `main`.

## Navigation

- Init logic: search `initScriptPath` in `sessions/service.ts` and `workflow-graph/parallel-worktrees.ts` (not `repo-config.ts`)
- Validation entry point: `validation/singleton.ts`; command configuration: `validation/schemas.ts`; executable resolution: `validation/command-resolution.ts`; cost projection: `validation/cost-resolution.ts` (kept free of `node:` builtins because browser-reachable preflight consumers import it)
- Dev server lifecycle: `dev-server/registry.ts` (spawn/stop), `dev-server/port-selection.ts` (port scan/ownership), `dev-server/liveness.ts` (polling)
- Timeouts: init = none (script self-bounds), validation = command `timeoutMs` or global `validation.defaultTimeoutMs`, dev server readiness = `READINESS_TIMEOUT_MS` in `dev-server/config.ts`
