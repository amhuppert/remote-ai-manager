# Project Configuration

Command Center reads an optional `CommandCenter.json` file from the root of each project it manages. This file lets you configure project-specific behavior: worktree initialization, pre-merge validation, and dev server automation.

Projects without a `CommandCenter.json` work normally — all fields are optional.

## File Location

Place `CommandCenter.json` at the root of your git repository:

```
my-project/
├── CommandCenter.json
├── scripts/
│   ├── worktree-init.sh
│   └── pre-merge-validate.sh
└── ...
```

## Schema

```json
{
  "initScriptPath": "scripts/worktree-init.sh",
  "preMergeCommand": "scripts/pre-merge-validate.sh",
  "devServers": [
    {
      "name": "nextjs",
      "command": "npx next dev --port $CC_ASSIGNED_PORT",
      "port": { "base": 3000, "range": 100 }
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `initScriptPath` | `string \| null` | No | Script to run after a session worktree is created |
| `preMergeCommand` | `string \| null` | No | Validation script to run before squash-merging into main |
| `devServers` | `Array<DevServer>` | No | Dev servers that can be launched from the session UI (see [`devServers`](#devservers--dev-server-configuration)) |

---

## `initScriptPath` — Worktree Initialization Script

Runs automatically after Command Center creates a new session worktree. Use this to install dependencies, set up environment files, run code generation, or perform any other setup that a fresh worktree needs before it's usable.

### When It Runs

1. User creates a new session (any mode: Fast or Focus)
2. Command Center creates the git worktree and branch
3. **The init script executes**
4. If the script succeeds, the session is ready
5. If the script fails, the entire session creation is rolled back (worktree removed, session deleted from state)

### Path Resolution

The value can be a relative or absolute path. Relative paths are resolved from the **project root** (the original repository, not the worktree).

```json
{ "initScriptPath": "scripts/worktree-init.sh" }
```

If the resolved path does not exist, session creation fails with an error.

### Execution Environment

| Property | Value |
|---|---|
| **Working directory** | The newly created worktree path |
| **Timeout** | 60 seconds |
| **Shell** | Direct execution (must have a shebang line, e.g., `#!/usr/bin/env bash`) |
| **Exit code** | `0` = success, non-zero = failure (triggers rollback) |

### Environment Variables

| Variable | Description | Example |
|---|---|---|
| `PROJECT_ROOT` | Absolute path to the original project root | `/home/user/repos/my-project` |
| `CLAUDE_PROJECT_DIR` | Same as `PROJECT_ROOT` | `/home/user/repos/my-project` |
| `WORKTREE_PATH` | Absolute path to the session worktree | `/home/user/repos/my-project/.worktrees/my-session` |
| `SESSION_NAME` | Session identifier | `my-session` |
| `BRANCH_NAME` | Git branch created for this session | `csm/my-session` |

> **Note:** `NODE_ENV` is intentionally unset so that package managers and tools use their own defaults (e.g., `bun install` installs dev dependencies). Next.js and Turbopack internal variables (`__NEXT_*`, `__TURBOPACK_*`) are also stripped to prevent conflicts.

### Contract

- The script **must be executable** (`chmod +x`).
- The script **must have a shebang line** (e.g., `#!/usr/bin/env bash`). It is invoked directly, not through a shell.
- The script **must exit 0 on success**. Any non-zero exit code causes session creation to fail and the worktree to be removed.
- The script **must complete within 60 seconds**. If it exceeds this timeout, it is killed and session creation fails.
- The script's **working directory is the worktree**, so commands like `npm install` or `bun install` operate on the worktree automatically.
- **Stdout and stderr** are not displayed to the user on success. On failure, the error message from the child process is included in the error response.

### Example

```bash
#!/usr/bin/env bash
# scripts/worktree-init.sh
set -euo pipefail

echo "Installing dependencies in worktree: $WORKTREE_PATH"
bun install
```

A more involved example:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Install dependencies
npm ci

