# ESLint Reference

Load this reference when ESLint is detected (`eslint` in `dependencies` or `devDependencies`).

## Changed wrapper invocation

Scope ESLint to the JS/TS files this branch changes. Linting unchanged files burns time on code the branch can't break and surfaces violations the author didn't introduce.

The shared wrapper setup in `references/pre-merge-script.md` populates `$lint_files` with changed JS/TS/JSX/TSX/MJS/CJS files that still exist.

```bash
if [ -z "$merge_base" ]; then
  # Fallback: lint the whole tree when no merge base resolves
  # (detached HEAD, missing target branch, shallow clone).
  run_quiet npx eslint . --fix --quiet --no-color --no-warn-ignored
elif [ "${#lint_files[@]}" -gt 0 ]; then
  run_quiet npx eslint --fix --quiet --no-color --no-warn-ignored "${lint_files[@]}"
fi
```

When `lint_files` is empty under a resolved merge base, skip ESLint entirely — there is nothing in this branch's diff for it to lint.

## Full wrapper invocation

The full wrapper does not resolve a merge base:

```bash
run_quiet npx eslint . --fix --quiet --no-color --no-warn-ignored
```

## Flags

| Flag | Purpose |
|---|---|
| `--fix` | Auto-fixable violations are written in place. CC commits the fixes after the script returns. |
| `--quiet` | Errors only, suppress warnings. Warnings are noise during merge gating. |
| `--no-color` | Disable ANSI codes so captured output is readable in logs and AI prompts. |
| `--no-warn-ignored` | Suppress "file ignored" messages when callers pass explicit file paths that ESLint's config ignores. |

## Parallelism

ESLint has no fan-out problem to fix here — it's a single process. The scoping above is the win.
Register both wrappers under one logical profile with cost `1` unless project plugins make the maximum fixed resource profile materially heavier.
