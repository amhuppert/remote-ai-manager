/**
 * Shared Vitest setup for unit tests.
 *
 * Logging is suppressed via CC_LOG_SILENT=1 env var (set in vitest.config.ts).
 * No vi.mock() calls needed — the real logging module is used but silenced.
 */
import "@testing-library/jest-dom/vitest";

// React Flow requires ResizeObserver which isn't available in jsdom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class IntersectionObserver {
    root = null;
    rootMargin = "";
    thresholds = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}
