#!/usr/bin/env bash
#
# resign-codex.sh — Work around Apple revoking OpenAI's Developer ID cert.
#
# macOS Gatekeeper rejects the @openai/codex native binary with
# CSSMERR_TP_CERT_REVOKED and moves it to Trash ("codex ... contains malware"),
# which breaks Command Center's run_codex path (the codex-sdk spawns this same
# binary). The binary is genuinely OpenAI-signed — Apple revoked the signing
# cert, so it's a false-positive-in-spirit, not an infection.
#
# This strips the revoked signature and ad-hoc re-signs the binary, so a local,
# unquarantined spawn runs again. After re-signing, `spctl -a` still reports
# "rejected" (unnotarized) — that's expected and harmless; the malware/trash
# verdict is gone.
#
# Runs automatically as an npm/bun `postinstall` hook (with --no-reinstall), and
# can be run by hand after any install. The script is idempotent, so re-running
# is always safe.
#
# Usage: scripts/resign-codex.sh [--no-reinstall] [project-dir]
#   --no-reinstall  Skip restoring a missing binary via `bun/npm install`.
#                   Used by the postinstall hook to avoid recursive installs.
#   project-dir     Project root to operate on (default: current directory).

set -euo pipefail

# Silent no-op off macOS so Linux/CI installs aren't spammed by the hook.
if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

REINSTALL=1
PROJECT_DIR=""
for arg in "$@"; do
  case "$arg" in
    --no-reinstall) REINSTALL=0 ;;
    *) PROJECT_DIR="$arg" ;;
  esac
done
cd "${PROJECT_DIR:-$(pwd)}"

case "$(uname -m)" in
  arm64 | aarch64) TRIPLE="aarch64-apple-darwin"; PKG="codex-darwin-arm64" ;;
  x86_64)          TRIPLE="x86_64-apple-darwin";  PKG="codex-darwin-x64" ;;
  *) echo "resign-codex: unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

BIN="node_modules/@openai/${PKG}/vendor/${TRIPLE}/codex/codex"

if [[ ! -f "$BIN" && "$REINSTALL" -eq 1 ]]; then
  echo "resign-codex: codex binary missing (likely trashed by Gatekeeper) — reinstalling…" >&2
  if command -v bun >/dev/null 2>&1 && [[ -f bun.lock || -f bun.lockb ]]; then
    bun install
  else
    npm install
  fi
fi

if [[ ! -f "$BIN" ]]; then
  echo "resign-codex: could not locate the codex binary at: $(pwd)/$BIN" >&2
  echo "resign-codex: is @openai/codex-sdk installed here? Run from the project root." >&2
  exit 1
fi

echo "resign-codex: target → $(pwd)/$BIN"

# Strip provenance/quarantine, drop the revoked signature, then ad-hoc re-sign.
xattr -c "$BIN" || true
codesign --remove-signature "$BIN" 2>/dev/null || true
codesign --force --sign - "$BIN"

DESC="$(codesign -dv "$BIN" 2>&1 || true)"
if grep -qi "Signature=adhoc" <<<"$DESC"; then
  echo "resign-codex: done — binary is now ad-hoc signed and will run under Gatekeeper."
else
  echo "resign-codex: WARNING — expected an ad-hoc signature but codesign reports otherwise:" >&2
  sed 's/^/  /' <<<"$DESC" >&2
  exit 1
fi
