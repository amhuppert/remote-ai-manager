import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { materializeGlobalConfig } from "@/lib/config/loader";
import {
  createDevServerRouteHandlers,
  type DevServerRouteDeps,
} from "@/lib/dev-server/route-handlers";
import {
  NoDevServersConfiguredError,
  createDevServerService,
  type DevServerService,
  type DevServerServiceDeps,
  type DevServerStatusItem,
} from "@/lib/dev-server/service";
import {
  createDevServerRegistry,
  type DevServerRegistryDeps,
} from "@/lib/dev-server/registry";
import { createDevServerTargetResolver } from "@/lib/dev-server/target-resolver";
import type { DevServerStatus } from "@/lib/dev-server/schemas";
import type { PortOwnershipInput } from "@/lib/dev-server/port-ownership";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { runCcWithHost } from "../testing/domain-runtime";
import type { CliEnv, CliHost } from "../transport";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real dev-server
 * route handlers in-process (no HTTP). Proves the CLI parses the routes' actual
 * response shapes — including deriving localUrl from `port` (the routes strip
 * localUrl via toRuntimeState) — and that `ensure` blocks by polling the list
 * route until the target reaches `running`.
 */

const PROJECT_PATH = "/repos/cc";
const WORKTREE = `${PROJECT_PATH}/.worktrees/sess`;

function item(status: DevServerStatus): DevServerStatusItem {
  const running = status === "running";
  return {
    serverName: "web",
    command: "bun run dev",
    status,
    port: running ? 5010 : null,
    // Set on the service item; the route strips it, forcing the CLI to derive it.
    localUrl: running ? "http://localhost:5010" : null,
    remoteUrl: running ? "https://web.example.ts.net" : null,
    startedAt: null,
    errorMessage: null,
    recentOutput: [],
    ownedByThisSession: running,
    worktreePath: WORKTREE,
    ownerPid: null,
    logFilePath: null,
  };
}

function makeDeps(service: DevServerService): DevServerRouteDeps {
  return {
    async resolveProjectPath() {
      return PROJECT_PATH;
    },
    async getSession() {
      return { worktreePath: WORKTREE };
    },
    targetResolver: {
      async resolve() {
        return {
          kind: "session",
          worktreePath: WORKTREE,
          branchName: "session-branch",
          isolation: "session",
          executionId: null,
          contextId: null,
          laneId: null,
        };
      },
    },
    service,
    async stopAllForSession() {},
    getServer: () => ({ status: "running" }),
    async stopServer() {},
  };
}

function routeHost(deps: DevServerRouteDeps): CliHost {
  const handlers = createDevServerRouteHandlers(deps);
  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // /api/projects/<name>/sessions/<session>/dev-servers[/<serverName>/(start|stop)]
      const name = decodeURIComponent(segments[2] ?? "");
      const session = decodeURIComponent(segments[4] ?? "");
      const serverName = segments[6] ? decodeURIComponent(segments[6]) : "";
      const action = segments[7];
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      if (init.method === "GET") {
        return handlers.GET(request, {
          params: Promise.resolve({ name, session }),
        });
      }
      if (action === "start") {
        return handlers.START(request, {
          params: Promise.resolve({ name, session, serverName }),
        });
      }
      if (action === "stop") {
        return handlers.STOP(request, {
          params: Promise.resolve({ name, session, serverName }),
        });
      }
      throw new Error(`unhandled ${init.method} ${parsed.pathname}`);
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

const env: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "t",
  CC_PROJECT: "cc",
  CC_SESSION: "sess",
};

