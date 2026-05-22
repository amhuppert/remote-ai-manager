import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "./exec";
import { _resetLoggerForTesting } from "./logging/logger";
import { _resetTimedForTesting } from "./logging/timed";

const tmpDir = path.join(os.tmpdir(), "cc-exec-test");
const testLogFile = path.join(tmpDir, "exec-test.log");

function readLogLines(): Record<string, unknown>[] {
  if (!existsSync(testLogFile)) return [];
  const content = readFileSync(testLogFile, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cleanupLog(): void {
  try {
    if (existsSync(testLogFile)) unlinkSync(testLogFile);
  } catch {
    // ignore
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => {
      // Allow our own once("exit") listener registered in `spawn()` to run first
      setImmediate(resolve);
    });
  });
}

describe("execFile", () => {
  beforeEach(() => {
    cleanupLog();
    _resetLoggerForTesting();
    _resetTimedForTesting();
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    delete process.env["CC_LOG_SILENT"];
    process.env["CC_LOG_FILE"] = testLogFile;
    process.env["CC_LOG_LEVEL"] = "debug";
    // Make sure complete log is emitted at info level regardless of duration
    process.env["CC_TIMING_INFO_MS"] = "0";
    process.env["CC_TIMING_WARN_MS"] = "999999";
  });

  afterEach(() => {
    cleanupLog();
    _resetLoggerForTesting();
    _resetTimedForTesting();
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_LEVEL"];
    delete process.env["CC_TIMING_INFO_MS"];
    delete process.env["CC_TIMING_WARN_MS"];
  });

  it("runs the command and returns stdout/stderr", async () => {
    const result = await execFile("/bin/echo", ["hello"]);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
  });

  it("logs exec.complete with durationMs and command on success", async () => {
    await execFile("/bin/echo", ["hello"]);
    const lines = readLogLines();
    const complete = lines.find((l) => l["message"] === "exec.complete");
    expect(complete).toBeDefined();
    expect(complete?.["command"]).toBe("/bin/echo");
    expect(complete?.["argsPreview"]).toBe("hello");
    expect(typeof complete?.["durationMs"]).toBe("number");
  });

  it("uses custom eventPrefix when provided", async () => {
    await execFile("/bin/echo", ["x"], { eventPrefix: "git" });
    const lines = readLogLines();
    const complete = lines.find((l) => l["message"] === "git.complete");
    expect(complete).toBeDefined();
    expect(lines.find((l) => l["message"] === "exec.complete")).toBeUndefined();
  });

  it("truncates argsPreview past 200 chars", async () => {
    const longArg = "a".repeat(500);
    await execFile("/bin/echo", [longArg]);
    const lines = readLogLines();
    const complete = lines.find((l) => l["message"] === "exec.complete");
    const preview = complete?.["argsPreview"] as string;
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(preview.endsWith("\u2026")).toBe(true);
  });

  it("rejects on non-zero exit and emits exit_error log", async () => {
    await expect(execFile("/bin/sh", ["-c", "exit 7"])).rejects.toThrow();

    const lines = readLogLines();
    const exitError = lines.find((l) => l["message"] === "exec.exit_error");
    expect(exitError).toBeDefined();
    expect(exitError?.["exitCode"]).toBe(7);
    expect(exitError?.["signal"]).toBeNull();
    // timed() also emits its own .error log
    expect(lines.find((l) => l["message"] === "exec.error")).toBeDefined();
  });

  it("preserves stdout/stderr on the rejected error object", async () => {
    let caught: (Error & { stdout?: string; stderr?: string }) | undefined;
    try {
      await execFile("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"]);
    } catch (err) {
      caught = err as Error & { stdout?: string; stderr?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.stdout).toContain("out");
    expect(caught?.stderr).toContain("err");
  });
});

describe("spawn", () => {
  beforeEach(() => {
    cleanupLog();
    _resetLoggerForTesting();
    _resetTimedForTesting();
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    delete process.env["CC_LOG_SILENT"];
    process.env["CC_LOG_FILE"] = testLogFile;
    process.env["CC_LOG_LEVEL"] = "debug";
  });

  afterEach(() => {
    cleanupLog();
    _resetLoggerForTesting();
    _resetTimedForTesting();
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_LEVEL"];
  });

  it("emits spawn.start immediately and spawn.exit on normal exit", async () => {
    const child = spawn("/bin/echo", ["hello"], { stdio: "ignore" });
    expect(child.pid).toBeGreaterThan(0);

    await waitForExit(child);

    const lines = readLogLines();
    const start = lines.find((l) => l["message"] === "spawn.start");
    const exit = lines.find((l) => l["message"] === "spawn.exit");
    expect(start).toBeDefined();
    expect(start?.["command"]).toBe("/bin/echo");
    expect(exit).toBeDefined();
    expect(exit?.["exitCode"]).toBe(0);
    expect(exit?.["level"]).toBe("info");
    expect(typeof exit?.["durationMs"]).toBe("number");
  });

  it("uses custom eventPrefix", async () => {
    const child = spawn("/bin/echo", ["x"], {
      stdio: "ignore",
      eventPrefix: "dev-server",
    });
    await waitForExit(child);

    const lines = readLogLines();
    expect(
      lines.find((l) => l["message"] === "dev-server.start"),
    ).toBeDefined();
    expect(lines.find((l) => l["message"] === "dev-server.exit")).toBeDefined();
    expect(lines.find((l) => l["message"] === "spawn.start")).toBeUndefined();
  });

  it("logs spawn.exit at warn for non-zero exit code", async () => {
    const child = spawn("/bin/sh", ["-c", "exit 4"], { stdio: "ignore" });
    await waitForExit(child);

    const lines = readLogLines();
    const exit = lines.find((l) => l["message"] === "spawn.exit");
    expect(exit?.["exitCode"]).toBe(4);
    expect(exit?.["level"]).toBe("warn");
  });

  it("logs spawn.exit at debug when killed by signal", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
    // Give it a moment to actually spawn before killing
    await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    await waitForExit(child);

    const lines = readLogLines();
    const exit = lines.find((l) => l["message"] === "spawn.exit");
    expect(exit?.["signal"]).toBe("SIGTERM");
    expect(exit?.["level"]).toBe("debug");
  });
});
