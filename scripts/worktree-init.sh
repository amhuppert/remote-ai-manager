#!/usr/bin/env bash
# Worktree initialization script for CSM sessions.
# Runs automatically after a worktree is created (configured via ClaudeSessionManager.json).
# Installs dependencies so tests, linting, and pre-commit hooks work in the worktree.

set -euo pipefail

echo "Installing dependencies in worktree: $WORKTREE_PATH"
bun install
