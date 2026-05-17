# Dev Server Reference

CC supports two configuration styles for dev servers. Prefer the first.

## Strategy 1 — `cc-assigned` (recommended)

CC itself runs the port scan over the configured range, picks an owned-or-free port, injects it into the child process via `CC_ASSIGNED_PORT`, `PORT`, and any user-defined alias, and waits for TCP readiness on that port. **No shell helper scripts required.**

### `CommandCenter.json` entries

```json
{
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

| Field | Default | Notes |
|---|---|---|
| `port.strategy` | `"cc-assigned"` when `port` block is present | The other value is `"stdout-cc-port"` (legacy). |
| `port.base` | required | First port in the scan window. |
| `port.range` | `100` | Number of ports to scan upward from `base`. |
| `port.env` | none | Optional extra env var name to set to the assigned port. |
| `readiness.type` | `"tcp"` for `cc-assigned` | Other value is `"stdout-cc-port"`. |
| `readiness.timeoutMs` | `60000` | Hard timeout before transitioning to `error`. |
| `cwd` | the worktree root | Optional subdirectory (e.g. `apps/web`). |

### Subdirectory variant (monorepos)

Set `cwd` to the subdirectory relative to the worktree. CC will spawn the command there and verify port ownership against that working directory.

```json
{
  "devServers": [
    {
      "name": "nextjs",
      "command": "npx next dev --port $CC_ASSIGNED_PORT",
      "cwd": "apps/web",
      "port": { "strategy": "cc-assigned", "base": 3000, "range": 100 }
    }
  ]
}
```

### Custom servers

Any framework that accepts a port flag works the same way — just reference `$CC_ASSIGNED_PORT` in the command:

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

If your framework only reads `PORT`, you can omit the flag — CC always exports `PORT=$CC_ASSIGNED_PORT` too:

```json
{
  "command": "node server.js",
  "port": { "strategy": "cc-assigned", "base": 8080, "range": 50 }
}
```

### Server Lifecycle (cc-assigned)

```
[Start]
  → CC scans [base, base+range) and picks an owned-or-free port
  → "starting" — env injected (CC_ASSIGNED_PORT, PORT, alias), command spawned in cwd
  → CC polls TCP loopback on the assigned port
  → port accepting connections within readiness.timeoutMs → "running"
  → timeout → "error" (process killed, last 10 output lines surfaced)
  → liveness check loses the port → "stopped"
```

---

## Strategy 2 — `stdout-cc-port` (legacy)

Older preset installs ship shell scripts under `.cc/dev-servers/` that perform the port scan themselves and announce the chosen port via stdout. CC continues to support this for projects that already use it.

### The `CC_PORT` Protocol

CC discovers the port by watching stdout for:

```
CC_PORT=<port>
```

**Rules:**
- Must appear on its own line in stdout
- Must match the exact format `CC_PORT=<digits>` (no spaces, no quotes)
- Must appear **within 60 seconds** of the process starting
- If not detected in time, CC transitions the server to `error` status and kills the process
- Print `CC_PORT` **before or at the same time as** starting the server (the typical pattern: determine port, print CC_PORT, then `exec` the server)

### `CommandCenter.json` entry (legacy)

```json
{
  "devServers": [
    { "name": "nextjs", "command": ".cc/dev-servers/nextjs.sh" }
  ]
}
```

Omitting the `port` block opts in to the legacy strategy.

### Helper Script (`_helpers.sh`)

Cross-platform (macOS/Linux) port detection and conflict resolution. Place at `.cc/dev-servers/_helpers.sh`:

```sh
#!/bin/sh
# CC Dev Server Helpers — shared port detection and worktree ownership functions
# Installed by CC (Claude Code). Intended to be committed to the repo.

# Detect platform: "Darwin" = macOS, "Linux" = Linux
CC_OS="$(uname -s)"

# Get the PID listening on a TCP port. Prints PID or empty string.
# Args: $1 = port
get_pid_on_port() {
  local port="$1"
  local pid=""

  if [ "$CC_OS" = "Darwin" ]; then
    pid=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null | head -1)
  else
    if command -v ss >/dev/null 2>&1; then
      pid=$(ss -tlnp sport = :"$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    fi
    if [ -z "$pid" ] && command -v lsof >/dev/null 2>&1; then
      pid=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null | head -1)
    fi
  fi

  echo "$pid"
}

# Resolve the working directory of a process.
# Args: $1 = pid
get_process_cwd() {
  local pid="$1"

  if [ "$CC_OS" = "Darwin" ]; then
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-
  else
    if [ -d "/proc/$pid" ]; then
      readlink "/proc/$pid/cwd" 2>/dev/null
    fi
  fi
}

# Check if a port is available, owned by this worktree, or in conflict.
# Args: $1 = port, $2 = expected worktree path
# Exit codes: 0 = available, 1 = owned (same worktree), 2 = conflict
check_port() {
  local port="$1"
  local expected_cwd="$2"

  local pid
  pid=$(get_pid_on_port "$port")

  if [ -z "$pid" ]; then
    return 0
  fi

  local process_cwd
  process_cwd=$(get_process_cwd "$pid")

  if [ -z "$process_cwd" ]; then
    return 2
  fi

  local norm_expected norm_actual
  norm_expected=$(cd "$expected_cwd" 2>/dev/null && pwd -P)
  norm_actual=$(cd "$process_cwd" 2>/dev/null && pwd -P)

  if [ "$norm_expected" = "$norm_actual" ]; then
    return 1
  fi

  return 2
}

