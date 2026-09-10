#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/vitest-env.sh"

resolve_validation_diff

# Architecture tests read repository paths outside Vitest's import graph and
# declare them with `// @vitest-inputs`. Vitest's `related` list is the branch
# diff plus the tests those declarations select, so a test runs when it imports
# a changed module, is itself changed, or declares a changed path as an input.
run_architecture_affected() {
  local related_paths="$CC_VALIDATION_SCRATCH_CONFIG_DIR/related-paths.txt"
  {
    if [ "${#diff_paths[@]}" -gt 0 ]; then
      printf '%s\n' "${diff_paths[@]}"
      printf '%s\n' "${diff_paths[@]}" | bun scripts/test-profiles.ts --affected
    fi
  } > "$related_paths"
  run_vitest related architecture "$related_paths"
}

if [ "$#" -gt 0 ]; then
  run_vitest paths both "$@"
elif [ -z "$merge_base" ]; then
  run_vitest full both
elif [ "$test_profile_config_changed" = true ]; then
  # Vitest does not treat its config or the profile inventory as test inputs.
  run_vitest full both
elif [ "$shared_test_setup_changed" = true ] || { [ "$node_test_setup_changed" = true ] && [ "$jsdom_test_setup_changed" = true ]; }; then
  run_vitest full integration
  run_vitest changed pure "$merge_base"
elif [ "$node_test_setup_changed" = true ]; then
  # Vitest excludes project setup files from --changed dependency traversal.
  run_vitest full node-setup
  run_vitest changed pure-dom "$merge_base"
elif [ "$jsdom_test_setup_changed" = true ]; then
  run_vitest full jsdom
  run_architecture_affected
  run_vitest changed pure-node "$merge_base"
elif [ "$architecture_test_setup_changed" = true ]; then
  # The read tracer is the gate that keeps declared inputs honest; a change to
  # it or its setup is verified against the whole cohort.
  run_vitest full architecture
  run_vitest changed runtime "$merge_base"
else
  run_architecture_affected
  run_vitest changed runtime "$merge_base"
fi
