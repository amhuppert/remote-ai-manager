#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Stays full-project because a type change can break unchanged dependents.
# build:info generates the module tsc expects to find on disk.
run_quiet bun run build:info
# The project graph outgrew Node's default heap the same way `next build` did;
# give tsc the same 8GB ceiling the build command uses.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
run_quiet npx tsc --noEmit --pretty false
