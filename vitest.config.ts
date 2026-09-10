import { defineConfig, type ConfigEnv } from "vitest/config";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepositoryTestProfileInventory } from "./scripts/test-profiles";
import { resolveWorkerBudget } from "./scripts/validate/worker-budget.mjs";

const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

// The authenticated acceptance suite (spec R14.2, D19). Its files are named
// apart from the unit corpus rather than merely placed apart, because the unit
// projects collect by filename: an acceptance file that landed in the unit
// suite would spend real credential and real money on every `test` run.
const testProfileInventory = buildRepositoryTestProfileInventory(dirname);
// The closing sweep scans everything the matrix produced, so it has to run
// after the cases that produce it. Ordering is stated here rather than left to
// directory traversal, and the project runs one file at a time.
const acceptanceTestFiles = [
  ...testProfileInventory.byProfile["browser-live-acceptance"],
].sort((left, right) => {
  const rank = (filePath: string): number =>
    path.basename(filePath).startsWith("final-") ? 1 : 0;
  return rank(left) - rank(right) || left.localeCompare(right);
});
const pureNodeTestFiles = [...testProfileInventory.byProfile["pure-node"]];
const nodeIntegrationTestFiles = [
  ...testProfileInventory.byProfile["node-integration"],
];
const domIntegrationTestFiles = [
  ...testProfileInventory.byProfile["dom-integration"],
];
const architectureToolchainTestFiles = [
  ...testProfileInventory.byProfile["architecture-toolchain"],
];

// Worker parallelism is bounded by RAM, not just core count — see
// `scripts/validate/worker-budget.mjs`, which owns that policy for this config
// and for the validation launcher alike. The unit projects use Node or jsdom,
// so ~1.5 GB per worker is ample.
const WORKER_HEAP_MB = 1536;
const COORDINATOR_HEAP_MB = 3072;
const maxForks = resolveWorkerBudget({
  coordinatorHeapMb: COORDINATOR_HEAP_MB,
  workerHeapMb: WORKER_HEAP_MB,
  totalMemoryBytes: os.totalmem(),
  availableParallelism: os.availableParallelism(),
});

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

// Storybook tests — runs *.stories.* in a headless browser. Requires a
// browser and port binding; disabled in sandboxed/AI/CI environments. Enable
// with VITEST_STORYBOOK=1. The plugin is imported only then: loading it costs
// over half a second on every Vitest start, including single-file runs.
async function resolveStorybookProjects() {
  if (process.env.VITEST_STORYBOOK !== "1") return [];
  const { storybookTest } =
    await import("@storybook/addon-vitest/vitest-plugin");
  return [
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
  ];
}

export default async function resolveConfig(_env: ConfigEnv) {
  const storybookProjects = await resolveStorybookProjects();
  return defineConfig({
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
        "**/.ds-sync/**",
        "**/ds-bundle/**",
        "**/claude-design/**",
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
        {
          extends: true,
          test: {
            name: "unit-pure",
            environment: "node",
            include: pureNodeTestFiles,
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
            include: nodeIntegrationTestFiles,
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
            include: domIntegrationTestFiles,
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
            name: "unit-architecture",
            environment: "node",
            include: architectureToolchainTestFiles,
            setupFiles: [
              "vitest.node.setup.ts",
              "vitest.architecture.setup.ts",
            ],
            testTimeout: 15000,
            env: {
              CC_LOG_SILENT: "1",
            },
          },
        },
        // The authenticated Cursor acceptance suite. Reached only through the
        // registered `cursor-acceptance` command, which gates on CURSOR_API_KEY
        // before Vitest starts; nothing selects this project by default.
        //
        // Logging is deliberately NOT silenced here: the suite reads its own log
        // files back and scans them for credential material, which a silenced
        // logger would turn into a vacuously clean scan. Timeouts are minutes,
        // not seconds, because every case is a live model turn.
        {
          extends: true,
          test: {
            name: "cursor-acceptance",
            environment: "node",
            include: acceptanceTestFiles,
            setupFiles: ["vitest.node.setup.ts"],
            testTimeout: 300_000,
            hookTimeout: 300_000,
          },
        },
        ...storybookProjects,
      ],
    },
  });
}
