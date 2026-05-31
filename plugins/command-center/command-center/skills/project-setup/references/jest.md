# Jest Reference

Load this reference when Jest is detected (`jest` in `dependencies` or `devDependencies`) and Vitest is not.

Jest config covers AI-optimal output and bounded parallelism. The pre-merge script then scopes each run to the files touched by the branch.

## Why bound parallelism

Jest defaults to `--maxWorkers=<numCpus - 1>`, with each worker loading the full module graph and (for jsdom projects) a DOM. On a high-core / low-RAM box this can exhaust memory + swap during a full-suite run. Cap workers to a fraction of CPUs and set a per-worker memory ceiling so runaway tests trigger a worker restart instead of unbounded growth.

## Jest config

Add this to `jest.config.ts` (or `jest.config.js`). When an existing config is present, merge — don't replace.

```typescript
const isAI = process.env.CLAUDECODE === "1";

export default {
  // Caps worker count against CPU/RAM. "50%" lets Jest scale with the box
  // without fanning out to N=cores workers on a 16-core machine.
  maxWorkers: "50%",

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
| `maxWorkers: "50%"` | Caps concurrent worker processes at half of CPU cores. Default is `cores - 1` with no RAM awareness. |
| `workerIdleMemoryLimit: "2GB"` | Per-worker memory ceiling. Triggers a worker restart on exceedance, bounding growth. |
| `reporters: [["summary", { summaryThreshold: 0 }]]` (AI) | Eliminates per-file PASS/FAIL lines while preserving failure details. |

## Pre-merge invocation

The pre-merge script (`references/pre-merge-script.md`) computes `$merge_base`. Use `--changedSince` so Jest runs only tests related to files changed against the merge target.

```bash
# Always export this; jest.config.ts checks CLAUDECODE for AI-optimal output.
export CLAUDECODE=1

if [ -z "$merge_base" ]; then
  # Fallback: validate the whole tree when no merge base resolves
  # (detached HEAD, missing target branch, shallow clone).
  npx jest --silent --no-color --bail=3
else
  npx jest --silent --no-color --bail=3 --changedSince="$merge_base" --passWithNoTests
fi
```

| Flag | Purpose |
|---|---|
| `--changedSince=<ref>` | Runs only tests related to files changed since `<ref>`. |
| `--passWithNoTests` | A branch that touches only untested files won't fail the merge. |
| `--silent` | Suppress `console.log` from test code. |
| `--no-color` | Disable ANSI codes for log capture. |
| `--bail=3` | Stop after 3 failures — cascading errors waste tokens. |
