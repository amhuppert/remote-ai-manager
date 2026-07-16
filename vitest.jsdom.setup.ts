import "./vitest.setup";
import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";

// Canonical Markdown surfaces render through a deferred (dynamic-import) adapter
// that paints a `data-markdown-fallback` placeholder first, so `waitFor`/`findBy`
// must survive the renderer's cold import. Under full-suite fork contention that
// import routinely exceeds Testing Library's 1s async default, causing flaky
// misses on the fallback. Raise the async-util budget well below the 15s
// testTimeout so a genuine hang still fails the test, not the whole suite.
configure({ asyncUtilTimeout: 10000 });

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

// Radix UI primitives (DropdownMenu / Select / …) call these DOM methods when a
// menu/listbox opens; jsdom implements none of them. Guard on Element so the
// setup can also load under the legacy compatibility `unit` project, whose
// non-jsdom tests run in Node.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.hasPointerCapture = function () {
    return false;
  };
  Element.prototype.setPointerCapture = function () {};
  Element.prototype.releasePointerCapture = function () {};
}
