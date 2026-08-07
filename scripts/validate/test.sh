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
elif [ "$shared_test_setup_changed" = true ] || { [ "$node_test_setup_changed" = true ] && [ "$jsdom_test_setup_changed" = true ]; }; then
  run_vitest full both
elif [ "$node_test_setup_changed" = true ]; then
  # Vitest excludes project setup files from --changed dependency traversal.
  run_vitest full node
  run_vitest changed jsdom "$merge_base"
elif [ "$jsdom_test_setup_changed" = true ]; then
  run_vitest full jsdom
  run_vitest changed node "$merge_base"
else
  run_vitest changed both "$merge_base"
fi
