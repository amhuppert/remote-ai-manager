import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  createArchiveRouteHandlers,
  type ArchiveRouteDeps,
} from "./archive-route-handlers";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function createTestDeps(): ArchiveRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    setProjectArchived: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/projects/test-proj/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeParams(name = "test-proj") {
  return { params: Promise.resolve({ name }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: ArchiveRouteDeps;
let handlers: ReturnType<typeof createArchiveRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createArchiveRouteHandlers(deps);
});

// ===========================================================================
// API route tests
// ===========================================================================

describe("POST /api/projects/[name]/archive", () => {
  it("archives a project when archived:true", async () => {
    const response = await handlers.POST(
      makeRequest({ archived: true }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deps.setProjectArchived).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      true,
    );
  });

  it("unarchives a project when archived:false", async () => {
    const response = await handlers.POST(
      makeRequest({ archived: false }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.setProjectArchived).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      false,
    );
  });

  it("returns 404 for unknown project", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);

    const response = await handlers.POST(
      makeRequest({ archived: true }),
      makeParams("nonexistent"),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 400 for invalid body", async () => {
    const response = await handlers.POST(
      makeRequest({ invalid: "data" }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("archived");
  });
});
