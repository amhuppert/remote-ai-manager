# AI-Optimal Validation Output

Command Center runs validation scripts before merging session branches into main. These scripts run linters, type checkers, and test suites — and their output is consumed by AI agents. This guide covers how to configure your project's validation tools to produce output that AI agents can process efficiently.

## Why This Matters

AI agents read every line of tool output, and each line consumes tokens from their context window. Default tool output is designed for human eyes scanning a terminal — color codes, decorative progress bars, verbose per-file success messages. None of this helps an agent understand what's broken.

A 200-test suite in default mode might produce 250 lines of output. In AI-optimal mode, the same passing suite produces ~10 characters. The savings matter: fewer wasted tokens means the agent has more context available for understanding and fixing actual errors.

The goal is simple: **maximize signal, minimize noise**. Show every failure in full detail. Suppress everything else.

## Core Principles

1. **Suppress success output** — Passing tests and clean files are noise. The agent only needs to know about failures.
2. **Preserve failure details** — Full error messages, file locations, expected/received values, and relevant stack frames must remain intact.
3. **Strip ANSI color codes** — Escape sequences like `\e[31m` waste tokens and convey nothing to an LLM. Use `--no-color` flags or equivalent.
4. **Bail early** — After a few failures, stop. Cascading errors from a single root cause waste context on symptoms rather than the cause.
5. **Truncate large diffs** — A 5,000-character snapshot diff burns tokens without helping the agent, which can read the source file directly.
6. **Use a backend-neutral signal** — Expose an explicit project-owned `AI_OUTPUT=1` switch and let provider- or CI-specific signals opt into it. Claude Code sets `CLAUDECODE=1`; CI systems commonly set `CI=true`; Codex environments do not guarantee the Claude variable.

## Command Center Validation Commands

### How It Works

Projects register granular wrappers under `validation.commands` in `CommandCenter.json`. Stable command names let workflows and merge operations select only the checks they need. `validation.preMerge` defines the ordered Smart Merge and Smart Commit gate, while `validation.laneMerge` defines the graph lane-merge gate.

```json
{
  "validation": {
    "commands": {
      "format": {
        "command": {
          "full": "scripts/validate/format-full.sh",
          "changed": "scripts/validate/format-changed.sh"
        },
        "cost": 1,
        "pathArgs": "forbid"
      },
      "lint": {
        "command": {
          "full": "scripts/validate/lint-full.sh",
          "changed": "scripts/validate/lint-changed.sh"
        },
        "cost": 2,
        "pathArgs": "forbid"
      },
      "typecheck": {
        "command": {
          "full": "scripts/validate/typecheck.sh"
        },
        "cost": 2,
        "pathArgs": "forbid"
      },
      "test": {
        "command": {
          "full": "scripts/validate/test-full.sh",
          "changed": "scripts/validate/test-changed.sh"
        },
        "cost": 8,
        "timeoutMs": 900000,
        "pathArgs": "paths"
      }
    },
    "preMerge": ["format", "lint", "typecheck", "test"],
    "laneMerge": ["typecheck", "test"]
  }
}
```

Every execution goes through Command Center's server-owned validation service. The service resolves the registered command and requested scope, enforces the allowed-command policy and global weighted budget, targets the correct worktree, and records queue and execution timing. Scope defaults to `changed`; when a command has no changed executable, Command Center selects its full executable and reports effective scope `full`. A command whose configured cost exceeds the global limit is rejected rather than clamped.

Give each wrapper one fixed behavior and register its full and changed paths under one logical command. Both variants share `cost` and `timeoutMs`; keep the cost honest for the more expensive variant. Use `pathArgs: "paths"` only when the changed wrapper safely accepts forwarded repository-relative paths. Full requests and changed-to-full fallbacks never accept paths.

The selected commands run in order. A non-zero exit aborts the gate and preserves the full failure output. Successful wrappers should emit nothing.

### Environment Variables

CC passes these environment variables to registered wrappers:

| Variable | Description |
|----------|-------------|
| `PROJECT_ROOT` | Absolute path to the target worktree |
| `CLAUDE_PROJECT_DIR` | Absolute path to the canonical project root |
| `WORKTREE_PATH` | Absolute path to the session worktree |
| `SESSION_NAME` | Session identifier (e.g., `feature-auth`) |
| `BRANCH_NAME` | Git branch name (e.g., `csm/feature-auth`) |
| `TARGET_BRANCH` | Comparison branch when the caller supplies one |
| `CONTEXT_ID` | Graph execution context when applicable |
| `CC_VALIDATION_RUN_ID` | Durable validation run identifier |
| `CC_VALIDATION_COMMAND` | Registered command name |
| `CC_VALIDATION_COST` | Configured reservation cost |

`CLAUDECODE` is a Claude Code process signal, not part of Command Center's backend-neutral validation contract. Projects should expose explicit `:ai` scripts or accept `AI_OUTPUT=1` so the same low-noise path works for Claude, Codex, CI, and direct operator runs.

### Timeouts and Queueing

Each command may set `timeoutMs`; otherwise the service default applies. Time spent waiting for budget does not consume the execution timeout. Capacity remains reserved until the spawned process group is confirmed dead on every terminal path.

### Wrapper Pattern

Wrappers must have a shebang and executable permission. Suppress passing output, preserve failing output, and pin internal parallelism so the registered cost remains true. Changed formatting and linting wrappers may use `TARGET_BRANCH`; full wrappers must ignore the diff. Keep type checking full-project when a changed declaration can break unchanged dependents, registering only `command.full` so changed requests fall back automatically. A changed test wrapper may accept path filters when its registration uses `pathArgs: "paths"`. Wrappers never receive or parse Command Center's scope value.

```bash
#!/usr/bin/env bash
set -euo pipefail

output_file="$(mktemp -t validation.XXXXXX)"
if npx tsc --noEmit --pretty false >"$output_file" 2>&1; then
  rm -f "$output_file"
  exit 0
else
  status=$?
fi
sed -n '1,$p' "$output_file" >&2
rm -f "$output_file"
exit "$status"
```

### Pre-Commit Hooks

You can use the same detection pattern in pre-commit hooks. Prefer the explicit `AI_OUTPUT=1` switch and accept `CLAUDECODE=1` as a Claude-specific convenience:

```bash
#!/bin/sh
set -e

# Lint with auto-fix — AI mode suppresses warnings and colors
if [ "${AI_OUTPUT:-0}" = "1" ] || [ "${CLAUDECODE:-0}" = "1" ]; then
  npx eslint . --fix --quiet --no-color --no-warn-ignored
else
  npx eslint . --fix
fi
git add -u

# Type check — AI mode uses one-line-per-error format
if [ "${AI_OUTPUT:-0}" = "1" ] || [ "${CLAUDECODE:-0}" = "1" ]; then
  tsc --noEmit --pretty false
else
  tsc --noEmit --pretty
fi

# Tests — reporter switching handled in vitest/jest config
npx vitest run
```

## Tool-by-Tool Configuration

### ESLint

**AI-optimal command:**

```bash
eslint . --quiet --no-color --no-warn-ignored
```

| Flag | What it does |
|------|--------------|
| `--quiet` | Report errors only, suppress warnings. In ESLint v9+, warning-level rules don't even execute, improving performance. |
| `--no-color` | Disable ANSI color codes. |
| `--no-warn-ignored` | Suppress "File ignored because of a matching ignore pattern" messages. |

**Why the default `stylish` formatter is fine:** ESLint v9 ships with `stylish` as its built-in default. It groups errors by file (the path appears once as a header) with errors listed underneath. This is more token-efficient than the `compact` or `unix` formatters, which repeat the full file path on every line. The `json` formatter adds ~3-5x token overhead from structural keys (`"filePath"`, `"ruleId"`, `"severity"`, etc.) for minimal benefit — an LLM parses the tabular `stylish` format just fine.

**Example output (AI mode):**

```
src/lib/prompt.ts
  42:5  error  'timeout' is defined but never used  no-unused-vars

src/lib/state.ts
  17:3  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

2 problems (2 errors, 0 warnings)
```

**With auto-fix (for validation scripts):** Add `--fix` before the other flags. ESLint will fix what it can and report remaining errors:

```bash
eslint . --fix --quiet --no-color --no-warn-ignored
```

**Package.json script:**

```json
{
  "lint": "eslint .",
  "lint:ai": "eslint . --quiet --no-color --no-warn-ignored"
}
```

### TypeScript Compiler

**AI-optimal command:**

```bash
tsc --noEmit --pretty false
```

| Flag | What it does |
|------|--------------|
| `--noEmit` | Type-check only, don't emit JavaScript files. |
| `--pretty false` | One-line-per-error machine-readable format without source snippets, underlines, or color codes. |

**Why `--pretty false`:** The default `--pretty` mode produces 6-8 lines per error — a source snippet, a squiggly underline, related type information, and a summary. `--pretty false` compresses this to a single line containing everything the agent needs: file, location, error code, and message. For 20 errors, that's ~20 lines vs. ~140 lines — a 7x reduction.

**Output comparison:**

Pretty mode (default):
```
src/lib/prompt.ts:42:5 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.

42     processTimeout("300");
                      ~~~~~

  src/lib/types.ts:15:3
    15   timeout: number;
         ~~~~~~~
    The expected type comes from property 'timeout' which is declared here on type 'Config'
```

`--pretty false`:
```
src/lib/prompt.ts(42,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

The agent can read the source file directly if it needs more context. The source snippet and underline are redundant.

**Package.json script:**

```json
{
  "typecheck": "tsc --noEmit --pretty",
  "typecheck:ai": "tsc --noEmit --pretty false"
}
```

### Vitest

**AI-optimal configuration:**

Vitest's output is best controlled through `vitest.config.ts` rather than CLI flags, because several key noise-reduction settings (bail, console suppression, stack trace filtering, diff truncation) are only available as config options.

```typescript
// vitest.config.ts
const isAI =
  process.env.AI_OUTPUT === "1" || process.env.CLAUDECODE === "1";
const isCI = process.env.CI === "true";

function getReporters(): string[] {
  if (isCI) return ["dot", "github-actions"];
  if (isAI) return ["dot"];
  return ["default"];
}

export default defineConfig({
  test: {
    reporters: getReporters(),

    ...(isAI && {
      // Stop after 3 failures — cascading errors waste tokens
      bail: 3,

      // Suppress console.log output from test code
      onConsoleLog() {
        return false;
      },

      // Filter node_modules frames from stack traces
      onStackTrace(_error, { file }) {
        if (file.includes("node_modules")) return false;
      },

      // Truncate large diffs that would blow up context
      diff: {
        truncateThreshold: 2000,
        truncateAnnotation: "... diff truncated",
        expand: false,
      },
    }),
  },
});
```

**Why the `dot` reporter:** It prints one character per test (`.` for pass, `x` for fail) and only shows full details on failure. A 200-test passing suite becomes a single line of dots. This is a ~96% reduction in output volume compared to the default reporter. Crucially, failure details — assertion message, expected/received values, file location — are still printed in full.

**What each setting does:**

| Setting | Purpose |
|---------|---------|
| `reporters: ["dot"]` | One character per test. Full failure details preserved. |
| `bail: 3` | Stop after 3 failures. Prevents cascading errors from one root cause burning tokens. |
| `onConsoleLog() { return false; }` | Suppress `console.log` from test code. Tests often log debug info that is noise for an agent. |
| `onStackTrace` filter | Remove `node_modules` frames from stack traces. The agent only needs application code locations. |
| `diff.truncateThreshold: 2000` | Truncate snapshot/object diffs that exceed 2000 characters. |
| `diff.expand: false` | Show collapsed diffs (changed lines with context) rather than full objects. |

**CLI flag:** Add `--no-color` when running from scripts or `package.json`:

```json
{
  "test": "vitest run",
  "test:ai": "vitest run --no-color"
}
```

The reporter switching is automatic via `AI_OUTPUT=1` or the Claude-specific `CLAUDECODE=1` signal in the config.

**Output comparison:**

Default reporter (200 tests, 1 failure):
```
 ✓ src/lib/config.test.ts (3 tests) 12ms
 ✓ src/lib/state.test.ts (5 tests) 24ms
 ✓ src/lib/sessions.test.ts (8 tests) 31ms
 ... (47 more passing file lines)
 ✗ src/lib/prompt.test.ts (2 tests | 1 failed) 18ms
   ✗ should timeout after configured duration
     → expected 'running' to be 'timed_out'

 Test Files  1 failed | 49 passed (50)
 Tests  1 failed | 199 passed (200)
