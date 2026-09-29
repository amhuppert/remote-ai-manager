#!/usr/bin/env bash
set -euo pipefail
readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/vitest-env.sh"

# No workers or tests are started: this records native related-file selection.
run_quiet env NODE_ENV=test node "$SCRIPT_DIR/test-impact.mjs" "$@"
