#!/bin/sh
# CSM Dev Server — Storybook
# Installed by CSM (Claude Session Manager). Intended to be committed to the repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=6006
WORKTREE_DIR="$(pwd)"

check_port "$BASE_PORT" "$WORKTREE_DIR"
case $? in
  0) PORT="$BASE_PORT" ;;
  1) echo "CSM_PORT=$BASE_PORT"; exit 0 ;;
  2) PORT=$(find_available_port "$BASE_PORT" "$WORKTREE_DIR") ;;
esac

echo "CSM_PORT=$PORT"
exec npx storybook dev --port "$PORT"
