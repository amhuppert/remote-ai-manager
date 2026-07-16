#!/usr/bin/env bash
# Worktree initialization script for CC sessions.
# Runs automatically after a worktree is created (configured via CommandCenter.json).
# Installs dependencies so tests, linting, and pre-commit hooks work in the worktree.

set -euo pipefail

echo "Installing dependencies in worktree: $WORKTREE_PATH"
bun install

parent_build_info="${PARENT_WORKTREE_PATH:-}/tsconfig.tsbuildinfo"
build_info="$WORKTREE_PATH/tsconfig.tsbuildinfo"
if [ -n "${PARENT_WORKTREE_PATH:-}" ] && [ -f "$parent_build_info" ] && [ ! -f "$build_info" ]; then
  cp "$parent_build_info" "$build_info"
  echo "Seeded TypeScript incremental state from parent worktree"
fi
