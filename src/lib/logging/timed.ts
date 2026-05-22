/**
 * Generic timing wrapper for operations that may take significant time.
 *
 * `timed()` / `timedSync()` log an operation's duration via the project logger.
 * Trace context propagates automatically through AsyncLocalStorage, so every
 * timed operation inherits the active traceId, action, projectName, sessionName.
 *
 * Event naming convention: pass a base name like `git.diff`; the wrapper emits
 * `<base>.start` (optional), `<base>.complete`, `<base>.error`.
 *
 * Level by duration:
 *   durationMs >= CC_TIMING_WARN_MS (default 1000)  -> warn
 *   durationMs >= CC_TIMING_INFO_MS (default 50)    -> info
 *   otherwise                                       -> debug
 *
 * `<base>.start` is emitted at debug only when CC_TIMING_START === "1"
 * (off by default to halve log volume on hot paths).
 *
 * Errors thrown by `fn` are logged at warn with `<base>.error` and re-thrown.
 */

import type { Logger, LogLevel } from "./logger";

const DEFAULT_INFO_MS = 50;
const DEFAULT_WARN_MS = 1000;

let cachedInfoMs: number | undefined;
let cachedWarnMs: number | undefined;
let cachedStartEnabled: boolean | undefined;

function readNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

function getInfoMs(): number {
  if (cachedInfoMs === undefined) {
    cachedInfoMs = readNumberEnv("CC_TIMING_INFO_MS", DEFAULT_INFO_MS);
  }
  return cachedInfoMs;
}

function getWarnMs(): number {
  if (cachedWarnMs === undefined) {
    cachedWarnMs = readNumberEnv("CC_TIMING_WARN_MS", DEFAULT_WARN_MS);
  }
  return cachedWarnMs;
}

function getStartEnabled(): boolean {
  if (cachedStartEnabled === undefined) {
    cachedStartEnabled = process.env["CC_TIMING_START"] === "1";
  }
  return cachedStartEnabled;
}

function levelForDuration(durationMs: number): LogLevel {
  if (durationMs >= getWarnMs()) return "warn";
  if (durationMs >= getInfoMs()) return "info";
  return "debug";
}

function emit(
  logger: Logger,
  level: LogLevel,
  message: string,
  fields: Record<string, unknown>,
): void {
  switch (level) {
    case "debug":
      logger.debug(message, fields);
      return;
    case "info":
      logger.info(message, fields);
      return;
    case "warn":
      logger.warn(message, fields);
      return;
    case "error":
      logger.error(message, fields);
      return;
  }
}

/**
 * Time an async operation. Emits `<event>.complete` (level by threshold) on
 * success, `<event>.error` (warn) on throw. Re-throws the original error.
 *
 * `resultFields` lets the caller derive additional fields from the resolved
 * value (e.g., `messageCount`, `fileCount`) to attach to the `.complete` log.
 * It is not called on error.
 */
export async function timed<T>(
  logger: Logger,
  event: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
  resultFields?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const start = Date.now();

  if (getStartEnabled()) {
    logger.debug(`${event}.start`, { ...fields });
  }

  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    const extra = resultFields ? resultFields(result) : {};
    emit(logger, levelForDuration(durationMs), `${event}.complete`, {
      ...fields,
      ...extra,
      durationMs,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.warn(`${event}.error`, {
      ...fields,
      durationMs,
      error: err instanceof Error ? err : String(err),
    });
    throw err;
  }
}

/** Synchronous variant of `timed()`. */
export function timedSync<T>(
  logger: Logger,
  event: string,
  fields: Record<string, unknown>,
  fn: () => T,
  resultFields?: (result: T) => Record<string, unknown>,
): T {
  const start = Date.now();

  if (getStartEnabled()) {
    logger.debug(`${event}.start`, { ...fields });
  }

  try {
    const result = fn();
    const durationMs = Date.now() - start;
    const extra = resultFields ? resultFields(result) : {};
    emit(logger, levelForDuration(durationMs), `${event}.complete`, {
      ...fields,
      ...extra,
      durationMs,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.warn(`${event}.error`, {
      ...fields,
      durationMs,
      error: err instanceof Error ? err : String(err),
    });
    throw err;
  }
}

/** Reset cached env-var reads (testing only). */
export function _resetTimedForTesting(): void {
  cachedInfoMs = undefined;
  cachedWarnMs = undefined;
  cachedStartEnabled = undefined;
}
