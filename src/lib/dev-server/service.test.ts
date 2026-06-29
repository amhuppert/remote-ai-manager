import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevServerEntry } from "./registry";
import {
  AmbiguousDevServerError,
  NoDevServersConfiguredError,
  SessionNotFoundError,
  UnknownDevServerError,
  UnmanagedDevServerDetectedError,
  createDevServerService,
  type DevServerServiceDeps,
} from "./service";
import type { DevServerConfig } from "@/lib/dev-server/schemas";
import type { PortSelectionResult } from "./port-selection";
type ConfiguredServer = DevServerConfig;

function makeEntry(overrides: Partial<DevServerEntry>): DevServerEntry {
  return {
    serverName: "nextjs",
    projectPath: "/projects/test",
    sessionName: "s1",
    command: "echo CC_PORT=3000",
    status: "stopped",
    port: null,
    remoteUrl: null,
    startedAt: "2026-05-16T00:00:00.000Z",
    errorMessage: null,
    recentOutput: [],
    worktreePath: "/projects/test/.worktrees/s1",
    ownedByThisSession: false,
    ownerPid: null,
    logFilePath: "/projects/test/.worktrees/s1/.cc/dev-server-logs/nextjs.log",
    _process: null,
    _pid: null,
    _logStream: null,
    _stdoutRemainder: "",
    _stderrRemainder: "",
    ...overrides,
  };
}

interface Harness {
  registry: Map<string, DevServerEntry>;
  configured: ConfiguredServer[];
  worktreePath: string;
  reconcile: ReturnType<typeof vi.fn>;
  startServer: ReturnType<typeof vi.fn>;
  stopServer: ReturnType<typeof vi.fn>;
  deps: DevServerServiceDeps;
}

function makeHarness(opts?: {
  configured?: ConfiguredServer[];
  sessionMissing?: boolean;
  initialEntries?: DevServerEntry[];
}): Harness {
  const worktreePath = "/projects/test/.worktrees/s1";
  const registry = new Map<string, DevServerEntry>();
  for (const entry of opts?.initialEntries ?? []) {
    registry.set(entry.serverName, entry);
  }
  const configured = opts?.configured ?? [
    {
      name: "nextjs",
      command: "echo CC_PORT=3000",
      port: { base: 3000, range: 100 },
    },
  ];

  const reconcile = vi.fn(async () => undefined);
  const startServer = vi.fn(async (input: { serverName: string }) => {
    const existing = registry.get(input.serverName);
    if (existing) {
      existing.status = "starting";
      existing.errorMessage = null;
      return;
    }
    registry.set(
      input.serverName,
      makeEntry({ serverName: input.serverName, status: "starting" }),
    );
  });
  const stopServer = vi.fn(async (input: { serverName: string }) => {
    const existing = registry.get(input.serverName);
    if (existing) {
      existing.status = "stopped";
      existing.ownedByThisSession = false;
    }
  });

  const deps: DevServerServiceDeps = {
    async getSession(_projectPath, _sessionName) {
      if (opts?.sessionMissing) return null;
      return { worktreePath };
    },
    async readRepoConfig(_worktreePath) {
      return { devServers: configured };
    },
    reconcileSessionDevServers: reconcile,
    getSessionServers({ projectPath: _p, sessionName: _s }) {
      return Array.from(registry.values());
    },
    getServer({ serverName }) {
      return registry.get(serverName);
    },
    startServer,
    stopServer,
    killListeningProcessForPort: vi.fn(async () => ({
      killed: [],
      skipped: [],
    })),
    selectPort: vi.fn(
      async (): Promise<PortSelectionResult> => ({
        status: "selected",
        port: 3001,
      }),
    ),
    async sleep(_ms) {},
    now: () => Date.now(),
  };

  return {
    registry,
    configured,
    worktreePath,
    reconcile,
    startServer,
    stopServer,
    deps,
  };
}

