# Prettier Reference

Load this reference when Prettier is detected (`prettier` in `dependencies` or `devDependencies`).

## Validation wrapper invocation

Scope Prettier to the files this branch changes. Formatting unchanged files churns the diff and risks reformatting code the author didn't touch.

The shared wrapper setup in `references/pre-merge-script.md` populates `$changed_files` with committed, staged, unstaged, and untracked changes that still exist.

```bash
if [ -z "$merge_base" ]; then
  # Fallback: format the whole tree when no merge base resolves
  # (detached HEAD, missing target branch, shallow clone).
  run_quiet npx prettier --write --no-color .
elif [ "${#changed_files[@]}" -gt 0 ]; then
  run_quiet npx prettier --write --ignore-unknown --no-color "${changed_files[@]}"
fi
```

When `changed_files` is empty under a resolved merge base, skip Prettier entirely — there is nothing in this branch's diff for it to format.

## Flags

| Flag | Purpose |
|---|---|
| `--write` | Apply formatting in place. CC commits the result after the script returns. |
| `--ignore-unknown` | Silently skip files with no parser (e.g., images, lockfiles) when explicit paths are passed. |
| `--no-color` | Keep captured diagnostics free of ANSI sequences. |

`run_quiet` suppresses the verbose file list on success and replays complete diagnostics on failure.

## Parallelism

Prettier processes files in a single Node process. No worker pool to cap.
Register this wrapper with cost `1`.
