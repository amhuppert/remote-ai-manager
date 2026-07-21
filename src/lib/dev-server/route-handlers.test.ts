import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDevServerRouteHandlers,
  type DevServerRouteDeps,
} from "./route-handlers";
import {
  UnmanagedDevServerDetectedError,
  createDevServerService,
  type DevServerService,
  type DevServerServiceDeps,
  type DevServerStatusItem,
} from "./service";
import {
  createDevServerRegistry,
  type DevServerRegistryDeps,
} from "./registry";
import type { PortOwnershipInput, PortOwnershipResult } from "./port-ownership";
import type { PublishFn } from "@/lib/events/publication";
import type { DevServerStatusEvent } from "@/lib/dev-server/schemas";

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
    awaitReady: vi.fn(async () => makeStatus({ status: "running" })),
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

// Criterion 2: the durable-acceptance boundary, proven end-to-end through the
// production seams — the real START route → real DevServerService → real
// DevServerRegistry (real spawn + the registry-owned `dev-server-status`
// broadcast the client's SSE reaction invalidates on). A server whose readiness
// is gated ("slow") must NOT delay the 202; readiness later propagates through
// that same broadcast. If the accept path awaited readiness, the START call
// could not resolve while `ready` is false — it would block until the readiness
// timeout, failing this test.
describe("dev-server START durable-acceptance boundary", () => {
  const projectPath = "/repos/accept-boundary";
  const sessionName = "s1";
  const serverName = "web";
  const assignedPort = 59950;

  let worktreePath: string;
  let registry: ReturnType<typeof createDevServerRegistry>;
  let broadcastEvents: DevServerStatusEvent[];
  let ready: boolean;

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(tmpdir(), "cc-accept-boundary-"));
    broadcastEvents = [];
    ready = false;

    const broadcast: PublishFn = (event) => {
      if (event.type === "dev-server-status") {
        broadcastEvents.push(event);
      }
      return { delivered: true };
    };

    const registryDeps: DevServerRegistryDeps = {
      broadcast,
      tailscale: {
        register: vi.fn().mockResolvedValue(null),
        unregister: vi.fn().mockResolvedValue(undefined),
      },
      readConfig: vi.fn().mockResolvedValue({
        tailscaleEnabled: false,
        baseDir: "/tmp",
        ignorePatterns: [],
        claudeTimeoutMs: 300_000,
      }),
      livenessStart: vi.fn(),
      getLanUrl: vi.fn((port: number) => `http://192.168.1.100:${port}`),
      // Gated readiness: the assigned port never "listens" until the test flips
      // `ready`, modeling a dev server that takes seconds to boot.
      checkPortListening: vi.fn(async () => ready),
      classifyPortOwnership: vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({ status: "owned", pid: 4242, cwd: worktreePath }),
      sendSignal: vi.fn().mockReturnValue(true),
      isProcessAlive: vi.fn().mockReturnValue(false),
      killGraceMs: 200,
    };
    registry = createDevServerRegistry(registryDeps);
  });

  afterEach(() => {
    // Kills the spawned `sleep 60` process group and clears the shared registry.
    registry._resetForTesting();
    rmSync(worktreePath, { recursive: true, force: true });
  });

  function makeRealHandlers() {
    const serviceDeps: DevServerServiceDeps = {
      getSession: async () => ({ worktreePath }),
      readRepoConfig: async () => ({
        devServers: [
          {
            name: serverName,
            command: "sleep 60",
            port: { base: assignedPort, range: 10 },
          },
        ],
      }),
      reconcileSessionDevServers: async () => {},
      getSessionServers: registry.getSessionServers,
      getServer: registry.getServer,
      startServer: registry.startServer,
      stopServer: registry.stopServer,
      killListeningProcessForPort: registry.killListeningProcessForPort,
      selectPort: async () => ({ status: "selected", port: assignedPort }),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    };
    const service = createDevServerService(serviceDeps);

    const routeDeps: DevServerRouteDeps = {
      resolveProjectPath: async () => projectPath,
      getSession: async () => ({ worktreePath }),
      service,
      stopAllForSession: async () => {},
      getServer: registry.getServer,
      stopServer: registry.stopServer,
    };
    return createDevServerRouteHandlers(routeDeps);
  }

  it("responds 202 with the current status item without awaiting slow readiness, then propagates readiness through the production dev-server-status broadcast", async () => {
    const handlers = makeRealHandlers();

    const response = await handlers.START(
      new Request("http://cc.test/dev-servers/web/start", { method: "POST" }),
      context({ name: "accept-boundary", session: sessionName, serverName }),
    );

    // The 202 returns at the boundary — intent recorded + spawn initiated. It
    // resolved while readiness is still gated (`ready === false`), so the accept
    // path did not await readiness. The body carries the current status item.
    expect(response.status).toBe(202);
    const body = (await json(response)) as {
      status: string;
      server: { status: string; serverName: string };
    };
    expect(body.status).toBe("accepted");
    expect(body.server).toMatchObject({ serverName, status: "starting" });

    // Slow readiness did not gate the response: at 202 time the registry has
    // broadcast only "starting"; nothing has reached "running".
    expect(broadcastEvents.map((e) => e.status)).toContain("starting");
    expect(broadcastEvents.some((e) => e.status === "running")).toBe(false);

    // Readiness completes post-boundary. It must reach the client through the
    // SAME registry-owned `dev-server-status` publication the client's SSE
    // reaction invalidates on.
    ready = true;
    await vi.waitFor(
      () => {
        expect(
          broadcastEvents.some(
            (e) => e.type === "dev-server-status" && e.status === "running",
          ),
        ).toBe(true);
      },
      { timeout: 3000, interval: 10 },
    );

    const runningEvent = broadcastEvents.find((e) => e.status === "running");
    expect(runningEvent).toMatchObject({
      type: "dev-server-status",
      projectName: projectPath,
      sessionName,
      serverName,
      status: "running",
      port: assignedPort,
    });

    // The registry runtime state transitioned via that same reaction path.
    const entry = registry.getServer({
      projectPath,
      sessionName,
      worktreePath,
      serverName,
    });
    expect(entry?.status).toBe("running");
  });
});
