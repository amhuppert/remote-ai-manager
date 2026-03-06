import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  createPinRouteHandlers,
  type PinRouteDeps,
} from "./pin-route-handlers";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function createTestDeps(): PinRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    setProjectPinned: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/projects/test-proj/pin", {
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

let deps: PinRouteDeps;
let handlers: ReturnType<typeof createPinRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createPinRouteHandlers(deps);
});

// ===========================================================================
// API route tests
// ===========================================================================

describe("POST /api/projects/[name]/pin", () => {
  it("pins a project when pinned:true", async () => {
    const response = await handlers.POST(
      makeRequest({ pinned: true }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deps.setProjectPinned).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      true,
    );
  });

  it("unpins a project when pinned:false", async () => {
    const response = await handlers.POST(
      makeRequest({ pinned: false }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.setProjectPinned).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      false,
    );
  });

  it("returns 404 for unknown project", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);

    const response = await handlers.POST(
      makeRequest({ pinned: true }),
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
    expect(body.error).toContain("pinned");
  });
});
