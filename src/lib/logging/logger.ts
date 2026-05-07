/**
 * Structured NDJSON logger with AsyncLocalStorage trace context enrichment.
 *
 * Each log call emits a single JSON line to a file resolved at write time
 * from the active TraceContext.
 *
 * Routing policy (when CC_LOG_FILE is unset and CC_LOG_SCOPED !== "0"):
 *   - <config-dir>/logs/global.log                                              (default + fallback)
 *   - <config-dir>/logs/sessions/<projectSlug>__<sessionSlug>/session.log       (project + session)
 *   - <config-dir>/logs/sessions/<projectSlug>__<sessionSlug>/conversations/<conversationSlug>.log
 *                                                                               (project + session + conversation)
 *
 * Resolution priority: conversation > session > global. The dynamic path components
 * (projectSlug, sessionSlug, conversationSlug) are sanitized on every call.
 *
 * Documented exception — request.start / request.complete from the "tracing"
 * module are written to BOTH the scoped destination AND the global log so
 * operators retain a chronological cross-session timeline.
 *
 * Configuration:
 * - CC_LOG_LEVEL: "debug" | "info" | "warn" | "error" (default: "info")
 * - CC_LOG_FILE: explicit single-file destination (overrides scoped routing)
 * - CC_LOG_SCOPED: "0" disables scoped routing (everything → global.log)
 *
 * The logger never throws — failed writes are silently dropped.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { getTraceContext, type TraceContext } from "./context";
import { resolveConfigDir } from "../config";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const VALID_LEVELS = new Set<string>(Object.keys(LOG_LEVELS));

const SAFE_CHAR_PATTERN = /[^A-Za-z0-9._-]/g;
const MAX_COMPONENT_LENGTH = 80;
const HASH_SUFFIX_LENGTH = 8;

const TRACING_MODULE = "tracing";
const TRACING_DUAL_MESSAGES = new Set(["request.start", "request.complete"]);

/**
 * Sanitize a single path component (projectSlug / sessionSlug / conversationSlug).
 *
 * - Replace any character outside [A-Za-z0-9._-] with `_`.
 * - Collapse leading dots so the value cannot resolve to a hidden file or
 *   escape via `..`.
 * - Truncate to 80 characters; on truncation, append a short SHA-256 hash
 *   of the original to preserve uniqueness across distinct long inputs.
 * - Returns null for inputs that sanitize to an empty string — callers
 *   fall back to the next-priority scope and emit `logger.path.sanitize_failure`.
 */
export function sanitizePathComponent(value: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;

  let sanitized = value.replace(SAFE_CHAR_PATTERN, "_");
  sanitized = sanitized.replace(/^\.+/, "");

  if (sanitized.length === 0) return null;

  if (sanitized.length > MAX_COMPONENT_LENGTH) {
    const hash = createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, HASH_SUFFIX_LENGTH);
    const headLen = MAX_COMPONENT_LENGTH - HASH_SUFFIX_LENGTH - 1;
    sanitized = `${sanitized.slice(0, headLen)}-${hash}`;
  }

  return sanitized;
}

/** Resolve the configured log level, falling back to "info" on invalid values */
function resolveLogLevel(): LogLevel {
  const env = process.env["CC_LOG_LEVEL"];
  if (env && VALID_LEVELS.has(env)) {
    return env as LogLevel;
  }
  if (env) {
    process.stderr.write(
      `[cc] Invalid CC_LOG_LEVEL="${env}", falling back to "info"\n`,
    );
  }
  return "info";
}

let logLevel: LogLevel | undefined;
let logsRoot: string | undefined;
let singleFileOverride: string | undefined;
let scopedRoutingEnabled = true;
let initialized = false;
const ensuredDirs = new Set<string>();

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  logLevel = resolveLogLevel();

  singleFileOverride = process.env["CC_LOG_FILE"] || undefined;
  scopedRoutingEnabled = process.env["CC_LOG_SCOPED"] !== "0";
  logsRoot = path.join(resolveConfigDir(), "logs");
}

function ensureDir(dir: string): void {
  if (ensuredDirs.has(dir)) return;
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    ensuredDirs.add(dir);
  } catch {
    // Silent — write attempts will fail (and be dropped) below.
  }
}

function globalLogPath(): string {
  if (singleFileOverride) return singleFileOverride;
  return path.join(logsRoot!, "global.log");
}

function sessionDirPath(projectSlug: string, sessionSlug: string): string {
  return path.join(logsRoot!, "sessions", `${projectSlug}__${sessionSlug}`);
}

