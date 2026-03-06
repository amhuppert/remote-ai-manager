import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createProjectsRouteHandlers,
  type ProjectsRouteDeps,
} from "./projects-route-handlers";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function createTestDeps(): ProjectsRouteDeps {
  return {
    discoverProjects: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: ProjectsRouteDeps;
let handlers: ReturnType<typeof createProjectsRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createProjectsRouteHandlers(deps);
});

// ===========================================================================
// API route tests
// ===========================================================================

describe("GET /api/projects", () => {
  it("returns JSON array of discovered projects with status 200", async () => {
    vi.mocked(deps.discoverProjects).mockResolvedValue([
      {
        name: "my-project",
        path: "/home/user/projects/my-project",
        activeSessions: 1,
        hasRunningSession: true,
      },
    ]);

    const response = await handlers.GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("my-project");
    expect(body[0].activeSessions).toBe(1);
    expect(body[0].hasRunningSession).toBe(true);
  });

  it("exports force-dynamic to disable response caching", async () => {
    const routeModule = await import("@/app/api/projects/route");
    expect(routeModule.dynamic).toBe("force-dynamic");
  });

  it("returns 500 with error field when discovery fails", async () => {
    vi.mocked(deps.discoverProjects).mockRejectedValue(
      new Error("Filesystem error"),
    );

    const response = await handlers.GET();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("Filesystem error");
  });

  it("returns generic error message for non-Error exceptions", async () => {
    vi.mocked(deps.discoverProjects).mockRejectedValue("string error");

    const response = await handlers.GET();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to discover projects");
  });
});
