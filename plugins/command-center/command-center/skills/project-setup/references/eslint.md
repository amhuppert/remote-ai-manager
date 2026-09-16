# ESLint Reference

Load this reference when ESLint is detected (`eslint` in `dependencies` or `devDependencies`).

## Changed wrapper invocation

Scope ordinary source edits to changed supported files when the rules are file-local. Changes to lint configuration, plugins, dependencies, or cross-file rules can affect unchanged files; use full or affected-package linting for those changes. Adapt the example below to detect those project-specific inputs before selecting the changed-file branch.

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

The example invokes ESLint without worker concurrency. If the installed version or wrapper enables parallel workers, bound and price that profile explicitly.
Register both wrappers under one logical profile with cost `1` unless project plugins make the maximum fixed resource profile materially heavier.
