#!/usr/bin/env bash

# Shared launch surface for the `test` and `test-full-suite` commands. Worker
# count and heap live here so the scoped and the full run cannot drift into
# different memory footprints — the two compete for the same global validation
# budget and are sized against the same machine.
#
# Callers must set SCRIPT_DIR and source common.sh first.

readonly TEST_WORKERS=8
readonly TEST_HEAP_MB=1536
export NODE_OPTIONS="--max-old-space-size=${TEST_HEAP_MB}"
export CC_TEST_WORKERS="$TEST_WORKERS"
export CC_TEST_HEAP_MB="$TEST_HEAP_MB"
export VITEST_MAX_FORKS="$TEST_WORKERS"
export VITEST_MIN_FORKS=1

run_vitest() {
  run_quiet env NODE_ENV=test node "$SCRIPT_DIR/vitest-launcher.mjs" "$@"
}