```

Dot reporter (same suite):
```
.....................................x.......
 FAIL  src/lib/prompt.test.ts > should timeout after configured duration
AssertionError: expected 'running' to be 'timed_out'
 - Expected: "timed_out"
 + Received: "running"

 Test Files  1 failed | 49 passed (50)
 Tests  1 failed | 199 passed (200)
```

### Jest

**AI-optimal configuration:**

Jest's `summary` reporter with `summaryThreshold: 0` is the closest equivalent to Vitest's `dot` reporter. It eliminates per-file PASS/FAIL lines while preserving full failure details.

```typescript
// jest.config.ts
const isAI =
  process.env.AI_OUTPUT === "1" || process.env.CLAUDECODE === "1";

export default {
  reporters: isAI
    ? [["summary", { summaryThreshold: 0 }]]
    : ["default"],
};
```

**Why `summary` with `summaryThreshold: 0`:** The default reporter prints a line for every test file — `PASS src/lib/config.test.ts`, `PASS src/lib/state.test.ts`, etc. For a 50-file suite with 1 failure, that's 49 useless PASS lines. The `summary` reporter skips all of that and only shows failure details plus the final count. The `summaryThreshold: 0` ensures failure details are always printed regardless of suite count (the default threshold is 20).

**CLI flags for AI mode:**

```bash
jest --silent --no-color --bail=3
```

| Flag | What it does |
|------|--------------|
| `--silent` | Suppress `console.log` from test code. |
| `--no-color` | Disable ANSI codes. |
| `--bail=3` | Stop after 3 failures. |

**Package.json script:**

```json
{
  "test": "jest",
  "test:ai": "jest --silent --no-color --bail=3"
}
```

**Output comparison:**

Default reporter (50 files, 1 failure):
```
 PASS src/lib/config.test.ts
 PASS src/lib/state.test.ts
 PASS src/lib/sessions.test.ts
 ... (46 more PASS lines)
 FAIL src/lib/prompt.test.ts
  ● should timeout after configured duration
    expect(received).toBe(expected)
    Expected: "timed_out"
    Received: "running"
      at Object.<anonymous> (src/lib/prompt.test.ts:42:5)

Test Suites: 1 failed, 49 passed, 50 total
Tests:       1 failed, 199 passed, 200 total
```

Summary reporter:
```
  ● src/lib/prompt.test.ts > should timeout after configured duration
    expect(received).toBe(expected)
    Expected: "timed_out"
    Received: "running"
      at Object.<anonymous> (src/lib/prompt.test.ts:42:5)