# Copy environment file if it doesn't exist
if [ ! -f .env.local ]; then
  cp "$PROJECT_ROOT/.env.example" .env.local
fi

# Run code generation
npx prisma generate
```

---

## `preMergeCommand` — Pre-Merge Validation Script

Runs automatically during Command Center's smart merge workflow, before squash-merging a session branch into main. Use this to run linters, type checkers, formatters, and tests to ensure the branch is clean before it lands on main.

### When It Runs

The smart merge workflow is a multi-phase process:

1. **Phase 1 — Forward merge:** Command Center merges `main` into the session branch to catch conflicts early
2. **Phase 2 — Validation:** **The pre-merge script executes** against the worktree (which now has main merged in)
3. **Phase 3 — Auto-fix (if validation failed):** If the script fails and auto-fix is enabled, Command Center sends the validation output to Claude to fix the issues, then re-runs validation
4. **Phase 4 — Squash merge:** If validation passes, the session branch is squash-merged into main

The script may run **multiple times** during a single merge if auto-fix retries are enabled.

### Path Resolution

Same as `initScriptPath` — relative paths resolve from the project root.

```json
{ "preMergeCommand": "scripts/pre-merge-validate.sh" }
```

### Execution Environment

| Property | Value |
|---|---|
| **Working directory** | The session worktree path |
| **Timeout** | Configurable via Command Center's global `preMergeTimeoutMs` setting (default: **5 minutes**) |
| **Shell** | Direct execution (must have a shebang line) |
| **Exit code** | `0` = validation passed, non-zero = validation failed (merge aborted or auto-fix attempted) |

### Environment Variables

| Variable | Description | Example |
|---|---|---|
| `PROJECT_ROOT` | Absolute path to the session worktree (where the code is) | `/home/user/repos/my-project/.worktrees/my-session` |
| `CLAUDE_PROJECT_DIR` | Absolute path to the original project root | `/home/user/repos/my-project` |
| `WORKTREE_PATH` | Same as `PROJECT_ROOT` — absolute path to the session worktree | `/home/user/repos/my-project/.worktrees/my-session` |
| `SESSION_NAME` | Session identifier | `my-session` |
| `BRANCH_NAME` | Git branch for this session | `csm/my-session` |

> **Note:** `PROJECT_ROOT` points to the **worktree** (not the original repo root) because the script should validate the code as it exists in the worktree — which already has main merged in at this point. Use `CLAUDE_PROJECT_DIR` if you need to reference the original project root.

### Contract

- The script **must be executable** (`chmod +x`) with a **shebang line**.
- **Exit 0** means all checks passed — the merge proceeds.
- **Non-zero exit** means validation failed — the merge is aborted (or auto-fix is attempted if enabled).
- **Stdout and stderr are captured** and included in the error notification when validation fails. Write clear, actionable output so failures can be diagnosed. When auto-fix is enabled, Claude reads this output to understand what needs fixing.
- The script **may make changes to files** (e.g., auto-formatting via Prettier, ESLint `--fix`). Any uncommitted changes left by the script are automatically committed by Command Center with the message `auto-fix: pre-merge validation` (using `--no-verify` to skip git hooks). These changes are included in the squash merge.
- The script **must complete within the configured timeout** (default 5 minutes). Exceeding the timeout kills the script and fails validation.
- The script runs with **`NODE_ENV` unset** and Next.js/Turbopack internal variables stripped, same as the init script.

### Example

```bash
#!/usr/bin/env bash
# scripts/pre-merge-validate.sh
set -euo pipefail

# Auto-fix formatting (changes are auto-committed by CC after this script)
npx prettier --write . > /dev/null 2>&1
npx eslint . --fix --quiet --no-color --no-warn-ignored

# Type checking
npx tsc --noEmit --pretty false

