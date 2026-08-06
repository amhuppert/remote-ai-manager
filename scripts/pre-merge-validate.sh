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

# Isolate every child from the operator's live Command Center state.
# `next build` evaluates route modules to collect their config, and
# src/lib/state-store/index.ts opens command-center.db at module scope, so an
# un-isolated build opens the real database; src/app/tickets parses the real
# config.json the same way. Both are shared by every branch and session on the
# machine, so live state can be AHEAD of the tree under validation — a neighbour
# that applies a migration and publishes the fail-closed compatibility barrier
# would otherwise fail this gate for every other branch. Scoping CC_CONFIG_DIR
# to a per-run scratch dir makes the gate depend only on the tree it validates.
CC_SCRATCH_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cc-premerge-config.XXXXXX")"
trap 'rm -rf "$CC_SCRATCH_CONFIG_DIR"' EXIT
export CC_CONFIG_DIR="$CC_SCRATCH_CONFIG_DIR"

# Resolve where this branch diverged from its merge target so we only lint/format/
# test what it actually introduces or changes. TARGET_BRANCH is supplied by CC's
# merge workflow; default to main for standalone runs.
TARGET_BRANCH="${TARGET_BRANCH:-main}"
merge_base=""
if git rev-parse --verify --quiet "${TARGET_BRANCH}^{commit}" >/dev/null 2>&1; then
  merge_base="$(git merge-base "${TARGET_BRANCH}" HEAD 2>/dev/null || true)"
fi

if [ -n "$merge_base" ] && git diff --quiet "$merge_base" -- && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "No changes to validate."
  exit 0
fi

# build-info.generated.ts is gitignored and normally produced by postinstall/dev/build;
# a fresh validation worktree may have run none of those, so generate it before
# tsc/vitest resolve the module.
bun run build:info >/dev/null

# Files changed vs the merge base: committed + staged + unstaged tracked changes
# plus untracked files. The formatter/linter lists are existence-filtered so
# neither tool receives a path that no longer exists.
changed_files=()
lint_files=()
shared_test_setup_changed=false
node_test_setup_changed=false
jsdom_test_setup_changed=false
if [ -n "$merge_base" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      vitest.setup.ts) shared_test_setup_changed=true ;;
      vitest.node.setup.ts) node_test_setup_changed=true ;;
      vitest.jsdom.setup.ts) jsdom_test_setup_changed=true ;;
    esac
    if [ -f "$f" ]; then
      changed_files+=("$f")
      case "$f" in
        *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs) lint_files+=("$f") ;;
      esac
    fi
  done < <(
    {
      git diff --name-only "$merge_base" --
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

# Seam-adoption ratchet: always full-repo — observed counts must equal the
# committed ceilings in scripts/seam-baselines.json, so any subset scan would
# report false drift. Fails the merge if a seam count exceeds or drifts below
# its baseline without the baseline being updated.
bun run seams:check

# Production build: always full-project — a client-bundle break is cross-file and
# only the bundler surfaces it. The canonical example: a client-reachable module
# statically importing the SERVER logging barrel (@/lib/logging) drags
# node:async_hooks into the browser chunk, which typecheck/lint/jsdom tests all
# pass but Turbopack rejects ("chunking context does not support external
# modules: node:async_hooks"). The architecture-seams/no-server-logging-in-client
# lint rule now catches the common shape early; this build gate is the backstop
# for any break lint cannot statically see. Matches the plan's per-work-item
# definition of done, which lists `bun run build` among the required gates.
bun run build >/dev/null

# Vitest: AI-optimized via CLAUDECODE detection in vitest.config.ts.
# --changed runs only unit tests whose module graph includes a changed file;
# --passWithNoTests so a change touching only untested files doesn't fail the merge.
# NODE_ENV=test mirrors package.json's `test` script so React loads its
# development build (which exports `React.act`) — required by
# @testing-library/react 16 under React 19.
if [ -z "$merge_base" ]; then
  NODE_ENV=test npx vitest run --project unit-node --project unit-jsdom --no-color
elif [ "$shared_test_setup_changed" = true ] || { [ "$node_test_setup_changed" = true ] && [ "$jsdom_test_setup_changed" = true ]; }; then
  NODE_ENV=test npx vitest run --project unit-node --project unit-jsdom --no-color
elif [ "$node_test_setup_changed" = true ]; then
  # Vitest does not include project-level setupFiles in --changed's dependency
  # graph. Run the owning project in full, while preserving diff scoping for
  # the other environment.
  NODE_ENV=test npx vitest run --project unit-node --no-color
  NODE_ENV=test npx vitest run --project unit-jsdom --no-color --changed "$merge_base" --passWithNoTests
elif [ "$jsdom_test_setup_changed" = true ]; then
  NODE_ENV=test npx vitest run --project unit-jsdom --no-color
  NODE_ENV=test npx vitest run --project unit-node --no-color --changed "$merge_base" --passWithNoTests
else
  NODE_ENV=test npx vitest run --project unit-node --project unit-jsdom --no-color --changed "$merge_base" --passWithNoTests
fi
