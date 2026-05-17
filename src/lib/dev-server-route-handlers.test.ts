import { describe, expect, it, vi } from "vitest";
import {
  createDevServerRouteHandlers,
  type DevServerRouteDeps,
} from "./dev-server-route-handlers";
import type {
  DevServerService,
  DevServerStatusItem,
} from "./dev-server-service";

function makeStatus(
  overrides: Partial<DevServerStatusItem> = {},
): DevServerStatusItem {
  return {
    serverName: "web",
    command: "npx next dev --port $CC_ASSIGNED_PORT",
    status: "stopped",
    port: null,
    localUrl: null,
    remoteUrl: null,
    startedAt: null,
    errorMessage: null,
    recentOutput: [],
    source: null,
    ownedByThisSession: false,
    worktreePath: null,
    ownerPid: null,
    ...overrides,
  };
}

function makeService(
  overrides: Partial<DevServerService> = {},
): DevServerService {
  return {
    list: vi.fn(async () => []),
    ensure: vi.fn(async () => makeStatus({ status: "starting" })),
    stop: vi.fn(async () => makeStatus({ status: "stopped" })),
    ...overrides,
  };
}

function makeHandlers(service: DevServerService) {
  const deps: DevServerRouteDeps = {
    resolveProjectPath: vi.fn(async () => "/repos/project"),
    service,
  };
  return { handlers: createDevServerRouteHandlers(deps), deps };
}

function context(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

async function json(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

describe("dev-server route handlers", () => {
  it("GET lists servers through DevServerService so status is reconciled consistently", async () => {
    const service = makeService({
      list: vi.fn(async () => [
        makeStatus({
          serverName: "web",
          status: "running",
          port: 3004,
          localUrl: "http://localhost:3004",
          ownedByThisSession: true,
          source: "external-adopted",
          ownerPid: 1234,
          worktreePath: "/repos/project/.worktrees/s1",
        }),
      ]),
    });
    const { handlers } = makeHandlers(service);

    const response = await handlers.GET(
      new Request("http://cc.test/dev-servers"),
      context({ name: "project", session: "s1" }),
    );

    expect(response.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith({
      projectPath: "/repos/project",
      sessionName: "s1",
    });
    expect(await json(response)).toMatchObject({
      servers: [
        {
          serverName: "web",
          status: "running",
          port: 3004,
          ownedByThisSession: true,
          source: "external-adopted",
        },
      ],
    });
  });

  it("START delegates to ensure(wait=false) so cc-assigned configuration is honored", async () => {
    const service = makeService({
      ensure: vi.fn(async () => makeStatus({ status: "starting" })),
    });
    const { handlers } = makeHandlers(service);

    const response = await handlers.START(
      new Request("http://cc.test/dev-servers/web/start", {
        method: "POST",
      }),
      context({ name: "project", session: "s1", serverName: "web" }),
    );

    expect(response.status).toBe(202);
    expect(service.ensure).toHaveBeenCalledWith({
      projectPath: "/repos/project",
      sessionName: "s1",
      serverName: "web",
      wait: false,
    });
  });

  it("START_ALL ensures only inactive servers after reconciliation", async () => {
    const service = makeService({
      list: vi.fn(async () => [
        makeStatus({ serverName: "running", status: "running", port: 3000 }),
        makeStatus({ serverName: "starting", status: "starting" }),
        makeStatus({ serverName: "stopped", status: "stopped" }),
        makeStatus({ serverName: "errored", status: "error" }),
      ]),
      ensure: vi.fn(async ({ serverName }) =>
        makeStatus({ serverName, status: "starting" }),
      ),
    });
    const { handlers } = makeHandlers(service);

    const response = await handlers.START_ALL(
      new Request("http://cc.test/dev-servers/start-all", {
        method: "POST",
      }),
      context({ name: "project", session: "s1" }),
    );

    expect(response.status).toBe(202);
    expect(service.ensure).toHaveBeenCalledTimes(2);
    expect(service.ensure).toHaveBeenNthCalledWith(1, {
      projectPath: "/repos/project",
      sessionName: "s1",
      serverName: "stopped",
      wait: false,
    });
    expect(service.ensure).toHaveBeenNthCalledWith(2, {
      projectPath: "/repos/project",
      sessionName: "s1",
      serverName: "errored",
      wait: false,
    });
  });

  it("START_ALL returns 400 when no dev servers are configured", async () => {
    const service = makeService({
      list: vi.fn(async () => []),
    });
    const { handlers } = makeHandlers(service);

    const response = await handlers.START_ALL(
      new Request("http://cc.test/dev-servers/start-all", {
        method: "POST",
      }),
      context({ name: "project", session: "s1" }),
    );

    expect(response.status).toBe(400);
    expect(service.ensure).not.toHaveBeenCalled();
  });
});