describe("dev-server-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("list", () => {
    it("throws SessionNotFoundError when session cannot be resolved", async () => {
      const h = makeHarness({ sessionMissing: true });
      const service = createDevServerService(h.deps);
      await expect(
        service.list({ projectPath: "/projects/test", sessionName: "s1" }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it("reconciles first and returns merged configured + runtime status", async () => {
      const h = makeHarness({
        configured: [
          {
            name: "nextjs",
            command: "next.sh",
            port: { base: 3000, range: 100 },
          },
          {
            name: "storybook",
            command: "sb.sh",
            port: { base: 6006, range: 100 },
          },
        ],
        initialEntries: [
          makeEntry({
            serverName: "nextjs",
            status: "running",
            port: 3002,
            ownedByThisSession: true,
            ownerPid: 4242,
            remoteUrl: "https://lan.example/3002",
          }),
        ],
      });
      const service = createDevServerService(h.deps);

      const result = await service.list({
        projectPath: "/projects/test",
        sessionName: "s1",
      });

      expect(h.reconcile).toHaveBeenCalledOnce();
      expect(result).toHaveLength(2);
      const next = result.find((r) => r.serverName === "nextjs")!;
      expect(next.status).toBe("running");
      expect(next.port).toBe(3002);
      expect(next.localUrl).toBe("http://localhost:3002");
      expect(next.remoteUrl).toBe("https://lan.example/3002");
      expect(next.ownedByThisSession).toBe(true);
      expect(next.worktreePath).toBe(h.worktreePath);
      const sb = result.find((r) => r.serverName === "storybook")!;
      expect(sb.status).toBe("stopped");
      expect(sb.localUrl).toBeNull();
    });

    it("returns empty array when no servers configured", async () => {
      const h = makeHarness({ configured: [] });
      const service = createDevServerService(h.deps);
      const result = await service.list({
        projectPath: "/projects/test",
        sessionName: "s1",
      });
      expect(result).toEqual([]);
    });
  });

  describe("ensure", () => {
    it("throws NoDevServersConfiguredError when project has no dev servers", async () => {
      const h = makeHarness({ configured: [] });
      const service = createDevServerService(h.deps);
      await expect(
        service.ensure({ projectPath: "/projects/test", sessionName: "s1" }),
      ).rejects.toBeInstanceOf(NoDevServersConfiguredError);
    });

    it("spawns the dev server in the lane worktree when a worktreePath override is given", async () => {
      const h = makeHarness();
      const service = createDevServerService(h.deps);
      const laneWorktree = "/projects/test/.worktrees/s1.laneA";
      await service.ensure({
        projectPath: "/projects/test",
        sessionName: "s1",
        serverName: "nextjs",
        worktreePath: laneWorktree,
        wait: false,
      });
      // The override (graph-workflow lane) must reach startServer rather than
      // defaulting to the parent session worktree.
      expect(h.startServer).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: laneWorktree }),
      );
    });

    it("returns ambiguity error when multiple servers and no name supplied", async () => {
      const h = makeHarness({
        configured: [
          {
            name: "nextjs",
            command: "next.sh",
            port: { base: 3000, range: 100 },
          },
          {
            name: "storybook",
            command: "sb.sh",
            port: { base: 6006, range: 100 },
          },
        ],
      });
      const service = createDevServerService(h.deps);
      const promise = service.ensure({
        projectPath: "/projects/test",
        sessionName: "s1",
      });
      await expect(promise).rejects.toBeInstanceOf(AmbiguousDevServerError);
      await promise.catch((err: AmbiguousDevServerError) => {
        expect(err.availableNames).toEqual(["nextjs", "storybook"]);
      });
    });

    it("throws UnknownDevServerError when serverName is not configured", async () => {
      const h = makeHarness();
      const service = createDevServerService(h.deps);
      await expect(
        service.ensure({
          projectPath: "/projects/test",
          sessionName: "s1",
          serverName: "missing",
        }),
      ).rejects.toBeInstanceOf(UnknownDevServerError);
    });

    it("throws UnmanagedDevServerDetectedError when port selection surfaces an owned listener", async () => {
      const h = makeHarness();
      h.deps.selectPort = vi.fn().mockResolvedValue({
        status: "unmanaged-detected",
        port: 3007,
        pid: 5001,
        cwd: h.worktreePath,
      });

      const service = createDevServerService(h.deps);
      const promise = service.ensure({
        projectPath: "/projects/test",
        sessionName: "s1",
      });

      await expect(promise).rejects.toBeInstanceOf(
        UnmanagedDevServerDetectedError,
      );
      await promise.catch((err: UnmanagedDevServerDetectedError) => {
        expect(err.serverName).toBe("nextjs");
        expect(err.port).toBe(3007);
        expect(err.pid).toBe(5001);
        expect(err.cwd).toBe(h.worktreePath);
        expect(err.code).toBe("UNMANAGED_DEV_SERVER_DETECTED");
      });
      expect(h.startServer).not.toHaveBeenCalled();
    });

    it("starts a stopped server and returns once running when wait is true", async () => {
      const h = makeHarness();
      h.startServer.mockImplementation(
        async (input: { serverName: string }) => {
          h.registry.set(
            input.serverName,
            makeEntry({ serverName: input.serverName, status: "starting" }),
          );
          // Simulate CC_PORT detection on first poll.
          queueMicrotask(() => {
            const entry = h.registry.get(input.serverName);
            if (entry) {
              entry.status = "running";
              entry.port = 3001;
              entry.ownedByThisSession = true;
              entry.ownerPid = 1234;
            }
          });
        },
      );

      const service = createDevServerService(h.deps);
      const result = await service.ensure({
        projectPath: "/projects/test",
        sessionName: "s1",
        wait: true,
      });

      expect(h.startServer).toHaveBeenCalledOnce();
      const startCall = h.startServer.mock.calls[0]![0]!;
      expect(startCall).toMatchObject({
        projectPath: "/projects/test",
        sessionName: "s1",
        serverName: "nextjs",
        command: "echo CC_PORT=3000",
        worktreePath: h.worktreePath,
      });
      expect(result.status).toBe("running");
      expect(result.port).toBe(3001);
      expect(result.localUrl).toBe("http://localhost:3001");
    });

    it("returns the current starting status when wait is false", async () => {
      const h = makeHarness();
      h.startServer.mockImplementation(
        async (input: { serverName: string }) => {
          h.registry.set(
            input.serverName,
            makeEntry({ serverName: input.serverName, status: "starting" }),
          );
        },
      );

      const service = createDevServerService(h.deps);
      const result = await service.ensure({
        projectPath: "/projects/test",
        sessionName: "s1",
        wait: false,
      });
      expect(result.status).toBe("starting");
      expect(h.startServer).toHaveBeenCalledOnce();
    });

    describe("tailscale serve orphan reconciliation", () => {
      it("runs the reconciler before starting the first server, and shares the result across concurrent ensure() calls", async () => {
        const h = makeHarness();
        const reconcile = vi.fn(async () => {
          // Simulate IO latency so concurrent ensures must wait on the same
          // promise rather than each spawning their own scan.
          await new Promise((r) => setTimeout(r, 20));
        });
        h.deps.reconcileTailscaleServeOrphans = reconcile;
        h.deps.selectPort = vi.fn(async () => {
          // selectPort must observe that reconcile already ran so the stale
          // listener it would have collided with has been cleared first.
          expect(reconcile).toHaveBeenCalled();
          return { status: "selected", port: 3001 } as const;
        });
        h.startServer.mockImplementation(
          async (input: { serverName: string }) => {
            h.registry.set(
              input.serverName,
              makeEntry({
                serverName: input.serverName,
                status: "running",
                port: 3001,
                ownedByThisSession: true,
              }),
            );
          },
        );

        const service = createDevServerService(h.deps);
        await Promise.all([
          service.ensure({ projectPath: "/projects/test", sessionName: "s1" }),
          service.ensure({ projectPath: "/projects/test", sessionName: "s1" }),
        ]);

        expect(reconcile).toHaveBeenCalledTimes(1);
      });

      it("does not run the reconciler when the server is already running and owned", async () => {
        const h = makeHarness({
          initialEntries: [
            makeEntry({
              serverName: "nextjs",
              status: "running",
              port: 3001,
              ownedByThisSession: true,
            }),
          ],
        });
        const reconcile = vi.fn(async () => undefined);
        h.deps.reconcileTailscaleServeOrphans = reconcile;

        const service = createDevServerService(h.deps);
        await service.ensure({
          projectPath: "/projects/test",
          sessionName: "s1",
        });

        expect(reconcile).not.toHaveBeenCalled();
      });

      it("does not block ensure() when reconcile throws — the error is logged and start proceeds", async () => {
        const h = makeHarness();
        h.deps.reconcileTailscaleServeOrphans = vi.fn(async () => {
          throw new Error("tailscale CLI exploded");
        });
        h.startServer.mockImplementation(
          async (input: { serverName: string }) => {
            h.registry.set(
              input.serverName,
              makeEntry({
                serverName: input.serverName,
                status: "running",
                port: 3001,
                ownedByThisSession: true,
              }),
            );
          },
        );

        const service = createDevServerService(h.deps);
        const result = await service.ensure({
          projectPath: "/projects/test",
          sessionName: "s1",
        });

        expect(result.status).toBe("running");
        expect(h.startServer).toHaveBeenCalledOnce();
      });
    });

    it("waits for an already-starting server to reach running when wait=true", async () => {
      const h = makeHarness({
        initialEntries: [
          makeEntry({ serverName: "nextjs", status: "starting" }),
        ],
      });

      // Promote to running after one poll cycle.
      let polls = 0;
      const originalGet = h.deps.getServer;
      h.deps.getServer = (input) => {
        polls++;
        if (polls > 1) {
          const entry = h.registry.get(input.serverName);
          if (entry && entry.status === "starting") {
            entry.status = "running";
            entry.port = 3010;
            entry.ownedByThisSession = true;
          }
        }
        return originalGet(input);
      };

      const service = createDevServerService(h.deps);
      const result = await service.ensure({
        projectPath: "/projects/test",
        sessionName: "s1",
        wait: true,
      });
      expect(result.status).toBe("running");
      expect(result.port).toBe(3010);
      expect(h.startServer).not.toHaveBeenCalled();
    });

    describe("cwd resolution for cc-assigned servers", () => {
      it("resolves relative cwd against the session worktree before starting", async () => {
        const h = makeHarness({
          configured: [
            {
              name: "web",
              command: "next dev --port $CC_ASSIGNED_PORT",
              cwd: "apps/web",
              port: { base: 3000, range: 10 },
            },
          ],
        });
        h.deps.selectPort = vi
          .fn()
          .mockResolvedValue({ status: "selected", port: 3000 });
        h.startServer.mockImplementation(
          async (input: { serverName: string }) => {
            h.registry.set(
              input.serverName,
              makeEntry({
                serverName: input.serverName,
                status: "running",
                port: 3000,
                ownedByThisSession: true,
              }),
            );
          },
        );

        const service = createDevServerService(h.deps);
        await service.ensure({
          projectPath: "/projects/test",
          sessionName: "s1",
          wait: true,
        });

        const startCall = h.startServer.mock.calls[0]![0]!;
        expect(startCall.startMode.cwd).toBe(`${h.worktreePath}/apps/web`);
      });

      it('resolves "." cwd to the worktree root', async () => {
        const h = makeHarness({
          configured: [
            {
              name: "web",
              command: "next dev --port $CC_ASSIGNED_PORT",
              cwd: ".",
              port: { base: 3000, range: 10 },
            },
          ],
        });
        h.deps.selectPort = vi
          .fn()
          .mockResolvedValue({ status: "selected", port: 3000 });
        h.startServer.mockImplementation(
          async (input: { serverName: string }) => {
            h.registry.set(
              input.serverName,
              makeEntry({
                serverName: input.serverName,
                status: "running",
                port: 3000,
                ownedByThisSession: true,
              }),
            );
          },
        );

        const service = createDevServerService(h.deps);
        await service.ensure({
          projectPath: "/projects/test",
          sessionName: "s1",
          wait: true,
        });

        const startCall = h.startServer.mock.calls[0]![0]!;
        expect(startCall.startMode.cwd).toBe(h.worktreePath);
      });

      it("passes absolute cwd through unchanged", async () => {
        const h = makeHarness({
          configured: [
            {
              name: "web",
              command: "next dev --port $CC_ASSIGNED_PORT",
              cwd: "/opt/some/abs/path",
              port: { base: 3000, range: 10 },
            },
          ],
        });
        h.deps.selectPort = vi
          .fn()
          .mockResolvedValue({ status: "selected", port: 3000 });
        h.startServer.mockImplementation(
          async (input: { serverName: string }) => {
            h.registry.set(
              input.serverName,
              makeEntry({
                serverName: input.serverName,
                status: "running",
                port: 3000,
                ownedByThisSession: true,
              }),
            );
          },
        );

        const service = createDevServerService(h.deps);
        await service.ensure({
          projectPath: "/projects/test",
          sessionName: "s1",
          wait: true,
        });

        const startCall = h.startServer.mock.calls[0]![0]!;
        expect(startCall.startMode.cwd).toBe("/opt/some/abs/path");
      });
    });

    it("retries once from error state and then surfaces failure with recent output", async () => {
      const h = makeHarness({
        initialEntries: [
          makeEntry({
            serverName: "nextjs",
            status: "error",
            errorMessage: "first failure",
            recentOutput: ["line 1", "line 2"],
          }),
        ],
      });
      h.startServer.mockImplementation(
        async (input: { serverName: string }) => {
          const entry = h.registry.get(input.serverName);
          if (entry) {
            entry.status = "error";
            entry.errorMessage = "second failure";
            entry.recentOutput = ["retry failed"];
          }
        },
      );

      const service = createDevServerService(h.deps);
      await expect(
        service.ensure({
          projectPath: "/projects/test",
          sessionName: "s1",
          wait: true,
        }),
      ).rejects.toMatchObject({
        code: "DEV_SERVER_START_FAILED",
        message: expect.stringContaining("second failure"),
      });
      expect(h.startServer).toHaveBeenCalledOnce();
    });
  });

  describe("stop", () => {
    it("throws UnknownDevServerError when name not in config", async () => {
      const h = makeHarness();
      const service = createDevServerService(h.deps);
      await expect(
        service.stop({
          projectPath: "/projects/test",
          sessionName: "s1",
          serverName: "ghost",
        }),
      ).rejects.toBeInstanceOf(UnknownDevServerError);
    });

    it("delegates to ownership-safe stopServer and returns final state", async () => {
      const h = makeHarness({
        initialEntries: [
          makeEntry({
            serverName: "nextjs",
            status: "running",
            port: 3000,
            ownedByThisSession: true,
          }),
        ],
      });
      const service = createDevServerService(h.deps);
      const result = await service.stop({
        projectPath: "/projects/test",
        sessionName: "s1",
        serverName: "nextjs",
      });
      expect(h.stopServer).toHaveBeenCalledWith({
        projectPath: "/projects/test",
        sessionName: "s1",
        worktreePath: "/projects/test/.worktrees/s1",
        serverName: "nextjs",
      });
      expect(result?.status).toBe("stopped");
      expect(result?.ownedByThisSession).toBe(false);
    });
  });
});
