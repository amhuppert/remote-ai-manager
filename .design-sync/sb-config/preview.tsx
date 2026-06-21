import type { Preview } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import basePreview from "../../.storybook/preview";
// Defines --font-anybody/manrope/geist-mono (next/font injects these at runtime
// in the app; stories don't render RootLayout). Imported here so they compile
// into the reference CSS and get scraped into _ds_bundle.css for the DS bundle —
// without them the `var(--font-*), "…"` token chain is guaranteed-invalid.
import "../fonts/brand-vars.css";

// Scoped Storybook preview for /design-sync. Inherits the real preview's
// parameters + the `globals.css` (Tailwind v4) side-effect import (via the
// basePreview module evaluation), but REPLACES the decorator chain: the real
// preview renders <TooltipProvider/>, which unconditionally portals a
// position:fixed node to document.body. In the DS grid card that node escapes
// every cell → [GRID_OVERFLOW] "escape" on all components. None of the 22
// in-scope components use react-query or the tooltip provider for static
// rendering, so the QueryClientProvider here is harmless safety and the tooltip
// portal is dropped. The reference build uses this same preview, so reference
// and DS previews stay matched for grading.

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const preview: Preview = {
  ...basePreview,
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <Story />
      </QueryClientProvider>
    ),
  ],
};

export default preview;