# Scan the configured range (base port inclusive, then upward) for a port
# already owned by this worktree. Lets us adopt an externally started dev
# server before starting a duplicate on a different free port.
# Args: $1 = base port, $2 = expected worktree path
# Prints the owned port number on success.
# Exit codes: 0 = found owned port, 1 = no owned port in range
find_owned_port() {
  local base_port="$1"
  local expected_cwd="$2"
  local port="$base_port"
  local attempts=100

  while [ "$attempts" -gt 0 ]; do
    check_port "$port" "$expected_cwd"
    if [ $? -eq 1 ]; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
    attempts=$((attempts - 1))
  done

  return 1
}

# Scan from the base port (inclusive) upward for the first truly free port.
# Owned and conflicting ports are both skipped — adoption is handled
# separately by find_owned_port so callers should run that first.
# Args: $1 = base port, $2 = expected worktree path
# Prints the available port number on success.
# Exit codes: 0 = found available port, 2 = no available port in range
find_available_port() {
  local base_port="$1"
  local expected_cwd="$2"
  local port="$base_port"
  local attempts=100

  while [ "$attempts" -gt 0 ]; do
    check_port "$port" "$expected_cwd"
    if [ $? -eq 0 ]; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
    attempts=$((attempts - 1))
  done

  echo "ERROR: Could not find an available port after scanning from $base_port" >&2
  return 2
}
```

### Preset Scripts (legacy)

#### Next.js (`.cc/dev-servers/nextjs.sh`)

Base port: 3000

```sh
#!/bin/sh
# CC Dev Server — Next.js
# Installed by CC (Claude Code). Intended to be committed to the repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=3000
WORKTREE_DIR="$(pwd)"

# Pass 1: adopt an externally started server anywhere in the scan range.
ADOPT_PORT=$(find_owned_port "$BASE_PORT" "$WORKTREE_DIR")
if [ $? -eq 0 ]; then
  echo "CC_PORT=$ADOPT_PORT"
  exit 0
fi

# Pass 2: no owned server — pick the lowest available port and start one.
PORT=$(find_available_port "$BASE_PORT" "$WORKTREE_DIR")
if [ $? -ne 0 ]; then
  echo "ERROR: no available port for Next.js starting at $BASE_PORT" >&2
  exit 1
fi

echo "CC_PORT=$PORT"
rm -f ".next/dev/lock"
exec npx next dev --port "$PORT"
```

#### Storybook (`.cc/dev-servers/storybook.sh`)

Base port: 6006

```sh
#!/bin/sh
# CC Dev Server — Storybook
# Installed by CC (Claude Code). Intended to be committed to the repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=6006
WORKTREE_DIR="$(pwd)"

# Pass 1: adopt an externally started server anywhere in the scan range.
ADOPT_PORT=$(find_owned_port "$BASE_PORT" "$WORKTREE_DIR")
if [ $? -eq 0 ]; then
  echo "CC_PORT=$ADOPT_PORT"
  exit 0
fi

# Pass 2: no owned server — pick the lowest available port and start one.
PORT=$(find_available_port "$BASE_PORT" "$WORKTREE_DIR")
if [ $? -ne 0 ]; then
  echo "ERROR: no available port for Storybook starting at $BASE_PORT" >&2
  exit 1
fi

echo "CC_PORT=$PORT"
exec npx storybook dev --port "$PORT"
```

#### Subdirectory variant (legacy monorepo)

```sh
#!/bin/sh
# CC Dev Server — Next.js (subdir: apps/web/)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=3000
WORKTREE_DIR="$(pwd)"
APP_DIR="$WORKTREE_DIR/apps/web"

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: apps/web/ directory not found at $APP_DIR" >&2
  exit 1
fi

ADOPT_PORT=$(find_owned_port "$BASE_PORT" "$APP_DIR")
if [ $? -eq 0 ]; then
  echo "CC_PORT=$ADOPT_PORT"
  exit 0
fi

PORT=$(find_available_port "$BASE_PORT" "$APP_DIR")
if [ $? -ne 0 ]; then
  echo "ERROR: no available port for Next.js starting at $BASE_PORT" >&2
  exit 1
fi

echo "CC_PORT=$PORT"
cd "$APP_DIR" && rm -f ".next/dev/lock"
exec npx next dev --port "$PORT"
```

### Custom Server Template (legacy)

For non-preset servers under the legacy strategy:

```sh
#!/bin/sh
PORT=8080
echo "CC_PORT=$PORT"
exec node server.js --port "$PORT"
```

The only strict requirement is printing `CC_PORT=<port>` to stdout within 60 seconds.

---

## Choosing Between Strategies

| Situation | Recommended |
|---|---|
| New project | `cc-assigned` — simpler config, no helper scripts |
| Existing project with working `.cc/dev-servers/*.sh` | Keep `stdout-cc-port` (no migration required) |
| Need custom startup logic (database checks, prebuild, etc.) | `stdout-cc-port` so the shell script can run that logic |
| Framework auto-picks its port (cannot accept a port flag) | `stdout-cc-port` — let the framework choose and print `CC_PORT` |
