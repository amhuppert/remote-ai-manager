import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/nextjs-vite";

const loggingStub = fileURLToPath(
  new URL("./logging-stub.mjs", import.meta.url),
);

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

    // Pre-existing-blocker fix (not Tailwind): the `@/lib/logging` barrel pulls
    // server-only Node builtins (async_hooks/fs/crypto + the config loader) into
    // any component that logs, which breaks the browser bundle for every story
    // rendering such a component. Alias the barrel to a no-op browser stub so
    // the Storybook build resolves cleanly. Exact-match regex so deep paths
    // (`@/lib/logging/logger`) still hit the real `@`→src alias. Storybook-only.
    config.resolve ??= {};
    const existingAlias = config.resolve.alias;
    const aliasEntries = Array.isArray(existingAlias)
      ? existingAlias
      : Object.entries(existingAlias ?? {}).map(([find, replacement]) => ({
          find,
          replacement,
        }));
    config.resolve.alias = [
      { find: /^@\/lib\/logging$/, replacement: loggingStub },
      ...aliasEntries,
    ];

    return config;
  },
};
export default config;
