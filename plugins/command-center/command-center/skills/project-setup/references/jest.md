# Jest Reference

Load this reference when Jest is detected (`jest` in `dependencies` or `devDependencies`) and Vitest is not.

Jest config covers AI-optimal output and may mirror a fixed resource profile. Separate full and changed wrappers share the same worker and heap enforcement. The changed wrapper scopes runs to affected tests or narrower TDD paths.

AI detection uses the `CLAUDECODE` env var, which every generated validation wrapper exports explicitly.

## Why bound parallelism

Jest defaults to `--maxWorkers=<numCpus - 1>`, with each worker loading the full module graph and often a DOM. Pin workers to a fixed count and set a per-worker memory ceiling so the registered cost describes the maximum profile on every machine.

## Jest config

Add this to `jest.config.ts` (or `jest.config.js`). When an existing config is present, merge — don't replace. The worker and memory values here are defense-in-depth mirrors; candidate-worktree configuration is not the enforcement boundary.

```typescript
const isAI = process.env.CLAUDECODE === "1";

export default {
  maxWorkers: 4,

  // Restart a worker once it crosses this heap threshold. A leaky test file
  // bounces its own worker instead of bloating the parent or the machine.
  workerIdleMemoryLimit: "2GB",

  ...(isAI && {
    reporters: [["summary", { summaryThreshold: 0 }]],
  }),
};
```

### What each setting does

| Setting | Purpose |
|---|---|
| `maxWorkers: 4` | Mirrors the canonical wrapper's worker cap for local runs outside Command Center. |
| `workerIdleMemoryLimit: "2GB"` | Mirrors the wrapper profile with a worker-restart threshold; it does not replace the inherited Node heap cap. |
| `reporters: [["summary", { summaryThreshold: 0 }]]` (AI) | Eliminates per-file PASS/FAIL lines while preserving failure details. |

Register this four-worker wrapper with cost `4`. If the project chooses another fixed count, change the wrapper constants and declared cost together, then update config mirrors to match.

## Validation wrapper invocation

The shared wrapper setup in `references/pre-merge-script.md` computes `$merge_base` for the changed wrapper. Register both wrappers under one logical test profile with `pathArgs: "paths"`; forwarded values reach only the changed wrapper and are already validated as relative non-option paths.

```bash
readonly TEST_WORKERS=4
readonly TEST_HEAP_MB=2048

# Wrapper-owned enforcement: NODE_OPTIONS reaches the Jest parent and workers.
export NODE_OPTIONS="--max-old-space-size=${TEST_HEAP_MB}"
export CLAUDECODE=1

# Changed wrapper only:
if [ "$#" -gt 0 ]; then
  run_quiet npx jest --silent --no-color --bail=3 --maxWorkers="$TEST_WORKERS" --passWithNoTests --runTestsByPath "$@"
elif [ -z "$merge_base" ]; then
  # Fallback: validate the whole tree when no merge base resolves
  # (detached HEAD, missing target branch, shallow clone).
  run_quiet npx jest --silent --no-color --bail=3 --maxWorkers="$TEST_WORKERS"
else
  run_quiet npx jest --silent --no-color --bail=3 --maxWorkers="$TEST_WORKERS" --changedSince="$merge_base" --passWithNoTests
fi
```

The full wrapper uses the same fixed resource prelude and unconditionally invokes:

```bash
run_quiet npx jest --silent --no-color --bail=3 --maxWorkers="$TEST_WORKERS"
```

| Flag | Purpose |
|---|---|
| `--changedSince=<ref>` | Runs only tests related to files changed since `<ref>`. |
| `--passWithNoTests` | A branch that touches only untested files won't fail the merge. |
| `--silent` | Suppress `console.log` from test code. |
| `--no-color` | Disable ANSI codes for log capture. |
| `--bail=3` | Stop after 3 failures — cascading errors waste tokens. |
| `--maxWorkers="$TEST_WORKERS"` | Prevent candidate config from increasing the wrapper's declared four-unit fan-out. |

The wrapper overwrites `NODE_OPTIONS` rather than preserving a caller value, so the Jest parent and every spawned Node worker inherit the fixed 2048 MB old-space cap. `workerIdleMemoryLimit` remains a useful mirror for local runs but is not the authoritative heap enforcement.
