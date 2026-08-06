# Validation Command Wrapper Reference

This reference defines the shared contract for the granular scripts registered in `validation.commands`. Generate one executable wrapper per tool or fixed resource profile under `scripts/validate/`; do not combine all tools into one script.

For each detected tool, also load its reference:

- ESLint → `references/eslint.md`
- Prettier → `references/prettier.md`
- TypeScript → `references/typescript.md`
- Vitest → `references/vitest.md`
- Jest → `references/jest.md`

## Execution Contract

| Property | Value |
|---|---|
| Working directory | Target session or lane worktree |
| Timeout | Command `timeoutMs`, then the global validation default |
| Execution method | Direct executable invocation with `execFile` semantics; a shebang and executable permission are required |
| Arguments | No forwarded values unless the registration uses `scopeArgs: "paths"`; forwarded values may only narrow work |
| Exit 0 | The command passed |
| Non-zero exit | The command failed; complete captured diagnostics must be available |

## Environment Variables

| Variable | Value | Description |
|---|---|---|
| `PROJECT_ROOT` | Target worktree path | Compatibility name for the tree being validated |
| `CLAUDE_PROJECT_DIR` | Canonical project root | Root from which the registered wrapper path was resolved |
| `WORKTREE_PATH` | Target worktree path | Tree being validated |
| `SESSION_NAME` | Session identifier | Owning session |
| `BRANCH_NAME` | Session or lane branch | Branch being validated |
| `TARGET_BRANCH` | Merge target, when known | Input to `git merge-base` scoping |
| `CONTEXT_ID` | Graph context id, when applicable | Owning execution context |
| `CC_VALIDATION_RUN_ID` | Validation run id | Correlation identifier and recursion guard |
| `CC_VALIDATION_COMMAND` | Registered command name | Active resource profile |
| `CC_VALIDATION_COST` | Declared cost | Reserved global-budget weight |

## Shared Wrapper Prelude

Each wrapper starts with the same safety and output setup. Use the diff setup in wrappers that support affected-work scoping and omit the unused arrays from wrappers such as a full-project typecheck.

```bash
#!/usr/bin/env bash
set -euo pipefail

export CLAUDECODE=1
export FORCE_COLOR=0
export NO_COLOR=1

run_quiet() {
  local output_file status
  output_file="$(mktemp)"
  if "$@" >"$output_file" 2>&1; then
    rm -f "$output_file"
    return 0
  else
    status=$?
  fi
  sed -n '1,$p' "$output_file" >&2
  rm -f "$output_file"
  return "$status"
}

TARGET_BRANCH="${TARGET_BRANCH:-main}"
merge_base=""
if git rev-parse --verify --quiet "${TARGET_BRANCH}^{commit}" >/dev/null 2>&1; then
  merge_base="$(git merge-base "$TARGET_BRANCH" HEAD 2>/dev/null || true)"
fi

changed_files=()
lint_files=()
if [ -n "$merge_base" ]; then
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || continue
    changed_files+=("$file")
    case "$file" in
      *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs) lint_files+=("$file") ;;
    esac
  done < <(
    {
      git diff --name-only --diff-filter=ACMR "$merge_base" --
      git diff --name-only --diff-filter=ACMR --cached --
      git diff --name-only --diff-filter=ACMR --
      git ls-files --others --exclude-standard
    } | sort -u
  )
else
  echo "validation: no merge base against '${TARGET_BRANCH}'; validating the full safe scope" >&2
fi
```

`run_quiet` suppresses successful output but replays the entire combined output on failure. Do not replace it with an unconditional redirect that discards failure diagnostics. Tool invocations must also disable color.

## Scoping Rules

- Formatters receive `changed_files` and skip when that array is empty.
- Linters receive the changed supported-file subset or a sound affected-package selection.
- Test runners use the merge base through `--changed`, `--changedSince`, or an equivalent related-tests mode.
- Typechecks and builds stay full when dependency analysis cannot make scoping sound.
- Failure to resolve a merge base triggers a full safe check, never a silent pass.

The registered test wrapper may additionally accept relative paths from a `scopeArgs: "paths"` registration. When paths are present, treat them as a narrower explicit test selection and do not add worker, heap, pool, or config options from forwarded arguments.

## Fixed Resource Profiles and Cost

Every test wrapper owns its worker and heap limits. Declare fixed constants in the canonical wrapper, use wrapper-owned flags or environment variables to cap workers, and overwrite `NODE_OPTIONS` with `--max-old-space-size=<heap>` before invoking the test runner. Overwriting instead of appending prevents caller-supplied Node options from loosening the inherited profile; runners that supply worker `execArgv` need the additional final override below.

```bash
readonly TEST_WORKERS=4
readonly TEST_HEAP_MB=2048
export NODE_OPTIONS="--max-old-space-size=${TEST_HEAP_MB}"
```

Runner configuration may mirror these limits but must not own enforcement. It loads from the candidate worktree, while the registered wrapper resolves from the canonical project root. The wrapper's maximum must not depend on CPU count, available memory, candidate configuration, caller environment, or forwarded flags.

`NODE_OPTIONS` is an inherited default, not a final override: a Node command-line heap flag in worker `execArgv` takes precedence. When a runner lets candidate configuration set worker `execArgv`, pair the wrapper with a canonical launcher that loads candidate configuration and then applies the wrapper's fixed heap flag as the final worker `execArgv`. The Vitest reference uses its programmatic API for this post-configuration override.

Declare about one cost unit per configured worker; an ordinary single-process wrapper normally costs one. Use the same convention for every project sharing the machine.

If a project needs both a two-worker inner-loop test and an eight-worker full test, register two wrappers and two command names with costs `2` and `8`. Do not make one command dynamically change profiles.

## Merge-Gate Ordering

`validation.preMerge` and `validation.laneMerge` are ordered lists of registered names. Use order to preserve dependencies, normally format → lint → typecheck → test/build. `laneMerge` may be a cheaper subset; when omitted, it inherits `preMerge`.

## Key Rules

- One wrapper per command or fixed resource profile under `scripts/validate/`.
- Shebang plus executable permission for every wrapper.
- `set -euo pipefail` and a non-zero exit on failure.
- Silent on success, complete on failure, and no color.
- Scope by default wherever sound; full typecheck/build where it is not.
- Keep workers and inherited per-process heap wrapper-owned and fixed so the declared cost remains honest.
