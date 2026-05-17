#!/bin/sh
# CC Dev Server — Next.js
# Installed by CC (Claude Code). Intended to be committed to the repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=3000
WORKTREE_DIR="$(pwd)"
# Pass 1: adopt an externally started server anywhere in the scan range.
# Prevents launching a duplicate when an owned server already runs on a
# later port (e.g. base port free, but our server is on BASE+4).
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
