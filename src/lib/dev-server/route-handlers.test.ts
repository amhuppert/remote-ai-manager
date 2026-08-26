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
import { createPortSelectionService } from "./port-selection";
import type { PublishFn } from "@/lib/events/publication";
import type { DevServerStatusEvent } from "@/lib/dev-server/schemas";
import {
  DevServerTargetError,
  type ResolvedDevServerTarget,
  type DevServerTargetResolver,
} from "./target-resolver";

const SESSION_WORKTREE = "/repos/project/.worktrees/s1";
const LANE_WORKTREE = "/repos/project/.worktrees/s1.lane";

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
      worktreePath: SESSION_WORKTREE,
    })),
    targetResolver: {
      resolve: vi.fn(
        async ({ target }): Promise<ResolvedDevServerTarget> => ({
          kind: target.kind,
          worktreePath:
            target.kind === "workflow-context"
              ? LANE_WORKTREE
              : SESSION_WORKTREE,
          branchName:
            target.kind === "workflow-context" ? "lane-branch" : "s1-branch",
          isolation:
            target.kind === "workflow-context" ? "worktree" : "session",
          executionId:
            target.kind === "workflow-context" ? target.executionId : null,
          contextId:
            target.kind === "workflow-context" ? target.contextId : null,
          laneId: target.kind === "workflow-context" ? "lane-1" : null,
        }),
      ),
    },
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
      worktreePath: SESSION_WORKTREE,
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
      worktreePath: SESSION_WORKTREE,
    });
  });

  it("GET lists only the server-owned workflow context target", async () => {
    const service = makeService();
    const { handlers } = makeHandlers(service);

    const response = await handlers.GET(
      new Request(
        "http://cc.test/dev-servers?executionId=execution-1&contextId=ctx-1",
      ),
      context({ name: "project", session: "s1" }),
    );

    expect(response.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith({
      projectPath: "/repos/project",
      sessionName: "s1",
      worktreePath: LANE_WORKTREE,
    });
  });

  it("START spawns only in the server-owned workflow context target", async () => {
    const service = makeService();
    const { handlers } = makeHandlers(service);

    const response = await handlers.START(
      new Request(
        "http://cc.test/dev-servers/web/start?executionId=execution-1&contextId=ctx-1",
        { method: "POST" },
      ),
      context({ name: "project", session: "s1", serverName: "web" }),
    );

    expect(response.status).toBe(202);
    expect(service.ensure).toHaveBeenCalledWith({
      projectPath: "/repos/project",
      sessionName: "s1",
      serverName: "web",
      wait: false,
      worktreePath: LANE_WORKTREE,
    });
  });

  it("STOP looks up and stops only the server-owned workflow context target", async () => {
    const service = makeService();
    const { handlers, deps } = makeHandlers(service);

    const response = await handlers.STOP(
      new Request(
        "http://cc.test/dev-servers/web/stop?executionId=execution-1&contextId=ctx-1",
        { method: "POST" },
      ),
      context({ name: "project", session: "s1", serverName: "web" }),
    );

    expect(response.status).toBe(200);
    expect(deps.getServer).toHaveBeenCalledWith({
      projectPath: "/repos/project",
      sessionName: "s1",
      worktreePath: LANE_WORKTREE,
      serverName: "web",
    });
    expect(deps.stopServer).toHaveBeenCalledWith({
      projectPath: "/repos/project",
      sessionName: "s1",
      worktreePath: LANE_WORKTREE,
      serverName: "web",
    });
  });

  it("rejects a partial workflow target before invoking the service", async () => {
    const service = makeService();
    const { handlers } = makeHandlers(service);

    const response = await handlers.GET(
      new Request("http://cc.test/dev-servers?executionId=execution-1"),
      context({ name: "project", session: "s1" }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      code: "INVALID_DEV_SERVER_TARGET",
    });
    expect(service.list).not.toHaveBeenCalled();
  });

  it("rejects ambiguous duplicate workflow identity before invoking the service", async () => {
    const service = makeService();
    const { handlers } = makeHandlers(service);

    const response = await handlers.GET(
      new Request(
        "http://cc.test/dev-servers?executionId=execution-1&executionId=execution-2&contextId=ctx-1",
      ),
      context({ name: "project", session: "s1" }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      code: "INVALID_DEV_SERVER_TARGET",
    });
    expect(service.list).not.toHaveBeenCalled();
  });

  it("rejects a stale workflow target before invoking the service", async () => {
    const service = makeService();
    const targetResolver: DevServerTargetResolver = {
      resolve: vi.fn(async () => {
        throw new DevServerTargetError(
          "WORKFLOW_EXECUTION_NOT_ACTIVE",
          "stale workflow execution",
          409,
          "Run `cctl workflow status`.",
        );
      }),
    };
    const { handlers } = makeHandlers(service, { targetResolver });

    const response = await handlers.GET(
      new Request(
        "http://cc.test/dev-servers?executionId=stale&contextId=ctx-1",
      ),
      context({ name: "project", session: "s1" }),
    );

    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      code: "WORKFLOW_EXECUTION_NOT_ACTIVE",
      instruction: "Run `cctl workflow status`.",
    });
    expect(service.list).not.toHaveBeenCalled();
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

  it("START_ALL starts every inactive server without waiting for the previous one", async () => {
    const events: string[] = [];
    const service = makeService({
      list: vi.fn(async () => [
        makeStatus({ serverName: "web", status: "stopped" }),
        makeStatus({ serverName: "storybook", status: "stopped" }),
      ]),
      ensure: vi.fn(async ({ serverName }) => {
        events.push(`enter:${serverName ?? "?"}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`exit:${serverName ?? "?"}`);
        return makeStatus({ serverName, status: "starting" });
      }),
    });
    const { handlers } = makeHandlers(service);

    const response = await handlers.START_ALL(
      new Request("http://cc.test/dev-servers/start-all", { method: "POST" }),
      context({ name: "project", session: "s1" }),
    );

    expect(response.status).toBe(202);
    // Every server's pre-response work (reconcile, port selection, spawn) is
    // independent, so the second must not queue behind the first's latency.
    expect(events.slice(0, 2)).toEqual(["enter:web", "enter:storybook"]);
  });

  it("START_ALL reports a failing server while still starting the others", async () => {
    const started: string[] = [];
    const service = makeService({
      list: vi.fn(async () => [
        makeStatus({ serverName: "web", status: "stopped" }),
        makeStatus({ serverName: "storybook", status: "stopped" }),
      ]),
      ensure: vi.fn(async ({ serverName }) => {
        if (serverName === "web") {
          throw new UnmanagedDevServerDetectedError(
            "web",
            3007,
            5001,
            "/repos/project/.worktrees/s1",
          );
        }
        started.push(serverName ?? "?");
        return makeStatus({ serverName, status: "starting" });
      }),
    });
    const { handlers } = makeHandlers(service);

    const response = await handlers.START_ALL(
      new Request("http://cc.test/dev-servers/start-all", { method: "POST" }),
      context({ name: "project", session: "s1" }),
    );

    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      code: "UNMANAGED_DEV_SERVER_DETECTED",
      details: { serverName: "web", port: 3007 },
    });
    expect(started).toEqual(["storybook"]);
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

  const portRange = 10;

  let worktreePath: string;
  let registry: ReturnType<typeof createDevServerRegistry>;
  let broadcastEvents: DevServerStatusEvent[];
  let ready: boolean;
  let classifiedPorts: number[];

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(tmpdir(), "cc-accept-boundary-"));
    broadcastEvents = [];
    ready = false;
    classifiedPorts = [];

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
    // The real port-selection service, so the accept path pays whatever port
    // classification actually costs. Each classification is an `lsof`/`ss`
    // spawn in production, so `classifiedPorts` is the wall-clock cost of the
    // pre-response work expressed as a countable observation.
    const portSelection = createPortSelectionService({
      classifyPort: async ({ port }) => {
        classifiedPorts.push(port);
        return { status: "available" };
      },
      findOwnedListenerInRange: async () => ({ status: "none" }),
    });

    const serviceDeps: DevServerServiceDeps = {
      getSession: async () => ({ worktreePath }),
      readRepoConfig: async () => ({
        devServers: [
          {
            name: serverName,
            command: "sleep 60",
            port: { base: assignedPort, range: portRange },
          },
        ],
      }),
      reconcileSessionDevServers: async () => {},
      getSessionServers: registry.getSessionServers,
      getServer: registry.getServer,
      startServer: registry.startServer,
      stopServer: registry.stopServer,
      killListeningProcessForPort: registry.killListeningProcessForPort,
      selectPort: portSelection.selectPort,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    };
    const service = createDevServerService(serviceDeps);

    const routeDeps: DevServerRouteDeps = {
      resolveProjectPath: async () => projectPath,
      getSession: async () => ({ worktreePath }),
      targetResolver: {
        resolve: async () => ({
          kind: "session",
          worktreePath,
          branchName: "accept-boundary",
          isolation: "session",
          executionId: null,
          contextId: null,
          laneId: null,
        }),
      },
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

    // The accept path is fast because it does bounded pre-response work, not
    // because the test stubbed the expensive part out: selecting the free base
    // port must not classify the whole configured range.
    expect(classifiedPorts).toEqual([assignedPort]);

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

    // The event carries the project NAME the client's query keys are
    // addressed by (the path's trailing segment), not the resolved path.
    const runningEvent = broadcastEvents.find((e) => e.status === "running");
    expect(runningEvent).toMatchObject({
      type: "dev-server-status",
      projectName: "accept-boundary",
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
