import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { processHookEventMock, detectHooksStatusMock } = vi.hoisted(() => ({
  processHookEventMock: vi.fn(),
  detectHooksStatusMock: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  processHookEvent: processHookEventMock,
  detectHooksStatus: detectHooksStatusMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePostRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/hooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  processHookEventMock.mockResolvedValue(false);
  detectHooksStatusMock.mockResolvedValue({
    installed: false,
    hasUserPromptSubmit: false,
    hasStop: false,
  });
});

// ===========================================================================
// 5.2 – API route tests (Req 1.1, 1.3, 1.4, 5.1, 5.2)
// ===========================================================================

describe("POST /api/hooks", () => {
  it("returns 200 with { matched: true } when session matches (Req 1.1)", async () => {
    processHookEventMock.mockResolvedValue(true);
    const { POST } = await import("@/app/api/hooks/route");
    const response = await POST(
      makePostRequest({
        cwd: "/project/.worktrees/test",
        session_id: "abc",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matched).toBe(true);
  });

  it("returns 200 with { matched: false } when no match (Req 1.3)", async () => {
    processHookEventMock.mockResolvedValue(false);
    const { POST } = await import("@/app/api/hooks/route");
    const response = await POST(makePostRequest({ cwd: "/unknown/path" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matched).toBe(false);
  });

  it("returns 400 for invalid body (Req 1.4)", async () => {
    const { POST } = await import("@/app/api/hooks/route");
    const badRequest = new Request("http://localhost/api/hooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    }) as unknown as NextRequest;
    const response = await POST(badRequest);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid JSON body");
  });
});

describe("GET /api/hooks/status", () => {
  it("returns 200 with detection result (Req 5.1, 5.2)", async () => {
    detectHooksStatusMock.mockResolvedValue({
      installed: true,
      hasUserPromptSubmit: true,
      hasStop: true,
    });
    const { GET } = await import("@/app/api/hooks/status/route");
    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.installed).toBe(true);
    expect(body.hasUserPromptSubmit).toBe(true);
    expect(body.hasStop).toBe(true);
  });

  it("returns correct fields when hooks not installed (Req 5.2)", async () => {
    detectHooksStatusMock.mockResolvedValue({
      installed: false,
      hasUserPromptSubmit: false,
      hasStop: false,
    });
    const { GET } = await import("@/app/api/hooks/status/route");
    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.installed).toBe(false);
    expect(body.hasUserPromptSubmit).toBe(false);
    expect(body.hasStop).toBe(false);
  });
});
