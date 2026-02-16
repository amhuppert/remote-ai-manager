/**
 * Integration tests for end-to-end trace flow.
 *
 * These tests verify that traceId propagates from the request header
 * through withTracing → ALS → downstream log calls, producing
 * correlated NDJSON entries in the log file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { withTracing } from "./tracing";
import { createLogger, _resetLoggerForTesting } from "./logger";
import { getTraceContext, type TraceContext } from "./context";

const tmpDir = path.join(os.tmpdir(), "csm-integration-test");
const testLogFile = path.join(tmpDir, "test.log");

function readLogLines(): Record<string, unknown>[] {
  if (!existsSync(testLogFile)) return [];
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

function makeRequest(
  url: string,
  options?: { method?: string; headers?: Record<string, string> },
): Request {
  return new Request(url, {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
  });
}

function makeParams(params: Record<string, string> = {}): {
  params: Promise<Record<string, string>>;
} {
  return { params: Promise.resolve(params) };
}

describe("End-to-end trace flow", () => {
  beforeEach(() => {
    cleanup();
    _resetLoggerForTesting();
    process.env["CSM_LOG_FILE"] = testLogFile;
    process.env["CSM_LOG_LEVEL"] = "debug";
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    cleanup();
    _resetLoggerForTesting();
    delete process.env["CSM_LOG_FILE"];
    delete process.env["CSM_LOG_LEVEL"];
    vi.restoreAllMocks();
  });

  it("propagates traceId from request header through ALS to downstream log calls", async () => {
    // Simulate a downstream module logger that reads from ALS
    const sessionLogger = createLogger("sessions");

    const handler = withTracing(async () => {
      // Simulate what a route handler + downstream module would do
      sessionLogger.info("session.create", {
        projectName: "/test/project",
        sessionName: "test-session",
      });

      sessionLogger.debug("session.detail", {
        worktreePath: "/test/.worktrees/test-session",
      });

      return new Response(JSON.stringify({ success: true }), { status: 201 });
    });

    const req = makeRequest(
      "http://localhost:3000/api/projects/myproj/sessions",
      {
        method: "POST",
        headers: {
          "x-trace-id": "e2e-trace-001",
          "x-action": "create-session",
        },
      },
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await handler(req, makeParams({ name: "myproj" }));
    stderrSpy.mockRestore();

    const lines = readLogLines();

    // Should have: request.start, session.create, session.detail, request.complete
    expect(lines.length).toBeGreaterThanOrEqual(4);

    // ALL entries must share the same traceId
    for (const line of lines) {
      expect(line["traceId"]).toBe("e2e-trace-001");
    }

    // ALL entries must have the action
    const actionLines = lines.filter((l) => l["action"] === "create-session");
    expect(actionLines.length).toBe(lines.length);

    // Module-level fields override ALS context (explicit projectName from sessions module)
    const sessionLog = lines.find((l) => l["message"] === "session.create");
    expect(sessionLog).toBeDefined();
    expect(sessionLog?.["projectName"]).toBe("/test/project");

    // Tracing-layer logs use ALS context projectName (URL param)
    const startLog = lines.find((l) => l["message"] === "request.start");
    expect(startLog?.["projectName"]).toBe("myproj");
  });

  it("includes event type and session context for hook events", async () => {
    const hooksLogger = createLogger("hooks");

    const handler = withTracing(async () => {
      // Simulate processHookEvent logging
      hooksLogger.info("hook.event_received", {
        eventType: "UserPromptSubmit",
        sessionId: "sess-abc",
        timestamp: "2026-02-16T00:00:00Z",
      });

      return new Response(JSON.stringify({ matched: true }), { status: 200 });
    });

    const req = makeRequest("http://localhost:3000/api/hooks", {
      method: "POST",
      headers: { "x-trace-id": "hook-trace-001" },
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await handler(req, makeParams());
    stderrSpy.mockRestore();

    const lines = readLogLines();
    const hookLog = lines.find((l) => l["message"] === "hook.event_received");
    expect(hookLog).toBeDefined();
    expect(hookLog?.["traceId"]).toBe("hook-trace-001");
    expect(hookLog?.["eventType"]).toBe("UserPromptSubmit");
    expect(hookLog?.["sessionId"]).toBe("sess-abc");
  });

  it("captures error context with CLI args, stderr, cwd, and traceId on prompt failure", async () => {
    const promptLogger = createLogger("prompt");

    const handler = withTracing(async () => {
      // Simulate prompt failure logging
      promptLogger.error("prompt.failure", {
        sessionName: "test-session",
        cliArgs: ["-c", "-p"],
        cwd: "/test/.worktrees/test-session",
        error: "Command failed: claude -c -p ...",
        stderr: "Error: API rate limit exceeded",
        stack: "Error: Command failed\n    at ChildProcess.exithandler",
      });

      return new Response(
        JSON.stringify({ error: "Prompt execution failed" }),
        { status: 500 },
      );
    });

    const req = makeRequest(
      "http://localhost:3000/api/projects/myproj/sessions/test-session/prompt",
      {
        method: "POST",
        headers: {
          "x-trace-id": "fail-trace-001",
          "x-action": "send-prompt",
        },
      },
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await handler(req, makeParams({ name: "myproj", session: "test-session" }));
    stderrSpy.mockRestore();

    const lines = readLogLines();
    const errorLog = lines.find((l) => l["message"] === "prompt.failure");
    expect(errorLog).toBeDefined();
    expect(errorLog?.["traceId"]).toBe("fail-trace-001");
    expect(errorLog?.["action"]).toBe("send-prompt");
    expect(errorLog?.["cliArgs"]).toEqual(["-c", "-p"]);
    expect(errorLog?.["cwd"]).toBe("/test/.worktrees/test-session");
    expect(errorLog?.["stderr"]).toBe("Error: API rate limit exceeded");
    expect(errorLog?.["projectName"]).toBe("myproj");
    expect(errorLog?.["sessionName"]).toBe("test-session");
  });

  it("getTraceContext returns context within withTracing scope", async () => {
    let capturedContext: TraceContext | undefined;

    const handler = withTracing(async () => {
      capturedContext = getTraceContext();
      return new Response("ok");
    });

    const req = makeRequest("http://localhost:3000/api/test", {
      headers: {
        "x-trace-id": "ctx-trace",
        "x-action": "test-action",
      },
    });

    await handler(req, makeParams({ name: "proj1", session: "sess1" }));

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.traceId).toBe("ctx-trace");
    expect(capturedContext?.action).toBe("test-action");
    expect(capturedContext?.projectName).toBe("proj1");
    expect(capturedContext?.sessionName).toBe("sess1");
  });
});
