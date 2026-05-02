# Project Configuration (`CommandCenter.json`)

Per-project config at repo root. Optional — all fields nullable. Read on demand by `readRepoConfig()`, not persisted in state.

## Key files

- `src/lib/schemas.ts` — `perRepoConfigSchema` (Zod): `initScriptPath`, `preMergeCommand`, `devServers`
- `src/lib/repo-config.ts` — `readRepoConfig()`, `runPreMergeValidation()`
- `src/lib/sessions.ts` — init script execution lives **in `createSession()`**, not in `repo-config.ts`
- `src/lib/dev-server-registry.ts` — spawn/stop/liveness, `CC_PORT` protocol
- `src/lib/dev-server-presets.ts` — script generation, `installPreset()`
- `src/lib/dev-server-liveness.ts` — liveness polling
- `src/lib/child-env.ts` — `buildChildEnv()` strips `NODE_ENV`, `__NEXT_*`, `__TURBOPACK_*`
- `docs/project-configuration.md` — user-facing docs

## Three features

### `initScriptPath` — Worktree init

- Runs after worktree creation in `createSession()`
- Direct exec (`execFile`, **shebang required**)
- cwd = worktree, timeout = 60s (hardcoded in `sessions.ts`)
- Failure → full rollback (worktree removed, session deleted)

### `preMergeCommand` — Pre-merge validation

Two consumers:
1. **Smart merge workflow (Phase 2)** via `runPreMergeValidation()` — failure aborts/auto-fixes; auto-commits formatter changes (`skipHooks: true`)
2. **Graph workflow script validator** via `executeRepoValidationCommand()` (`src/lib/workflow-graph/script-validator-runner.ts`) — when context enables `scriptValidator: { enabled: true }`, runs after all tasks complete. Failure → output to `.cc/workflow/<executionId>/pre-merge-<timestamp>.log`, remediation task added. Missing `preMergeCommand` + enabled validator → halt with `script_validator_missing_command`. See `workflows.md`.

Shared:
- Direct exec (`execFile`, **shebang required**)
- cwd = worktree, timeout = `preMergeTimeoutMs` (default 5min, `src/lib/config.ts`)
- Combined stdout/stderr captured

### `devServers` — Dev server declarations

- Array of `{ name, command }` — UI-started, not auto-started
- Spawned with `shell: true` (unlike init/pre-merge)
- **`CC_PORT=<port>` stdout protocol** — script must print within 60s (`STARTUP_TIMEOUT_MS` in `dev-server-registry.ts`)
- Liveness polling every 5s after port detected
- Remote URL via Tailscale Serve or LAN IP (`dev-server-registry.ts`)
- Presets install to `.cc/dev-servers/` and update `CommandCenter.json`

## Env var differences

| Variable | Init | Pre-merge |
|---|---|---|
| `PROJECT_ROOT` | Original repo root | **Worktree path** |
| `CLAUDE_PROJECT_DIR` | Original repo root | Original repo root |
| `WORKTREE_PATH` | Worktree | Worktree |
| `SESSION_NAME` | Session name | Session name |
| `BRANCH_NAME` | `csm/<name>` | `csm/<name>` |

`PROJECT_ROOT` differs intentionally: pre-merge validates merged code in the worktree.

## Navigation

- Init logic: search `initScriptPath` in `sessions.ts` (not `repo-config.ts`)
- Pre-merge logic: `repo-config.ts` is the single module
- Dev server lifecycle: `dev-server-registry.ts` (core), `dev-server-presets.ts` (install), `dev-server-liveness.ts` (polling)
- Timeouts: init = 60s in `sessions.ts`, pre-merge = `config.ts` (`preMergeTimeoutMs`), dev server = `STARTUP_TIMEOUT_MS` in `dev-server-registry.ts`
