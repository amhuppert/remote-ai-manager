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
 *   - <config-dir>/logs/projects/<projectSlug>/project.log                      (project conversation scope)
 *   - <config-dir>/logs/projects/<projectSlug>/conversations/<conversationSlug>.log
 *
 * A project conversation has no owning session — its state-store key is the
 * internal sentinel — so it routes to the `projects/` tree rather than to
 * `sessions/<projectSlug>__<sentinel>`. A log file path is a diagnostic identity
 * a reader sees, and the sentinel does not appear on those
 * (project-conversation-parity R1.3).
 *
 * Resolution priority: conversation > session/project > global. The dynamic path
 * components (projectSlug, sessionSlug, conversationSlug) are sanitized on every
 * call.
 *
 * Documented exception — request.start / request.complete from the "tracing"
 * module are written to BOTH the scoped destination AND the global log so
 * operators retain a chronological cross-session timeline.
 *
 * Configuration:
 * - CC_LOG_LEVEL: "debug" | "info" | "warn" | "error" (default: "info")
 * - CC_LOG_FILE: explicit single-file destination (overrides scoped routing)
 * - CC_LOG_SCOPED: "0" disables scoped routing (everything → global.log)
 * - CC_LOG_MAX_BYTES: rotate a log file once an append would exceed this size
 *   (default: 100 MiB; "0" disables rotation → unbounded growth)
 * - CC_LOG_MAX_FILES: number of rotated backups to retain per file
 *   (default: 5; total disk per file ≈ CC_LOG_MAX_BYTES × (CC_LOG_MAX_FILES + 1))
 *
 * Rotation is size-based with numbered backups (`global.log` → `global.log.1` →
 * … → `global.log.N`, oldest dropped). It is applied in appendLine, so it covers
 * the global log and the scoped session/conversation logs uniformly. File sizes
 * are tracked in memory (seeded by a single stat per path) to keep the
 * synchronous-append hot path off the filesystem on every line.
 *
 * The logger never throws — failed writes are silently dropped.
 */

import {
  appendFileSync,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { getTraceContext, type TraceContext } from "./context";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import { resolveConfigDir } from "../config/loader";

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

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

/**
 * Parse a non-negative integer env override, falling back on absent/invalid
 * values (with a stderr note, matching the CC_LOG_LEVEL convention).
 */
function parseNonNegativeInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  process.stderr.write(
    `[cc] Invalid ${envName}="${raw}", falling back to ${fallback}\n`,
  );
  return fallback;
}

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
let maxBytes = DEFAULT_MAX_BYTES;
let maxFiles = DEFAULT_MAX_FILES;
let initialized = false;
const ensuredDirs = new Set<string>();

