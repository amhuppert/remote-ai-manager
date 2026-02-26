#!/usr/bin/env bash
# Pre-merge validation script for CSM sessions.
# Runs automatically before squash-merging a session branch into main.
# Auto-fixes (prettier, eslint) are committed by the caller after this script completes.

set -euo pipefail

npx prettier --write .
npx eslint . --fix
npx tsc --noEmit --pretty
npx vitest run --project unit
