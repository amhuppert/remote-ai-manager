# Dev Server Reference

## The CC_PORT Protocol

This is the critical contract for dev server scripts. CC discovers which port the server is running on by watching stdout for:

```
CC_PORT=<port>
```

**Rules:**
- Must appear on its own line in stdout
- Must match the exact format `CC_PORT=<digits>` (no spaces, no quotes)
- Must appear **within 60 seconds** of the process starting
- If not detected in time, CC transitions the server to `error` status and kills the process
- Print `CC_PORT` **before or at the same time as** starting the server (the typical pattern: determine port, print CC_PORT, then `exec` the server)

## Server Lifecycle

```
[Start]  →  "starting"  →  CC_PORT detected  →  "running"  →  port dies  →  "stopped"
                         →  60s timeout       →  "error"
                         →  process crashes   →  "error"
```

- Liveness polling checks the port every 5 seconds after detection
- User can stop a server at any time (SIGTERM → SIGKILL after 5s)
- Dev servers are spawned with `shell: true` (unlike init/pre-merge scripts which use `execFile`)

## Helper Script (`_helpers.sh`)

This cross-platform (macOS/Linux) script provides port detection and conflict resolution. Place at `.cc/dev-servers/_helpers.sh`:

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

# Scan from a base port upward to find the first available or owned port.
# Args: $1 = base port, $2 = expected worktree path
# Prints the port number.
# Exit codes: 0 = found available port, 1 = found owned port (adopt), 2 = no port found
find_available_port() {
  local base_port="$1"
  local expected_cwd="$2"
  local port="$base_port"
  local max_attempts=100

  while [ "$max_attempts" -gt 0 ]; do
    port=$((port + 1))
    check_port "$port" "$expected_cwd"
    case $? in
      0) echo "$port"; return 0 ;;
      1) echo "$port"; return 1 ;;
    esac
    max_attempts=$((max_attempts - 1))
  done

  echo "ERROR: Could not find an available port after scanning from $base_port" >&2
  return 2
}
```

## Preset Scripts

### Next.js (`.cc/dev-servers/nextjs.sh`)

Base port: 3000

```sh
#!/bin/sh
# CC Dev Server — Next.js
# Installed by CC (Claude Code). Intended to be committed to the repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=3000
WORKTREE_DIR="$(pwd)"

check_port "$BASE_PORT" "$WORKTREE_DIR"
case $? in
  0) PORT="$BASE_PORT" ;;
  1)
    # Server already running for this worktree — report port and exit
    echo "CC_PORT=$BASE_PORT"
    exit 0
    ;;
  2)
    PORT=$(find_available_port "$BASE_PORT" "$WORKTREE_DIR")
    if [ $? -eq 1 ]; then
      # Server already running for this worktree on a different port
      echo "CC_PORT=$PORT"
      exit 0
    fi
    ;;
esac

echo "CC_PORT=$PORT"
exec npx next dev --port "$PORT"
```

### Storybook (`.cc/dev-servers/storybook.sh`)

Base port: 6006

```sh
#!/bin/sh
# CC Dev Server — Storybook
# Installed by CC (Claude Code). Intended to be committed to the repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=6006
WORKTREE_DIR="$(pwd)"

check_port "$BASE_PORT" "$WORKTREE_DIR"
case $? in
  0) PORT="$BASE_PORT" ;;
  1)
    echo "CC_PORT=$BASE_PORT"
    exit 0
    ;;
  2)
    PORT=$(find_available_port "$BASE_PORT" "$WORKTREE_DIR")
    if [ $? -eq 1 ]; then
      echo "CC_PORT=$PORT"
      exit 0
    fi
    ;;
esac

echo "CC_PORT=$PORT"
exec npx storybook dev --port "$PORT"
```

## Subdirectory Variant (Monorepos)

For monorepos where the app lives in a subdirectory (e.g., `apps/web/`), use this pattern. Replace `apps/web` with the actual subdirectory:

```sh
#!/bin/sh
# CC Dev Server — Next.js (subdir: apps/web/)
# Installed by CC (Claude Code). Intended to be committed to the repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=3000
WORKTREE_DIR="$(pwd)"
APP_DIR="$WORKTREE_DIR/apps/web"

# Verify the subdirectory exists
if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: apps/web/ directory not found at $APP_DIR" >&2
  exit 1
fi

check_port "$BASE_PORT" "$APP_DIR"
case $? in
  0) PORT="$BASE_PORT" ;;
  1)
    echo "CC_PORT=$BASE_PORT"
    exit 0
    ;;
  2)
    PORT=$(find_available_port "$BASE_PORT" "$APP_DIR")
    if [ $? -eq 1 ]; then
      echo "CC_PORT=$PORT"
      exit 0
    fi
    ;;
esac

echo "CC_PORT=$PORT"
cd "$APP_DIR" && exec npx next dev --port "$PORT"
```

## Custom Server Template

For non-preset servers, use this minimal template:

```sh
#!/bin/sh
PORT=8080
echo "CC_PORT=$PORT"
exec node server.js --port "$PORT"
```

The only strict requirement is printing `CC_PORT=<port>` to stdout within 60 seconds.