/** Per-path running byte size, so the hot path avoids a stat on every line. */
const fileSizes = new Map<string, number>();

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  logLevel = resolveLogLevel();

  singleFileOverride = process.env["CC_LOG_FILE"] || undefined;
  scopedRoutingEnabled = process.env["CC_LOG_SCOPED"] !== "0";
  maxBytes = parseNonNegativeInt("CC_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
  maxFiles = parseNonNegativeInt("CC_LOG_MAX_FILES", DEFAULT_MAX_FILES);
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

/**
 * A project conversation's log tree. It is deliberately NOT
 * `sessions/<project>__<sessionSlug>`: for a project conversation the store
 * session key is the sentinel, and a file path is a diagnostic identity a
 * reader sees, so routing there would publish the sentinel that
 * `refuseSentinelSessionIdentity` strips from the entry itself (R1.3).
 */
function projectDirPath(projectSlug: string): string {
  return path.join(logsRoot!, "projects", projectSlug);
}

/**
 * The directory owning this trace's logs, or null when the context is too thin
 * to scope (falls back to the global log).
 */
function resolveScopeDir(
  projectSlug: string | null,
  sessionSlug: string | null,
  isProjectScope: boolean,
): string | null {
  if (projectSlug === null) return null;
  if (isProjectScope) return projectDirPath(projectSlug);
  if (sessionSlug === null) return null;
  return sessionDirPath(projectSlug, sessionSlug);
}

function conversationLogPath(
  scopeDir: string,
  conversationSlug: string,
): string {
  return path.join(scopeDir, "conversations", `${conversationSlug}.log`);
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
    // A project conversation is keyed by the sentinel in the state store, and
    // the log tree mirrors the store — but the mirror stops at the PATH, which
    // is published. Project scope gets its own session-less tree instead.
    const isProjectScope =
      ctx.sessionName !== undefined && isProjectSentinel(ctx.sessionName);
    const projectSlug = ctx.projectName
      ? sanitizePathComponent(ctx.projectName)
      : null;
    const sessionSlug =
      ctx.sessionName && !isProjectScope
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
    if (ctx.sessionName && !isProjectScope && sessionSlug === null) {
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

    // A project conversation always carries a (sentinel) sessionName, so it is
    // scoped, not unscoped — this stays the original condition.
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

    const scopeDir = resolveScopeDir(projectSlug, sessionSlug, isProjectScope);
    if (scopeDir !== null) {
      scopedPath = conversationSlug
        ? conversationLogPath(scopeDir, conversationSlug)
        : path.join(scopeDir, isProjectScope ? "project.log" : "session.log");
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

/**
 * The sink's refusal of the project sentinel in a public session position
 * (`project-conversation-parity` R1.3, D2).
 *
 * `sessionName` is a PUBLIC diagnostic identity; the sentinel is a state-store /
 * runtime key that serves the session-keyed APIs a project conversation shares.
 * Two things can put it in this field: a call site on the project-reachable call
 * graph, and the request trace context, which stamps `sessionName` onto EVERY
 * entry emitted inside a project request regardless of the call site. Auditing
 * that surface call-by-call is what kept missing sinks, so the guarantee lives
 * here instead: a session-less conversation reports `scope: "project"` and NO
 * `sessionName` key, which is the same discriminated shape the call sites on
 * that path build deliberately.
 *
 * This is the logging analogue of the throw in `conversationTargetApiBase` — the
 * builder that would emit the sentinel refuses to. The logger never throws by
 * contract, so it substitutes.
 *
 * The destination PATH is the other half of the same guarantee and is resolved
 * separately, in `resolveDestinations`: project scope routes to `projectDirPath`
 * so no sentinel-bearing path is ever created.
 */
function refuseSentinelSessionIdentity(entry: Record<string, unknown>): void {
  const sessionName = entry["sessionName"];
  if (typeof sessionName !== "string" || !isProjectSentinel(sessionName))
    return;
  delete entry["sessionName"];
  entry["scope"] = "project";
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

  refuseSentinelSessionIdentity(entry);

  return entry;
}

function currentFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Shift numbered backups and move the current file aside:
 *   <file>.N is dropped, <file>.i → <file>.(i+1), <file> → <file>.1.
 * With keep <= 0 the current file is simply removed (no history retained).
 * Best-effort: any individual fs error is swallowed so logging never throws.
 */
function rotateFile(filePath: string, keep: number): void {
  if (keep < 1) {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // ignore
    }
    return;
  }

  try {
    rmSync(`${filePath}.${keep}`, { force: true });
  } catch {
    // ignore
  }
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${filePath}.${i}`;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, `${filePath}.${i + 1}`);
    } catch {
      // ignore
    }
  }
  try {
    if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`);
  } catch {
    // ignore
  }
}

/** Open a freshly-rotated file with a marker line for post-hoc forensics. */
function writeRotationNotice(filePath: string): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "info",
    module: "logger",
    message: "logger.rotate",
    file: path.basename(filePath),
    maxBytes,
    maxFiles,
  };
  try {
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(filePath, line, "utf-8");
    fileSizes.set(filePath, Buffer.byteLength(line, "utf-8"));
  } catch {
    fileSizes.set(filePath, 0);
  }
}

/**
 * Rotate `filePath` when appending `lineBytes` more would exceed maxBytes.
 * Size is tracked in memory (seeded lazily by one stat) so the common path
 * touches the filesystem only for the actual append.
 */
function maybeRotate(filePath: string, lineBytes: number): void {
  if (maxBytes <= 0) return;

  let size = fileSizes.get(filePath);
  if (size === undefined) {
    size = currentFileSize(filePath);
    fileSizes.set(filePath, size);
  }

  if (size > 0 && size + lineBytes > maxBytes) {
    rotateFile(filePath, maxFiles);
    fileSizes.set(filePath, 0);
    writeRotationNotice(filePath);
  }
}

function appendLine(filePath: string, entry: Record<string, unknown>): void {
  try {
    ensureDir(path.dirname(filePath));
    const line = JSON.stringify(entry) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf-8");
    maybeRotate(filePath, lineBytes);
    appendFileSync(filePath, line, "utf-8");
    fileSizes.set(filePath, (fileSizes.get(filePath) ?? 0) + lineBytes);
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
  maxBytes = DEFAULT_MAX_BYTES;
  maxFiles = DEFAULT_MAX_FILES;
  ensuredDirs.clear();
  fileSizes.clear();
}
