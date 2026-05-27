# Prettier Reference

Load this reference when Prettier is detected (`prettier` in `dependencies` or `devDependencies`).

## Pre-merge invocation

Scope Prettier to the files this branch changes. Formatting unchanged files churns the diff and risks reformatting code the author didn't touch.

The pre-merge script (`references/pre-merge-script.md`) populates `$changed_files` — the union of committed/staged/unstaged/untracked changes filtered to ones that still exist.

```bash
if [ -z "$merge_base" ]; then
  # Fallback: format the whole tree when no merge base resolves
  # (detached HEAD, missing target branch, shallow clone).
  npx prettier --write . >/dev/null 2>&1
elif [ "${#changed_files[@]}" -gt 0 ]; then
  npx prettier --write --ignore-unknown "${changed_files[@]}" >/dev/null 2>&1
fi
```

When `changed_files` is empty under a resolved merge base, skip Prettier entirely — there is nothing in this branch's diff for it to format.

## Flags

| Flag | Purpose |
|---|---|
| `--write` | Apply formatting in place. CC commits the result after the script returns. |
| `--ignore-unknown` | Silently skip files with no parser (e.g., images, lockfiles) when explicit paths are passed. |

The `>/dev/null 2>&1` suppresses Prettier's verbose file-by-file listing on success; failures surface through the non-zero exit code.

## Parallelism

Prettier processes files in a single Node process. No worker pool to cap.
