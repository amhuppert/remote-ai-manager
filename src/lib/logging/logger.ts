/**
 * Structured NDJSON logger with AsyncLocalStorage trace context enrichment.
 *
 * Each log call emits a single JSON line to the log file.
 * Trace context (traceId, action, projectName, sessionName) is
 * automatically read from AsyncLocalStorage when available.
 *
 * Configuration:
 * - CSM_LOG_LEVEL: "debug" | "info" | "warn" | "error" (default: "info")
 * - CSM_LOG_FILE: absolute path to log file (default: <config-dir>/csm-debug.log)
 *
 * The logger never throws — failed writes are silently dropped.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { getTraceContext } from "./context";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const VALID_LEVELS = new Set<string>(Object.keys(LOG_LEVELS));

/** Resolve the configured log level, falling back to "info" on invalid values */
function resolveLogLevel(): LogLevel {
  const env = process.env["CSM_LOG_LEVEL"];
  if (env && VALID_LEVELS.has(env)) {
    return env as LogLevel;
  }
  if (env) {
    // Invalid value — warn on stderr and fall back
    process.stderr.write(
      `[csm] Invalid CSM_LOG_LEVEL="${env}", falling back to "info"\n`,
    );
  }
  return "info";
}

/**
 * Resolve the log file path.
 * Uses CSM_LOG_FILE env var if set, otherwise derives from config directory.
 *
 * Since readConfig() is async and we need sync file writes,
 * we resolve the config directory path directly (same logic as config.ts).
 */
function resolveLogFilePath(): string {
  const envPath = process.env["CSM_LOG_FILE"];
  if (envPath) {
    return envPath;
  }

  // Derive config dir using same logic as config.ts
  const platform = process.platform;
  let configDir: string;
  if (platform === "darwin") {
    configDir = path.join(
      process.env["HOME"] ?? "/tmp",
      "Library",
      "Application Support",
      "csm",
    );
  } else {
    const xdg = process.env["XDG_CONFIG_HOME"];
    configDir = xdg
      ? path.join(xdg, "csm")
      : path.join(process.env["HOME"] ?? "/tmp", ".config", "csm");
  }

  return path.join(configDir, "csm-debug.log");
}

// Lazy-initialized state (resolved on first log call)
let logLevel: LogLevel | undefined;
let logFilePath: string | undefined;
let initialized = false;

/** Initialize logger state (once guard) */
function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  logLevel = resolveLogLevel();
  logFilePath = resolveLogFilePath();

  // Ensure parent directory exists
  try {
    const dir = path.dirname(logFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Silent — if we can't create the dir, writes will fail silently later
  }
}

/** Check if a log level passes the current filter */
function shouldLog(level: LogLevel): boolean {
  ensureInitialized();
  return LOG_LEVELS[level] >= LOG_LEVELS[logLevel!];
}

/** Build a log entry with trace context and additional fields */
function buildEntry(
  level: LogLevel,
  module: string,
  message: string,
  fields?: Record<string, unknown>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
  };

  // Auto-enrich from ALS trace context
  const ctx = getTraceContext();
  if (ctx) {
    entry["traceId"] = ctx.traceId;
    if (ctx.action) entry["action"] = ctx.action;
    if (ctx.projectName) entry["projectName"] = ctx.projectName;
    if (ctx.sessionName) entry["sessionName"] = ctx.sessionName;
  }

  // Merge additional fields
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        // Preserve full error stack traces
        if (value instanceof Error) {
          entry[key] = value.message;
          if (value.stack) {
            entry["stack"] = value.stack;
          }
        } else {
          entry[key] = value;
        }
      }
    }
  }

  return entry;
}

/** Write a single NDJSON line to the log file */
function writeEntry(entry: Record<string, unknown>): void {
  try {
    ensureInitialized();
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(logFilePath!, line, "utf-8");
  } catch {
    // Never throw — silently drop on write failure
  }
}

/** Write to stderr for warn/error level entries */
function writeStderr(entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify(entry) + "\n";
    process.stderr.write(line);
  } catch {
    // Never throw
  }
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Create a module-scoped logger */
export function createLogger(module: string): Logger {
  function log(
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (!shouldLog(level)) return;

    const entry = buildEntry(level, module, message, fields);
    writeEntry(entry);

    // Also write warn/error to stderr
    if (level === "warn" || level === "error") {
      writeStderr(entry);
    }
  }

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}

/**
 * Reset logger state (for testing only).
 * Allows tests to re-initialize with different env vars.
 */
export function _resetLoggerForTesting(): void {
  initialized = false;
  logLevel = undefined;
  logFilePath = undefined;
}
