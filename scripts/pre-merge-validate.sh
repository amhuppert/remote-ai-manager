#!/usr/bin/env bash
# Composite command for stored workflow definitions that select "pre-merge".
# Smart Merge and Smart Commit select the same phases from validation.preMerge.

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Establishes the run's single scratch CC_CONFIG_DIR before any phase starts.
# Each phase sources the same file and inherits this one, so the whole composite
# shares one isolated config dir that is removed when this script exits.
source "$SCRIPT_DIR/validate/common.sh"

"$SCRIPT_DIR/validate/format.sh"
"$SCRIPT_DIR/validate/lint.sh"
"$SCRIPT_DIR/validate/typecheck.sh"
"$SCRIPT_DIR/validate/seams.sh"
"$SCRIPT_DIR/validate/test.sh"
