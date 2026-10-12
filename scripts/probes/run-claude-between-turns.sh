#!/usr/bin/env bash
# Bundle and run the C5b probes (see claude-between-turns.ts). Bun bundles for
# Node with the SDK left external; Node runs the bundle.
#
# This spends real provider credit. It is deliberately not a registered
# validation command: nothing runs it but an operator typing it.
#
#   scripts/probes/run-claude-between-turns.sh [--model haiku] [--scenario continuation]
set -euo pipefail

cd "$(dirname "$0")/../.."
out=".cc/temp/claude-between-turns-bundle.mjs"
mkdir -p .cc/temp

bun build scripts/probes/claude-between-turns.ts \
  --target=node --format=esm --outfile="$out" \
  --external '@anthropic-ai/claude-agent-sdk' >/dev/null

exec node "$out" "$@"