describe("cctl dev against the real dev-server route handlers", () => {
  it("ensure (no name) starts the single server, polls to running, prints the derived localUrl + hint", async () => {
    let status: DevServerStatus = "stopped";
    let pollsWhileStarting = 0;
    const service: DevServerService = {
      async list() {
        if (status === "starting" && ++pollsWhileStarting >= 2) {
          status = "running";
        }
        return [item(status)];
      },
      async ensure() {
        if (status === "stopped" || status === "error") status = "starting";
        return item(status);
      },
      async stop() {
        status = "stopped";
        return item(status);
      },
      async awaitReady() {
        return item("running");
      },
      async stopUnmanaged() {
        return { killed: [], skipped: [] };
      },
    };

    const result = await runCcWithHost(
      ["dev", "ensure"],
      env,
      routeHost(makeDeps(service)),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("http://localhost:5010");
    expect(result.stdout).toContain("https://web.example.ts.net");
    expect(result.stdout).toContain("cctl dev list");
  });

  it("list renders the derived localUrl for a running server", async () => {
    const service: DevServerService = {
      async list() {
        return [item("running")];
      },
      async ensure() {
        return item("running");
      },
      async stop() {
        return item("stopped");
      },
      async awaitReady() {
        return item("running");
      },
      async stopUnmanaged() {
        return { killed: [], skipped: [] };
      },
    };

    const result = await runCcWithHost(
      ["dev", "list", "--json"],
      env,
      routeHost(makeDeps(service)),
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.servers[0].localUrl).toBe(
      "http://localhost:5010",
    );
  });

  it("ensure (named) exits 1 with a CommandCenter.json pointer when nothing is configured", async () => {
    const service: DevServerService = {
      async list() {
        return [];
      },
      async ensure() {
        throw new NoDevServersConfiguredError();
      },
      async stop() {
        return item("stopped");
      },
      async awaitReady() {
        return item("running");
      },
      async stopUnmanaged() {
        return { killed: [], skipped: [] };
      },
    };

    const result = await runCcWithHost(
      ["dev", "ensure", "web"],
      env,
      routeHost(makeDeps(service)),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CommandCenter.json");
  });

  it("stop maps to the real STOP route and reports success", async () => {
    const service: DevServerService = {
      async list() {
        return [item("running")];
      },
      async ensure() {
        return item("running");
      },
      async stop() {
        return item("stopped");
      },
      async awaitReady() {
        return item("running");
      },
      async stopUnmanaged() {
        return { killed: [], skipped: [] };
      },
    };

    const result = await runCcWithHost(
      ["dev", "stop", "web"],
      env,
      routeHost(makeDeps(service)),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stopped web");
  });
});

describe("cctl dev workflow-lane isolation", () => {
  it("lists, starts, prepares fixtures, and stops only the invoking workflow context across sibling worktrees", async () => {
    const projectPath = mkdtempSync(
      path.join(tmpdir(), "cc-dev-target-contract-"),
    );
    const sessionWorktree = path.join(projectPath, "session-worktree");
    const laneWorktree = path.join(projectPath, "lane-worktree");
    mkdirSync(sessionWorktree);
    mkdirSync(laneWorktree);

    const registryDeps: DevServerRegistryDeps = {
      broadcast: () => ({ delivered: true }),
      tailscale: {
        register: vi.fn(async () => null),
        unregister: vi.fn(async () => {}),
      },
      readConfig: vi.fn(async () =>
        materializeGlobalConfig({
          tailscaleEnabled: false,
          baseDir: projectPath,
          ignorePatterns: [],
        }),
      ),
      livenessStart: vi.fn(),
      getLanUrl: (port) => `http://127.0.0.1:${port}`,
      checkPortListening: vi.fn(async () => true),
      classifyPortOwnership: vi.fn(async (input: PortOwnershipInput) => ({
        status: "owned" as const,
        pid: 4242,
        cwd: input.worktreePath,
      })),
      sendSignal: vi.fn(() => true),
      isProcessAlive: vi.fn(() => false),
      killGraceMs: 1,
    };
    const registry = createDevServerRegistry(registryDeps);

    try {
      const command = "pwd; sleep 60";
      await registry.startServer({
        projectPath,
        sessionName: "sess",
        serverName: "web",
        command,
        worktreePath: sessionWorktree,
        startMode: {
          port: 59960,
          readinessTimeoutMs: 1_000,
        },
      });
      await vi.waitFor(() => {
        expect(
          registry.getServer({
            projectPath,
            sessionName: "sess",
            worktreePath: sessionWorktree,
            serverName: "web",
          })?.status,
        ).toBe("running");
      });

      const configReads: string[] = [];
      const serviceDeps: DevServerServiceDeps = {
        getSession: async () => ({ worktreePath: sessionWorktree }),
        readRepoConfig: async (worktreePath) => {
          configReads.push(worktreePath);
          return {
            devServers: [
              {
                name: "web",
                command,
                port: { base: 59961, range: 1 },
              },
            ],
          };
        },
        reconcileSessionDevServers: async () => {},
        getSessionServers: registry.getSessionServers,
        getServer: registry.getServer,
        startServer: registry.startServer,
        stopServer: registry.stopServer,
        killListeningProcessForPort: registry.killListeningProcessForPort,
        selectPort: async ({ basePort }) => ({
          status: "selected",
          port: basePort,
        }),
        sleep: async () => {},
        now: () => Date.now(),
      };
      const service = createDevServerService(serviceDeps);
      const workflowExecution = graphWorkflowExecutionSchema.parse(
        buildMaximalGraphWorkflowExecution(),
      );
      workflowExecution.id = "execution-1";
      workflowExecution.contextStates["ctx-1"]!.status = "running";
      workflowExecution.contextStates["ctx-1"]!.cleanupStatus =
        "not-applicable";
      workflowExecution.contextStates["ctx-1"]!.laneId = "lane-1";
      workflowExecution.executionLanes["lane-1"]!.worktreePath = laneWorktree;
      workflowExecution.executionLanes["lane-1"]!.branchName = "lane-branch";
      const targetResolver = createDevServerTargetResolver({
        getSession: async () =>
          sessionStateSchema.parse({
            sessionName: "sess",
            worktreePath: sessionWorktree,
            branchName: "session-branch",
            targetBranch: "main",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
          }),
        getActiveGraphWorkflowExecution: async () => workflowExecution,
        directoryExists: async (candidate) => candidate === laneWorktree,
      });
      const deps: DevServerRouteDeps = {
        resolveProjectPath: async () => projectPath,
        getSession: async () => ({ worktreePath: sessionWorktree }),
        targetResolver,
        service,
        stopAllForSession: async () => {},
        getServer: registry.getServer,
        stopServer: registry.stopServer,
      };
      const laneEnv: CliEnv = {
        ...env,
        CC_WORKFLOW_EXECUTION_ID: "execution-1",
        CC_WORKFLOW_CONTEXT_ID: "ctx-1",
      };
      const managingHost = routeHost(deps);
      const fixtureWrites: string[] = [];
      const host: CliHost = {
        ...managingHost,
        async fetch(url, init) {
          const parsed = new URL(url);
          if (
            (parsed.port === "59960" || parsed.port === "59961") &&
            init.method === "POST"
          ) {
            fixtureWrites.push(url);
            return new Response(
              JSON.stringify({
                sessionName: "fx-lane",
                conversations: [{ id: "conversation-lane" }],
              }),
              {
                status: 201,
                headers: { "content-type": "application/json" },
              },
            );
          }
          return managingHost.fetch(url, init);
        },
      };

      const before = await runCcWithHost(
        ["dev", "list", "--json"],
        laneEnv,
        host,
      );
      expect(before.exitCode).toBe(0);
      const beforeEnvelope = JSON.parse(before.stdout);
      expect(beforeEnvelope.payload.data.servers).toHaveLength(1);
      expect(beforeEnvelope.payload.data.servers[0]).toMatchObject({
        status: "stopped",
        worktreePath: null,
        localUrl: null,
      });

      const ensured = await runCcWithHost(
        ["dev", "ensure", "web", "--json"],
        laneEnv,
        host,
      );
      expect(ensured.exitCode).toBe(0);
      const ensuredEnvelope = JSON.parse(ensured.stdout);
      expect(ensuredEnvelope.payload.data.server).toMatchObject({
        worktreePath: laneWorktree,
        localUrl: "http://localhost:59961",
      });
      expect(ensuredEnvelope.payload.data.server.localUrl).not.toBe(
        "http://localhost:59960",
      );
      await vi.waitFor(() => {
        expect(
          registry.getServer({
            projectPath,
            sessionName: "sess",
            worktreePath: laneWorktree,
            serverName: "web",
          })?.recentOutput,
        ).toContain(realpathSync(laneWorktree));
      });

      const fixture = await runCcWithHost(
        ["fixture", "session", "create", "scratch", "--skip-warm", "--json"],
        laneEnv,
        host,
      );
      expect(fixture.exitCode).toBe(0);
      expect(JSON.parse(fixture.stdout).payload.data).toMatchObject({
        target: "http://localhost:59961",
        worktreePath: laneWorktree,
        dbPath: path.join(laneWorktree, ".config", "command-center.db"),
        transcriptPath: path.join(
          laneWorktree,
          ".config",
          "transcripts",
          "conversation-lane.jsonl",
        ),
      });
      expect(configReads.length).toBeGreaterThan(0);
      expect(configReads.every((candidate) => candidate === laneWorktree)).toBe(
        true,
      );
      expect(configReads).not.toContain(sessionWorktree);
      expect(fixtureWrites).toEqual([
        "http://localhost:59961/api/projects/scratch/sessions",
      ]);

      const stopped = await runCcWithHost(
        ["dev", "stop", "web"],
        laneEnv,
        host,
      );
      expect(stopped.exitCode).toBe(0);
      expect(
        registry.getServer({
          projectPath,
          sessionName: "sess",
          worktreePath: laneWorktree,
          serverName: "web",
        })?.status,
      ).toBe("stopped");
      expect(
        registry.getServer({
          projectPath,
          sessionName: "sess",
          worktreePath: sessionWorktree,
          serverName: "web",
        })?.status,
      ).toBe("running");
    } finally {
      registry._resetForTesting();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
