#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

resolve_validation_diff

if [ -z "$merge_base" ]; then
  run_quiet npx eslint . --cache --cache-location node_modules/.cache/eslint/ --fix --quiet --no-color --no-warn-ignored
elif [ "${#lint_files[@]}" -gt 0 ]; then
  run_quiet npx eslint --cache --cache-location node_modules/.cache/eslint/ --fix --quiet --no-color --no-warn-ignored "${lint_files[@]}"
fi
