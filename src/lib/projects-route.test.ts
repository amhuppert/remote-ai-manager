import { describe, it, expect, vi } from "vitest";

// Mock the discovery module
vi.mock("@/lib/discovery", () => ({
  discoverProjects: vi.fn(),
}));

describe("GET /api/projects", () => {
  it("returns JSON array of discovered projects with status 200", async () => {
    const { discoverProjects } = await import("@/lib/discovery");
    vi.mocked(discoverProjects).mockResolvedValue([
      {
        name: "my-project",
        path: "/home/user/projects/my-project",
        activeSessions: 1,
        hasRunningSession: true,
      },
    ]);

    const { GET } = await import("@/app/api/projects/route");
    const response = await GET();

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
    const { discoverProjects } = await import("@/lib/discovery");
    vi.mocked(discoverProjects).mockRejectedValue(
      new Error("Filesystem error"),
    );

    const { GET } = await import("@/app/api/projects/route");
    const response = await GET();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("Filesystem error");
  });

  it("returns generic error message for non-Error exceptions", async () => {
    const { discoverProjects } = await import("@/lib/discovery");
    vi.mocked(discoverProjects).mockRejectedValue("string error");

    const { GET } = await import("@/app/api/projects/route");
    const response = await GET();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to discover projects");
  });
});
