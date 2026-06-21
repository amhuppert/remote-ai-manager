/**
 * Size-based rotation + retention tests for the NDJSON logger.
 *
 * Rotation is a general primitive applied in appendLine, so it covers global.log
 * and the scoped session/conversation logs uniformly. Tests drive it with a tiny
 * CC_LOG_MAX_BYTES against a real temp directory (real fs, no mocking).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { runWithTrace } from "./context";
import { createLogger, _resetLoggerForTesting } from "./logger";

let tmpRoot: string;

function logsDir(): string {
  return path.join(tmpRoot, "logs");
}

function globalLog(): string {
  return path.join(logsDir(), "global.log");
}

function sessionLog(slug: string): string {
  return path.join(logsDir(), "sessions", slug, "session.log");
}

function readLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function messagesIn(file: string): unknown[] {
  return readLines(file).map((l) => l["message"]);
}

describe("Logger size-based rotation + retention", () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "cc-logger-rotation-"));
    _resetLoggerForTesting();
    delete process.env["CC_LOG_SILENT"];
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_SCOPED"];
    delete process.env["CC_LOG_MAX_BYTES"];
    delete process.env["CC_LOG_MAX_FILES"];
    process.env["CC_CONFIG_DIR"] = tmpRoot;
    process.env["CC_LOG_LEVEL"] = "debug";
  });

  afterEach(() => {
    _resetLoggerForTesting();
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_SCOPED"];
    delete process.env["CC_LOG_LEVEL"];
    delete process.env["CC_LOG_MAX_BYTES"];
    delete process.env["CC_LOG_MAX_FILES"];
    delete process.env["CC_CONFIG_DIR"];
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("rotates global.log into global.log.1 once it would exceed CC_LOG_MAX_BYTES", () => {
    process.env["CC_LOG_MAX_BYTES"] = "400";
    process.env["CC_LOG_MAX_FILES"] = "5";
    _resetLoggerForTesting();

    const logger = createLogger("mod");
    for (let i = 0; i < 20; i++) {
      logger.info(`line-${String(i).padStart(4, "0")}`);
    }

    // A rotation happened: the backup exists and the active file was recreated.
    expect(existsSync(`${globalLog()}.1`)).toBe(true);
    expect(existsSync(globalLog())).toBe(true);

    // The earliest line moved into a backup; a late line is in the active file.
    const allMessages = [
      ...messagesIn(globalLog()),
      ...messagesIn(`${globalLog()}.1`),
      ...messagesIn(`${globalLog()}.2`),
      ...messagesIn(`${globalLog()}.3`),
      ...messagesIn(`${globalLog()}.4`),
      ...messagesIn(`${globalLog()}.5`),
    ];
    expect(allMessages).toContain("line-0019");
    expect(messagesIn(globalLog())).not.toContain("line-0000");
  });

  it("keeps no more than CC_LOG_MAX_FILES backups (oldest deleted)", () => {
    process.env["CC_LOG_MAX_BYTES"] = "1"; // rotate on every line after the first
    process.env["CC_LOG_MAX_FILES"] = "2";
    _resetLoggerForTesting();

    const logger = createLogger("mod");
    for (let i = 0; i < 30; i++) {
      logger.info(`line-${i}`);
    }

    expect(existsSync(`${globalLog()}.1`)).toBe(true);
    expect(existsSync(`${globalLog()}.2`)).toBe(true);
    expect(existsSync(`${globalLog()}.3`)).toBe(false);
  });

  it("does not corrupt or partially write lines across rotations", () => {
    process.env["CC_LOG_MAX_BYTES"] = "300";
    process.env["CC_LOG_MAX_FILES"] = "5";
    _resetLoggerForTesting();

    const logger = createLogger("mod");
    for (let i = 0; i < 40; i++) {
      logger.info(`line-${i}`, { i });
    }

    // Every line in every retained file must be complete, valid JSON.
    for (let n = 0; n <= 5; n++) {
      const f = n === 0 ? globalLog() : `${globalLog()}.${n}`;
      expect(() => readLines(f)).not.toThrow();
    }
  });

  it("CC_LOG_MAX_BYTES=0 disables rotation (unbounded, current behavior)", () => {
    process.env["CC_LOG_MAX_BYTES"] = "0";
    _resetLoggerForTesting();

    const logger = createLogger("mod");
    for (let i = 0; i < 50; i++) {
      logger.info(`line-${i}`);
    }

    expect(existsSync(`${globalLog()}.1`)).toBe(false);
    expect(readLines(globalLog()).length).toBe(50);
  });

  it("seeds size from a pre-existing file and rotates it on the next write", () => {
    process.env["CC_LOG_MAX_BYTES"] = "200";
    process.env["CC_LOG_MAX_FILES"] = "3";
    _resetLoggerForTesting();

    // Simulate a server restart against an already-large log file.
    const preExisting = `${"x".repeat(500)}\n`;
    mkdirSync(logsDir(), { recursive: true });
    writeFileSync(globalLog(), preExisting, "utf-8");

    const logger = createLogger("mod");
    logger.info("after-restart");

    expect(existsSync(`${globalLog()}.1`)).toBe(true);
    expect(readFileSync(`${globalLog()}.1`, "utf-8")).toBe(preExisting);
    expect(messagesIn(globalLog())).toContain("after-restart");
  });

  it("opens each freshly-rotated file with a logger.rotate notice", () => {
    process.env["CC_LOG_MAX_BYTES"] = "300";
    process.env["CC_LOG_MAX_FILES"] = "5";
    _resetLoggerForTesting();

    const logger = createLogger("mod");
    for (let i = 0; i < 20; i++) {
      logger.info(`line-${i}`);
    }

    expect(messagesIn(globalLog())).toContain("logger.rotate");
  });

  it("rotates scoped session logs too (general primitive, not global-only)", () => {
    process.env["CC_LOG_MAX_BYTES"] = "300";
    process.env["CC_LOG_MAX_FILES"] = "5";
    _resetLoggerForTesting();

    const logger = createLogger("mod");
    runWithTrace({ traceId: "t", projectName: "p", sessionName: "s" }, () => {
      for (let i = 0; i < 20; i++) {
        logger.info(`line-${i}`);
      }
    });

    expect(existsSync(`${sessionLog("p__s")}.1`)).toBe(true);
  });
});
