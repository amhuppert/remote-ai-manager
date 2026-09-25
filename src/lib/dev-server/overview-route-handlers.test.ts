import { describe, expect, it, vi } from "vitest";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  createDevServerOverviewRouteHandlers,
  type DevServerOverviewRouteDeps,
} from "./overview-route-handlers";

function makeHandlers(overrides: Partial<DevServerOverviewRouteDeps> = {}) {
  const deps: DevServerOverviewRouteDeps = {
    overview: { read: vi.fn(async () => ({ projects: [] })) },
    resolveProjectPath: vi.fn(async (name: string) =>
      name === "alpha" ? "/repos/alpha" : null,
    ),
    getServer: vi.fn(() => ({ status: "running" as const })),
    stopServer: vi.fn(async () => {}),
    ...overrides,
  };
  return { handlers: createDevServerOverviewRouteHandlers(deps), deps };
}

function stopRequest(body: unknown): Request {
  return new Request("http://cc.test/api/dev-servers/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("dev-server overview routes", () => {
  it("STOP_INSTANCE stops the exact session instance it names", async () => {
    const { handlers, deps } = makeHandlers();

    const response = await handlers.STOP_INSTANCE(
      stopRequest({
        projectName: "alpha",
        sessionName: "feature",
        worktreePath: "/repos/alpha/.worktrees/feature-1a2b3c.ctx-api",
        serverName: "web",
      }),
    );

    expect(response.status).toBe(200);
    expect(deps.stopServer).toHaveBeenCalledWith({
      projectPath: "/repos/alpha",
      sessionName: "feature",
      worktreePath: "/repos/alpha/.worktrees/feature-1a2b3c.ctx-api",
      serverName: "web",
    });
  });

  it("STOP_INSTANCE addresses the project root when sessionName is null", async () => {
    const { handlers, deps } = makeHandlers();

    const response = await handlers.STOP_INSTANCE(
      stopRequest({
        projectName: "alpha",
        sessionName: null,
        worktreePath: "/repos/alpha",
        serverName: "web",
      }),
    );

    expect(response.status).toBe(200);
    expect(deps.stopServer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        worktreePath: "/repos/alpha",
      }),
    );
  });

  it("STOP_INSTANCE returns 404 without stopping when the instance is not running", async () => {
    const { handlers, deps } = makeHandlers({
      getServer: vi.fn(() => ({ status: "stopped" as const })),
    });

    const response = await handlers.STOP_INSTANCE(
      stopRequest({
        projectName: "alpha",
        sessionName: "feature",
        worktreePath: "/repos/alpha/.worktrees/feature-1a2b3c",
        serverName: "web",
      }),
    );

    expect(response.status).toBe(404);
    expect(deps.stopServer).not.toHaveBeenCalled();
  });

  it("STOP_INSTANCE rejects a malformed body", async () => {
    const { handlers, deps } = makeHandlers();

    const response = await handlers.STOP_INSTANCE(
      stopRequest({ projectName: "alpha", serverName: "web" }),
    );

    expect(response.status).toBe(400);
    expect(deps.stopServer).not.toHaveBeenCalled();
  });
});
