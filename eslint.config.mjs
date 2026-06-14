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
    "command-center-multi-tasking-ui-improvements/**",
    "next-env.d.ts",
  ]),
  ...storybook.configs["flat/recommended"],
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    files: [
      "src/lib/workflows/collaboration/workflow-envelope.ts",
      "src/lib/workflows/collaboration/workflow-envelope.test.ts",
      "src/lib/workflows/collaboration/feature-snapshot.ts",
      "src/lib/workflows/collaboration/feature-snapshot.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/workflows/primitives/human-approval-gate",
              message:
                "Workflow-scoped collaboration must NEVER pause for user input. Report requires_user_input as a structured result instead. See design §Workflow Collaboration Envelope and Requirement 4.1.",
            },
            {
              name: "@/lib/workflows/collaboration/envelope",
              message:
                "Workflow-scoped collaboration must not couple to the user-triggered envelope. Duplicate the round/collaborator-invocation logic locally per design §Envelope Extraction Decision.",
            },
          ],
          patterns: [
            {
              group: [
                "**/workflows/primitives/human-approval-gate",
                "**/workflows/primitives/human-approval-gate.*",
              ],
              message:
                "Workflow-scoped collaboration must NEVER pause for user input. Report requires_user_input as a structured result instead.",
            },
            {
              group: [
                "**/workflows/collaboration/envelope",
                "**/workflows/collaboration/envelope.*",
              ],
              message:
                "Workflow-scoped collaboration must not couple to the user-triggered envelope.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
