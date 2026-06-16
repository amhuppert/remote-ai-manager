/**
 * Browser stub for `@/lib/logging`, used ONLY by the Storybook build.
 *
 * The real logging barrel re-exports server-only code — AsyncLocalStorage trace
 * context (`node:async_hooks`), the file-system log writer (`node:fs`,
 * `node:crypto`), and the config loader — which cannot run in Storybook's
 * browser bundle. Any story that renders a component calling `createLogger()`
 * (mandated project-wide) transitively pulls that server subtree in and the
 * Rollup browser build fails (`AsyncLocalStorage is not exported by
 * __vite-browser-external:node:async_hooks`). This is a pre-existing condition
 * (the Storybook build is not in the pre-merge gate, so it went unnoticed);
 * it surfaced while integrating Tailwind and is unrelated to it.
 *
 * Aliasing `@/lib/logging` to this no-op in `.storybook/main.ts` cuts the whole
 * server subtree at the logging boundary so stories bundle cleanly. Logging is
 * meaningless in Storybook, so a no-op is the correct behavior. Production,
 * `next build`, and `tsc` all use the real module unchanged — this alias exists
 * only inside the Storybook Vite config.
 *
 * Mirrors the value exports of `src/lib/logging/index.ts` (types are erased
 * before bundling, so they are not needed here).
 */

const noop = () => {};

export function createLogger() {
  return { debug: noop, info: noop, warn: noop, error: noop };
}

export function runWithTrace(_context, fn) {
  return fn();
}

export function getTraceContext() {
  return undefined;
}

export function captureTraceContext() {
  return null;
}

export function runAsTrace(_action, fn) {
  return fn();
}

export function withTracing(handler) {
  return handler;
}

export function timed(_logger, _event, _fields, fn) {
  return fn();
}
