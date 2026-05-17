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
      "port": { "strategy": "cc-assigned", "base": 3000, "range": 100 }
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

Each entry has two required fields and three optional ones:

| Field | Type | Description |
|---|---|---|
| `name` | `string` (min 1 char) | Unique identifier for the server, displayed in the UI |
| `command` | `string` (min 1 char) | Shell command to start the server |
| `cwd` | `string` (optional) | Working directory relative to the worktree (e.g. `apps/web`) |
| `port` | `object` (optional) | Port allocation strategy — see [Port Strategy](#port-strategy) |
| `readiness` | `object` (optional) | Override how CC waits for the server to be ready |

```json
{
  "devServers": [
    { "name": "nextjs", "command": ".cc/dev-servers/nextjs.sh" },
    { "name": "storybook", "command": ".cc/dev-servers/storybook.sh" }
  ]
}
```

Server names must be unique within the `devServers` array.

#### Port Strategy

The optional `port` block tells CC how to allocate a TCP port for the server. Two strategies are supported:

| Strategy | When to use | What CC does |
|---|---|---|
| `stdout-cc-port` (default for legacy entries) | Your script picks its own port and prints `CC_PORT=<n>` | CC reads stdout for the line and treats that port as the server's port |
| `cc-assigned` | You want CC to pick the port and pass it to the server | CC scans the configured range, picks an owned-or-available port, injects it via `$CC_ASSIGNED_PORT`, `$PORT`, and any `env` alias, and waits for TCP readiness instead of stdout parsing |

```json
{
  "devServers": [
    {
      "name": "web",
      "command": "bun run dev -- --port $CC_ASSIGNED_PORT",
      "cwd": ".",
      "port": {
        "strategy": "cc-assigned",
        "base": 3000,
        "range": 100,
        "env": "CC_ASSIGNED_PORT"
      },
      "readiness": { "type": "tcp", "timeoutMs": 60000 }
    }
  ]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `port.strategy` | `"stdout-cc-port" \| "cc-assigned"` | `"cc-assigned"` when `port` is present, `"stdout-cc-port"` otherwise | How CC discovers/assigns the port |
| `port.base` | `number` (1–65535) | required when strategy is `cc-assigned` | Starting port for the scan |
| `port.range` | `number` (≥1) | `100` | How many ports above `base` to scan |
| `port.env` | `string` | none | Extra env var name to set to the assigned port (alongside `CC_ASSIGNED_PORT` and `PORT`) |
| `readiness.type` | `"tcp" \| "stdout-cc-port"` | `"tcp"` for `cc-assigned`, `"stdout-cc-port"` otherwise | How CC decides the server is ready |
| `readiness.timeoutMs` | `number` (100–600000) | 60_000 | How long to wait before transitioning to `error` |

When `cc-assigned` is used, the server script does **not** need to print `CC_PORT=<port>` — CC already knows the port and will wait for the server to start listening on it. This removes the need for `.cc/dev-servers/*.sh` shell helpers for most setups.

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

Command Center supports two readiness strategies, picked automatically from the port strategy:

| `readiness.type` | When CC marks the server `running` |
|---|---|
| `tcp` (default for `cc-assigned`) | When the assigned port begins accepting TCP connections from the loopback interface |
| `stdout-cc-port` (default for legacy entries) | When the server writes `CC_PORT=<port>` to stdout |

Both strategies fall back to the same timeout (60s by default, configurable via `readiness.timeoutMs`). If the deadline elapses the server transitions to `error`, the process is killed, and the last 10 lines of output are surfaced as the error message.

#### The `CC_PORT` Protocol (legacy / stdout strategy)

When a server uses `readiness.type: "stdout-cc-port"` (which is the default whenever no `port` block is provided), Command Center watches stdout for:

```
CC_PORT=<port>
```

**Rules:**

- The script **must print `CC_PORT=<port>` to stdout** where `<port>` is the TCP port number the server is listening on.
- The `CC_PORT` line must be on its own line and match the exact format `CC_PORT=<digits>` (no spaces, no quotes).
- Print `CC_PORT` **before or at the same time as** starting the server process. The typical pattern is: determine the port, print `CC_PORT=<port>`, then `exec` the actual server.
- This line must appear within `readiness.timeoutMs` (default 60s).

Servers using `cc-assigned` ports do **not** need to print `CC_PORT` — CC already knows the port it injected.

### Server Lifecycle

```
[User clicks Start]
    → status: "starting"
    → cc-assigned: port pre-selected from scan range; env (CC_ASSIGNED_PORT/PORT/alias) injected
    → stdout-cc-port: script spawned; CC watches stdout for CC_PORT=<port>

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

When multiple sessions run the same dev server they need different ports. Command Center has two ways to handle this:

**`cc-assigned` (recommended for new configs).** CC itself runs the scan over the configured `port.base` + `port.range` window before spawning the script. It picks the first port that is either already owned by this worktree (so the existing process can be adopted) or completely free, injects it into the child via `CC_ASSIGNED_PORT`/`PORT`/your optional `port.env` alias, and waits for TCP readiness on that port. No shell helpers are required and CC never claims a port whose ownership cannot be verified.

**`stdout-cc-port` (legacy).** The dev server script is responsible for the scan and prints `CC_PORT=<n>` once it has chosen a port. The preset installer ships shell helpers under `.cc/dev-servers/_helpers.sh` that do this:

1. **Pass 1 — adopt an externally started server.** Scan the entire range for a listener whose process working directory is inside the session's worktree. If one is found, print its port and exit without starting a new server. Owned ports are preferred over free ones.
2. **Pass 2 — start on the lowest free port.** If no owned server exists in the range, pick the first port that has no listener at all. Ports with listeners owned by other worktrees, or whose ownership cannot be determined, are skipped.
3. **Error if exhausted.** If every port in the range is occupied by someone else (or has an unverifiable owner), the script exits non-zero with a diagnostic line on stderr.

The two strategies are interchangeable — pick `cc-assigned` for new projects to avoid the helper script, keep `stdout-cc-port` if you already have working scripts that print `CC_PORT`.

### Using Presets vs Custom Configs

**Presets** (recommended for common frameworks): Command Center can install configuration for Next.js and Storybook via the session UI. The current preset emits a `cc-assigned` entry directly in `CommandCenter.json` — no shell script is written. The framework command is invoked with `$CC_ASSIGNED_PORT` already in the environment.

```json
{
  "devServers": [
    {
      "name": "nextjs",
      "command": "npx next dev --port $CC_ASSIGNED_PORT",
      "port": { "strategy": "cc-assigned", "base": 3000, "range": 100 },
      "readiness": { "type": "tcp", "timeoutMs": 60000 }
    }
  ]
}
```

**Custom servers**: For other frameworks just reference `$CC_ASSIGNED_PORT` in your command and let CC manage the scan + readiness:

```json
{
  "devServers": [
    {
      "name": "api",
      "command": "node server.js --port $CC_ASSIGNED_PORT",
      "port": { "strategy": "cc-assigned", "base": 8080, "range": 50 }
    }
  ]
}
```

If you prefer to keep a shell script (e.g. you already have one that prints `CC_PORT`), omit the `port` block entirely — CC will fall back to the legacy `stdout-cc-port` strategy and read the port from stdout.

#### Legacy Helper Scripts

Older preset installs wrote `.cc/dev-servers/_helpers.sh` plus per-framework wrappers (`nextjs.sh`, `storybook.sh`) that performed the two-pass scan themselves. These remain supported via the `stdout-cc-port` strategy. The helper functions are:

- `check_port <port> <expected_cwd>` — classifies a single port (exit `0` available, `1` owned, `2` conflict)
- `find_owned_port <base> <expected_cwd>` — scans the range for an already-owned listener
- `find_available_port <base> <expected_cwd>` — scans the range for the first port with no listener at all

If you migrate an existing project to `cc-assigned`, you can delete the helper scripts; nothing else in the system depends on them.

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
      "port": { "strategy": "cc-assigned", "base": 3000, "range": 100 },
      "readiness": { "type": "tcp", "timeoutMs": 60000 }
    },
    {
      "name": "storybook",
      "command": "npx storybook dev --port $CC_ASSIGNED_PORT --no-open",
      "port": { "strategy": "cc-assigned", "base": 6006, "range": 50 }
    }
  ]
}
```
