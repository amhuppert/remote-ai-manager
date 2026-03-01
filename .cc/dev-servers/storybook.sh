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
exec npx storybook dev --port "$PORT"
