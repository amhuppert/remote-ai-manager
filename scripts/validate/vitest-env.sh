#!/usr/bin/env bash

# Shared launch surface for the changed and full variants of the `test`
# profile. Worker count and heap live here so the variants cannot drift into
# different memory footprints — both use the same global validation reservation
# and are sized against the same machine.
#
# TEST_WORKERS is a CEILING REQUEST and mirrors TEST_WORKERS in
# scripts/validate/worker-budget.mjs, which owns the measured count. The
# launcher clamps it to what the machine can hold rather than spawning it
# blindly, so validation cannot oversubscribe a box the vitest config would have
# sized down. It travels as CC_TEST_WORKERS, which only the launcher reads.
#
# VITEST_MAX_FORKS/VITEST_MIN_FORKS are deliberately NOT exported, and are
# unset if a caller's shell already carries them. Vitest applies those two over
# `resolved.poolOptions.forks` AFTER config resolution, so they outrank both the
# budget the launcher computes and the vitest config default — exporting the raw
# ceiling through them ran the full pool on a machine budgeted for a third of
# it. The symptom is not a failing test: the fork fleet starves the vitest main
# process until a worker's `onTaskUpdate` RPC goes unanswered, and the run dies
# on an unhandled timeout with every test passing.
#
# Callers must set SCRIPT_DIR and source common.sh first.

readonly TEST_WORKERS=4
readonly TEST_HEAP_MB=1536
readonly TEST_COORDINATOR_HEAP_MB=3072
export NODE_OPTIONS="--max-old-space-size=${TEST_COORDINATOR_HEAP_MB}"
export CC_TEST_WORKERS="$TEST_WORKERS"
export CC_TEST_HEAP_MB="$TEST_HEAP_MB"
export CC_TEST_COORDINATOR_HEAP_MB="$TEST_COORDINATOR_HEAP_MB"
unset VITEST_MAX_FORKS VITEST_MIN_FORKS

run_vitest() {
  run_quiet env NODE_ENV=test node "$SCRIPT_DIR/vitest-launcher.mjs" "$@"
}
