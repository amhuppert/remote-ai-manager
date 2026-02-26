import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";

const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

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
          include: ["src/**/*.test.{ts,tsx}"],
          testTimeout: 15000,
        },
      },
      // Storybook tests — runs *.stories.* in a headless browser
      {
        extends: true,
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
            provider: "playwright",
            instances: [{ browser: "chromium" }],
          },
          setupFiles: [".storybook/vitest.setup.ts"],
        },
      },
    ],
  },
});
