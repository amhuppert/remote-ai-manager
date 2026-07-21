import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import {
  createDevServerRegistry,
  buildDevServerEnv,
  isPortListening,
  type DevServerRegistryDeps,
  type DevServerStartMode,
} from "./registry";
import type { PortOwnershipInput, PortOwnershipResult } from "./port-ownership";

function createTestDeps(
  overrides: Partial<DevServerRegistryDeps> = {},
): DevServerRegistryDeps {
  return {
    broadcast: vi.fn(),
    tailscale: {
      register: vi.fn().mockResolvedValue("https://mock.ts.net:3000"),
      unregister: vi.fn().mockResolvedValue(undefined),
    },
    readConfig: vi.fn().mockResolvedValue({
      tailscaleEnabled: true,
      baseDir: "/tmp",
      ignorePatterns: [],
      agentBackends: {
        claude: {
          model: "opus",
          reasoningEffort: "high",
          timeoutMs: 300_000,
        },
        codex: {
          model: "gpt-5.4",
          reasoningEffort: "high",
          timeoutMs: null,
        },
      },
      defaultAgentBackend: "claude",
    }),
    livenessStart: vi.fn(),
    getLanUrl: vi.fn((port: number) => `http://192.168.1.100:${port}`),
    checkPortListening: vi.fn().mockResolvedValue(false),
    classifyPortOwnership: vi
      .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
      .mockResolvedValue({ status: "available" }),
    sendSignal: vi.fn().mockReturnValue(true),
    isProcessAlive: vi.fn().mockReturnValue(false),
    killGraceMs: 200,
    ...overrides,
  };
}

function startMode(
  port: number,
  overrides: Partial<DevServerStartMode> = {},
): DevServerStartMode {
  return {
    port,
    readinessTimeoutMs: 60_000,
    ...overrides,
  };
}

describe("buildDevServerEnv", () => {
  it("blanks every inherited CC_* key so a dev instance cannot adopt the parent's identity", () => {
    // A dev server is an identity-creating boundary: the child records its OWN
    // server URL at boot, so the parent's ambient CC_SERVER_URL (which
    // resolveServerBaseUrl treats as authoritative) must not leak in — else the
    // instance mis-identifies as the parent and its self-probe mismatches.
    const base = {
      CC_SERVER_URL: "http://127.0.0.1:3000",
      CC_API_TOKEN: "parent-token",
      CC_WORKFLOW_EXECUTION_ID: "exec-parent",
      CC_CONFIG_DIR: "/parent/.config",
      PATH: "/usr/bin",
      HOME: "/home/dev",
    };

    const env = buildDevServerEnv(base, startMode(3071));

    expect(env.CC_SERVER_URL).toBe("");
    expect(env.CC_API_TOKEN).toBe("");
    expect(env.CC_WORKFLOW_EXECUTION_ID).toBe("");
    expect(env.CC_CONFIG_DIR).toBe("");
    // Non-CC hygiene passthrough is preserved.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
  });

  it("sets PORT / CC_ASSIGNED_PORT / aliases to the assigned port after neutralization", () => {
    // CC_ASSIGNED_PORT is CC_-prefixed, so neutralization blanks it first; the
    // assigned-port write must run AFTER, or the child gets an empty port.
    const env = buildDevServerEnv(
      { CC_ASSIGNED_PORT: "9999" },
      startMode(3071, { envAliases: ["STORYBOOK_PORT"] }),
    );

    expect(env.PORT).toBe("3071");
    expect(env.CC_ASSIGNED_PORT).toBe("3071");
    expect(env.STORYBOOK_PORT).toBe("3071");
  });

  it("does not mutate the caller's base env", () => {
    const base = { CC_SERVER_URL: "http://127.0.0.1:3000" };
    buildDevServerEnv(base, startMode(3071));
    expect(base.CC_SERVER_URL).toBe("http://127.0.0.1:3000");
  });
});

