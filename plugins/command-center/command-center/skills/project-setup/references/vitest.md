# Vitest Reference

Load this reference when Vitest is detected (`vitest` in `dependencies` or `devDependencies`).

Vitest config covers AI-optimal output and may mirror the fixed worker count. The registered test wrapper and its canonical launcher own worker and heap enforcement, scope each run to the files touched by the branch, and permit narrower path selection for TDD.

AI detection uses the `CLAUDECODE` env var, which every generated validation wrapper exports explicitly.

## Why bound parallelism

Vitest's default `forks` pool spawns one worker per CPU core with no heap cap. Pin `maxForks` to a fixed count and cap each worker's heap so the registered cost describes the maximum fan-out on every machine. A different worker profile is a different registered command.

## Vitest config

Add this to `vitest.config.ts` (or `vitest.config.js`). When an existing config is present, merge — don't replace. The worker value here is a defense-in-depth mirror; candidate-worktree configuration is not the enforcement boundary. Do not put the heap cap in candidate `poolOptions.forks.execArgv`: Node command-line heap flags override `NODE_OPTIONS`, so the canonical launcher must supply that field last.

```typescript
import { defineConfig } from "vitest/config";
const isAI = process.env.CLAUDECODE === "1";
const isCI = process.env.CI === "true";
const maxForks = 4;

function getReporters(): string[] {
  if (isCI) return ["dot", "github-actions"];
  if (isAI) return ["dot"];
  return ["default"];
}

export default defineConfig({
  test: {
    reporters: getReporters(),

    pool: "forks",
    poolOptions: {
      forks: {
        maxForks,
        minForks: 1,
      },
    },

    ...(isAI && {
      bail: 3,
      onConsoleLog() {
        return false;
      },
      onStackTrace(_error, { file }) {
        if (file.includes("node_modules")) return false;
      },
      diff: {
        truncateThreshold: 2000,
        truncateAnnotation: "... diff truncated",
        expand: false,
      },
    }),
  },
});
```

### What each setting does

| Setting | Purpose |
|---|---|
| `pool: "forks"` + `maxForks` | Mirrors the canonical wrapper's worker cap for local runs outside Command Center. |
| `reporters: ["dot"]` (AI) | One char per test, full failure details preserved. ~96% output reduction. |
| `bail: 3` | Stop after 3 failures — cascading errors waste tokens. |
| `onConsoleLog() { return false; }` | Suppress `console.log` from test code. |
| `onStackTrace` filter | Strip `node_modules` frames from stack traces. |
| `diff.truncateThreshold: 2000` | Truncate large object diffs. |

Register this four-worker wrapper with cost `4`. If the project chooses another fixed count, change the wrapper constants and declared cost together, then update the worker mirror to match.

## Canonical launcher

Generate `scripts/validate/vitest-launcher.mjs` beside the registered wrapper. The launcher reads only environment values that the wrapper overwrites, snapshots them before Vitest loads candidate code, and passes fixed programmatic options to `startVitest`. Vitest merges these programmatic options after the candidate configuration, so a candidate `poolOptions.forks.execArgv` such as `--max-old-space-size=8192` is replaced by the canonical 2048 MB value.

```javascript
import { startVitest } from "vitest/node";

const [scope, ...scopeArgs] = process.argv.slice(2);
const testWorkers = Number.parseInt(process.env.CC_TEST_WORKERS ?? "", 10);
const testHeapMb = Number.parseInt(process.env.CC_TEST_HEAP_MB ?? "", 10);

if (!Number.isInteger(testWorkers) || testWorkers < 1) {
  throw new Error("CC_TEST_WORKERS must be a positive integer");
}
if (!Number.isInteger(testHeapMb) || testHeapMb < 1) {
  throw new Error("CC_TEST_HEAP_MB must be a positive integer");
}

let filters = [];
let changed;
if (scope === "paths") {
  filters = scopeArgs;
} else if (scope === "changed" && scopeArgs.length === 1) {
  changed = scopeArgs[0];
} else if (scope !== "full" || scopeArgs.length > 0) {
  throw new Error("expected full, changed <merge-base>, or paths <path...>");
}

await startVitest(
  "test",
  filters,
  {
    run: true,
    color: false,
    reporters: ["dot"],
    bail: 3,
    passWithNoTests: scope !== "full",
    ...(changed ? { changed } : {}),
    pool: "forks",
    maxWorkers: testWorkers,
    minWorkers: 1,
    poolOptions: {
      forks: {
        maxForks: testWorkers,
        minForks: 1,
        execArgv: [`--max-old-space-size=${testHeapMb}`],
      },
    },
  },
);
```

The `startVitest` options are the final configuration layer. Both `maxForks` and `execArgv` are therefore authoritative even if candidate configuration declares larger values. Keep this launcher in the canonical project root with the wrapper; do not generate it inside each candidate worktree.

## Validation wrapper invocation

The shared wrapper setup in `references/pre-merge-script.md` computes `$merge_base`. Register `scripts/validate/test.sh` with `scopeArgs: "paths"`; forwarded values are already validated as relative non-option paths. The wrapper invokes the canonical launcher instead of the candidate-worktree Vitest CLI entry point.

```bash
readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
readonly TEST_WORKERS=4
readonly TEST_HEAP_MB=2048

# NODE_OPTIONS caps the launcher and parent process. The launcher applies the
# same cap as final worker execArgv after candidate configuration resolves.
export NODE_OPTIONS="--max-old-space-size=${TEST_HEAP_MB}"
export CC_TEST_WORKERS="$TEST_WORKERS"
export CC_TEST_HEAP_MB="$TEST_HEAP_MB"
export VITEST_MAX_FORKS="$TEST_WORKERS"
export VITEST_MIN_FORKS=1
export CLAUDECODE=1

if [ "$#" -gt 0 ]; then
  run_quiet env NODE_ENV=test node "$SCRIPT_DIR/vitest-launcher.mjs" paths "$@"
elif [ -z "$merge_base" ]; then
  # Fallback: validate the whole tree when no merge base resolves
  # (detached HEAD, missing target branch, shallow clone).
  run_quiet env NODE_ENV=test node "$SCRIPT_DIR/vitest-launcher.mjs" full
else
  run_quiet env NODE_ENV=test node "$SCRIPT_DIR/vitest-launcher.mjs" changed "$merge_base"
fi
```

| Mechanism | Purpose |
|---|---|
| `changed "$merge_base"` | Makes the launcher set Vitest's `changed` option to the merge base. |
| `paths "$@"` | Passes only server-validated relative paths as narrower test filters. |
| `passWithNoTests` for scoped modes | Allows a branch that touches only untested files to pass. |
| `color: false` plus `run_quiet` | Produces no color, discards success output, and replays complete failure output. |
| Final `poolOptions.forks` | Prevents candidate configuration from increasing fan-out or worker heap. |

The wrapper overwrites `NODE_OPTIONS` rather than preserving a caller value, so the Vitest parent inherits the fixed 2048 MB old-space cap. The launcher separately replaces candidate worker `execArgv` with the same cap because command-line Node flags take precedence over `NODE_OPTIONS`.

`NODE_ENV=test` is set explicitly so React loads its development build (which exports `React.act`) under projects using `@testing-library/react 16` with React 19. Harmless for projects not on that stack.

## When the project also uses Storybook tests

If `@storybook/addon-vitest/vitest-plugin` is wired into `vitest.config.ts`, the `pool`/`poolOptions` settings apply to the unit project only — Storybook's browser project uses its own pool. No additional config needed.
