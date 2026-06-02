# Project Configuration (`CommandCenter.json`)

Per-project config at repo root. Optional — all fields nullable. Read on demand by `readRepoConfig()`, not persisted in state.

## Key files

- `src/lib/config/schemas.ts` — `perRepoConfigSchema` (Zod): `initScriptPath`, `preMergeCommand`, `devServers`
- `src/lib/projects/repo-config.ts` — `readRepoConfig()`, `runPreMergeValidation()`
- `src/lib/sessions/service.ts` — init script execution lives **in `createSession()`**, not in `repo-config.ts`
- `src/lib/workflow-graph/parallel-worktrees.ts` — `provision()` runs the same init script after each graph-workflow parallel-context worktree is created
- `src/lib/dev-server/registry.ts` — spawn/stop, CC-assigned port injection (`CC_ASSIGNED_PORT`/`PORT`)
- `src/lib/dev-server/port-selection.ts` — port scan + ownership (`selectPort`)
- `src/lib/dev-server/liveness.ts` — liveness polling
- `src/lib/shared/child-env.ts` — `buildChildEnv()` strips `NODE_ENV`, `__NEXT_*`, `__TURBOPACK_*`
- `docs/project-configuration.md` — user-facing docs

## Three features

### `initScriptPath` — Worktree init

- Runs after worktree creation in `createSession()` **and** after each graph-workflow parallel-context worktree is created in `parallel-worktrees.ts:provision()`
- Direct exec (`execFile`, **shebang required**)
- cwd = worktree, no timeout (relies on script's own bounding)
- Failure → rollback: session path removes worktree and deletes session state; parallel-context path disposes the worktree (and branch) so the next iteration can retry
- Idempotent re-provision of an existing parallel-context worktree on the matching branch **skips** the init script (it ran on the first provision)
- Parallel-context invocations set an additional `CONTEXT_ID` env var; presence of `CONTEXT_ID` distinguishes parallel-context init from regular session init

### `preMergeCommand` — Pre-merge validation

Two consumers:
1. **Smart merge workflow (Phase 2)** via `runPreMergeValidation()` — failure aborts/auto-fixes; auto-commits formatter changes (`skipHooks: true`)
2. **Graph workflow script validator** via `executeRepoValidationCommand()` (`src/lib/workflow-graph/script-validator-runner.ts`) — when context enables `scriptValidator: { enabled: true }`, runs after all tasks complete. Failure → output to `.cc/workflow/<executionId>/pre-merge-<timestamp>.log`, remediation task added. Missing `preMergeCommand` + enabled validator → halt with `script_validator_missing_command`. See `workflows.md`.

Shared:
- Direct exec (`execFile`, **shebang required**)
- cwd = worktree, timeout = `preMergeTimeoutMs` (default 5min, `src/lib/config/`)
- Combined stdout/stderr captured

### `devServers` — Dev server declarations

- Array of `{ name, command, port: { base, range? }, cwd? }` — UI-started, not auto-started. `port` is required.
- Spawned with `shell: true` (unlike init/pre-merge)
- **CC owns port assignment.** CC scans `port.base`‥`port.base + port.range − 1` (`range` default 100), picks the first port already owned by this worktree (adopt) or free, and injects it as `CC_ASSIGNED_PORT` and `PORT` (plus any optional `port.env` alias). The `command` references `$CC_ASSIGNED_PORT`/`$PORT` directly — there is no `CC_PORT` stdout protocol and no helper scripts.
- Readiness = TCP connect on the assigned port; 60s timeout (`READINESS_TIMEOUT_MS` in `dev-server/config.ts`) → `error`
- Liveness polling every 5s once the server is listening
- Remote URL via Tailscale Serve or LAN IP (`dev-server/registry.ts`)

## Env var differences

| Variable | Init (session) | Init (parallel context) | Pre-merge |
|---|---|---|---|
| `PROJECT_ROOT` | Original repo root | Original repo root | **Worktree path** |
| `CLAUDE_PROJECT_DIR` | Original repo root | Original repo root | Original repo root |
| `WORKTREE_PATH` | Worktree | Parallel-context worktree | Worktree |
| `SESSION_NAME` | Session name | Parent session name | Session name |
| `BRANCH_NAME` | `csm/<name>` | `csm/<sessionDir>-<contextId>` | `csm/<name>` |
| `CONTEXT_ID` | — | Parallel context id | — |
| `TARGET_BRANCH` | — | — | Branch the work merges into (optional) |

`PROJECT_ROOT` differs intentionally for pre-merge: it validates merged code in the worktree.

`TARGET_BRANCH` lets the validation script scope checks (prettier/eslint/tests) to the diff against the merge target via `git merge-base`. All three validation paths pass it: the merge and commit workflows pass `session.targetBranch` (precise for stacked sessions); the graph script validator passes the session branch for worktree-isolated contexts (their fan-in target) and the session's own target for solo contexts. When absent, the script falls back to `main`.

## Navigation

- Init logic: search `initScriptPath` in `sessions/service.ts` and `workflow-graph/parallel-worktrees.ts` (not `repo-config.ts`)
- Pre-merge logic: `projects/repo-config.ts` is the single module
- Dev server lifecycle: `dev-server/registry.ts` (spawn/stop), `dev-server/port-selection.ts` (port scan/ownership), `dev-server/liveness.ts` (polling)
- Timeouts: init = none (script self-bounds), pre-merge = `config/` (`preMergeTimeoutMs`), dev server readiness = `READINESS_TIMEOUT_MS` in `dev-server/config.ts`