function sessionLogPath(projectSlug: string, sessionSlug: string): string {
  return path.join(sessionDirPath(projectSlug, sessionSlug), "session.log");
}

function conversationLogPath(
  projectSlug: string,
  sessionSlug: string,
  conversationSlug: string,
): string {
  return path.join(
    sessionDirPath(projectSlug, sessionSlug),
    "conversations",
    `${conversationSlug}.log`,
  );
}

interface RouteDecision {
  paths: string[];
  diagnostics: { event: string; fields?: Record<string, unknown> }[];
}

function resolveDestinations(
  entry: Record<string, unknown>,
  ctx: TraceContext | undefined,
): RouteDecision {
  ensureInitialized();

  if (singleFileOverride || !scopedRoutingEnabled) {
    return { paths: [globalLogPath()], diagnostics: [] };
  }

  const diagnostics: { event: string; fields?: Record<string, unknown> }[] = [];
  let scopedPath: string | undefined;

  if (ctx) {
    const projectSlug = ctx.projectName
      ? sanitizePathComponent(ctx.projectName)
      : null;
    const sessionSlug = ctx.sessionName
      ? sanitizePathComponent(ctx.sessionName)
      : null;
    const conversationSlug = ctx.conversationId
      ? sanitizePathComponent(ctx.conversationId)
      : null;

    if (ctx.projectName && projectSlug === null) {
      diagnostics.push({
        event: "logger.path.sanitize_failure",
        fields: { component: "projectName", value: ctx.projectName },
      });
    }
    if (ctx.sessionName && sessionSlug === null) {
      diagnostics.push({
        event: "logger.path.sanitize_failure",
        fields: { component: "sessionName", value: ctx.sessionName },
      });
    }
    if (ctx.conversationId && conversationSlug === null) {
      diagnostics.push({
        event: "logger.path.sanitize_failure",
        fields: { component: "conversationId", value: ctx.conversationId },
      });
    }

    if (ctx.conversationId && (!ctx.sessionName || !ctx.projectName)) {
      diagnostics.push({
        event: "logger.path.unscoped_conversation",
        fields: {
          conversationId: ctx.conversationId,
          projectName: ctx.projectName,
          sessionName: ctx.sessionName,
        },
      });
    }

    if (projectSlug && sessionSlug && conversationSlug) {
      scopedPath = conversationLogPath(
        projectSlug,
        sessionSlug,
        conversationSlug,
      );
    } else if (projectSlug && sessionSlug) {
      scopedPath = sessionLogPath(projectSlug, sessionSlug);
    }
  }

  const primaryPath = scopedPath ?? globalLogPath();

  const isDual =
    scopedPath !== undefined &&
    entry["module"] === TRACING_MODULE &&
    typeof entry["message"] === "string" &&
    TRACING_DUAL_MESSAGES.has(entry["message"]);

  const paths: string[] = isDual
    ? [primaryPath, globalLogPath()]
    : [primaryPath];

  return { paths, diagnostics };
}

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

  const ctx = getTraceContext();
  if (ctx) {
    entry["traceId"] = ctx.traceId;
    if (ctx.action) entry["action"] = ctx.action;
    if (ctx.projectName) entry["projectName"] = ctx.projectName;
    if (ctx.sessionName) entry["sessionName"] = ctx.sessionName;
    if (ctx.conversationId) entry["conversationId"] = ctx.conversationId;
  }

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
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

function appendLine(filePath: string, entry: Record<string, unknown>): void {
  try {
    ensureDir(path.dirname(filePath));
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(filePath, line, "utf-8");
  } catch {
    // Never throw — silently drop on write failure.
  }
}

function writeEntry(entry: Record<string, unknown>): void {
  const ctx = getTraceContext();
  const { paths, diagnostics } = resolveDestinations(entry, ctx);
  const uniquePaths = Array.from(new Set(paths));

  for (const p of uniquePaths) {
    appendLine(p, entry);
  }

  for (const diag of diagnostics) {
    const diagEntry = buildEntry("warn", "logger", diag.event, diag.fields);
    for (const p of uniquePaths) {
      appendLine(p, diagEntry);
    }
  }
}

function writeStderr(entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify(entry) + "\n";
    process.stderr.write(line);
  } catch {
    // Never throw
  }
}

function shouldLog(level: LogLevel): boolean {
  if (process.env["CC_LOG_SILENT"] === "1") return false;
  ensureInitialized();
  return LOG_LEVELS[level] >= LOG_LEVELS[logLevel!];
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
  logsRoot = undefined;
  singleFileOverride = undefined;
  scopedRoutingEnabled = true;
  ensuredDirs.clear();
}
