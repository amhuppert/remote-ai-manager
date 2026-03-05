import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  createPromptRouteHandlers,
  type PromptRouteDeps,
} from "./prompt-route-handlers";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function createTestDeps(): PromptRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    getSession: vi.fn().mockResolvedValue(testSession),
    isSessionBusy: vi.fn().mockReturnValue(false),
    executePromptStream: vi.fn().mockResolvedValue(undefined),
  };
}

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
  createdAt: "2024-01-01T00:00:00Z",
  lastActivityAt: "2024-01-01T00:00:00Z",
  archived: false,
  finished: false,
  conversations: [],
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: PromptRouteDeps;
let handlers: ReturnType<typeof createPromptRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createPromptRouteHandlers(deps);
});

// ===========================================================================
// API route tests
// ===========================================================================

describe("POST /api/projects/[name]/sessions/[session]/prompt", () => {
  it("returns SSE stream with text/event-stream content type on valid prompt", async () => {
    const response = await handlers.POST(
      makeRequest({ prompt: "Hello Claude" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("returns 400 when prompt field is missing", async () => {
    const response = await handlers.POST(makeRequest({}), makeParams());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain(
      "Either prompt text or at least one image is required",
    );
  });

  it("returns 400 when prompt is empty string", async () => {
    const response = await handlers.POST(
      makeRequest({ prompt: "   " }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain(
      "Either prompt text or at least one image is required",
    );
  });

  it("returns 404 when project is not found", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest({ prompt: "test" }),
      makeParams("unknown"),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 404 when session is not found", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest({ prompt: "test" }),
      makeParams("my-project", "unknown-session"),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 409 with SESSION_BUSY code when session is busy", async () => {
    vi.mocked(deps.isSessionBusy).mockReturnValue(true);
    const response = await handlers.POST(
      makeRequest({ prompt: "test" }),
      makeParams(),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("SESSION_BUSY");
    expect(body.error).toContain("Session is busy");
  });

  it("trims prompt text (whitespace-only rejected as empty)", async () => {
    const response = await handlers.POST(
      makeRequest({ prompt: "  Hello Claude  " }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  });
});
