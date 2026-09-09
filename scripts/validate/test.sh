#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/vitest-env.sh"

resolve_validation_diff

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
  run_vitest full architecture
  run_vitest changed pure-node "$merge_base"
else
  # Architecture tests read source and configuration by path, outside Vitest's
  # import graph. Until those inputs are declared, full selection is the only
  # sound changed-scope behavior for this profile.
  run_vitest full architecture
  run_vitest changed runtime "$merge_base"
fi
