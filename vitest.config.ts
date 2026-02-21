import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";

const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

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
    globals: true,
    exclude: ["**/node_modules/**", "**/.worktrees/**", "**/dist/**"],
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
