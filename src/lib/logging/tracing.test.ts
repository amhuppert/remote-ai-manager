import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { withTracing, _resetTracingForTesting } from "./tracing";
import { getTraceContext } from "./context";
import { _resetLoggerForTesting } from "./logger";

const tmpDir = path.join(os.tmpdir(), "cc-tracing-test");
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

function makeRequest(
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
  },
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

describe("withTracing", () => {
  beforeEach(() => {
    cleanup();
    _resetLoggerForTesting();
    _resetTracingForTesting();
    // Override test-wide CC_LOG_SILENT so tracing tests can verify real output
    delete process.env["CC_LOG_SILENT"];
    process.env["CC_LOG_FILE"] = testLogFile;
    process.env["CC_LOG_LEVEL"] = "debug";
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    cleanup();
    _resetLoggerForTesting();
    _resetTracingForTesting();
    // Restore CC_LOG_SILENT for other tests
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_LEVEL"];
    delete process.env["CC_REQUEST_SLOW_MS"];
    vi.restoreAllMocks();
  });

  it("extracts trace ID from X-Trace-Id header", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withTracing(handler);

    const req = makeRequest("http://localhost:3000/api/test", {
      headers: { "x-trace-id": "my-trace-123" },
    });

    const response = await wrapped(req, makeParams());

    expect(response.headers.get("x-trace-id")).toBe("my-trace-123");

    const lines = readLogLines();
    const startLog = lines.find((l) => l["message"] === "request.start");
    expect(startLog?.["traceId"]).toBe("my-trace-123");
  });

  it("generates new trace ID when header is absent", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withTracing(handler);

    const req = makeRequest("http://localhost:3000/api/test");
    const response = await wrapped(req, makeParams());

    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toBeTruthy();
    // Should be a valid UUID format
    expect(traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("includes X-Trace-Id in response header", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withTracing(handler);

    const req = makeRequest("http://localhost:3000/api/test", {
      headers: { "x-trace-id": "resp-trace" },
    });

    const response = await wrapped(req, makeParams());
    expect(response.headers.get("x-trace-id")).toBe("resp-trace");
  });

  it("logs request start and completion with method, path, status, duration", async () => {
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const wrapped = withTracing(handler);

    const req = makeRequest("http://localhost:3000/api/projects", {
      method: "GET",
      headers: { "x-trace-id": "lifecycle-trace" },
    });

    await wrapped(req, makeParams());

    const lines = readLogLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const startLog = lines.find((l) => l["message"] === "request.start");
    expect(startLog).toBeDefined();
    expect(startLog?.["method"]).toBe("GET");
    expect(startLog?.["path"]).toBe("/api/projects");
    expect(startLog?.["module"]).toBe("tracing");

    const completeLog = lines.find((l) => l["message"] === "request.complete");
    expect(completeLog).toBeDefined();
    expect(completeLog?.["method"]).toBe("GET");
    expect(completeLog?.["path"]).toBe("/api/projects");
    expect(completeLog?.["status"]).toBe(200);
    expect(typeof completeLog?.["durationMs"]).toBe("number");
  });

  it("logs error with full context and returns a shaped ApiError 500 envelope", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const testError = new Error("handler exploded");
    const handler = vi.fn(async () => {
      throw testError;
    });
    const wrapped = withTracing(handler);

    const req = makeRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "x-trace-id": "error-trace" },
    });

    const response = await wrapped(req, makeParams());
    expect(response.status).toBe(500);
    expect(response.headers.get("x-trace-id")).toBe("error-trace");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("handler exploded");
    expect(body["code"]).toBe("internal_error");

    const lines = readLogLines();
    const errorLog = lines.find((l) => l["message"] === "request.error");
    expect(errorLog).toBeDefined();
    expect(errorLog?.["traceId"]).toBe("error-trace");
    expect(errorLog?.["method"]).toBe("POST");
    expect(errorLog?.["status"]).toBe(500);
    expect(errorLog?.["error"]).toBe("handler exploded");
    expect(errorLog?.["stack"]).toMatch(/Error: handler exploded/);
    expect(typeof errorLog?.["durationMs"]).toBe("number");

    stderrSpy.mockRestore();
  });

  it("uses the per-domain error mapper's response when it maps the error", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = vi.fn(async () => {
      throw new Error("branch is stale");
    });
    const wrapped = withTracing(handler, {
      mapError(error) {
        if (error instanceof Error && error.message.includes("stale")) {
          return Response.json(
            { error: "Branch is stale", code: "stale_branch" },
            { status: 409 },
          );
        }
        return undefined;
      },
    });

    const req = makeRequest("http://localhost:3000/api/test", {
      headers: { "x-trace-id": "mapper-trace" },
    });

    const response = await wrapped(req, makeParams());
    expect(response.status).toBe(409);
    expect(response.headers.get("x-trace-id")).toBe("mapper-trace");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("stale_branch");

    const lines = readLogLines();
    const errorLog = lines.find((l) => l["message"] === "request.error");
    expect(errorLog?.["status"]).toBe(409);

    stderrSpy.mockRestore();
  });

  it("falls back to the default 500 envelope when the mapper returns undefined", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = vi.fn(async () => {
      throw new Error("unmapped failure");
    });
    const wrapped = withTracing(handler, {
      mapError() {
        return undefined;
      },
    });

    const req = makeRequest("http://localhost:3000/api/test");
    const response = await wrapped(req, makeParams());

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("unmapped failure");
    expect(body["code"]).toBe("internal_error");

    stderrSpy.mockRestore();
  });

  it("falls back to the default 500 envelope when the mapper itself throws", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = vi.fn(async () => {
      throw new Error("original failure");
    });
    const wrapped = withTracing(handler, {
      mapError() {
        throw new Error("mapper exploded");
      },
    });

    const req = makeRequest("http://localhost:3000/api/test");
    const response = await wrapped(req, makeParams());

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("original failure");
    expect(body["code"]).toBe("internal_error");

    const lines = readLogLines();
    const mapperLog = lines.find(
      (l) => l["message"] === "request.error_mapper_failed",
    );
    expect(mapperLog?.["error"]).toBe("mapper exploded");

    stderrSpy.mockRestore();
  });

  it("extracts projectName and sessionName from URL params", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withTracing(handler);

    const req = makeRequest(
      "http://localhost:3000/api/projects/my-project/sessions/my-session/prompt",
      {
        method: "POST",
        headers: { "x-trace-id": "params-trace" },
      },
    );

    await wrapped(
      req,
      makeParams({ name: "my-project", session: "my-session" }),
    );

    const lines = readLogLines();
    const startLog = lines.find((l) => l["message"] === "request.start");
    expect(startLog?.["projectName"]).toBe("my-project");
    expect(startLog?.["sessionName"]).toBe("my-session");
  });

  it("extracts X-Action header into trace context", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withTracing(handler);

    const req = makeRequest("http://localhost:3000/api/test", {
      headers: {
        "x-trace-id": "action-trace",
        "x-action": "send-prompt",
      },
    });

    await wrapped(req, makeParams());

    const lines = readLogLines();
    const startLog = lines.find((l) => l["message"] === "request.start");
    expect(startLog?.["action"]).toBe("send-prompt");
  });

  it("extracts conversationId route param into the active trace context", async () => {
    let observed: ReturnType<typeof getTraceContext>;
    const handler = vi.fn(async () => {
      observed = getTraceContext();
      return new Response("ok");
    });
    const wrapped = withTracing(handler);

    const req = makeRequest(
      "http://localhost:3000/api/projects/p/sessions/s/conversations/c/messages",
      { headers: { "x-trace-id": "conv-trace" } },
    );

    await wrapped(
      req,
      makeParams({ name: "p", session: "s", conversationId: "c" }),
    );

    expect(observed?.conversationId).toBe("c");
    expect(observed?.projectName).toBe("p");
    expect(observed?.sessionName).toBe("s");
  });

  it("accepts a catch-all route handler (string[] param) and still extracts the string params", async () => {
    let received:
      | { name: string; session: string; docPath: string[] }
      | undefined;
    const handler = async (
      _request: Request,
      context: {
        params: Promise<{ name: string; session: string; docPath: string[] }>;
      },
    ): Promise<Response> => {
      received = await context.params;
      return new Response("ok");
    };
    const wrapped = withTracing(handler);

    const req = makeRequest(
      "http://localhost:3000/api/projects/p/sessions/s/graph-workflow/shared-documents/a/b.md",
      { method: "PUT", headers: { "x-trace-id": "catchall-trace" } },
    );

    const response = await wrapped(req, {
      params: Promise.resolve({
        name: "p",
        session: "s",
        docPath: ["a", "b.md"],
      }),
    });

    expect(response.status).toBe(200);
    expect(received?.docPath).toEqual(["a", "b.md"]);
    const lines = readLogLines();
    const startLog = lines.find((l) => l["message"] === "request.start");
    expect(startLog?.["projectName"]).toBe("p");
    expect(startLog?.["sessionName"]).toBe("s");
  });

  it("handles routes without params gracefully", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withTracing(handler);

    const req = makeRequest("http://localhost:3000/api/hooks", {
      method: "POST",
    });

    // Simulate no params by providing a rejecting promise
    const ctx = { params: Promise.reject(new Error("no params")) };

    const response = await wrapped(req, ctx);
    expect(response.status).toBe(200);

    const lines = readLogLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("sets Server-Timing total header on non-streaming responses", async () => {
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const wrapped = withTracing(handler);

    const req = makeRequest("http://localhost:3000/api/test");
    const response = await wrapped(req, makeParams());

    const serverTiming = response.headers.get("Server-Timing");
    expect(serverTiming).toMatch(/^total;dur=\d+$/);
  });

  it("logs request.complete at warn when duration exceeds CC_REQUEST_SLOW_MS", async () => {
    process.env["CC_REQUEST_SLOW_MS"] = "0";
    _resetTracingForTesting();

    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withTracing(handler);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const req = makeRequest("http://localhost:3000/api/slow");
    await wrapped(req, makeParams());

    const lines = readLogLines();
    const completeLog = lines.find((l) => l["message"] === "request.complete");
    expect(completeLog?.["level"]).toBe("warn");

    stderrSpy.mockRestore();
  });

  it("tags SSE responses with streaming: true and durationMs: null, no Server-Timing", async () => {
    const handler = vi.fn(
      async () =>
        new Response("data: x\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const wrapped = withTracing(handler);

    const req = makeRequest("http://localhost:3000/api/events");
    const response = await wrapped(req, makeParams());

    expect(response.headers.get("Server-Timing")).toBeNull();

    const lines = readLogLines();
    const completeLog = lines.find((l) => l["message"] === "request.complete");
    expect(completeLog?.["streaming"]).toBe(true);
    expect(completeLog?.["durationMs"]).toBeNull();
    expect(completeLog?.["level"]).toBe("debug");
  });
});
