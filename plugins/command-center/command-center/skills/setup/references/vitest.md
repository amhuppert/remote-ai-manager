# Vitest Reference

Load this reference when Vitest is detected (`vitest` in `dependencies` or `devDependencies`).

Vitest config covers two concerns: AI-optimal output and bounded parallelism. The pre-merge script then scopes each run to the files touched by the branch.

## Why bound parallelism

Vitest's default `forks` pool spawns one worker per CPU core with no heap cap. On a high-core / low-RAM machine that fans out to N heavyweight Node processes at once (each loads the full app module graph + jsdom), exhausts memory + swap during a full-suite run, and can freeze the machine. Bound `maxForks` to a RAM budget and cap each worker's heap so a runaway file OOM-kills its own fork instead of growing unbounded.

## Vitest config

Add this to `vitest.config.ts` (or `vitest.config.js`). When an existing config is present, merge — don't replace.

```typescript
import { defineConfig } from "vitest/config";
import os from "node:os";

const isAI = process.env.CLAUDECODE === "1";
const isCI = process.env.CI === "true";

// Budget ~2 GB per worker against ~60% of total RAM, clamped to [2, cores].
// Prevents the default "one worker per core" fan-out from OOM-ing the box.
const GB = 1024 ** 3;
const maxForks = Math.max(
  2,
  Math.min(
    os.availableParallelism(),
    Math.floor(((os.totalmem() / GB) * 0.6) / 2),
  ),
);

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
        // Cap each worker's heap so a runaway file OOM-kills its own fork
        // instead of growing unbounded across the machine.
        execArgv: ["--max-old-space-size=2048"],
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
| `pool: "forks"` + `maxForks` | Caps concurrent worker processes against a RAM budget. Default is one per core with no cap. |
| `execArgv: ["--max-old-space-size=2048"]` | Per-worker heap cap. A runaway worker OOMs alone instead of taking the machine with it. |
| `reporters: ["dot"]` (AI) | One char per test, full failure details preserved. ~96% output reduction. |
| `bail: 3` | Stop after 3 failures — cascading errors waste tokens. |
| `onConsoleLog() { return false; }` | Suppress `console.log` from test code. |
| `onStackTrace` filter | Strip `node_modules` frames from stack traces. |
| `diff.truncateThreshold: 2000` | Truncate large object diffs. |

## Pre-merge invocation

The pre-merge script (`references/pre-merge-script.md`) computes `$merge_base`. Use `--changed` so Vitest runs only tests whose module graph includes a changed file.

```bash
# Always export this; vitest.config.ts checks CLAUDECODE for AI-optimal output.
export CLAUDECODE=1

if [ -z "$merge_base" ]; then
  # Fallback: validate the whole tree when no merge base resolves
  # (detached HEAD, missing target branch, shallow clone).
  NODE_ENV=test npx vitest run --no-color
else
  NODE_ENV=test npx vitest run --no-color --changed "$merge_base" --passWithNoTests
fi
```

| Flag | Purpose |
|---|---|
| `--changed <ref>` | Runs only tests whose module graph includes a file changed since `<ref>`. |
| `--passWithNoTests` | A branch that touches only untested files won't fail the merge. |
| `--no-color` | Disable ANSI codes for log capture. |

`NODE_ENV=test` is set explicitly so React loads its development build (which exports `React.act`) under projects using `@testing-library/react 16` with React 19. Harmless for projects not on that stack.

## When the project also uses Storybook tests

If `@storybook/addon-vitest/vitest-plugin` is wired into `vitest.config.ts`, the `pool`/`poolOptions` settings apply to the unit project only — Storybook's browser project uses its own pool. No additional config needed.
