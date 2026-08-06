#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

resolve_validation_diff

if [ -z "$merge_base" ]; then
  run_quiet npx prettier --write --no-color .
elif [ "${#changed_files[@]}" -gt 0 ]; then
  run_quiet npx prettier --write --ignore-unknown --no-color "${changed_files[@]}"
fi
