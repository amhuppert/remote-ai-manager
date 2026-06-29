import { describe, expect, it, vi } from "vitest";
import {
  createDevServerRouteHandlers,
  type DevServerRouteDeps,
} from "./route-handlers";
import {
  UnmanagedDevServerDetectedError,
  type DevServerService,
  type DevServerStatusItem,
} from "./service";

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
    ownedByThisSession: false,
    worktreePath: null,
    ownerPid: null,
    logFilePath: null,
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
    stopUnmanaged: vi.fn(async () => ({ killed: [], skipped: [] })),
    ...overrides,
  };
}

function makeHandlers(
  service: DevServerService,
  overrides: Partial<DevServerRouteDeps> = {},
) {
  const deps: DevServerRouteDeps = {
    resolveProjectPath: vi.fn(async () => "/repos/project"),
    getSession: vi.fn(async () => ({
      worktreePath: "/repos/project/.worktrees/s1",
    })),
    service,
    stopAllForSession: vi.fn(async () => {}),
    getServer: vi.fn(() => ({ status: "running" })),
    stopServer: vi.fn(async () => {}),
    ...overrides,
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

  it("START returns 409 with structured payload when an unmanaged listener is detected", async () => {
    const service = makeService({
      ensure: vi.fn(async () => {
        throw new UnmanagedDevServerDetectedError(
          "web",
          3007,
          5001,
          "/repos/project/.worktrees/s1",
        );
      }),
    });
    const { handlers } = makeHandlers(service);

    const response = await handlers.START(
      new Request("http://cc.test/dev-servers/web/start", {
        method: "POST",
      }),
      context({ name: "project", session: "s1", serverName: "web" }),
    );

    expect(response.status).toBe(409);
    const body = (await json(response)) as {
      error: string;
      code: string;
      details: {
        serverName: string;
        port: number;
        pid: number;
        cwd: string;
      };
    };
    expect(body.code).toBe("UNMANAGED_DEV_SERVER_DETECTED");
    expect(body.details).toEqual({
      serverName: "web",
      port: 3007,
      pid: 5001,
      cwd: "/repos/project/.worktrees/s1",
    });
  });

  it("STOP_UNMANAGED delegates to service.stopUnmanaged with structured request", async () => {
    const stopUnmanaged = vi.fn(async () => ({
      killed: [5001],
      skipped: [],
    }));
    const service = makeService({ stopUnmanaged });
    const { handlers } = makeHandlers(service);

    const response = await handlers.STOP_UNMANAGED(
      new Request("http://cc.test/dev-servers/web/stop-unmanaged", {
        method: "POST",
        body: JSON.stringify({ port: 3007 }),
        headers: { "content-type": "application/json" },
      }),
      context({ name: "project", session: "s1", serverName: "web" }),
    );

    expect(response.status).toBe(200);
    expect(stopUnmanaged).toHaveBeenCalledWith({
      projectPath: "/repos/project",
      sessionName: "s1",
      serverName: "web",
      port: 3007,
    });
    expect(await json(response)).toMatchObject({
      status: "ok",
      killed: [5001],
    });
  });

  it("STOP_UNMANAGED returns 409 when ownership cannot be verified", async () => {
    const stopUnmanaged = vi.fn(async () => ({
      killed: [],
      skipped: [{ pid: 5001, reason: "cwd_not_owned", cwd: "/other" }],
    }));
    const service = makeService({ stopUnmanaged });
    const { handlers } = makeHandlers(service);

    const response = await handlers.STOP_UNMANAGED(
      new Request("http://cc.test/dev-servers/web/stop-unmanaged", {
        method: "POST",
        body: JSON.stringify({ port: 3007 }),
        headers: { "content-type": "application/json" },
      }),
      context({ name: "project", session: "s1", serverName: "web" }),
    );

    expect(response.status).toBe(409);
    const body = (await json(response)) as {
      error: string;
      code: string;
    };
    expect(body.code).toBe("UNMANAGED_OWNERSHIP_UNVERIFIED");
  });
});
