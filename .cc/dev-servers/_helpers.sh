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
    # macOS — lsof is the standard tool
    pid=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null | head -1)
  else
    # Linux — try ss first (grep -oP requires GNU grep), fallback to lsof
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
    # macOS — use lsof to resolve process working directory
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-
  else
    # Linux — use /proc filesystem
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

  # No process on this port — available
  if [ -z "$pid" ]; then
    return 0
  fi

  # Process found — check if it belongs to our worktree
  local process_cwd
  process_cwd=$(get_process_cwd "$pid")

  if [ -z "$process_cwd" ]; then
    # Cannot determine cwd — treat as conflict
    return 2
  fi

  # Normalize paths (resolve symlinks)
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
