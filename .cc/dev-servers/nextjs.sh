#!/bin/sh
# CC Dev Server — Next.js
# Installed by CC (Claude Code). Intended to be committed to the repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=3000
WORKTREE_DIR="$(pwd)"

# Helper: emit adoption markers and exit
adopt_port() {
  local port="$1"
  ADOPTED_PID=$(get_pid_on_port "$port")
  echo "CC_ADOPTED=1"
  echo "CC_ADOPTED_PID=$ADOPTED_PID"
  echo "CC_PORT=$port"
  exit 0
}

check_port "$BASE_PORT" "$WORKTREE_DIR"
case $? in
  0) PORT="$BASE_PORT" ;;
  1) adopt_port "$BASE_PORT" ;;
  2)
    PORT=$(find_available_port "$BASE_PORT" "$WORKTREE_DIR")
    if [ $? -eq 1 ]; then
      adopt_port "$PORT"
    fi
    ;;
esac

echo "CC_PORT=$PORT"
exec npx next dev --port "$PORT"
