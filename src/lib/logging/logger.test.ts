import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runWithTrace } from "./context";
import { createLogger, _resetLoggerForTesting } from "./logger";

// Use a temp directory for test log files
const tmpDir = path.join(os.tmpdir(), "cc-logger-test");
const testLogFile = path.join(tmpDir, "test.log");

function readLogLines(): Record<string, unknown>[] {
  const content = readFileSync(testLogFile, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cleanup(): void {
  try {
    if (existsSync(testLogFile)) unlinkSync(testLogFile);
  } catch {
    // ignore
  }
}

describe("Logger", () => {
  beforeEach(() => {
    cleanup();
    _resetLoggerForTesting();
    // Point log file to our temp location
    process.env["CC_LOG_FILE"] = testLogFile;
    process.env["CC_LOG_LEVEL"] = "debug";
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    cleanup();
    _resetLoggerForTesting();
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_LEVEL"];
  });

  it("emits valid NDJSON with required fields", () => {
    const logger = createLogger("test-module");
    logger.info("hello world");

    const lines = readLogLines();
    expect(lines).toHaveLength(1);

    const entry = lines[0]!;
    expect(entry["timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry["level"]).toBe("info");
    expect(entry["module"]).toBe("test-module");
    expect(entry["message"]).toBe("hello world");
  });

  it("includes additional structured fields", () => {
    const logger = createLogger("test");
    logger.info("with fields", { count: 42, path: "/api/test" });

    const entry = readLogLines()[0]!;
    expect(entry["count"]).toBe(42);
    expect(entry["path"]).toBe("/api/test");
  });

  it("filters entries below configured log level", () => {
    _resetLoggerForTesting();
    process.env["CC_LOG_LEVEL"] = "warn";

    const logger = createLogger("test");
    logger.debug("should be filtered");
    logger.info("should be filtered");
    logger.warn("should pass");
    logger.error("should pass");

    const lines = readLogLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]!["level"]).toBe("warn");
    expect(lines[1]!["level"]).toBe("error");
  });

  it("defaults to info level when CC_LOG_LEVEL is not set", () => {
    _resetLoggerForTesting();
    delete process.env["CC_LOG_LEVEL"];

    const logger = createLogger("test");
    logger.debug("should be filtered");
    logger.info("should pass");

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!["level"]).toBe("info");
  });

  it("falls back to info on invalid CC_LOG_LEVEL and warns on stderr", () => {
    _resetLoggerForTesting();
    process.env["CC_LOG_LEVEL"] = "banana";

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const logger = createLogger("test");
    logger.debug("should be filtered");
    logger.info("should pass");

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!["level"]).toBe("info");

    // Check stderr warning about invalid level
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid CC_LOG_LEVEL="banana"'),
    );

    stderrSpy.mockRestore();
  });

  it("writes warn/error to stderr in addition to file", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const logger = createLogger("test");
    logger.info("not on stderr");
    logger.warn("on stderr");
    logger.error("also on stderr");

    // File should have all 3
    const lines = readLogLines();
    expect(lines).toHaveLength(3);

    // Stderr should have 2 calls (warn + error)
    expect(stderrSpy).toHaveBeenCalledTimes(2);

    stderrSpy.mockRestore();
  });

  it("auto-enriches with ALS trace context", () => {
    const logger = createLogger("test");
    const ctx = {
      traceId: "trace-abc",
      action: "send-prompt",
      projectName: "proj",
      sessionName: "sess",
    };

    runWithTrace(ctx, () => {
      logger.info("traced log");
    });

    const entry = readLogLines()[0]!;
    expect(entry["traceId"]).toBe("trace-abc");
    expect(entry["action"]).toBe("send-prompt");
    expect(entry["projectName"]).toBe("proj");
    expect(entry["sessionName"]).toBe("sess");
  });

  it("omits context fields gracefully when outside trace context", () => {
    const logger = createLogger("test");
    logger.info("no context");

    const entry = readLogLines()[0]!;
    expect(entry["traceId"]).toBeUndefined();
    expect(entry["action"]).toBeUndefined();
    expect(entry["projectName"]).toBeUndefined();
    expect(entry["sessionName"]).toBeUndefined();
  });

  it("preserves full error stack traces", () => {
    const logger = createLogger("test");
    const err = new Error("test failure");

    logger.error("operation failed", { error: err });

    const entry = readLogLines()[0]!;
    expect(entry["error"]).toBe("test failure");
    expect(entry["stack"]).toMatch(/Error: test failure/);
    expect(entry["stack"]).toMatch(/logger\.test\.ts/);
  });

  it("never throws on invalid file path", () => {
    _resetLoggerForTesting();
    process.env["CC_LOG_FILE"] = "/nonexistent/deeply/nested/path/log.ndjson";

    const logger = createLogger("test");
    // Should not throw
    expect(() => logger.info("test")).not.toThrow();
    expect(() => logger.error("test")).not.toThrow();
  });

  it("handles undefined values in additional fields", () => {
    const logger = createLogger("test");
    logger.info("test", { defined: "yes", notDefined: undefined });

    const entry = readLogLines()[0]!;
    expect(entry["defined"]).toBe("yes");
    expect("notDefined" in entry).toBe(false);
  });
});
