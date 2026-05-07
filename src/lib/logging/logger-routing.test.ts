/**
 * Routing tests for scoped log file destinations.
 *
 * Verifies that log entries land in the correct file based on
 * the active TraceContext, with global fallback and dual-destination
 * for `request.start` / `request.complete` tracing events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  mkdtempSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { runWithTrace } from "./context";
import {
  createLogger,
  sanitizePathComponent,
  _resetLoggerForTesting,
} from "./logger";

let tmpRoot: string;

function readLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function logsDir(): string {
  return path.join(tmpRoot, "logs");
}

function globalLog(): string {
  return path.join(logsDir(), "global.log");
}

function sessionLog(slug: string): string {
  return path.join(logsDir(), "sessions", slug, "session.log");
}

function conversationLog(sessionSlug: string, conversationId: string): string {
  return path.join(
    logsDir(),
    "sessions",
    sessionSlug,
    "conversations",
    `${conversationId}.log`,
  );
}

describe("Logger scoped routing", () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "cc-logger-routing-"));
    _resetLoggerForTesting();
    delete process.env["CC_LOG_SILENT"];
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_SCOPED"];
    process.env["CC_CONFIG_DIR"] = tmpRoot;
    process.env["CC_LOG_LEVEL"] = "debug";
  });

  afterEach(() => {
    _resetLoggerForTesting();
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_SCOPED"];
    delete process.env["CC_LOG_LEVEL"];
    delete process.env["CC_CONFIG_DIR"];
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it("routes to global.log when no TraceContext is set", () => {
    const logger = createLogger("mod");
    logger.info("no-context");

    expect(readLines(globalLog())).toHaveLength(1);
  });

  it("routes to session.log when projectName + sessionName are present", () => {
    const logger = createLogger("mod");
    runWithTrace(
      { traceId: "t", projectName: "myproj", sessionName: "mysess" },
      () => logger.info("scoped-session"),
    );

    const sessLines = readLines(sessionLog("myproj__mysess"));
    expect(sessLines).toHaveLength(1);
    expect(sessLines[0]?.["message"]).toBe("scoped-session");

    expect(readLines(globalLog())).toHaveLength(0);
  });

  it("routes to per-conversation log when project + session + conversationId are present", () => {
    const logger = createLogger("mod");
    runWithTrace(
      {
        traceId: "t",
        projectName: "p",
        sessionName: "s",
        conversationId: "abc-123",
      },
      () => logger.info("scoped-conv"),
    );

    const convLines = readLines(conversationLog("p__s", "abc-123"));
    expect(convLines).toHaveLength(1);
    expect(convLines[0]?.["message"]).toBe("scoped-conv");

    expect(readLines(globalLog())).toHaveLength(0);
    expect(readLines(sessionLog("p__s"))).toHaveLength(0);
  });

  it("routes to global with logger.path.unscoped_conversation when conversationId has no session", () => {
    const logger = createLogger("mod");
    runWithTrace({ traceId: "t", projectName: "p", conversationId: "c" }, () =>
      logger.info("orphan-conv"),
    );

    const lines = readLines(globalLog());
    const messages = lines.map((l) => l["message"]);
    expect(messages).toContain("orphan-conv");
    expect(messages).toContain("logger.path.unscoped_conversation");
  });

  it("sanitizes path components: strips invalid characters", () => {
    const logger = createLogger("mod");
    runWithTrace(
      {
        traceId: "t",
        projectName: "weird/project name",
        sessionName: "../escape",
      },
      () => logger.info("dirty-paths"),
    );

    const expected = sessionLog("weird_project_name___escape");
    expect(readLines(expected)).toHaveLength(1);
  });

  it("sanitizes leading dots in path components to prevent hidden files / traversal", () => {
    const logger = createLogger("mod");
    runWithTrace(
      {
        traceId: "t",
        projectName: "...weird",
        sessionName: "..",
      },
      () => logger.info("dotted"),
    );

    // ..  → empty after collapsing leading dots → invalid → fallback global
    const lines = readLines(globalLog());
    const messages = lines.map((l) => l["message"]);
    expect(messages).toContain("dotted");
    expect(messages).toContain("logger.path.sanitize_failure");
  });

  it("truncates long path components and appends a hash to preserve uniqueness", () => {
    const longName = "a".repeat(120);
    const result = sanitizePathComponent(longName);

    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
    // Should contain a hash suffix because truncation occurred
    expect(result).toMatch(/-[0-9a-f]{8}$/);

    // Different inputs produce different outputs
    const longName2 = "a".repeat(119) + "b";
    const result2 = sanitizePathComponent(longName2);
    expect(result2).not.toBe(result);
  });

  it("rejects empty strings (sanitize returns null)", () => {
    expect(sanitizePathComponent("")).toBeNull();
    expect(sanitizePathComponent("...")).toBeNull(); // collapses to empty
  });

  it("falls back to session scope on malformed conversationId values", () => {
    const logger = createLogger("mod");
    runWithTrace(
      {
        traceId: "t",
        projectName: "p",
        sessionName: "s",
        conversationId: "..",
      },
      () => logger.info("bad-conv"),
    );

    // Conversation ID sanitization fails — fall back to session scope
    const sessLines = readLines(sessionLog("p__s"));
    expect(sessLines.map((l) => l["message"])).toContain("bad-conv");
    expect(sessLines.map((l) => l["message"])).toContain(
      "logger.path.sanitize_failure",
    );
  });

  it("dual-writes request.start and request.complete from tracing module to scoped + global", () => {
    const tracingLogger = createLogger("tracing");
    runWithTrace({ traceId: "t", projectName: "p", sessionName: "s" }, () => {
      tracingLogger.info("request.start", { method: "GET", path: "/api/x" });
      tracingLogger.info("request.complete", {
        method: "GET",
        path: "/api/x",
        status: 200,
        durationMs: 10,
      });
    });

    const sess = readLines(sessionLog("p__s"));
    const glob = readLines(globalLog());

    const sessMsgs = sess.map((l) => l["message"]);
    expect(sessMsgs).toContain("request.start");
    expect(sessMsgs).toContain("request.complete");

    const globMsgs = glob.map((l) => l["message"]);
    expect(globMsgs).toContain("request.start");
    expect(globMsgs).toContain("request.complete");
  });

  it("does not dual-write non-tracing module logs even with same message strings", () => {
    const otherLogger = createLogger("not-tracing");
    runWithTrace({ traceId: "t", projectName: "p", sessionName: "s" }, () =>
      otherLogger.info("request.start", { coincidence: true }),
    );

    expect(readLines(sessionLog("p__s"))).toHaveLength(1);
    expect(readLines(globalLog())).toHaveLength(0);
  });

  it("does not dual-write tracing module logs other than request.start/complete", () => {
    const tracingLogger = createLogger("tracing");
    runWithTrace({ traceId: "t", projectName: "p", sessionName: "s" }, () =>
      tracingLogger.error("request.error", { error: "boom" }),
    );

    expect(readLines(sessionLog("p__s"))).toHaveLength(1);
    expect(readLines(globalLog())).toHaveLength(0);
  });

  it("CC_LOG_SCOPED=0 disables scoped routing entirely", () => {
    process.env["CC_LOG_SCOPED"] = "0";
    _resetLoggerForTesting();

    const logger = createLogger("mod");
    runWithTrace({ traceId: "t", projectName: "p", sessionName: "s" }, () =>
      logger.info("flat"),
    );

    expect(readLines(globalLog())).toHaveLength(1);
    expect(existsSync(sessionLog("p__s"))).toBe(false);
  });

  it("emits one entry per call when scoped routing chooses a single destination", () => {
    const logger = createLogger("mod");
    runWithTrace({ traceId: "t", projectName: "p", sessionName: "s" }, () =>
      logger.info("once"),
    );

    expect(readLines(sessionLog("p__s"))).toHaveLength(1);
    expect(readLines(globalLog())).toHaveLength(0);
  });

  it("creates intermediate directories on first write", () => {
    const logger = createLogger("mod");
    runWithTrace(
      {
        traceId: "t",
        projectName: "newproj",
        sessionName: "newsess",
        conversationId: "newconv",
      },
      () => logger.info("first-write"),
    );

    expect(existsSync(conversationLog("newproj__newsess", "newconv"))).toBe(
      true,
    );
  });

  it("returns the same sanitized result deterministically", () => {
    expect(sanitizePathComponent("ok-name_1.0")).toBe("ok-name_1.0");
    expect(sanitizePathComponent("a/b\\c")).toBe("a_b_c");
    expect(sanitizePathComponent("..hidden")).toBe("hidden");
  });

  // Ensure we didn't accidentally create a tmpRoot leak — sanity check
  it("sanity: temp root exists during the test", () => {
    expect(existsSync(tmpRoot)).toBe(true);
    mkdirSync(tmpRoot, { recursive: true });
  });
});
