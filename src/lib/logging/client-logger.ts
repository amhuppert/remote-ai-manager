/**
 * Client-safe structured logger.
 *
 * The server logger (`createLogger` from `@/lib/logging`) enriches every line
 * with AsyncLocalStorage trace context and writes NDJSON to disk — it statically
 * imports `node:async_hooks` and the filesystem, so it must NEVER enter a client
 * bundle (Turbopack rejects `node:` externals in the browser chunk). Client code
 * logs through this shim instead, which keeps the same `(event, payload)` call
 * shape but emits to the browser console (mirroring `tracedFetch`'s
 * `console.debug("api.fetch", …)`). Correlate by the event name + payload.
 */
export interface ClientLogger {
  debug(event: string, payload?: Record<string, unknown>): void;
  info(event: string, payload?: Record<string, unknown>): void;
  warn(event: string, payload?: Record<string, unknown>): void;
  error(event: string, payload?: Record<string, unknown>): void;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(
  level: Level,
  module: string,
  event: string,
  payload?: Record<string, unknown>,
): void {
  console[level](event, { module, ...(payload ?? {}) });
}

/**
 * Create a client logger scoped to a module name (e.g. `"document-feedback-send"`).
 * The module is attached to every payload so client logs stay attributable.
 */
export function createClientLogger(module: string): ClientLogger {
  return {
    debug: (event, payload) => emit("debug", module, event, payload),
    info: (event, payload) => emit("info", module, event, payload),
    warn: (event, payload) => emit("warn", module, event, payload),
    error: (event, payload) => emit("error", module, event, payload),
  };
}
