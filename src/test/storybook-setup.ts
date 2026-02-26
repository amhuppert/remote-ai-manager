/**
 * Shared portable-stories setup for unit tests that use composeStories.
 *
 * Usage in a test file:
 *   import { beforeAll } from "vitest";
 *   import { storybookAnnotations } from "@/test/storybook-setup";
 *   beforeAll(storybookAnnotations.beforeAll);
 */
// Use @storybook/react (not @storybook/nextjs-vite) because the nextjs-vite
// entry point imports browser-only virtual modules (sb-original) that don't
// resolve in Node/jsdom. The renderer's portable-stories API is identical.
import "@testing-library/jest-dom/vitest";
import { setProjectAnnotations } from "@storybook/react";

// react-syntax-highlighter calls HTMLCanvasElement.getContext() internally.
// JSDOM doesn't implement it, so stub it to suppress the "Not implemented" warning.
HTMLCanvasElement.prototype.getContext = () => null;
import * as a11yAnnotations from "@storybook/addon-a11y/preview";
import * as previewAnnotations from "../../.storybook/preview";

export const storybookAnnotations = setProjectAnnotations([
  a11yAnnotations,
  previewAnnotations,
]);
