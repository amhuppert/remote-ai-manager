#!/usr/bin/env bash
# Pre-merge validation script for CC sessions.
# Runs automatically before squash-merging a session branch into main.
# Output is AI-optimized — consumed by the merge machine and Claude auto-fix agent.
# Auto-fixes (prettier, eslint) are committed by the caller after this script completes.

set -euo pipefail

# Enable AI-optimized output for tools that detect this (e.g., vitest.config.ts)
export CLAUDECODE=1

# Prettier: auto-fix only, suppress verbose file-by-file listing
npx prettier --write . > /dev/null 2>&1
# ESLint: auto-fix, errors only, no color
npx eslint . --fix --quiet --no-color --no-warn-ignored
# TypeScript: one-line-per-error format
npx tsc --noEmit --pretty false
# Vitest: AI-optimized via CLAUDECODE detection in vitest.config.ts
npx vitest run --project unit --no-color
