#!/usr/bin/env bash
# Parity spike: `git merge-tree --write-tree` (plumbing) vs
# `git merge --squash` (porcelain) across scenarios the CC
# smart-merge redesign relies on.
#
# For each scenario:
#   - build a fresh repo with `main` + `feature` branches
#   - run both merge paths
#   - record: outcome class (clean|conflict), resulting tree OID
#     (clean only), conflicted file set (conflict only)
#   - PASS iff both paths agree on outcome class, AND tree OIDs
#     match when clean, AND conflict file sets match when conflict
#
# Exit 0 iff every scenario passes.

set -uo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export GIT_AUTHOR_NAME=spike
export GIT_AUTHOR_EMAIL=spike@local
export GIT_COMMITTER_NAME=spike
export GIT_COMMITTER_EMAIL=spike@local
export GIT_CONFIG_NOSYSTEM=1

PASS=0
FAIL=0
declare -a RESULTS

run_scenario() {
  local name="$1" setup="$2"
  local dir="$WORK/$name"
  mkdir -p "$dir"
  cd "$dir"

  git init -q -b main
  git config commit.gpgsign false

  # scenario setup creates `main` and `feature` branches diverged from a base
  eval "$setup"
  git checkout -q main

  # --- Porcelain path: `git merge --squash` in the worktree
  local porcelain_exit porcelain_tree porcelain_conflicts
  git merge --squash feature >/dev/null 2>&1
  porcelain_exit=$?
  if [[ $porcelain_exit -eq 0 ]]; then
    porcelain_tree="$(git write-tree 2>/dev/null || echo WRITE-TREE-FAILED)"
    porcelain_conflicts=""
  else
    porcelain_tree="(unmerged)"
    porcelain_conflicts="$(git diff --name-only --diff-filter=U 2>/dev/null | sort -u | paste -sd, -)"
  fi
  git reset -q --hard HEAD >/dev/null 2>&1

  # --- Plumbing path: `git merge-tree --write-tree main feature`
  local plumbing_exit plumbing_out plumbing_tree plumbing_conflicts
  plumbing_out="$(git merge-tree --write-tree main feature 2>&1)"
  plumbing_exit=$?
  plumbing_tree="$(printf '%s\n' "$plumbing_out" | head -n1)"
  if [[ $plumbing_exit -eq 0 ]]; then
    plumbing_conflicts=""
  else
    # Conflict info lines look like: `<mode> <oid> <stage>\t<path>`
    plumbing_conflicts="$(printf '%s\n' "$plumbing_out" | awk -F'\t' '
      NF >= 2 {
        split($1, a, " ")
        if (a[1] ~ /^[0-7]+$/ && a[2] ~ /^[0-9a-f]+$/ && a[3] ~ /^[123]$/) print $2
      }
    ' | sort -u | paste -sd, -)"
  fi

  # --- Compare
  local class_p class_l status detail
  class_p=$([[ $porcelain_exit -eq 0 ]] && echo clean || echo conflict)
  class_l=$([[ $plumbing_exit -eq 0 ]] && echo clean || echo conflict)
  status="PASS"; detail=""

  if [[ "$class_p" != "$class_l" ]]; then
    status="FAIL"
    detail="outcome class mismatch (porcelain=$class_p, plumbing=$class_l)"
  elif [[ "$class_p" == clean ]]; then
    if [[ "$porcelain_tree" != "$plumbing_tree" ]]; then
      status="FAIL"
      detail="clean tree OID mismatch (porcelain=$porcelain_tree, plumbing=$plumbing_tree)"
    fi
  else
    if [[ "$porcelain_conflicts" != "$plumbing_conflicts" ]]; then
      status="FAIL"
      detail="conflict set mismatch (porcelain=[$porcelain_conflicts], plumbing=[$plumbing_conflicts])"
    fi
  fi

  if [[ "$status" == PASS ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  RESULTS+=("$status  $name  ($class_p)  $detail")

  cd / # let trap clean up
}

# Scenario 1: clean merge — distinct files added on each side
run_scenario clean-merge '
  echo base > a.txt
  git add -A && git commit -q -m base
  git checkout -q -b feature
  echo feature-file > f.txt
  git add -A && git commit -q -m feat
  git checkout -q main
  echo main-file > m.txt
  git add -A && git commit -q -m main-side
'

# Scenario 2: rename on feature, modify same content on main
run_scenario rename-vs-modify '
  printf "line1\nline2\nline3\n" > old.txt
  git add -A && git commit -q -m base
  git checkout -q -b feature
  git mv old.txt new.txt
  git commit -q -m rename
  git checkout -q main
  printf "line1\nMODIFIED\nline3\n" > old.txt
  git add -A && git commit -q -m modify
'

# Scenario 3: delete on feature, modify on main (delete/modify conflict)
run_scenario delete-vs-modify '
  echo "content" > f.txt
  git add -A && git commit -q -m base
  git checkout -q -b feature
  git rm -q f.txt
  git commit -q -m delete
  git checkout -q main
  echo "content modified" > f.txt
  git add -A && git commit -q -m modify
'

# Scenario 4: mode change on feature, content change on main
run_scenario mode-vs-content '
  printf "echo hello\n" > script.sh
  git add -A && git commit -q -m base
  git checkout -q -b feature
  chmod +x script.sh
  git update-index --chmod=+x script.sh
  git commit -q -m mode
  git checkout -q main
  printf "echo hello world\n" > script.sh
  git add -A && git commit -q -m content
'

# Scenario 5: binary file modified on both sides (conflict)
run_scenario binary-conflict '
  printf "\x00\x01\x02BASE\x03\x04" > bin.dat
  git add -A && git commit -q -m base
  git checkout -q -b feature
  printf "\x00\x01\x02FEATURE\x03\x04" > bin.dat
  git add -A && git commit -q -m feat
  git checkout -q main
  printf "\x00\x01\x02MAIN\x03\x04" > bin.dat
  git add -A && git commit -q -m main-side
'

# Scenario 6: text content conflict on the same line
run_scenario text-content-conflict '
  printf "line1\nline2\nline3\n" > a.txt
  git add -A && git commit -q -m base
  git checkout -q -b feature
  printf "line1\nFEATURE\nline3\n" > a.txt
  git add -A && git commit -q -m feat
  git checkout -q main
  printf "line1\nMAIN\nline3\n" > a.txt
  git add -A && git commit -q -m main-side
'

# Scenario 7: .gitattributes text normalization (clean merge w/ filter)
run_scenario gitattributes-eol '
  printf "* text=auto eol=lf\n" > .gitattributes
  printf "a\nb\nc\n" > a.txt
  git add -A && git commit -q -m base
  git checkout -q -b feature
  printf "a\nb\nc\nd\n" > a.txt
  git add -A && git commit -q -m feat
  git checkout -q main
  printf "0\na\nb\nc\n" > a.txt
  git add -A && git commit -q -m main-side
'

# Scenario 8: both sides rename to different names (rename/rename conflict)
run_scenario rename-rename-conflict '
  echo content > old.txt
  git add -A && git commit -q -m base
  git checkout -q -b feature
  git mv old.txt feature-name.txt
  git commit -q -m rename-feature
  git checkout -q main
  git mv old.txt main-name.txt
  git commit -q -m rename-main
'

# Scenario 9: submodule (skip if env lacks support)
run_scenario submodule-add-vs-modify '
  # Build a tiny upstream sub-repo
  mkdir sub-upstream
  ( cd sub-upstream && git init -q -b main && echo s > s.txt && git add -A && git commit -q -m s )
  echo root > root.txt
  git add -A && git commit -q -m base
  git checkout -q -b feature
  git -c protocol.file.allow=always submodule add -q ./sub-upstream sub >/dev/null 2>&1 || true
  git add -A && git commit -q -m "feature adds submodule" 2>/dev/null || true
  git checkout -q main
  echo root-modified > root.txt
  git add -A && git commit -q -m "main modifies root"
'

echo
echo "=== merge-tree parity spike: results ==="
printf "%s\n" "${RESULTS[@]}"
echo
echo "passed: $PASS  failed: $FAIL  total: $((PASS+FAIL))"

if (( FAIL == 0 )); then
  echo "all scenarios agree — plumbing parity holds for the cases tested"
  exit 0
fi
exit 1
