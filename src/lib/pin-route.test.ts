import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
vi.mock("@/lib/project-resolver", () => ({
  resolveProjectPath: vi.fn(),
}));

vi.mock("@/lib/state", () => ({
  setProjectPinned: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/projects/test-proj/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/projects/[name]/pin", () => {
  it("pins a project when pinned:true", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { setProjectPinned } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/home/projects/test-proj");
    vi.mocked(setProjectPinned).mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/projects/[name]/pin/route");
    const response = await POST(makeRequest({ pinned: true }), {
      params: Promise.resolve({ name: "test-proj" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(setProjectPinned).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      true,
    );
  });

  it("unpins a project when pinned:false", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { setProjectPinned } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/home/projects/test-proj");
    vi.mocked(setProjectPinned).mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/projects/[name]/pin/route");
    const response = await POST(makeRequest({ pinned: false }), {
      params: Promise.resolve({ name: "test-proj" }),
    });

    expect(response.status).toBe(200);
    expect(setProjectPinned).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      false,
    );
  });

  it("returns 404 for unknown project", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    vi.mocked(resolveProjectPath).mockResolvedValue(null);

    const { POST } = await import("@/app/api/projects/[name]/pin/route");
    const response = await POST(makeRequest({ pinned: true }), {
      params: Promise.resolve({ name: "nonexistent" }),
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 400 for invalid body", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    vi.mocked(resolveProjectPath).mockResolvedValue("/home/projects/test-proj");

    const { POST } = await import("@/app/api/projects/[name]/pin/route");
    const response = await POST(makeRequest({ invalid: "data" }), {
      params: Promise.resolve({ name: "test-proj" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("pinned");
  });
});
