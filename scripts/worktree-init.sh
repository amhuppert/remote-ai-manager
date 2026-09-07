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

# Vitest orders files by their cached durations (longest first) and, without a
# cache, by file size, which leaves the slowest files to finish alone at the
# end of a run. The cache's hash directory is derived from the config root's
# relative path, so the parent's file is valid here as well.
if [ -n "${PARENT_WORKTREE_PATH:-}" ]; then
  for parent_results in "${PARENT_WORKTREE_PATH}"/node_modules/.vite/vitest/*/results.json; do
    [ -f "$parent_results" ] || continue
    results_dir="$WORKTREE_PATH/node_modules/.vite/vitest/$(basename "$(dirname "$parent_results")")"
    if [ ! -f "$results_dir/results.json" ]; then
      mkdir -p "$results_dir"
      cp "$parent_results" "$results_dir/results.json"
      echo "Seeded Vitest duration cache from parent worktree"
    fi
  done
fi
