#!/usr/bin/env bash
# Regenerates the Codex copies of this repository's Claude customizations and
# stages every unit that changed. The pre-commit hook runs it; it is also safe
# to run by hand.
#
#   .claude/skills -> .agents/skills   one directory per skill
#   .claude/agents -> .codex/agents    one TOML file per agent, when .claude/agents exists
#
# The Claude side is the source: a differing Codex unit is replaced whole, so
# edit .claude/ and never the generated copy. Codex units without a Claude
# counterpart, such as the managed .agents/skills/command-center link, are left
# untouched. Generation reads the working tree, so an unstaged edit to a Claude
# source still reaches the commit through its generated copy.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v skill-sync >/dev/null; then
  echo "error: skill-sync is not on PATH; install it from its checkout (npm run build && npm link) and commit again" >&2
  exit 1
fi

sync_units() {
  local output unit
  if ! output="$(skill-sync "$1" --override 2>&1)"; then
    printf '%s\n' "$output" >&2
    echo "error: skill-sync $1 failed; fix the Claude source named above and commit again" >&2
    exit 1
  fi
  while IFS= read -r unit; do
    git add -A -- "$unit"
    echo "skill-sync: regenerated $unit"
  done < <(printf '%s\n' "$output" | sed -n 's/^written //p')
}

sync_units skills
if [ -d .claude/agents ]; then
  sync_units agents
fi
