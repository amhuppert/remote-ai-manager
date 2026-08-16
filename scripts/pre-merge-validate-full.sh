#!/usr/bin/env bash
# Composite command for full-branch validation outside the changed-file path.

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

source "$SCRIPT_DIR/validate/common.sh"

"$SCRIPT_DIR/validate/format-full.sh"
"$SCRIPT_DIR/validate/lint-full.sh"
"$SCRIPT_DIR/validate/typecheck.sh"
"$SCRIPT_DIR/validate/seams.sh"
"$SCRIPT_DIR/validate/test-full-suite.sh"
