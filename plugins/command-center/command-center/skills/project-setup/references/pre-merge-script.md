# Pre-Merge Validation Script Reference

This file documents the script's execution contract, the changed-files scoping pattern, and how per-tool invocations slot in. For each detected tool, also load the matching tool-specific reference:

- ESLint → `references/eslint.md`
- Prettier → `references/prettier.md`
- TypeScript → `references/typescript.md`
- Vitest → `references/vitest.md`
- Jest → `references/jest.md`

## When it runs

The smart merge workflow is a multi-phase process:

1. **Phase 1 — Forward merge:** CC merges the target branch into the session branch to catch conflicts.
2. **Phase 2 — Validation:** **The pre-merge script executes** (worktree now has target merged in).
3. **Phase 3 — Auto-fix (if validation failed):** If enabled, CC sends validation output to an agent to fix the issues, then re-runs validation.
4. **Phase 4 — Squash merge:** If validation passes, the session branch is squash-merged into the target.

The script may run **multiple times** if auto-fix retries are enabled.

## Execution contract

| Property | Value |
|---|---|
| Working directory | The session worktree path |
| Timeout | 5 minutes (configurable via CC's global `preMergeTimeoutMs` setting) |
| Execution method | Direct execution via `execFileGroup` — **must have a shebang line**. CC runs the script as the leader of its own process group so a timeout signals the whole tree (vitest workers included), not just the script. |
| Permissions | Must be executable (`chmod +x`) |
| Exit 0 | Validation passed — merge proceeds |
| Non-zero exit | Validation failed — merge aborted or auto-fix attempted |

## Environment variables

| Variable | Value | Description |
|---|---|---|
| `PROJECT_ROOT` | `.worktrees/my-session` | **The worktree path** (not the original repo) |
| `CLAUDE_PROJECT_DIR` | `/home/user/repos/my-project` | Absolute path to the original project root |
| `WORKTREE_PATH` | `.worktrees/my-session` | Same as `PROJECT_ROOT` |
| `SESSION_NAME` | `my-session` | Session identifier |
| `BRANCH_NAME` | `csm/my-session` | Git branch for this session |
| `TARGET_BRANCH` | `main` (default), or the session's configured target | Branch this work merges into — used to compute the changed-files diff |

`PROJECT_ROOT` points to the **worktree** (not the original repo root) because the script validates code as it exists in the worktree — which has the target branch merged in. Use `CLAUDE_PROJECT_DIR` if you need the original project root.

## Scoping principle

Run linters, formatters, and tests against **only the files this branch touches** relative to its merge target. A full-codebase run on every merge re-validates code the branch can't break, fans out test-worker memory pressure, and burns wall-clock time.

The exception is **TypeScript** — see `references/typescript.md` for why `tsc` must remain full-project.

## Auto-fix behavior

The script **may modify files** (e.g., Prettier `--write`, ESLint `--fix`). After the script completes:
- CC checks for uncommitted changes.
- If changes exist, CC commits them with message `auto-fix: pre-merge validation` using `--no-verify`.
- These auto-fix changes are included in the squash merge.

## Tool ordering

Run tools in this order:

1. **Formatters** (Prettier) — modify files, auto-committed by CC
2. **Linters** (ESLint `--fix`) — modify files, auto-committed by CC
3. **Static checkers** (TypeScript) — fail fast on type errors, full-project
4. **Tests** (Vitest/Jest) — slowest, run last

## Shared shell prelude

Every generated pre-merge script starts with the same setup: enable AI-optimal output, resolve the merge base against `TARGET_BRANCH`, and populate two arrays — `changed_files` (everything tracked + untracked) and `lint_files` (subset matching JS/TS extensions).

```bash
#!/usr/bin/env bash
set -euo pipefail

# Enable AI-optimal output for tools that detect CLAUDECODE.
export CLAUDECODE=1

# Resolve where this branch diverged from its merge target so we only
# lint/format/test what it actually introduces or changes. TARGET_BRANCH is
# supplied by CC's merge workflow; default to main for standalone runs.
TARGET_BRANCH="${TARGET_BRANCH:-main}"
merge_base=""
if git rev-parse --verify --quiet "${TARGET_BRANCH}^{commit}" >/dev/null 2>&1; then
  merge_base="$(git merge-base "${TARGET_BRANCH}" HEAD 2>/dev/null || true)"
fi

# Files changed vs the merge base: committed + staged + unstaged tracked
# changes (ACMR drops deletions; renames resolve to the new path) plus
# untracked files. Existence-filtered so tools never receive a path that
# no longer exists.
changed_files=()
lint_files=()
if [ -n "$merge_base" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    changed_files+=("$f")
    case "$f" in
      *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs) lint_files+=("$f") ;;
    esac
  done < <(
    {
      git diff --name-only --diff-filter=ACMR "$merge_base" --
      git ls-files --others --exclude-standard
    } | sort -u
  )
else
  # Detached HEAD, missing target, or shallow clone: each tool falls back
  # to validating the whole tree rather than silently skipping checks.
  echo "pre-merge: no merge base against '${TARGET_BRANCH}'; validating entire tree" >&2
fi

# --- per-tool invocations follow; see references/<tool>.md for each ---
```

## Generation rule

For each detected tool, append the invocation block from its reference file in the order above. Tools that weren't detected are simply omitted — there are no placeholder blocks. The script always ends with the per-tool sections it actually needs.

Each tool's reference contains:
- Its invocation block (using `$merge_base`, `$changed_files`, or `$lint_files` from the prelude)
- The fallback branch when `$merge_base` is empty
- Tool-specific flags and rationale

When the project has none of the detected tools, do not generate a pre-merge script — omit `preMergeCommand` from `CommandCenter.json` entirely.

## Key rules

- `set -euo pipefail` — fail at the first error. CC needs the non-zero exit code to detect failure.
- Stdout and stderr are captured and shown in the error notification when validation fails.
- The output should be clear and actionable — when auto-fix is enabled, the auto-fix agent reads it to understand what to fix.
- `export CLAUDECODE=1` — enables AI-optimal output mode for tools that detect it in their config. (The variable name comes from Claude Code, which sets it in its own sessions; the script exports it explicitly so the detection fires no matter which agent or workflow runs the validation.)
- Never scope `tsc` to changed files. The other tools must scope.
