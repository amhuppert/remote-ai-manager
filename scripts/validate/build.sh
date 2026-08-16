#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Full production build: build:info + next build + cctl bundle. The client
# bundle can break on changes tsc accepts, so run this at checkpoints and
# before merge readiness even when typecheck is green.
run_quiet bun run build
