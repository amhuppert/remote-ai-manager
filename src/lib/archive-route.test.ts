import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
vi.mock("@/lib/project-resolver", () => ({
  resolveProjectPath: vi.fn(),
}));

vi.mock("@/lib/state", () => ({
  setProjectArchived: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/projects/test-proj/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/projects/[name]/archive", () => {
  it("archives a project when archived:true", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { setProjectArchived } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/home/projects/test-proj");
    vi.mocked(setProjectArchived).mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/projects/[name]/archive/route");
    const response = await POST(makeRequest({ archived: true }), {
      params: Promise.resolve({ name: "test-proj" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(setProjectArchived).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      true,
    );
  });

  it("unarchives a project when archived:false", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { setProjectArchived } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/home/projects/test-proj");
    vi.mocked(setProjectArchived).mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/projects/[name]/archive/route");
    const response = await POST(makeRequest({ archived: false }), {
      params: Promise.resolve({ name: "test-proj" }),
    });

    expect(response.status).toBe(200);
    expect(setProjectArchived).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      false,
    );
  });

  it("returns 404 for unknown project", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    vi.mocked(resolveProjectPath).mockResolvedValue(null);

    const { POST } = await import("@/app/api/projects/[name]/archive/route");
    const response = await POST(makeRequest({ archived: true }), {
      params: Promise.resolve({ name: "nonexistent" }),
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 400 for invalid body", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    vi.mocked(resolveProjectPath).mockResolvedValue("/home/projects/test-proj");

    const { POST } = await import("@/app/api/projects/[name]/archive/route");
    const response = await POST(makeRequest({ invalid: "data" }), {
      params: Promise.resolve({ name: "test-proj" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("archived");
  });
});
