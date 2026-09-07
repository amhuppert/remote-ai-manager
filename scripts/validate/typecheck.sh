#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# The full-project type graph exceeds Node's default heap. The wrapper owns the
# limit so registered validation does not depend on the invoking environment.
readonly TYPECHECK_HEAP_MB=8192
export NODE_OPTIONS="--max-old-space-size=${TYPECHECK_HEAP_MB}"

# Stays full-project because a type change can break unchanged dependents.
# build:info generates the module tsc expects to find on disk. It is generated
# only when absent: every generation stamps a fresh buildTime into the module,
# which invalidates it and its dependents in the incremental state on every
# check. A diagnostic typecheck does not need a new build identity; the
# production build script keeps generating one.
# Resolved against the checkout under validation ($PWD), not this script's
# location: the validation service runs the registered checkout's wrappers
# with the session worktree as the working directory.
readonly BUILD_INFO_MODULE="$PWD/src/lib/build-info/build-info.generated.ts"
if [ ! -f "$BUILD_INFO_MODULE" ]; then
  run_quiet bun run build:info
fi
# The project graph outgrew Node's default heap the same way `next build` did;
# give tsc the same 8GB ceiling the build command uses.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
run_quiet npx tsc --noEmit --pretty false
