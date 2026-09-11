#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

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

# The native TypeScript 7 compiler, installed as the `typescript-native` npm
# alias, checks this program in about 15 s cold and 2 s warm where tsc 5.9
# needs 100 s and 12 s. `typescript` itself stays on 5.x for the compiler JS
# API the architecture scanners and lint rules import. A checkout that
# predates the dependency has to run `bun install` before it can be checked.
readonly NATIVE_TSC="$PWD/node_modules/typescript-native/bin/tsc"
if [ ! -x "$NATIVE_TSC" ]; then
  echo "typecheck: $NATIVE_TSC is not installed; run \`bun install\` in this checkout" >&2
  exit 1
fi
# The two compilers' incremental formats are mutually unreadable, so the
# native state lives beside the ESLint cache instead of in tsconfig.tsbuildinfo,
# which tsc 5.9 (`bun run typecheck`) keeps for itself.
readonly NATIVE_BUILD_INFO_DIR="$PWD/node_modules/.cache/typescript-native"
mkdir -p "$NATIVE_BUILD_INFO_DIR"
run_quiet "$NATIVE_TSC" --noEmit --pretty false --tsBuildInfoFile "$NATIVE_BUILD_INFO_DIR/tsconfig.tsbuildinfo"
