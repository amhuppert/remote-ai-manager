#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# These checks stay full-project because changes can break unchanged dependents,
# seam counts, or the production client bundle.
run_quiet bun run build:info
run_quiet npx tsc --noEmit --pretty false
run_quiet bun run seams:check
run_quiet bun run build
