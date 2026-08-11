import type { StorybookConfig } from "@storybook/nextjs-vite";

import { storybookBrowserAliases } from "./browser-aliases";

const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-vitest",
    "@storybook/addon-onboarding",
    "@chromatic-com/storybook",
  ],
  framework: "@storybook/nextjs-vite",
  staticDirs: ["../public"],
  async viteFinal(config) {
    config.server ??= {};
    config.server.allowedHosts = true;

    // Tailwind v4 for Storybook: the Vite plugin processes the
    // `@import "tailwindcss/..."` layer imports + `@theme` in globals.css
    // (imported by preview.tsx), so stories get the same theme + utilities as
    // the Next app. Dynamic import avoids ESM startup issues in main.ts.
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    config.plugins ??= [];
    config.plugins.push(tailwindcss());

    // Server subtrees the browser build cannot carry, cut to browser-safe
    // stubs. The table lives in `./browser-aliases.mjs` because the story
    // import-graph guard replays the same cuts; see that file for why a cut is
    // the fallback rather than the remedy. Storybook-only — production,
    // `next build`, and `tsc` all use the real modules.
    config.resolve ??= {};
    const existingAlias = config.resolve.alias;
    const aliasEntries = Array.isArray(existingAlias)
      ? existingAlias
      : Object.entries(existingAlias ?? {}).map(([find, replacement]) => ({
          find,
          replacement,
        }));
    config.resolve.alias = [...storybookBrowserAliases, ...aliasEntries];

    return config;
  },
};
export default config;
