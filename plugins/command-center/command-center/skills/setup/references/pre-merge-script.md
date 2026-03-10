# Pre-Merge Validation Script Reference

## When It Runs

The smart merge workflow is a multi-phase process:

1. **Phase 1 — Forward merge:** CC merges `main` into the session branch to catch conflicts
2. **Phase 2 — Validation:** **The pre-merge script executes** (worktree now has main merged in)
3. **Phase 3 — Auto-fix (if validation failed):** If enabled, CC sends validation output to Claude to fix issues, then re-runs validation
4. **Phase 4 — Squash merge:** If validation passes, the session branch is squash-merged into main

The script may run **multiple times** if auto-fix retries are enabled.

## Execution Contract

| Property | Value |
|---|---|
| Working directory | The session worktree path |
| Timeout | 5 minutes (configurable via CC's global `preMergeTimeoutMs` setting) |
| Execution method | Direct execution via `execFile` — **must have a shebang line** |
| Permissions | Must be executable (`chmod +x`) |
| Exit 0 | Validation passed — merge proceeds |
| Non-zero exit | Validation failed — merge aborted or auto-fix attempted |

## Environment Variables

| Variable | Value | Description |
|---|---|---|
| `PROJECT_ROOT` | `.worktrees/my-session` | **The worktree path** (not the original repo!) |
| `CLAUDE_PROJECT_DIR` | `/home/user/repos/my-project` | Absolute path to the original project root |
| `WORKTREE_PATH` | `.worktrees/my-session` | Same as `PROJECT_ROOT` — the session worktree |
| `SESSION_NAME` | `my-session` | Session identifier |
| `BRANCH_NAME` | `csm/my-session` | Git branch for this session |

**Critical difference from init script:** `PROJECT_ROOT` points to the **worktree** (not the original repo root) because the script validates code as it exists in the worktree — which has main merged in. Use `CLAUDE_PROJECT_DIR` if you need the original project root.

## Auto-Fix Behavior

The script **may modify files** (e.g., Prettier auto-formatting, ESLint `--fix`). After the script completes:
- CC checks for uncommitted changes
- If changes exist, CC commits them with message `auto-fix: pre-merge validation` using `--no-verify` (skipping git hooks)
- These auto-fix changes are included in the squash merge

This means formatters like Prettier and ESLint with `--fix` work seamlessly.

## Tool Ordering

Run tools in this order:
1. **Formatters** (Prettier, ESLint --fix) — modify files, auto-committed by CC
2. **Static checkers** (TypeScript) — fail fast on type errors
3. **Tests** (Vitest/Jest) — slowest, run last

## Template

```bash
#!/usr/bin/env bash
set -euo pipefail

# Enable AI-optimal output for tools that detect CLAUDECODE
export CLAUDECODE=1

# 1. Auto-fix formatting (changes auto-committed by CC after script)
npx prettier --write . > /dev/null 2>&1

# 2. Lint with auto-fix, errors only, no color
npx eslint . --fix --quiet --no-color --no-warn-ignored

# 3. Type check — one-line-per-error format
npx tsc --noEmit --pretty false

# 4. Tests — reporter auto-switches via CLAUDECODE detection in config
npx vitest run --no-color
```

### With Jest Instead of Vitest

Replace the last line:

```bash
npx jest --silent --no-color --bail=3
```

### Without Certain Tools

Omit lines for tools the project doesn't use. For example, a project without TypeScript:

```bash
#!/usr/bin/env bash
set -euo pipefail
export CLAUDECODE=1
npx prettier --write . > /dev/null 2>&1
npx eslint . --fix --quiet --no-color --no-warn-ignored
npx vitest run --no-color
```

## Key Rules

- `set -euo pipefail` — fail at the first error. CC needs the non-zero exit code to detect failure.
- Stdout and stderr are captured and shown in the error notification when validation fails.
- The output should be clear and actionable — when auto-fix is enabled, Claude reads it to understand what to fix.
- `export CLAUDECODE=1` — enables AI-optimal output mode for tools that detect it in their config (e.g., Vitest dot reporter).
