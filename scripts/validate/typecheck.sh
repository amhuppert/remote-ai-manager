#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Stays full-project because a type change can break unchanged dependents.
# build:info generates the module tsc expects to find on disk.
run_quiet bun run build:info
run_quiet npx tsc --noEmit --pretty false
