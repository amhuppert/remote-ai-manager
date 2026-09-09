import "./vitest.setup";
import { expect } from "vitest";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { configure } from "@testing-library/dom";

// Register jest-dom against the `expect` this setup file resolves, rather than
// importing "@testing-library/jest-dom/vitest". That entry does its own
// `import { expect } from "vitest"`, and Vite externalizes it, so it binds to
// whichever physical vitest copy sits nearest the config root. A session
// worktree carries its own node_modules (worktree-init.sh runs `bun install`)
// while the validation wrapper executes the main worktree's launcher, so the
// runner and that entry can resolve two different vitest/chai instances —
// jest-dom then extends a chai the tests never assert through, and every
// matcher fails as `Invalid Chai property: toBeInTheDocument`. The matchers
// module is pure (no vitest import), so extending it here always lands on the
// instance the tests use.
expect.extend(jestDomMatchers);

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
// menu/listbox opens; jsdom implements none of them. Guard on Element so this
// setup remains safe to load in a Node diagnostic.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.hasPointerCapture = function () {
    return false;
  };
  Element.prototype.setPointerCapture = function () {};
  Element.prototype.releasePointerCapture = function () {};
}
