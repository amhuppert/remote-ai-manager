// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";
import css from "@eslint/css";
import betterTailwind from "eslint-plugin-better-tailwindcss";
import tailwindGuardrails from "./eslint-rules/tailwind-guardrails.mjs";

// Surfaces migrated to Tailwind utilities (utility-first BY DESIGN). The Tailwind
// guardrail rules apply ONLY here — they would false-positive on legacy
// BEM/conditional classNames that Stage A intentionally leaves untouched. Append
// a path as each feature wave migrates (mirrors the utility-collisions allowlist
// and the .prettierrc class-sort overrides).
const MIGRATED_UTILITY_FIRST = [
  "src/components/ui/**/*.{ts,tsx}",
  "src/features/projects-index/components/ProjectCard.tsx",
];

// Foundation/vendor areas where authored global CSS is allowed. Feature `styles/`
// dirs are deliberately NOT here — they are migration debt, so a NEW stylesheet
// there must fail the no-unapproved-global-css guardrail (globals.css/theme.css
// are the Tailwind directive entry points, ignored by the css block below).
const APPROVED_GLOBAL_CSS_AREAS = [
  "/features/_root/styles/", // foundation (tokens, reset, shell, typography, …)
  "/components/workflow-graph/", // React Flow vendor stylesheet
];

// Pre-existing legacy feature stylesheets, grandfathered as debt: they may keep
// their rules (the css:progress ratchet drives the counts down), but the guardrail
// blocks any NEW global CSS file. Do NOT add to this list to make room for new
// global CSS — migrate to utilities instead.
const GRANDFATHERED_LEGACY_CSS = [
  "/features/_root/spawn-card/spawn-card.css",
  "/features/config/styles/config-editor.css",
  "/features/project-detail/cockpit/styles/cockpit.css",
  "/features/project-detail/composer/styles/composer.css",
  "/features/project-detail/styles/project-detail.css",
  "/features/projects-index/styles/projects-index.css",
  "/features/session-diff/styles/session-diff.css",
  "/features/session-workflow/styles/session-workflow.css",
  "/features/session/sidebar/styles/PeekPopover.css",
  "/features/workflows-builder/styles/workflows-builder.css",
  "/features/workflows-catalog/styles/workflows-catalog.css",
];

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
  // Tailwind migration guardrails on migrated, utility-first surfaces (design 5.2;
  // R7.5/8.3). Plus eslint-plugin-better-tailwindcss for duplicate-class detection.
  {
    files: MIGRATED_UTILITY_FIRST,
    ignores: ["**/*.test.{ts,tsx}"],
    plugins: {
      "tailwind-guardrails": tailwindGuardrails,
      "better-tailwindcss": betterTailwind,
    },
    settings: {
      "better-tailwindcss": { entryPoint: "src/app/globals.css" },
    },
    rules: {
      "tailwind-guardrails/no-dynamic-class": "error",
      "tailwind-guardrails/no-hardcoded-color": "error",
      "tailwind-guardrails/no-appearance-in-layout-classname": "error",
      "better-tailwindcss/no-duplicate-classes": "error",
    },
  },
  // No new global CSS outside approved foundation/vendor areas (design 5.2; R8.4).
  // The Tailwind directive entry points (globals.css/theme.css) are ignored: they
  // are approved anyway and use @theme/@custom-variant syntax the CSS parser need
  // not understand.
  {
    files: ["**/*.css"],
    ignores: ["src/app/globals.css", "src/features/_root/styles/theme.css"],
    language: "css/css",
    languageOptions: { tolerant: true },
    plugins: { css, "tailwind-guardrails": tailwindGuardrails },
    rules: {
      "tailwind-guardrails/no-unapproved-global-css": [
        "error",
        {
          approvedAreas: APPROVED_GLOBAL_CSS_AREAS,
          grandfathered: GRANDFATHERED_LEGACY_CSS,
        },
      ],
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
