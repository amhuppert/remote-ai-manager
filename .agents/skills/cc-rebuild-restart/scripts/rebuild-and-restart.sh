#!/usr/bin/env bash
#
# Rebuild Command Center in the MAIN worktree, then schedule a detached server restart.
#
#   1. bun install            (in the main worktree)
#   2. bun run build
#   3. on build success only:  launch a fully-detached daemon that kills the running
#      main-worktree server and restarts it.
#
# The restarter MUST outlive the server it kills. The Claude session that triggers this
# skill runs as a child of that same server, so a restarter living in the session's
# process tree would die with the server. We detach it into its own session (reparented
# to launchd) via `bun -e ... spawn({ detached: true }).unref()` — the macOS-safe
# stand-in for `setsid`, which macOS does not ship.
#
# Env overrides (all optional):
#   CC_PORT               force the server port (default: detected, else 3000)
#   CC_RESTART_DELAY_MS   grace period before the kill (default: 5000)
#   CC_RESTART_DRY_RUN=1  preview the kill/restart plan without touching anything
#   CC_RESTART_LOG        daemon log path (default: /tmp/command-center-restart.log)
#   CC_SERVER_LOG         restarted-server log path (default: /tmp/command-center-server.log)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ]; then
  echo "[rebuild-restart] ERROR: bun not found on PATH" >&2
  exit 1
fi

# Resolve the MAIN worktree root (the shared .git lives there) — never the session worktree.
GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(dirname "$GIT_COMMON_DIR")"

# Detect the port the main server currently listens on (cwd === main root); fall back to 3000.
detect_port() {
  local pid cwd port
  while read -r pid; do
    [ -n "$pid" ] || continue
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    [ "$cwd" = "$MAIN_ROOT" ] || continue
    port="$(lsof -a -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -1)"
    if [ -n "$port" ]; then
      echo "$port"
      return 0
    fi
  done < <(ps -eo pid=,command= | awk '/next-server/{print $1}')
  return 1
}

PORT="${CC_PORT:-$(detect_port || echo 3000)}"
RESTART_DELAY_MS="${CC_RESTART_DELAY_MS:-5000}"
RESTART_LOG="${CC_RESTART_LOG:-/tmp/command-center-restart.log}"
SERVER_LOG="${CC_SERVER_LOG:-/tmp/command-center-server.log}"

echo "[rebuild-restart] main worktree: $MAIN_ROOT"
echo "[rebuild-restart] target port:   $PORT"

cd "$MAIN_ROOT"

echo "[rebuild-restart] bun install ..."
if ! "$BUN_BIN" install; then
  echo "[rebuild-restart] ERROR: bun install failed — server NOT restarted." >&2
  exit 1
fi

echo "[rebuild-restart] bun run build ..."
if ! "$BUN_BIN" run build; then
  echo "[rebuild-restart] ERROR: build failed — server NOT restarted." >&2
  exit 1
fi
echo "[rebuild-restart] build OK."

# Launch the detached restart daemon. The `bun -e` launcher returns immediately; the
# spawned daemon runs in its own session and outlives this whole process tree (including
# the server it is about to kill).
CC_MAIN_ROOT="$MAIN_ROOT" \
CC_PORT="$PORT" \
CC_BUN_BIN="$BUN_BIN" \
CC_RESTART_DELAY_MS="$RESTART_DELAY_MS" \
CC_RESTART_SCRIPT="$SCRIPT_DIR/restart-server.ts" \
CC_RESTART_LOG="$RESTART_LOG" \
CC_SERVER_LOG="$SERVER_LOG" \
CC_RESTART_DRY_RUN="${CC_RESTART_DRY_RUN:-0}" \
"$BUN_BIN" -e '
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const log = fs.openSync(process.env.CC_RESTART_LOG, "a");
const child = spawn(process.env.CC_BUN_BIN, [process.env.CC_RESTART_SCRIPT], {
  detached: true,
  stdio: ["ignore", log, log],
  cwd: process.env.CC_MAIN_ROOT,
  env: process.env,
});
child.unref();
'

if [ "${CC_RESTART_DRY_RUN:-0}" = "1" ]; then
  echo "[rebuild-restart] DRY RUN: restart plan written to $RESTART_LOG (nothing killed/restarted)."
else
  echo "[rebuild-restart] restart scheduled in ${RESTART_DELAY_MS}ms (detached daemon)."
  echo "[rebuild-restart] the running server will be killed and restarted shortly;"
  echo "[rebuild-restart] this session's UI may briefly disconnect, then reconnect."
fi
echo "[rebuild-restart] daemon log: $RESTART_LOG"
echo "[rebuild-restart] server log: $SERVER_LOG"
