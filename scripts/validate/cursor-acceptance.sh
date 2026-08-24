#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# The gate runs FIRST, before anything destructive or expensive. A blocked run
# must not clear the previous run's evidence or rebuild the worker: it produced
# nothing, so it has no business replacing what a credentialed run left behind.
node "$SCRIPT_DIR/cursor-acceptance-launcher.mjs" --gate-only

# Everything this suite writes is private evidence: raw native envelopes,
# transcripts, worker logs, and captured process tables. It is created
# owner-only, before anything can write into it, under the git-ignored `.cc/`
# tree so a raw fixture can never reach a commit.
umask 077
readonly REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly ACCEPTANCE_ROOT="$REPO_ROOT/.cc/temp/cursor-acceptance"
# Cleared per run, deliberately: published records, raw fixtures, worker logs
# and workspaces all describe ONE live matrix, and an appended-to tree would let
# a case that no longer runs keep supplying evidence for the current verdict.
rm -rf "$ACCEPTANCE_ROOT"
mkdir -p "$ACCEPTANCE_ROOT/config"
chmod 700 "$ACCEPTANCE_ROOT" "$ACCEPTANCE_ROOT/config"
export CC_CURSOR_ACCEPTANCE_ROOT="$ACCEPTANCE_ROOT"

# The suite reads its own logs back to scan them for credential material, so it
# needs a config dir that survives the run rather than common.sh's scratch dir,
# which is removed on exit.
export CC_CONFIG_DIR="$ACCEPTANCE_ROOT/config"

# The vitest setup nests each fork's CC_CONFIG_DIR in a scratch directory it
# deletes when the test file ends, which would reap every worker log before the
# final sweep walks the tree. A single log file inside the evidence root keeps
# the whole logging surface durable — and scanned.
export CC_LOG_FILE="$ACCEPTANCE_ROOT/logs/acceptance.log"

export NODE_OPTIONS="--max-old-space-size=3072"

# The suite spawns the real worker bundle, so it must be the bundle this tree
# produces. A stale artifact would let the matrix report live evidence for code
# that is not the code under review.
run_quiet bun run build:worker

# Not run through `run_quiet`: the verdict line is the point of this command and
# must be visible on a pass as well as on a refusal.
env NODE_ENV=test node "$SCRIPT_DIR/cursor-acceptance-launcher.mjs"