# Tests
npx vitest run --no-color
```

### Tips

- **Formatting first:** Run formatters (`prettier --write`, `eslint --fix`) before checkers (`tsc`, `vitest`). Command Center auto-commits any file changes the script makes, so formatters work seamlessly.
- **Suppress noise:** Use `--no-color`, `--quiet`, and `--pretty false` to keep output clean and machine-readable. This helps both human debugging and Claude auto-fix.
- **Fail fast with `set -euo pipefail`:** The script should stop at the first failure. Don't swallow errors — Command Center needs the non-zero exit code to detect failure.

---

## `devServers` — Dev Server Configuration

Declares dev servers that users can start and stop from the session detail page in Command Center. Each server runs inside the session's worktree, gets automatic port management, liveness monitoring, and optional remote URL resolution via Tailscale or LAN IP.

### Configuration

Each entry has three required fields (`name`, `command`, `port`) and one optional one (`cwd`):

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` (min 1 char) | Yes | Unique identifier for the server, displayed in the UI |
| `command` | `string` (min 1 char) | Yes | Shell command to start the server; references `$CC_ASSIGNED_PORT` (or relies on `$PORT`) |
| `port` | `object` | Yes | The CC-assigned port window — see [Port Assignment](#port-assignment) |
| `cwd` | `string` | No | Working directory relative to the worktree (e.g. `apps/web`) |

```json
{
  "devServers": [
    { "name": "nextjs",    "command": "npx next dev --port $CC_ASSIGNED_PORT",            "port": { "base": 3000, "range": 100 } },
    { "name": "storybook", "command": "npx storybook dev --port $CC_ASSIGNED_PORT --no-open", "port": { "base": 6006, "range": 100 } }
  ]
}
```

Server names must be unique within the `devServers` array.

#### Port Assignment

CC owns port assignment. Before spawning the server, CC scans the window `base‥base+range−1` and picks the first port that is either already owned by this worktree (so the existing process can be adopted) or completely free. It never claims a port whose ownership it cannot verify. The chosen port is injected into the spawned child as `CC_ASSIGNED_PORT` and `PORT` (plus any `port.env` alias). Your command references `$CC_ASSIGNED_PORT`, or relies on `$PORT`.

```json
{
  "devServers": [
    {
      "name": "web",
      "command": "bun run dev -- --port $CC_ASSIGNED_PORT",
      "cwd": ".",
      "port": {
        "base": 3000,
        "range": 100,
        "env": "CC_ASSIGNED_PORT"
      }
    }
  ]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `port.base` | `number` (1–65535) | required | Starting port for the scan |
| `port.range` | `number` (≥1) | `100` | How many ports above `base` to scan |
| `port.env` | `string` | none | Extra env var name to set to the assigned port (alongside `CC_ASSIGNED_PORT` and `PORT`) |

### When It Runs

Dev servers are started either from the Command Center UI on the session detail page **or** on demand by the agent inside the session via the session-scoped MCP tools described below. They are not started automatically during session creation.

When a session is deleted, all running dev servers for that session are stopped automatically.

### Agent-Facing MCP Tools

Each session exposes three session-scoped MCP tools through `cc-session-tools`:

| Tool | Purpose |
|---|---|
| `get_dev_servers` | List configured servers with reconciled runtime status (`status`, `port`, `localUrl`, `remoteUrl`, `ownedByThisSession`, `source`, `ownerPid`). |
| `ensure_dev_server({ name?, wait?, timeout_ms? })` | Reconcile and ensure a usable server: adopt an externally started owned server, start a stopped/errored one, or wait for an already-starting one. Returns `localUrl`/`remoteUrl` to use. Defaults: `wait=true`, `timeout_ms=60000`. |
| `stop_dev_server({ name })` | Stop a named server. Verifies worktree ownership before signalling so externally owned listeners are never killed. |

All responses are plain JSON inside MCP text content. Error responses use `isError: true` with a structured `error.code`:

- `AMBIGUOUS_DEV_SERVER` — multiple servers configured; pass `name` (response payload includes `availableNames`).
- `NO_DEV_SERVERS_CONFIGURED` — no `devServers` in `CommandCenter.json`.
- `UNKNOWN_DEV_SERVER` — the requested `name` is not configured.
- `DEV_SERVER_START_FAILED` — start failed; payload includes `recentOutput`.
- `DEV_SERVER_WAIT_TIMEOUT` — server didn't reach running within the requested timeout.

Agents should call `ensure_dev_server` before any Playwright, browser, visual, or Next.js MCP verification rather than assuming a default port belongs to their worktree.

### Execution Environment

| Property | Value |
|---|---|
| **Working directory** | The session worktree path |
| **Shell** | Spawned via shell (`shell: true`), so the command can be a script path or inline shell command |
| **Lifetime** | Runs until stopped by the user, the session is deleted, or the process exits |

### Readiness Detection

Readiness is always a TCP connect on the assigned port: CC marks the server `running` once the assigned port begins accepting TCP connections from the loopback interface. The timeout is a hardcoded 60 seconds (`READINESS_TIMEOUT_MS`) and is not configurable. If the deadline elapses the server transitions to `error`, the process is killed, and the last 10 lines of output are surfaced as the error message.

### Server Lifecycle

```
[User clicks Start]
    → status: "starting"
    → port pre-selected from scan range; env (CC_ASSIGNED_PORT/PORT/alias) injected; command spawned

[Readiness satisfied within timeout]
    → status: "running"
    → Port shown in UI
    → Liveness polling begins (every 5s)
    → Remote URL resolved (Tailscale or LAN)

[Readiness NOT satisfied within timeout]
    → status: "error"
    → Process killed
    → Last 10 lines of output shown as error message

[Port stops responding (liveness check fails)]
    → status: "stopped"
    → Tailscale registration removed (if applicable)

[User clicks Stop]
    → SIGTERM sent to process
    → All processes on the port killed (SIGTERM, then SIGKILL after 5s)
    → Tailscale registration removed
    → status: "stopped"
```

### Port Conflict Handling

When multiple sessions run the same dev server they need different ports. CC handles this itself: it runs the scan over the configured `port.base` + `port.range` window before spawning the command. It picks the first port that is either already owned by this worktree (so the existing process can be adopted) or completely free, injects it into the child via `CC_ASSIGNED_PORT`/`PORT`/your optional `port.env` alias, and waits for TCP readiness on that port. CC never claims a port whose ownership it cannot verify; if every port in the range is occupied by someone else (or has an unverifiable owner), the start fails.

### Writing Entries

For common frameworks, reference `$CC_ASSIGNED_PORT` directly in the command and let CC manage the scan + readiness:

```json
{
  "devServers": [
    { "name": "nextjs",    "command": "npx next dev --port $CC_ASSIGNED_PORT",            "port": { "base": 3000, "range": 100 } },
    { "name": "storybook", "command": "npx storybook dev --port $CC_ASSIGNED_PORT --no-open", "port": { "base": 6006, "range": 100 } }
  ]
}
```

**Custom servers** work the same way — reference `$CC_ASSIGNED_PORT` in your command:

```json
{
  "devServers": [
    {
      "name": "api",
      "command": "node server.js --port $CC_ASSIGNED_PORT",
      "port": { "base": 8080, "range": 50 }
    }
  ]
}
```

Frameworks that read only `PORT` can omit the flag, since CC also exports `PORT` with the assigned port.

---

## Minimal Configuration

The simplest useful configuration — just install dependencies on session creation:

```json
{
  "initScriptPath": "scripts/worktree-init.sh"
}
```

```bash
#!/usr/bin/env bash
# scripts/worktree-init.sh
set -euo pipefail
npm ci
```

## Full Configuration

A project using all features:

```json
{
  "initScriptPath": "scripts/worktree-init.sh",
  "preMergeCommand": "scripts/pre-merge-validate.sh",
  "devServers": [
    {
      "name": "nextjs",
      "command": "npx next dev --port $CC_ASSIGNED_PORT",
      "port": { "base": 3000, "range": 100 }
    },
    {
      "name": "storybook",
      "command": "npx storybook dev --port $CC_ASSIGNED_PORT --no-open",
      "port": { "base": 6006, "range": 100 }
    }
  ]
}
```
