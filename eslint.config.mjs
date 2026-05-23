// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "storybook-static/**",
    ".worktrees/**",
    "memory-bank/**",
    "redesign-session-page-handoff/**",
    "next-env.d.ts",
  ]),
  ...storybook.configs["flat/recommended"],
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
]);

export default eslintConfig;
