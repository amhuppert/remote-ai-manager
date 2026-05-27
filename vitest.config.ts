import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";

const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

// Bound worker parallelism to available RAM, not just core count. Vitest's
// default forks pool spawns one worker per CPU core with no heap cap; on a
// high-core / low-RAM machine that fans out to N heavyweight Node processes at
// once (each loads the full app module graph + jsdom), which can exhaust
// RAM + swap during a full-suite (e.g. pre-merge validation) run and freeze
// the machine. Budget ~2 GB per worker against ~60% of total RAM, clamped to
// [2, cores].
const GB = 1024 ** 3;
const maxForks = Math.max(
  2,
  Math.min(
    os.availableParallelism(),
    Math.floor(((os.totalmem() / GB) * 0.6) / 2),
  ),
);

// Claude Code sets CLAUDECODE=1 in every shell it spawns.
// Use the minimal `dot` reporter to reduce test output by ~96%,
// printing one char per test and only showing details on failure.
const isAI = process.env.CLAUDECODE === "1";
const isCI = process.env.CI === "true";

function getReporters(): string[] {
  if (isCI) return ["dot", "github-actions"];
  if (isAI) return ["dot"];
  return ["default"];
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
      // Storybook 10 moved @storybook/test to storybook/test. Story files
      // import from @storybook/test so we alias it for the unit workspace.
      "@storybook/test": "storybook/test",
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    reporters: getReporters(),
    globals: true,
    exclude: ["**/node_modules/**", "**/.worktrees/**", "**/dist/**"],

    pool: "forks",
    poolOptions: {
      forks: {
        maxForks,
        minForks: 1,
        // Cap each worker's heap so a single runaway file OOM-kills its own
        // fork (bounded) instead of growing unbounded across the machine.
        execArgv: ["--max-old-space-size=2048"],
      },
    },

    // AI-specific noise reduction: stop early, suppress console output,
    // filter node_modules from stack traces, and truncate large diffs.
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

    workspace: [
      // Unit tests — runs existing *.test.ts files in Node/jsdom
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],
          setupFiles: ["vitest.setup.ts"],
          testTimeout: 15000,
          env: {
            CC_LOG_SILENT: "1",
          },
        },
      },
      // Storybook tests — runs *.stories.* in a headless browser.
      // Requires a browser and port binding; disabled in sandboxed/AI/CI
      // environments. Enable with VITEST_STORYBOOK=1.
      ...(process.env.VITEST_STORYBOOK === "1"
        ? [
            {
              extends: true as const,
              plugins: [
                storybookTest({
                  configDir: path.join(dirname, ".storybook"),
                }),
              ],
              test: {
                name: "storybook",
                browser: {
                  enabled: true,
                  headless: true,
                  provider: "playwright" as const,
                  instances: [{ browser: "chromium" }],
                },
                setupFiles: [".storybook/vitest.setup.ts"],
              },
            },
          ]
        : []),
    ],
  },
});
