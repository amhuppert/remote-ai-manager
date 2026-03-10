# Project Configuration (`CommandCenter.json`)

Per-project configuration file at repository root. Optional — all fields nullable/optional. Read on demand by `readRepoConfig()`, not persisted in state.

## Schema & Key Files

- **Schema**: `src/lib/schemas.ts` — `perRepoConfigSchema` (Zod), defines `initScriptPath`, `preMergeCommand`, `devServers`
- **Reader**: `src/lib/repo-config.ts` — `readRepoConfig()` loads + parses, `runPreMergeValidation()` executes pre-merge script
- **Init execution**: `src/lib/sessions.ts:302-323` — init script runs inside `createSession()`, not in repo-config
- **Dev server registry**: `src/lib/dev-server-registry.ts` — spawn, stop, liveness, `CC_PORT` protocol
- **Dev server presets**: `src/lib/dev-server-presets.ts` — script generation, `installPreset()` writes to config
- **Child env**: `src/lib/child-env.ts` — `buildChildEnv()` strips `NODE_ENV`, `__NEXT_*`, `__TURBOPACK_*`
- **Consumer docs**: `docs/project-configuration.md` — user-facing documentation

## Three Configuration Features

### 1. `initScriptPath` — Worktree Init

- Runs after worktree creation in `createSession()`
- Direct execution (`execFile`, not shell) — **must have shebang**
- cwd = worktree, timeout = 60s
- Failure → full rollback (worktree removed, session deleted from state)
- `PROJECT_ROOT` = original project root, `WORKTREE_PATH` = worktree

### 2. `preMergeCommand` — Pre-Merge Validation

- Runs in smart merge workflow (Phase 2) via `runPreMergeValidation()`
- Direct execution — **must have shebang**
- cwd = worktree, timeout = `preMergeTimeoutMs` config (default 5min, defined in `src/lib/config.ts`)
- Failure → merge aborted or auto-fix attempted; stdout/stderr captured for diagnostics
- Auto-commits any file changes script makes (formatters) with `skipHooks: true`
- **`PROJECT_ROOT` = worktree** (not original repo!) — differs from init script

### 3. `devServers` — Dev Server Declarations

- Array of `{ name, command }` — started from session UI, not auto-started
- Spawned with `shell: true` (unlike init/pre-merge which use `execFile`)
- **`CC_PORT=<port>` stdout protocol**: script must print this within 60s or server errors out
- Liveness polling every 5s after port detected (`dev-server-liveness.ts`)
- Remote URL via Tailscale Serve or LAN IP (`dev-server-registry.ts:146-206`)
- Presets install scripts to `.cc/dev-servers/` and update `CommandCenter.json`

## Environment Variable Differences

| Variable | Init Script | Pre-Merge Script |
|---|---|---|
| `PROJECT_ROOT` | Original repo root | **Worktree path** |
| `CLAUDE_PROJECT_DIR` | Original repo root | Original repo root |
| `WORKTREE_PATH` | Worktree path | Worktree path |
| `SESSION_NAME` | Session name | Session name |
| `BRANCH_NAME` | `csm/<name>` | `csm/<name>` |

The `PROJECT_ROOT` difference is intentional: pre-merge validates merged code in the worktree.

## Navigation Patterns

- Init script logic: search `initScriptPath` in `sessions.ts` (not `repo-config.ts`)
- Pre-merge logic: `repo-config.ts` is the single module
- Dev server lifecycle spans three files: `dev-server-registry.ts` (core), `dev-server-presets.ts` (install), `dev-server-liveness.ts` (polling)
- Timeout defaults: init = hardcoded 60s in `sessions.ts`, pre-merge = `config.ts:43`, dev server startup = `STARTUP_TIMEOUT_MS` in `dev-server-registry.ts`

---

_Navigate by feature contract, not file tree. Init and pre-merge share env vars but differ in execution context._
