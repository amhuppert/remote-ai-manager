#!/usr/bin/env bash

export CLAUDECODE=1
export FORCE_COLOR=0
export NO_COLOR=1

# Isolate every child from the operator's live Command Center state.
# `next build` evaluates route modules to collect their config, and
# src/lib/state-store/index.ts opens command-center.db at module scope, so an
# un-isolated build opens the real database; src/app/tickets parses the real
# config.json the same way. Both are shared by every branch and session on the
# machine, so live state can be AHEAD of the tree under validation — a neighbour
# that applies a migration and publishes the fail-closed compatibility barrier
# would otherwise fail this gate for every other branch. Scoping CC_CONFIG_DIR
# to a per-run scratch dir makes the gate depend only on the tree it validates.
#
# This lives here rather than in the pre-merge composite because each phase is
# a separately registered validation command: `cctl validate run typecheck`
# runs the build without the composite ever executing. The marker variable —
# not CC_CONFIG_DIR itself — gates the setup, so an operator environment that
# already points CC_CONFIG_DIR at live state is still overridden, while phases
# spawned by an outer validate script reuse (and do not delete) its scratch dir.
if [ -z "${CC_VALIDATION_SCRATCH_CONFIG_DIR:-}" ]; then
  CC_VALIDATION_SCRATCH_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cc-validation-config.XXXXXX")"
  export CC_VALIDATION_SCRATCH_CONFIG_DIR
  export CC_CONFIG_DIR="$CC_VALIDATION_SCRATCH_CONFIG_DIR"
  trap 'rm -rf "$CC_VALIDATION_SCRATCH_CONFIG_DIR"' EXIT
fi

run_quiet() {
  local output_file status
  output_file="$(mktemp -t cc-validation.XXXXXX)"
  if "$@" >"$output_file" 2>&1; then
    rm -f "$output_file"
    return 0
  else
    status=$?
  fi
  sed -n '1,$p' "$output_file" >&2
  rm -f "$output_file"
  return "$status"
}

resolve_validation_diff() {
  TARGET_BRANCH="${TARGET_BRANCH:-main}"
  merge_base=""
  if git rev-parse --verify --quiet "${TARGET_BRANCH}^{commit}" >/dev/null 2>&1; then
    merge_base="$(git merge-base "$TARGET_BRANCH" HEAD 2>/dev/null || true)"
  fi

  changed_files=()
  lint_files=()
  shared_test_setup_changed=false
  node_test_setup_changed=false
  jsdom_test_setup_changed=false

  if [ -z "$merge_base" ]; then
    echo "validation: no merge base against '${TARGET_BRANCH}'; validating the full safe scope" >&2
    return 0
  fi

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    case "$file" in
      vitest.setup.ts) shared_test_setup_changed=true ;;
      vitest.node.setup.ts) node_test_setup_changed=true ;;
      vitest.jsdom.setup.ts) jsdom_test_setup_changed=true ;;
    esac
    [ -f "$file" ] || continue
    changed_files+=("$file")
    case "$file" in
      *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs) lint_files+=("$file") ;;
    esac
  done < <(
    {
      git diff --name-only --diff-filter=ACMR "$merge_base" --
      git diff --name-only --diff-filter=ACMR --cached --
      git diff --name-only --diff-filter=ACMR --
      git ls-files --others --exclude-standard
    } | sort -u
  )
}
