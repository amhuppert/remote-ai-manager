#!/usr/bin/env bash
# Pre-merge validation script for CC sessions.
# Runs automatically before squash-merging a session branch into main.
# Output is AI-optimized — consumed by the merge machine and Claude auto-fix agent.
# Auto-fixes (prettier, eslint) are committed by the caller after this script completes.
#
# Prettier, ESLint, and the Vitest run are scoped to the files this branch changes
# relative to its merge target. tsc stays full-project: a changed file can break
# type-checking in an unchanged dependent (renamed export, changed signature), so
# scoping it would let breakage merge into main.

set -euo pipefail

# Enable AI-optimized output for tools that detect this (e.g., vitest.config.ts)
export CLAUDECODE=1

# build-info.generated.ts is gitignored and normally produced by postinstall/dev/build;
# a fresh validation worktree may have run none of those, so generate it before
# tsc/vitest resolve the module.
bun run build:info >/dev/null

# Resolve where this branch diverged from its merge target so we only lint/format/
# test what it actually introduces or changes. TARGET_BRANCH is supplied by CC's
# merge workflow; default to main for standalone runs.
TARGET_BRANCH="${TARGET_BRANCH:-main}"
merge_base=""
if git rev-parse --verify --quiet "${TARGET_BRANCH}^{commit}" >/dev/null 2>&1; then
  merge_base="$(git merge-base "${TARGET_BRANCH}" HEAD 2>/dev/null || true)"
fi

# Files changed vs the merge base: committed + staged + unstaged tracked changes
# (ACMR drops deletions; renames resolve to the new path) plus untracked files.
# Existence-filtered so prettier/eslint never receive a path that no longer exists.
changed_files=()
lint_files=()
if [ -n "$merge_base" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    changed_files+=("$f")
    case "$f" in
      *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs) lint_files+=("$f") ;;
    esac
  done < <(
    {
      git diff --name-only --diff-filter=ACMR "$merge_base" --
      git ls-files --others --exclude-standard
    } | sort -u
  )
else
  # Detached HEAD, missing target, or shallow clone: fall back to validating the
  # whole tree rather than silently skipping checks.
  echo "pre-merge: no merge base against '${TARGET_BRANCH}'; validating entire tree" >&2
fi

# Prettier: auto-fix only, suppress verbose file-by-file listing.
# --ignore-unknown skips changed files Prettier has no parser for.
if [ -z "$merge_base" ]; then
  npx prettier --write . >/dev/null 2>&1
elif [ "${#changed_files[@]}" -gt 0 ]; then
  npx prettier --write --ignore-unknown "${changed_files[@]}" >/dev/null 2>&1
fi

# ESLint: auto-fix, errors only, no color, scoped to changed JS/TS files.
if [ -z "$merge_base" ]; then
  npx eslint . --fix --quiet --no-color --no-warn-ignored
elif [ "${#lint_files[@]}" -gt 0 ]; then
  npx eslint --fix --quiet --no-color --no-warn-ignored "${lint_files[@]}"
fi

# TypeScript: always full-project — scoping is unsafe (see header).
npx tsc --noEmit --pretty false

# Vitest: AI-optimized via CLAUDECODE detection in vitest.config.ts.
# --changed runs only unit tests whose module graph includes a changed file;
# --passWithNoTests so a change touching only untested files doesn't fail the merge.
# NODE_ENV=test mirrors package.json's `test` script so React loads its
# development build (which exports `React.act`) — required by
# @testing-library/react 16 under React 19.
if [ -z "$merge_base" ]; then
  NODE_ENV=test npx vitest run --project unit --no-color
else
  NODE_ENV=test npx vitest run --project unit --no-color --changed "$merge_base" --passWithNoTests
fi
