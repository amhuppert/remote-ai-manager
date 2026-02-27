#!/usr/bin/env bash
# Worktree initialization script for CC sessions.
# Runs automatically after a worktree is created (configured via CommandCenter.json).
# Installs dependencies so tests, linting, and pre-commit hooks work in the worktree.

set -euo pipefail

echo "Installing dependencies in worktree: $WORKTREE_PATH"
bun install
