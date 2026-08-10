# Research Notes: validation-command-scopes

## Current contract

- `validationCommandConfigSchema` stores one flat executable in `command` plus `scopeArgs: "forbid" | "paths"`.
- `ValidationService.submit` accepts optional `scopePaths`, resolves the flat executable, validates paths, records whether paths were present in `scoped`, and invokes the process runner.
- `submitSystem` has no scope input. Smart Merge, Smart Commit, graph script validation, and graph lane-merge therefore inherit whatever behavior the selected wrapper implements.
- `cctl validate run <name> [--wait] [-- <paths>]` has no full/changed flag.
- The durable ledger distinguishes only path-filtered and non-path-filtered runs through `scoped` and `scoped_path_count`; it cannot distinguish an affected-file run from a full run when neither received explicit paths.

## Repository wrapper behavior

- `scripts/validate/format.sh` and `lint.sh` compute files changed from `git merge-base "$TARGET_BRANCH" HEAD`, include staged/unstaged/untracked files, and safely widen to a full run when no merge base exists.
- `scripts/validate/typecheck.sh` always runs full-project build info, TypeScript, seam checks, and production build.
- `scripts/validate/test.sh` uses the repository's Vitest launcher. Its ordinary changed path invokes Vitest with native `changed: mergeBase`; explicit paths become Vitest filters. Test setup-file changes widen the affected project because Vitest excludes setup files from dependency traversal.
- `scripts/validate/test-full-suite.sh` invokes the same launcher and worker/heap profile in full mode, with bail disabled.
- `CommandCenter.json` registers `test` and `test-full-suite` separately even though they share cost and timeout.

## Existing safety boundaries to retain

- Executable paths are canonicalized under the registered project root and target worktree and invoked through `execFile`, never through a shell.
- Forwarded path arguments are lexically validated, cannot begin with `-`, and must remain inside the target worktree.
- The service owns policy checks, weighted FIFO admission, leases, timeout, cancellation, process-group cleanup, recovery, events, and durable timing.
- Command discovery deliberately omits executable paths so agents cannot copy a path around the validation service.

## Decisions confirmed by Alex

1. One logical registration contains separate full and changed executable entries; wrappers do not parse Command Center's scope argument.
2. Explicit path filters remain available.
3. The registry and public contract make a clean cutover without backward compatibility for the old flat shape.

## Persistence constraint

Old `validation_runs.scoped` means only that explicit paths were forwarded. For arbitrary registered projects, `scoped = 0` does not reveal whether the wrapper performed changed or full validation. A migration therefore cannot truthfully backfill requested/effective scope for those rows. New columns must allow legacy unknowns while the submission path guarantees both values for every new run.
