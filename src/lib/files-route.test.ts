import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { FileItem } from "@/types";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { resolveProjectPathMock, scanProjectFilesMock } = vi.hoisted(() => ({
  resolveProjectPathMock: vi.fn(),
  scanProjectFilesMock: vi.fn(),
}));

vi.mock("@/lib/project-resolver", () => ({
  resolveProjectPath: resolveProjectPathMock,
}));

vi.mock("@/lib/file-scanner", () => ({
  scanProjectFiles: scanProjectFilesMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(): NextRequest {
  return new Request("http://localhost/api/projects/my-project/files", {
    method: "GET",
  }) as unknown as NextRequest;
}

function makeParams(name = "my-project") {
  return { params: Promise.resolve({ name }) };
}

const testFiles: FileItem[] = [
  { path: "src/index.ts" },
  { path: "src/app.tsx" },
  { path: "package.json" },
];

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  resolveProjectPathMock.mockResolvedValue("/projects/my-project");
  scanProjectFilesMock.mockResolvedValue(testFiles);
});

// ===========================================================================
// GET /api/projects/[name]/files
// ===========================================================================

describe("GET /api/projects/[name]/files", () => {
  it("returns 200 with correct response shape", async () => {
    const { GET } = await import("@/app/api/projects/[name]/files/route");
    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: FileItem[] };
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toEqual({ path: "src/index.ts" });
  });

  it("returns 404 when project not found", async () => {
    resolveProjectPathMock.mockResolvedValue(null);

    const { GET } = await import("@/app/api/projects/[name]/files/route");
    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Project not found");
  });

  it("returns 500 on scanner error", async () => {
    scanProjectFilesMock.mockRejectedValue(new Error("Permission denied"));

    const { GET } = await import("@/app/api/projects/[name]/files/route");
    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Permission denied");
  });

  it("returns empty items for project with no files", async () => {
    scanProjectFilesMock.mockResolvedValue([]);

    const { GET } = await import("@/app/api/projects/[name]/files/route");
    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: FileItem[] };
    expect(body.items).toEqual([]);
  });

  it("passes project path to scanProjectFiles", async () => {
    const { GET } = await import("@/app/api/projects/[name]/files/route");
    await GET(makeRequest(), makeParams());

    expect(scanProjectFilesMock).toHaveBeenCalledWith("/projects/my-project");
  });
});
