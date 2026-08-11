import { fileURLToPath } from "node:url";

/**
 * The module boundaries the Storybook browser build cuts, and the browser-safe
 * stubs it substitutes.
 *
 * One owner for two readers: `main.ts` feeds these to Vite's resolver, and
 * `src/test/story-browser-safety.architecture.test.ts` replays them when it
 * walks story import graphs looking for Node builtins. A cut recorded in only
 * one of those places would either break stories the guard calls safe or make
 * the guard demand a split the build already handles.
 *
 * A cut is the fallback, not the remedy. Prefer keeping the builtin out of the
 * shared module — schemas and pure logic browser-safe, hashing and filesystem
 * work in a server-side sibling. Stub only where the server subtree is the
 * module's whole point, as with logging.
 */
export interface StorybookBrowserAlias {
  /** Matched against the raw specifier, so exact-match anchors are required. */
  readonly find: RegExp;
  /** Absolute path to the browser-safe stub Vite resolves the match to. */
  readonly replacement: string;
}

export const storybookBrowserAliases: readonly StorybookBrowserAlias[] = [
  {
    // The `@/lib/logging` barrel re-exports the AsyncLocalStorage trace context
    // (`node:async_hooks`), the filesystem log writer, and the config loader.
    // Every component logs, so without this cut essentially no story renders.
    // Exact-match so deep paths (`@/lib/logging/logger`) still hit `@`→src.
    find: /^@\/lib\/logging$/,
    replacement: fileURLToPath(new URL("./logging-stub.mjs", import.meta.url)),
  },
];
