#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/vitest-env.sh"

# The full `test` variant ignores merge-base narrowing, so a green run speaks
# for the whole branch rather than for its diff. Bail is disabled because the
# point of asking for the full suite is a complete failure list — stopping at
# the third failure would hide the rest of the branch's state.
export CC_TEST_BAIL=0

run_vitest full both
