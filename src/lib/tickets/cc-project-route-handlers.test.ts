import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCommandCenterProjectRouteHandlers,
  type CommandCenterProjectRouteDeps,
} from "./cc-project-route-handlers";

function makeDeps(): CommandCenterProjectRouteDeps {
  return {
    resolveProjectName: vi.fn(async () => null),
  };
}

let deps: CommandCenterProjectRouteDeps;
let handlers: ReturnType<typeof createCommandCenterProjectRouteHandlers>;

beforeEach(() => {
  deps = makeDeps();
  handlers = createCommandCenterProjectRouteHandlers(deps);
});

describe("GET /api/command-center-project", () => {
  it("returns the resolved project name", async () => {
    vi.mocked(deps.resolveProjectName).mockResolvedValue("command-center");

    const response = await handlers.GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projectName: "command-center",
    });
  });

  it("returns a null project name when resolution is unavailable", async () => {
    const response = await handlers.GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projectName: null });
  });

  it("returns a stable 500 response when resolution throws", async () => {
    vi.mocked(deps.resolveProjectName).mockRejectedValue(
      new Error("git probe failed"),
    );

    const response = await handlers.GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to resolve the Command Center project",
    });
  });

  it("exports force-dynamic to disable response caching", async () => {
    const routeModule = await import("@/app/api/command-center-project/route");
    expect(routeModule.dynamic).toBe("force-dynamic");
  });
});
