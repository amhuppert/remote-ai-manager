# AI-Optimal Test Runner Configuration

## Environment Detection

Claude Code sets `CLAUDECODE=1` in every spawned shell. CI systems set `CI=true`. Use these for automatic output switching:

```typescript
const isAI = process.env.CLAUDECODE === "1";
const isCI = process.env.CI === "true";
```

This is deterministic — the right output mode is selected automatically without manual flags.

## Core Principles

1. **Suppress success output** — passing tests are noise. Only failures matter.
2. **Preserve failure details** — full error messages, file locations, expected/received values.
3. **Strip ANSI color codes** — `--no-color` flags.
4. **Bail early** — stop after a few failures. Cascading errors waste tokens.
5. **Truncate large diffs** — the agent can read source files directly.

## Vitest Configuration

Add this to `vitest.config.ts`:

```typescript
const isAI = process.env.CLAUDECODE === "1";
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

      // Truncate large diffs
      diff: {
        truncateThreshold: 2000,
        truncateAnnotation: "... diff truncated",
        expand: false,
      },
    }),
  },
});
```

**What each setting does:**

| Setting | Purpose |
|---|---|
| `reporters: ["dot"]` | One character per test (`.` pass, `x` fail). Full failure details preserved. ~96% output reduction. |
| `bail: 3` | Stop after 3 failures. Prevents cascading errors from burning tokens. |
| `onConsoleLog() { return false; }` | Suppress `console.log` from test code. |
| `onStackTrace` filter | Remove `node_modules` frames from stack traces. |
| `diff.truncateThreshold: 2000` | Truncate snapshot/object diffs exceeding 2000 chars. |
| `diff.expand: false` | Collapsed diffs (changed lines with context) rather than full objects. |

**CLI flag:** Add `--no-color` when running from scripts:

```json
{
  "test": "vitest run",
  "test:ai": "vitest run --no-color"
}
```

## Jest Configuration

Add this to `jest.config.ts`:

```typescript
const isAI = process.env.CLAUDECODE === "1";

export default {
  reporters: isAI
    ? [["summary", { summaryThreshold: 0 }]]
    : ["default"],
};
```

The `summary` reporter with `summaryThreshold: 0` eliminates per-file PASS/FAIL lines while preserving full failure details.

**CLI flags:**

```bash
jest --silent --no-color --bail=3
```

| Flag | Purpose |
|---|---|
| `--silent` | Suppress `console.log` from test code |
| `--no-color` | Disable ANSI codes |
| `--bail=3` | Stop after 3 failures |

**Package.json:**

```json
{
  "test": "jest",
  "test:ai": "jest --silent --no-color --bail=3"
}
```

## Integration Pattern

When adding AI detection to an **existing** config file, preserve the existing configuration and wrap AI-specific settings conditionally:

```typescript
// Existing config stays as-is
export default defineConfig({
  test: {
    // ... existing settings preserved ...

    // ADD: AI-optimal output
    reporters: getReporters(),
    ...(isAI && {
      bail: 3,
      onConsoleLog() { return false; },
      onStackTrace(_error, { file }) {
        if (file.includes("node_modules")) return false;
      },
      diff: { truncateThreshold: 2000, truncateAnnotation: "... diff truncated", expand: false },
    }),
  },
});
```

The `isAI` conditional ensures these settings only apply when Claude Code is running — human development is unaffected.

## ESLint AI-Optimal Flags

For completeness, ESLint AI-optimal flags for pre-merge scripts:

```bash
eslint . --fix --quiet --no-color --no-warn-ignored
```

| Flag | Purpose |
|---|---|
| `--quiet` | Errors only, suppress warnings |
| `--no-color` | Disable ANSI codes |
| `--no-warn-ignored` | Suppress "file ignored" messages |

## TypeScript AI-Optimal Flags

```bash
tsc --noEmit --pretty false
```

`--pretty false` produces one-line-per-error format (~7x reduction vs. default).
