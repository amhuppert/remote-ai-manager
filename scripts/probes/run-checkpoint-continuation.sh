#!/usr/bin/env bash
# Bundle and run the checkpoint continuation probe.
#
# Two steps because neither runtime does the whole job: `better-sqlite3` has no
# Bun binding, and Node cannot resolve this project's path aliases or the
# provider SDKs' ESM-only entry points from a bare `.ts` file. So Bun bundles
# for the Node target with the native and SDK packages left external, and Node
# runs the bundle.
#
# This spends real provider credit. It is deliberately not a registered
# validation command: nothing runs it but an operator typing it.
#
#   scripts/probes/run-checkpoint-continuation.sh --backend claude --scope session
set -euo pipefail

cd "$(dirname "$0")/../.."
out=".cc/temp/checkpoint-probe-bundle.mjs"
mkdir -p .cc/temp

bun build scripts/probes/checkpoint-continuation.ts \
  --target=node --format=esm --outfile="$out" \
  --external better-sqlite3 \
  --external '@openai/codex-sdk' \
  --external '@anthropic-ai/claude-agent-sdk' \
  --external '@cursor/sdk' >/dev/null

exec node "$out" "$@"
