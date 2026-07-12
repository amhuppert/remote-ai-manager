import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  createProjectRouteHandlers,
  type ProjectRouteDeps,
} from "./route-handlers";

function createTestDeps(): ProjectRouteDeps {
  return {
    deleteProject: vi.fn().mockResolvedValue({
      sessionsRemoved: 0,
      deletedTicketNumbers: [],
    }),
  };
}

function makeRequest(url: string): NextRequest {
  return new Request(url, { method: "DELETE" }) as unknown as NextRequest;
}

function makeParams(name = "test-proj") {
  return { params: Promise.resolve({ name }) };
}

let deps: ProjectRouteDeps;
let handlers: ReturnType<typeof createProjectRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createProjectRouteHandlers(deps);
});

describe("DELETE /api/projects/[name]", () => {
  it("reports removed sessions and authoritative deleted ticket numbers", async () => {
    vi.mocked(deps.deleteProject).mockResolvedValue({
      sessionsRemoved: 3,
      deletedTicketNumbers: [2, 7],
    });

    const response = await handlers.DELETE(
      makeRequest(
        "http://localhost/api/projects/test-proj?projectPath=%2Fprojects%2Ftest-proj",
      ),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      sessionsRemoved: 3,
      deletedTicketNumbers: [2, 7],
    });
    expect(deps.deleteProject).toHaveBeenCalledWith("/projects/test-proj");
  });

  it("returns 400 when projectPath query parameter is missing", async () => {
    const response = await handlers.DELETE(
      makeRequest("http://localhost/api/projects/test-proj"),
      makeParams(),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("projectPath");
    expect(deps.deleteProject).not.toHaveBeenCalled();
  });

  it("returns 404 when deleteProject throws 'Project not found'", async () => {
    vi.mocked(deps.deleteProject).mockRejectedValue(
      new Error("Project not found: /projects/ghost"),
    );

    const response = await handlers.DELETE(
      makeRequest(
        "http://localhost/api/projects/ghost?projectPath=%2Fprojects%2Fghost",
      ),
      makeParams("ghost"),
    );

    expect(response.status).toBe(404);
  });

  it("returns 500 for any other error from deleteProject", async () => {
    vi.mocked(deps.deleteProject).mockRejectedValue(new Error("disk on fire"));

    const response = await handlers.DELETE(
      makeRequest(
        "http://localhost/api/projects/test-proj?projectPath=%2Fprojects%2Ftest-proj",
      ),
      makeParams(),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("disk on fire");
  });
});