describe("DevServerRegistry", () => {
  let registry: ReturnType<typeof createDevServerRegistry>;
  let deps: DevServerRegistryDeps;

  type ServerQuery = Parameters<(typeof registry)["getServer"]>[0];
  type ServerEntry = NonNullable<ReturnType<(typeof registry)["getServer"]>>;

  async function waitForServer(
    query: ServerQuery,
    predicate: (server: ServerEntry) => boolean,
    timeout = 3000,
  ): Promise<ServerEntry> {
    return vi.waitFor(
      () => {
        const server = registry.getServer(query);
        if (!server || !predicate(server)) {
          throw new Error(
            `Server ${query.serverName} has not reached the expected state`,
          );
        }
        return server;
      },
      { timeout, interval: 10 },
    );
  }

  beforeEach(() => {
    deps = createTestDeps();
    registry = createDevServerRegistry(deps);
  });

  afterEach(() => {
    registry._resetForTesting();
  });

  describe("getSessionServers / getServer", () => {
    it("returns empty array when no servers registered", () => {
      const servers = registry.getSessionServers({
        projectPath: "/proj",
        sessionName: "s1",
      });
      expect(servers).toEqual([]);
    });

    it("returns undefined for non-existent server", () => {
      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "web",
      });
      expect(server).toBeUndefined();
    });
  });

  describe("startServer", () => {
    it("spawns process and transitions to starting", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(59800),
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "web",
      });

      expect(server).toBeDefined();
      expect(server!.status).toBe("starting");
      expect(server!.serverName).toBe("web");

      expect(deps.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "dev-server-status",
          serverName: "web",
          status: "starting",
        }),
      );
    });

    it("rejects duplicate start for running/starting server", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(59801),
      });

      await expect(
        registry.startServer({
          projectPath: "/proj",
          sessionName: "s1",
          serverName: "web",
          command: "sleep 60",
          worktreePath: "/tmp",
          startMode: startMode(59801),
        }),
      ).rejects.toThrow('Server "web" is already starting');
    });

    it("transitions to running once the assigned port starts listening", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "port-test",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(59802, { readinessTimeoutMs: 2000 }),
      });

      const server = await waitForServer(
        {
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: "/tmp",
          serverName: "port-test",
        },
        (entry) => entry.status === "running",
      );

      expect(server!.status).toBe("running");
      expect(server!.port).toBe(59802);
    });

    it("registers Tailscale after server starts listening on port", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);
      const port = 54321;

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "tailscale-test",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(port, { readinessTimeoutMs: 2000 }),
      });

      const server = await waitForServer(
        {
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: "/tmp",
          serverName: "tailscale-test",
        },
        (entry) => entry.remoteUrl !== null,
      );

      expect(server!.status).toBe("running");
      expect(server!.port).toBe(port);
      expect(deps.tailscale.register).toHaveBeenCalledWith(port);
      expect(server!.remoteUrl).toBe("https://mock.ts.net:3000");
    });

    it("transitions to error when process exits before the port is listening", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "fail-test",
        command: "echo 'server failed' && exit 1",
        worktreePath: "/tmp",
        startMode: startMode(59803),
      });

      const query = {
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "fail-test",
      };
      const server = await waitForServer(
        query,
        (entry) => entry.status === "error",
        5000,
      );

      expect(server!.status).toBe("error");
      expect(server!.errorMessage).toContain(
        "before port 59803 ever listening",
      );
    });

    it("captures recent output in buffer", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "output-test",
        command: "echo line1 && echo line2 && echo line3 && sleep 60 &",
        worktreePath: "/tmp",
        startMode: startMode(59804),
      });

      const server = await waitForServer(
        {
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: "/tmp",
          serverName: "output-test",
        },
        (entry) => entry.recentOutput.length > 0,
      );

      expect(server!.recentOutput.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("stopServer", () => {
    it("stops a running server gracefully", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "stop-test",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(4000, { readinessTimeoutMs: 2000 }),
      });

      await waitForServer(
        {
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: "/tmp",
          serverName: "stop-test",
        },
        (entry) => entry.status === "running",
      );

      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "stop-test",
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "stop-test",
      });

      expect(server!.status).toBe("stopped");
      expect(deps.tailscale.unregister).toHaveBeenCalledWith(4000);
    });

    it("is a no-op for non-existent server", async () => {
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "nonexistent",
      });
    });
  });

  describe("stopAllForSession", () => {
    it("stops all servers for a session", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(59810),
      });

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "storybook",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(59811),
      });

      await registry.stopAllForSession({
        projectPath: "/proj",
        sessionName: "s1",
      });

      const servers = registry.getSessionServers({
        projectPath: "/proj",
        sessionName: "s1",
      });

      expect(servers.every((s) => s.status === "stopped")).toBe(true);
    });
  });

  describe("stopAllForWorktree", () => {
    it("stops only servers whose worktree matches, leaving others running", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);
      const laneAPath = mkdtempSync(path.join(tmpdir(), "cc-laneA-"));
      const laneBPath = mkdtempSync(path.join(tmpdir(), "cc-laneB-"));

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
        command: "sleep 60",
        worktreePath: laneAPath,
        startMode: startMode(59820, { readinessTimeoutMs: 2000 }),
      });
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
        command: "sleep 60",
        worktreePath: laneBPath,
        startMode: startMode(59821, { readinessTimeoutMs: 2000 }),
      });

      await Promise.all([
        waitForServer(
          {
            projectPath: "/proj",
            sessionName: "s1",
            worktreePath: laneAPath,
            serverName: "web",
          },
          (entry) => entry.status === "running",
        ),
        waitForServer(
          {
            projectPath: "/proj",
            sessionName: "s1",
            worktreePath: laneBPath,
            serverName: "web",
          },
          (entry) => entry.status === "running",
        ),
      ]);

      await registry.stopAllForWorktree({
        projectPath: "/proj",
        worktreePath: laneAPath,
      });

      const laneA = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: laneAPath,
        serverName: "web",
      });
      const laneB = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: laneBPath,
        serverName: "web",
      });

      expect(laneA!.status).toBe("stopped");
      expect(laneB!.status).toBe("running");

      rmSync(laneAPath, { recursive: true, force: true });
      rmSync(laneBPath, { recursive: true, force: true });
    });

    it("matches worktree paths after normalization (trailing slash)", async () => {
      const lanePath = mkdtempSync(path.join(tmpdir(), "cc-lane-norm-"));

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
        command: "sleep 60",
        worktreePath: lanePath,
        startMode: startMode(59822),
      });

      await registry.stopAllForWorktree({
        projectPath: "/proj",
        worktreePath: `${lanePath}/`,
      });

      const lane = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: lanePath,
        serverName: "web",
      });
      expect(lane!.status).toBe("stopped");

      rmSync(lanePath, { recursive: true, force: true });
    });
  });

  describe("worktree-disambiguated keys", () => {
    it("tracks same (project, session, serverName) in two worktrees independently", async () => {
      const sessionPath = mkdtempSync(path.join(tmpdir(), "cc-session-"));
      const lanePath = mkdtempSync(path.join(tmpdir(), "cc-lane-"));

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
        command: "sleep 60",
        worktreePath: sessionPath,
        startMode: startMode(59830),
      });

      // Same project/session/serverName, different worktree — must NOT collide
      // or throw "already running"; both entries coexist.
      await expect(
        registry.startServer({
          projectPath: "/proj",
          sessionName: "s1",
          serverName: "web",
          command: "sleep 60",
          worktreePath: lanePath,
          startMode: startMode(59831),
        }),
      ).resolves.toBeUndefined();

      const servers = registry.getSessionServers({
        projectPath: "/proj",
        sessionName: "s1",
      });
      expect(servers).toHaveLength(2);
      expect(new Set(servers.map((s) => s.worktreePath))).toEqual(
        new Set([sessionPath, lanePath]),
      );

      rmSync(sessionPath, { recursive: true, force: true });
      rmSync(lanePath, { recursive: true, force: true });
    });
  });

  describe("process group killing", () => {
    /** Helper: wait until an operating-system process condition is true. */
    async function waitFor(
      fn: () => boolean | Promise<boolean>,
      timeoutMs = 5000,
      intervalMs = 20,
    ): Promise<void> {
      await vi.waitFor(
        async () => {
          if (!(await fn())) throw new Error("Process condition not met");
        },
        { timeout: timeoutMs, interval: intervalMs },
      );
    }

    /** Check if a process group is alive (signal 0 = existence check) */
    function isProcessGroupAlive(pid: number): boolean {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    it("stores PID in entry for process group kills", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "pid-test",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(59820),
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "pid-test",
      });

      expect(server!._pid).toBeGreaterThan(0);
    });

    it("kills child processes via process group when stopping", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);
      const fakePort = 54322;

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "group-kill-test",
        command: `node -e "setInterval(()=>{},60000)"`,
        worktreePath: "/tmp",
        startMode: startMode(fakePort, { readinessTimeoutMs: 2000 }),
      });

      await waitFor(() => {
        const s = registry.getServer({
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: "/tmp",
          serverName: "group-kill-test",
        });
        return s?.status === "running";
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "group-kill-test",
      });
      expect(server!.status).toBe("running");
      const pid = server!._pid!;
      expect(pid).toBeGreaterThan(0);

      expect(isProcessGroupAlive(pid)).toBe(true);

      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "group-kill-test",
      });

      await waitFor(() => !isProcessGroupAlive(pid), 10000);
      expect(isProcessGroupAlive(pid)).toBe(false);
    });
  });

  describe("stop safety — listener-only verified kill", () => {
    const WORKTREE = "/tmp";

    async function startSleepingServer(port: number, serverName: string) {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName,
        command: "sleep 60",
        worktreePath: WORKTREE,
        startMode: startMode(port, { readinessTimeoutMs: 2000 }),
      });

      return waitForServer(
        {
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: WORKTREE,
          serverName,
        },
        (entry) => entry.status === "running",
      );
    }

    it("only signals listener PIDs, never client-connection PIDs", async () => {
      const listenerPid = 99001;
      const sendSignal = vi.fn().mockReturnValue(true);
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({
          status: "owned",
          pid: listenerPid,
          cwd: WORKTREE,
        });
      const checkPortListening = vi.fn().mockResolvedValue(true);

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        checkPortListening,
      });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59901, "listener-only-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "listener-only-test",
      });

      const signaledPids = sendSignal.mock.calls.map((c) => c[0]);
      for (const pid of signaledPids) {
        expect(pid).toBe(listenerPid);
      }
      expect(sendSignal).toHaveBeenCalledWith(listenerPid, "SIGTERM");
    });

    it("does not signal anything when no listener exists (client-only port)", async () => {
      const sendSignal = vi.fn();
      // First call (readiness probe) returns true so we transition to running.
      // Subsequent calls (stop-path classify) return "available" so no signal.
      const checkPortListening = vi.fn().mockResolvedValue(true);
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({ status: "available" });

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        checkPortListening,
      });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59902, "client-only-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "client-only-test",
      });

      expect(sendSignal).not.toHaveBeenCalled();
    });

    it("refuses to kill when listener cwd cannot be resolved", async () => {
      const sendSignal = vi.fn();
      // First classify (source) succeeds; second (stop) returns unknown.
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValueOnce({
          status: "owned",
          pid: 99003,
          cwd: WORKTREE,
        })
        .mockResolvedValue({ status: "unknown", reason: "cwd_unresolved" });
      const checkPortListening = vi.fn().mockResolvedValue(true);

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        checkPortListening,
      });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59903, "unresolved-cwd-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "unresolved-cwd-test",
      });

      expect(sendSignal).not.toHaveBeenCalled();
      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "unresolved-cwd-test",
      });
      expect(server!.errorMessage).toBeTruthy();
      expect(server!.errorMessage).toMatch(/verified|ownership|verify/i);
    });

    it("refuses to kill when listener cwd is outside the session worktree", async () => {
      const listenerPid = 99004;
      const sendSignal = vi.fn();
      // First classify (source path) shows owned; second (stop path) shows conflict.
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValueOnce({
          status: "owned",
          pid: listenerPid,
          cwd: WORKTREE,
        })
        .mockResolvedValue({
          status: "conflict",
          pid: listenerPid,
          cwd: "/var/run/someone-elses-app",
        });
      const checkPortListening = vi.fn().mockResolvedValue(true);

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        checkPortListening,
      });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59904, "foreign-cwd-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "foreign-cwd-test",
      });

      expect(sendSignal).not.toHaveBeenCalled();
      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "foreign-cwd-test",
      });
      expect(server!.errorMessage).toMatch(/verified|ownership|verify/i);
    });

    it("signals SIGTERM for verified session-owned listener (dies gracefully)", async () => {
      const listenerPid = 99005;
      const sendSignal = vi.fn().mockReturnValue(true);
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({
          status: "owned",
          pid: listenerPid,
          cwd: `${WORKTREE}/app`,
        });
      const isProcessAlive = vi.fn().mockReturnValue(false);
      const checkPortListening = vi.fn().mockResolvedValue(true);

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        isProcessAlive,
        checkPortListening,
      });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59905, "owned-sigterm-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "owned-sigterm-test",
      });

      const sigterms = sendSignal.mock.calls.filter(
        (c) => c[0] === listenerPid && c[1] === "SIGTERM",
      );
      const sigkills = sendSignal.mock.calls.filter(
        (c) => c[0] === listenerPid && c[1] === "SIGKILL",
      );
      expect(sigterms.length).toBeGreaterThan(0);
      expect(sigkills.length).toBe(0);
    });

    it("escalates to SIGKILL when verified listener does not exit on SIGTERM", async () => {
      const listenerPid = 99006;
      const sendSignal = vi.fn().mockReturnValue(true);
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({
          status: "owned",
          pid: listenerPid,
          cwd: WORKTREE,
        });
      const isProcessAlive = vi.fn().mockReturnValue(true);
      const checkPortListening = vi.fn().mockResolvedValue(true);

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        isProcessAlive,
        killGraceMs: 100,
        checkPortListening,
      });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59906, "owned-sigkill-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: "/tmp",
        serverName: "owned-sigkill-test",
      });

      expect(sendSignal).toHaveBeenCalledWith(listenerPid, "SIGTERM");
      expect(sendSignal).toHaveBeenCalledWith(listenerPid, "SIGKILL");
    });
  });

  describe("getSessionServers", () => {
    it("only returns servers for the requested session", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(59830),
      });

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s2",
        serverName: "web",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(59831),
      });

      const s1Servers = registry.getSessionServers({
        projectPath: "/proj",
        sessionName: "s1",
      });
      const s2Servers = registry.getSessionServers({
        projectPath: "/proj",
        sessionName: "s2",
      });

      expect(s1Servers).toHaveLength(1);
      expect(s1Servers[0]!.sessionName).toBe("s1");
      expect(s2Servers).toHaveLength(1);
      expect(s2Servers[0]!.sessionName).toBe("s2");
    });
  });

  describe("log capture", () => {
    let logWorktree: string;

    beforeEach(() => {
      logWorktree = mkdtempSync(path.join(tmpdir(), "cc-devserver-log-"));
    });

    afterEach(() => {
      rmSync(logWorktree, { recursive: true, force: true });
    });

    async function waitForLogToContain(
      filePath: string,
      needle: string,
      timeoutMs = 3000,
    ): Promise<string> {
      return vi.waitFor(
        () => {
          try {
            const contents = readFileSync(filePath, "utf-8");
            if (contents.includes(needle)) return contents;
          } catch {
            // not created yet
          }
          throw new Error(`log file ${filePath} does not contain ${needle}`);
        },
        { timeout: timeoutMs, interval: 10 },
      );
    }

    it("computes logFilePath under <worktree>/.cc/dev-server-logs/<server>.log", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "logged-server",
        command: "sleep 60",
        worktreePath: logWorktree,
        startMode: startMode(59840),
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: logWorktree,
        serverName: "logged-server",
      });

      expect(server!.logFilePath).toBe(
        path.join(logWorktree, ".cc/dev-server-logs/logged-server.log"),
      );
    });

    it("writes stdout lines with [OUT] prefix to the log file", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "stdout-log",
        command: "echo hello-from-stdout && sleep 60",
        worktreePath: logWorktree,
        startMode: startMode(59841),
      });

      const logPath = path.join(
        logWorktree,
        ".cc/dev-server-logs/stdout-log.log",
      );
      const contents = await waitForLogToContain(logPath, "hello-from-stdout");
      expect(contents).toContain("[OUT] hello-from-stdout");
    });

    it("writes stderr lines with [ERR] prefix to the log file", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "stderr-log",
        command: "echo angry-stderr 1>&2 && sleep 60",
        worktreePath: logWorktree,
        startMode: startMode(59842),
      });

      const logPath = path.join(
        logWorktree,
        ".cc/dev-server-logs/stderr-log.log",
      );
      const contents = await waitForLogToContain(logPath, "angry-stderr");
      expect(contents).toContain("[ERR] angry-stderr");
    });

    it("truncates the existing log file on each spawn", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "truncate-log",
        command: "echo first-run && sleep 60",
        worktreePath: logWorktree,
        startMode: startMode(59843),
      });

      const logPath = path.join(
        logWorktree,
        ".cc/dev-server-logs/truncate-log.log",
      );
      await waitForLogToContain(logPath, "first-run");

      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        worktreePath: logWorktree,
        serverName: "truncate-log",
      });

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "truncate-log",
        command: "echo second-run && sleep 60",
        worktreePath: logWorktree,
        startMode: startMode(59844),
      });

      const contents = await waitForLogToContain(logPath, "second-run");
      expect(contents).toContain("[OUT] second-run");
      expect(contents).not.toContain("first-run");
    });

    it("includes logFilePath on broadcast status events", async () => {
      const broadcast = vi.fn();
      deps = createTestDeps({ broadcast });
      registry = createDevServerRegistry(deps);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "broadcast-log",
        command: "sleep 60",
        worktreePath: logWorktree,
        startMode: startMode(59845),
      });

      const event = broadcast.mock.calls[0]![0];
      expect(event).toMatchObject({
        type: "dev-server-status",
        serverName: "broadcast-log",
        logFilePath: path.join(
          logWorktree,
          ".cc/dev-server-logs/broadcast-log.log",
        ),
      });
    });
  });

  describe("cc-assigned start mode", () => {
    it("injects CC_ASSIGNED_PORT, PORT, and the configured env alias into the child", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-assigned-env",
        command:
          'echo "CC_ASSIGNED_PORT=$CC_ASSIGNED_PORT" && echo "PORT=$PORT" && echo "ALIAS_PORT=$ALIAS_PORT" && sleep 60',
        worktreePath: "/tmp",
        startMode: {
          port: 51234,
          envAliases: ["ALIAS_PORT"],
          readinessTimeoutMs: 2000,
        },
      });

      const server = await waitForServer(
        {
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: "/tmp",
          serverName: "cc-assigned-env",
        },
        (entry) =>
          entry.recentOutput.includes("CC_ASSIGNED_PORT=51234") &&
          entry.recentOutput.includes("PORT=51234") &&
          entry.recentOutput.includes("ALIAS_PORT=51234"),
      );
      expect(server).toBeDefined();
      expect(server!.recentOutput).toContain("CC_ASSIGNED_PORT=51234");
      expect(server!.recentOutput).toContain("PORT=51234");
      expect(server!.recentOutput).toContain("ALIAS_PORT=51234");
    });

    it("transitions to running once TCP readiness passes", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-assigned-tcp-ready",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: {
          port: 51235,
          readinessTimeoutMs: 2000,
        },
      });

      const server = await waitForServer(
        {
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: "/tmp",
          serverName: "cc-assigned-tcp-ready",
        },
        (entry) => entry.status === "running",
        2500,
      );

      expect(server!.status).toBe("running");
      expect(server!.port).toBe(51235);
    });

    it("errors out when TCP readiness never passes within the timeout", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(false);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-assigned-tcp-timeout",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: {
          port: 51236,
          readinessTimeoutMs: 400,
        },
      });

      const server = await waitForServer(
        {
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: "/tmp",
          serverName: "cc-assigned-tcp-timeout",
        },
        (entry) => entry.status === "error",
        2000,
      );

      expect(server!.status).toBe("error");
      expect(server!.errorMessage ?? "").toMatch(/readiness|timeout/i);
    });

    it("uses the override cwd when starting the cc-assigned child", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-assigned-cwd",
        command: 'echo "PWD=$(pwd)" && sleep 60',
        worktreePath: "/tmp",
        startMode: {
          port: 51237,
          cwd: "/usr",
          readinessTimeoutMs: 2000,
        },
      });

      const server = await waitForServer(
        {
          projectPath: "/proj",
          sessionName: "s1",
          worktreePath: "/tmp",
          serverName: "cc-assigned-cwd",
        },
        (entry) => entry.recentOutput.some((line) => line.startsWith("PWD=")),
      );
      const pwdLine = server?.recentOutput.find((l) => l.startsWith("PWD="));
      expect(pwdLine).toBe("PWD=/usr");
    });
  });
});

describe("isPortListening (production probe)", () => {
  // Regression: Next.js 16 dev binds tcp46 wildcard ("*.<port>"). On macOS,
  // a 127.0.0.1 bind-probe of that port can still succeed — so the prior
  // bind-probe impl falsely reported "no listener" and dev servers
  // hit a 60s readiness timeout despite Next.js logging "Ready in 4.7s".
  // The probe MUST detect tcp46 wildcard listeners via TCP connect.

  function listenWildcard(): Promise<{
    port: number;
    close: () => Promise<void>;
  }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("no address"));
          return;
        }
        resolve({
          port: addr.port,
          close: () =>
            new Promise<void>((res) => {
              server.close(() => res());
            }),
        });
      });
    });
  }

  it("returns true for a real wildcard tcp46 listener (Next.js dev shape)", async () => {
    const listener = await listenWildcard();
    try {
      const result = await isPortListening(listener.port);
      expect(result).toBe(true);
    } finally {
      await listener.close();
    }
  });

  it("returns false when nothing is listening on the port", async () => {
    // Bind+close to obtain a port number that's free at probe time.
    const listener = await listenWildcard();
    const freePort = listener.port;
    await listener.close();

    const result = await isPortListening(freePort);
    expect(result).toBe(false);
  });
});