Test Suites: 1 failed, 49 passed, 50 total
Tests:       1 failed, 199 passed, 200 total
```

## Complete Project Setup

### 1. Create `CommandCenter.json`

Place this file in your project root to configure CC integration:

```json
{
  "validation": {
    "commands": {
      "format": {
        "command": {
          "full": "scripts/validate/format-full.sh",
          "changed": "scripts/validate/format-changed.sh"
        },
        "cost": 1,
        "pathArgs": "forbid"
      },
      "lint": {
        "command": {
          "full": "scripts/validate/lint-full.sh",
          "changed": "scripts/validate/lint-changed.sh"
        },
        "cost": 2,
        "pathArgs": "forbid"
      },
      "typecheck": {
        "command": {
          "full": "scripts/validate/typecheck.sh"
        },
        "cost": 2,
        "pathArgs": "forbid"
      },
      "test": {
        "command": {
          "full": "scripts/validate/test-full.sh",
          "changed": "scripts/validate/test-changed.sh"
        },
        "cost": 8,
        "pathArgs": "paths"
      }
    },
    "preMerge": ["format", "lint", "typecheck", "test"],
    "laneMerge": ["typecheck", "test"]
  }
}
```

This is the concrete `validation.commands` registry and its `validation.preMerge` policy. Adjust costs to the wrappers' fixed maximum resource use rather than copying the example blindly.

### 2. Create Granular Wrappers

Create fixed full and changed scripts where both modes are sound, and a full-only script where changed execution is not sound:

```bash
scripts/validate/format-full.sh
scripts/validate/format-changed.sh
scripts/validate/lint-full.sh
scripts/validate/lint-changed.sh
scripts/validate/typecheck.sh
scripts/validate/test-full.sh
scripts/validate/test-changed.sh
```

Each wrapper should use the AI-quiet pattern above: no output on success and complete, colorless diagnostics on failure. Pin test workers and register the same number as the command cost. Changed wrappers can use `TARGET_BRANCH`; full wrappers must cover the whole project. When the changed test wrapper accepts path arguments, use them only as test-file filters and set `pathArgs` to `"paths"`.

### 3. Set Up the Pre-Commit Hook

Using [Husky](https://typicode.github.io/husky/):

```bash
npx husky init
```

Then write your hook:

```bash
#!/bin/sh
# .husky/pre-commit
set -e

# Format and stage
npx prettier --write . > /dev/null 2>&1
git add -u

# Lint — AI mode suppresses warnings and colors
if [ "${AI_OUTPUT:-0}" = "1" ] || [ "${CLAUDECODE:-0}" = "1" ]; then
  npx eslint . --fix --quiet --no-color --no-warn-ignored
else
  npx eslint . --fix
fi
git add -u

# Type check — AI mode uses one-line-per-error format
if [ "${AI_OUTPUT:-0}" = "1" ] || [ "${CLAUDECODE:-0}" = "1" ]; then
  tsc --noEmit --pretty false
else
  tsc --noEmit --pretty
fi

# Tests — reporter switching handled in config
npx vitest run
```

### 4. Add AI Script Aliases

In `package.json`, add dedicated `:ai` variants for use in CI or agent workflows:

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:ai": "eslint . --quiet --no-color --no-warn-ignored",
    "test": "vitest run",
    "test:ai": "vitest run --no-color",
    "typecheck": "tsc --noEmit --pretty",
    "typecheck:ai": "tsc --noEmit --pretty false",
    "check:ai": "eslint . --quiet --no-color --no-warn-ignored && tsc --noEmit --pretty false && vitest run --no-color"
  }
}
```

### 5. Configure Test Runner

Add automatic AI detection to your test config. See the [Vitest](#vitest) or [Jest](#jest) sections above for the full configuration.

## Quick Reference

| Tool | Human Command | AI Command | Key Difference |
|------|--------------|------------|----------------|
| ESLint | `eslint .` | `eslint . --quiet --no-color --no-warn-ignored` | Errors only, no colors |
| TypeScript | `tsc --noEmit --pretty` | `tsc --noEmit --pretty false` | One line per error, no source snippets |
| Vitest | `vitest run` (default reporter) | `vitest run --no-color` (dot reporter via config) | 1 char per test, full failure detail |
| Jest | `jest` (default reporter) | `jest --silent --no-color --bail=3` (summary reporter via config) | No per-file PASS lines |
| Prettier | `prettier --write .` | `prettier --write . > /dev/null 2>&1` | Suppress file list |

## Environment Detection

The automatic switching relies on these environment variables:

| Variable | Set by | Value |
|----------|--------|-------|
| `AI_OUTPUT` | Project script, agent, or operator | Set to `"1"` to request backend-neutral low-noise output |
| `CLAUDECODE` | Claude Code | `"1"` in every spawned shell |
| `CI` | GitHub Actions, GitLab CI, CircleCI, etc. | `"true"` |

Use these in your configs to switch output modes without requiring manual flags:

```typescript
const isAI =
  process.env.AI_OUTPUT === "1" || process.env.CLAUDECODE === "1";
const isCI = process.env.CI === "true";
```

Use `AI_OUTPUT=1` when invoking a dedicated `:ai` script from an environment that provides no stable agent variable. Environment detection remains deterministic without coupling the validation contract to one backend.
