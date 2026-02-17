import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  resolveProjectPathMock,
  getSessionMock,
  isSessionBusyMock,
  executePromptMock,
} = vi.hoisted(() => ({
  resolveProjectPathMock: vi.fn(),
  getSessionMock: vi.fn(),
  isSessionBusyMock: vi.fn(),
  executePromptMock: vi.fn(),
}));

vi.mock("@/lib/project-resolver", () => ({
  resolveProjectPath: resolveProjectPathMock,
}));

vi.mock("@/lib/state", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/lock", () => ({
  isSessionBusy: isSessionBusyMock,
}));

vi.mock("@/lib/prompt", () => ({
  executePrompt: executePromptMock,
}));

// Mock logging to avoid file I/O during tests
vi.mock("@/lib/logging", () => ({
  withTracing: (handler: (...args: unknown[]) => unknown) => handler,
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): NextRequest {
  return new Request(
    "http://localhost/api/projects/my-project/sessions/test-session/prompt",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as NextRequest;
}

function makeParams(name = "my-project", session = "test-session") {
  return { params: Promise.resolve({ name, session }) };
}

const testSession = {
  sessionName: "test-session",
  worktreePath: "/projects/my-project/.worktrees/test-session",
  branchName: "csm/test-session",
  claudeSessionId: null,
  transcriptPath: null,
  status: "ready" as const,
  createdAt: "2024-01-01T00:00:00Z",
  lastActivityAt: "2024-01-01T00:00:00Z",
  promptCount: 0,
  archived: false,
              finished: false,
  messages: [],
};

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  resolveProjectPathMock.mockResolvedValue("/projects/my-project");
  getSessionMock.mockResolvedValue(testSession);
  isSessionBusyMock.mockReturnValue(false);
  executePromptMock.mockResolvedValue({
    output: '{"result":"Claude says hello","session_id":"sess-123"}',
    claudeResponse: "Claude says hello",
  });
});

// ===========================================================================
// 2.6 – API route tests (Req 7.1–7.7)
// ===========================================================================

describe("POST /api/projects/[name]/sessions/[session]/prompt", () => {
  it("returns 200 with { success: true } on valid prompt (Req 7.1)", async () => {
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/prompt/route");
    const response = await POST(
      makeRequest({ prompt: "Hello Claude" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it("includes X-Claude-Output-Length header (Req 7.6)", async () => {
    executePromptMock.mockResolvedValue({
      output: "12345",
      claudeResponse: "12345",
    });
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/prompt/route");
    const response = await POST(makeRequest({ prompt: "test" }), makeParams());

    expect(response.headers.get("X-Claude-Output-Length")).toBe("5");
  });

  it("returns 400 when prompt field is missing (Req 7.2)", async () => {
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/prompt/route");
    const response = await POST(makeRequest({}), makeParams());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("prompt is required");
  });

  it("returns 400 when prompt is empty string (Req 7.2)", async () => {
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/prompt/route");
    const response = await POST(makeRequest({ prompt: "   " }), makeParams());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("prompt is required");
  });

  it("returns 404 when project is not found (Req 7.3)", async () => {
    resolveProjectPathMock.mockResolvedValue(null);
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/prompt/route");
    const response = await POST(
      makeRequest({ prompt: "test" }),
      makeParams("unknown"),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 404 when session is not found (Req 7.4)", async () => {
    getSessionMock.mockResolvedValue(null);
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/prompt/route");
    const response = await POST(
      makeRequest({ prompt: "test" }),
      makeParams("my-project", "unknown-session"),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 409 with SESSION_BUSY code when session is busy (Req 7.5)", async () => {
    isSessionBusyMock.mockReturnValue(true);
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/prompt/route");
    const response = await POST(makeRequest({ prompt: "test" }), makeParams());

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("SESSION_BUSY");
    expect(body.error).toContain("Session is busy");
  });

  it("returns 500 with error message when execution fails (Req 7.7)", async () => {
    executePromptMock.mockRejectedValue(
      new Error("Prompt execution failed: CLI crashed"),
    );
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/prompt/route");
    const response = await POST(makeRequest({ prompt: "test" }), makeParams());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain("Prompt execution failed");
  });
});
