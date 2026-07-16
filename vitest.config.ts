import { defineConfig } from "vitest/config";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";

const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|mjs)$/;
const JSDOM_DIRECTIVE_PATTERN = /^\/\/ @vitest-environment jsdom\s*$/m;

function collectTestFiles(directory: string): string[] {
  const absoluteDirectory = path.join(dirname, directory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTestFiles(relativePath);
      if (!entry.isFile() || !TEST_FILE_PATTERN.test(entry.name)) return [];
      return [relativePath.split(path.sep).join("/")];
    },
  );
}

const unitTestFiles = ["src", "scripts", "eslint-rules"].flatMap(
  collectTestFiles,
);
const jsdomTestFiles = unitTestFiles.filter((filePath) =>
  JSDOM_DIRECTIVE_PATTERN.test(
    readFileSync(path.join(dirname, filePath), "utf8"),
  ),
);
const jsdomTestFileSet = new Set(jsdomTestFiles);
const nodeTestFiles = unitTestFiles.filter(
  (filePath) => !jsdomTestFileSet.has(filePath),
);

// Bound worker parallelism to available RAM, not just core count. Vitest's
// default forks pool spawns one worker per CPU core with no heap cap; on a
// high-core / low-RAM machine that fans out to N heavyweight Node processes at
// once, which can exhaust RAM + swap during a full-suite (e.g. pre-merge
// validation) run and freeze the machine. The unit projects use Node or jsdom,
// so ~1.5 GB per worker is ample; budgeting that heap
// against ~55% of total RAM keeps low-RAM machines at the 2-worker floor while
// letting high-RAM / high-core machines use more parallelism (e.g. 16 GB / 16
// cores -> 5 workers) at a *lower* total heap footprint than the old 2 GB
// budget — so the change adds throughput without raising peak memory pressure.
const GB = 1024 ** 3;
const WORKER_HEAP_MB = 1536;
const maxForks = Math.max(
  2,
  Math.min(
    os.availableParallelism(),
    Math.floor(((os.totalmem() / GB) * 0.55) / (WORKER_HEAP_MB / 1024)),
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
    exclude: [
      "**/node_modules/**",
      "**/.design-sync/**",
      "**/.worktrees/**",
      "**/dist/**",
    ],

    pool: "forks",
    poolOptions: {
      forks: {
        maxForks,
        minForks: 1,
        // Cap each worker's heap so a single runaway file OOM-kills its own
        // fork (bounded) instead of growing unbounded across the machine. Kept
        // in sync with the RAM budget used to derive `maxForks` above.
        execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
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

    projects: [
      // Compatibility alias for callers that still filter `--project unit`.
      // The explicit node/jsdom shards remain the primary validation entrypoints.
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: unitTestFiles,
          setupFiles: ["vitest.jsdom.setup.ts"],
          testTimeout: 15000,
          env: {
            CC_LOG_SILENT: "1",
          },
        },
      },
      {
        extends: true,
        test: {
          name: "unit-node",
          environment: "node",
          include: nodeTestFiles,
          setupFiles: ["vitest.node.setup.ts"],
          testTimeout: 15000,
          env: {
            CC_LOG_SILENT: "1",
          },
        },
      },
      {
        extends: true,
        test: {
          name: "unit-jsdom",
          environment: "jsdom",
          include: jsdomTestFiles,
          setupFiles: ["vitest.jsdom.setup.ts"],
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
