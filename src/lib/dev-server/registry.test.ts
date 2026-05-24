import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDevServerRegistry,
  type DevServerRegistryDeps,
} from "./registry";
import type { PortOwnershipInput, PortOwnershipResult } from "./port-ownership";
import type { DevServerSource } from "@/lib/dev-server/schemas";
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
      claudeTimeoutMs: 300_000,
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
    classifyServerSource: vi
      .fn<
        (input: {
          listenerPid: number;
          spawnedPid: number | null;
        }) => Promise<DevServerSource>
      >()
      .mockResolvedValue("cc-started"),
    ...overrides,
  };
}

describe("DevServerRegistry", () => {
  let registry: ReturnType<typeof createDevServerRegistry>;
  let deps: DevServerRegistryDeps;

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
        serverName: "web",
      });
      expect(server).toBeUndefined();
    });
  });

  describe("startServer", () => {
    it("spawns process and transitions to starting", async () => {
      // Use a command that will stay alive briefly
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
        command: "sleep 60",
        worktreePath: "/tmp",
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "web",
      });

      expect(server).toBeDefined();
      expect(server!.status).toBe("starting");
      expect(server!.serverName).toBe("web");

      // SSE broadcast should have been called with 'starting'
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
      });

      await expect(
        registry.startServer({
          projectPath: "/proj",
          sessionName: "s1",
          serverName: "web",
          command: "sleep 60",
          worktreePath: "/tmp",
        }),
      ).rejects.toThrow('Server "web" is already starting');
    });

    it("detects CC_PORT and transitions to running", async () => {
      // Use a port that's unlikely to be occupied so the deferred Tailscale
      // poll doesn't fire within the test window
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "port-test",
        command: "echo CC_PORT=59876 && sleep 60",
        worktreePath: "/tmp",
      });

      // Wait for stdout processing
      await new Promise((r) => setTimeout(r, 200));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "port-test",
      });

      expect(server!.status).toBe("running");
      expect(server!.port).toBe(59876);
      // remoteUrl is null initially — Tailscale registration is deferred until
      // the server is actually listening on the port
      expect(server!.remoteUrl).toBeNull();
      // Tailscale should NOT have been called yet since nothing is listening
      expect(deps.tailscale.register).not.toHaveBeenCalled();
    });

    it("registers Tailscale after server starts listening on port", async () => {
      // Mock port-listening check to report port as occupied (avoids needing
      // a real TCP server, which can fail with EPERM in sandboxed environments)
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);
      const port = 54321;

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "tailscale-test",
        command: `echo CC_PORT=${port} && sleep 60`,
        worktreePath: "/tmp",
      });

      // Wait for stdout processing + deferred Tailscale poll (500ms interval)
      await new Promise((r) => setTimeout(r, 1200));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "tailscale-test",
      });

      expect(server!.status).toBe("running");
      expect(server!.port).toBe(port);
      expect(deps.tailscale.register).toHaveBeenCalledWith(port);
      expect(server!.remoteUrl).toBe("https://mock.ts.net:3000");
    });

    it("transitions to error when process exits before CC_PORT", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "fail-test",
        command: "echo 'server failed' && exit 1",
        worktreePath: "/tmp",
      });

      // Wait for process exit
      await new Promise((r) => setTimeout(r, 200));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "fail-test",
      });

      expect(server!.status).toBe("error");
      expect(server!.errorMessage).toContain("before reporting CC_PORT");
    });

    it("captures recent output in buffer", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "output-test",
        command: "echo line1 && echo line2 && echo line3 && sleep 60 &",
        worktreePath: "/tmp",
      });

      await new Promise((r) => setTimeout(r, 200));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "output-test",
      });

      expect(server!.recentOutput.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("stopServer", () => {
    it("stops a running server gracefully", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "stop-test",
        command: "echo CC_PORT=4000 && sleep 60",
        worktreePath: "/tmp",
      });

      await new Promise((r) => setTimeout(r, 200));

      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "stop-test",
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "stop-test",
      });

      expect(server!.status).toBe("stopped");
      expect(deps.tailscale.unregister).toHaveBeenCalledWith(4000);
    });

    it("is a no-op for non-existent server", async () => {
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "nonexistent",
      });
      // Should not throw
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
      });

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "storybook",
        command: "sleep 60",
        worktreePath: "/tmp",
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

  describe("process group killing", () => {
    /** Helper: poll until condition is true or timeout */
    async function waitFor(
      fn: () => boolean | Promise<boolean>,
      timeoutMs = 5000,
      intervalMs = 200,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw new Error("waitFor timed out");
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
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "pid-test",
      });

      expect(server!._pid).toBeGreaterThan(0);
    });

    it("kills child processes via process group when stopping", async () => {
      const fakePort = 54322;

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "group-kill-test",
        command: `echo CC_PORT=${fakePort} && node -e "setInterval(()=>{},60000)"`,
        worktreePath: "/tmp",
      });

      // Wait for CC_PORT detection → "running" status
      await waitFor(() => {
        const s = registry.getServer({
          projectPath: "/proj",
          sessionName: "s1",
          serverName: "group-kill-test",
        });
        return s?.status === "running";
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "group-kill-test",
      });
      expect(server!.status).toBe("running");
      const pid = server!._pid!;
      expect(pid).toBeGreaterThan(0);

      // Verify the process group is alive before stopping
      expect(isProcessGroupAlive(pid)).toBe(true);

      // Stop the server
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "group-kill-test",
      });

      // Process group should be dead (all children killed)
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
        command: `echo CC_PORT=${port} && sleep 60`,
        worktreePath: WORKTREE,
      });

      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const s = registry.getServer({
          projectPath: "/proj",
          sessionName: "s1",
          serverName,
        });
        if (s?.status === "running") return s;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("server never reached running");
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

      deps = createTestDeps({ classifyPortOwnership, sendSignal });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59901, "listener-only-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
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
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({ status: "available" });

      deps = createTestDeps({ classifyPortOwnership, sendSignal });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59902, "client-only-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "client-only-test",
      });

      expect(sendSignal).not.toHaveBeenCalled();
    });

    it("refuses to kill when listener cwd cannot be resolved", async () => {
      const sendSignal = vi.fn();
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({ status: "unknown", reason: "cwd_unresolved" });

      deps = createTestDeps({ classifyPortOwnership, sendSignal });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59903, "unresolved-cwd-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "unresolved-cwd-test",
      });

      expect(sendSignal).not.toHaveBeenCalled();
      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "unresolved-cwd-test",
      });
      expect(server!.errorMessage).toBeTruthy();
      expect(server!.errorMessage).toMatch(/verified|ownership|verify/i);
    });

    it("refuses to kill when listener cwd is outside the session worktree", async () => {
      const listenerPid = 99004;
      const sendSignal = vi.fn();
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({
          status: "conflict",
          pid: listenerPid,
          cwd: "/var/run/someone-elses-app",
        });

      deps = createTestDeps({ classifyPortOwnership, sendSignal });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59904, "foreign-cwd-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "foreign-cwd-test",
      });

      expect(sendSignal).not.toHaveBeenCalled();
      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
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

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        isProcessAlive,
      });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59905, "owned-sigterm-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
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

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        isProcessAlive,
        killGraceMs: 100,
      });
      registry = createDevServerRegistry(deps);

      await startSleepingServer(59906, "owned-sigkill-test");
      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "owned-sigkill-test",
      });

      expect(sendSignal).toHaveBeenCalledWith(listenerPid, "SIGTERM");
      expect(sendSignal).toHaveBeenCalledWith(listenerPid, "SIGKILL");
    });
  });

  describe("source classification and ownership tracking", () => {
    const WORKTREE = "/tmp";

    async function waitForRunning(serverName: string) {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const s = registry.getServer({
          projectPath: "/proj",
          sessionName: "s1",
          serverName,
        });
        if (s?.status === "running") return s;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("server never reached running");
    }

    it("records source='cc-started', ownedByThisSession=true, and ownerPid for CC-spawned listeners", async () => {
      const listenerPid = 91001;
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({
          status: "owned",
          pid: listenerPid,
          cwd: WORKTREE,
        });
      const classifyServerSource = vi
        .fn<
          (input: {
            listenerPid: number;
            spawnedPid: number | null;
          }) => Promise<DevServerSource>
        >()
        .mockResolvedValue("cc-started");

      deps = createTestDeps({ classifyPortOwnership, classifyServerSource });
      registry = createDevServerRegistry(deps);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-source-test",
        command: `echo CC_PORT=59910 && sleep 60`,
        worktreePath: WORKTREE,
      });

      await waitForRunning("cc-source-test");
      // Allow async classification to settle after the CC_PORT line
      await new Promise((r) => setTimeout(r, 100));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-source-test",
      });

      expect(server!.source).toBe("cc-started");
      expect(server!.ownedByThisSession).toBe(true);
      expect(server!.ownerPid).toBe(listenerPid);
      expect(server!.worktreePath).toBe(WORKTREE);
      expect(classifyServerSource).toHaveBeenCalledWith(
        expect.objectContaining({ listenerPid }),
      );
    });

    it("records source='external-adopted' when listener was started outside the spawn group", async () => {
      const listenerPid = 91002;
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({
          status: "owned",
          pid: listenerPid,
          cwd: WORKTREE,
        });
      const classifyServerSource = vi
        .fn<
          (input: {
            listenerPid: number;
            spawnedPid: number | null;
          }) => Promise<DevServerSource>
        >()
        .mockResolvedValue("external-adopted");

      deps = createTestDeps({ classifyPortOwnership, classifyServerSource });
      registry = createDevServerRegistry(deps);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-source-test",
        command: `echo CC_PORT=59911 && sleep 60`,
        worktreePath: WORKTREE,
      });

      await waitForRunning("adopted-source-test");
      await new Promise((r) => setTimeout(r, 100));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-source-test",
      });

      expect(server!.source).toBe("external-adopted");
      expect(server!.ownedByThisSession).toBe(true);
      expect(server!.ownerPid).toBe(listenerPid);
    });

    it("broadcasts the new source/ownership fields on status events", async () => {
      const broadcast = vi.fn();
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({
          status: "owned",
          pid: 91003,
          cwd: WORKTREE,
        });

      deps = createTestDeps({
        broadcast,
        classifyPortOwnership,
        classifyServerSource: vi.fn().mockResolvedValue("external-adopted"),
      });
      registry = createDevServerRegistry(deps);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "broadcast-source-test",
        command: `echo CC_PORT=59912 && sleep 60`,
        worktreePath: WORKTREE,
      });

      await waitForRunning("broadcast-source-test");
      await new Promise((r) => setTimeout(r, 100));

      const adoptedEvent = broadcast.mock.calls
        .map((c) => c[0])
        .find(
          (e: { source: DevServerSource | null }) =>
            e.source === "external-adopted",
        );

      expect(adoptedEvent).toMatchObject({
        type: "dev-server-status",
        source: "external-adopted",
        ownedByThisSession: true,
        worktreePath: WORKTREE,
        ownerPid: 91003,
      });
    });

    it("stopAllForSession stops externally adopted servers when ownership is verified", async () => {
      const listenerPid = 91004;
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValue({
          status: "owned",
          pid: listenerPid,
          cwd: WORKTREE,
        });
      const sendSignal = vi.fn().mockReturnValue(true);
      const isProcessAlive = vi.fn().mockReturnValue(false);

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        isProcessAlive,
        classifyServerSource: vi.fn().mockResolvedValue("external-adopted"),
      });
      registry = createDevServerRegistry(deps);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-stopall-test",
        command: `echo CC_PORT=59913 && sleep 60`,
        worktreePath: WORKTREE,
      });

      await waitForRunning("adopted-stopall-test");
      await new Promise((r) => setTimeout(r, 100));

      await registry.stopAllForSession({
        projectPath: "/proj",
        sessionName: "s1",
      });

      expect(sendSignal).toHaveBeenCalledWith(listenerPid, "SIGTERM");

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-stopall-test",
      });
      expect(server!.status).toBe("stopped");
    });

    it("automatic cleanup refuses to kill when ownership cannot be verified at stop time", async () => {
      const classifyPortOwnership = vi
        .fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>()
        .mockResolvedValueOnce({
          status: "owned",
          pid: 91005,
          cwd: WORKTREE,
        })
        .mockResolvedValue({
          status: "unknown",
          reason: "cwd_unresolved",
        });
      const sendSignal = vi.fn();

      deps = createTestDeps({
        classifyPortOwnership,
        sendSignal,
        classifyServerSource: vi.fn().mockResolvedValue("external-adopted"),
      });
      registry = createDevServerRegistry(deps);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-unverified-test",
        command: `echo CC_PORT=59914 && sleep 60`,
        worktreePath: WORKTREE,
      });

      await waitForRunning("adopted-unverified-test");
      await new Promise((r) => setTimeout(r, 100));

      await registry.stopAllForSession({
        projectPath: "/proj",
        sessionName: "s1",
      });

      expect(sendSignal).not.toHaveBeenCalled();

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-unverified-test",
      });
      expect(server!.errorMessage).toMatch(/verified|ownership|verify/i);
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
      });

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s2",
        serverName: "web",
        command: "sleep 60",
        worktreePath: "/tmp",
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
          type: "cc-assigned",
          port: 51234,
          envAliases: ["ALIAS_PORT"],
          readiness: { type: "tcp", timeoutMs: 2000 },
        },
      });

      await new Promise((r) => setTimeout(r, 600));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-assigned-env",
      });
      expect(server).toBeDefined();
      expect(server!.recentOutput).toContain("CC_ASSIGNED_PORT=51234");
      expect(server!.recentOutput).toContain("PORT=51234");
      expect(server!.recentOutput).toContain("ALIAS_PORT=51234");
    });

    it("transitions to running once TCP readiness passes without a CC_PORT line", async () => {
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-assigned-tcp-ready",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: {
          type: "cc-assigned",
          port: 51235,
          readiness: { type: "tcp", timeoutMs: 2000 },
        },
      });

      const deadline = Date.now() + 2500;
      let server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-assigned-tcp-ready",
      });
      while (Date.now() < deadline && server?.status !== "running") {
        await new Promise((r) => setTimeout(r, 100));
        server = registry.getServer({
          projectPath: "/proj",
          sessionName: "s1",
          serverName: "cc-assigned-tcp-ready",
        });
      }

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
          type: "cc-assigned",
          port: 51236,
          readiness: { type: "tcp", timeoutMs: 400 },
        },
      });

      const deadline = Date.now() + 2000;
      let server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-assigned-tcp-timeout",
      });
      while (Date.now() < deadline && server?.status === "starting") {
        await new Promise((r) => setTimeout(r, 100));
        server = registry.getServer({
          projectPath: "/proj",
          sessionName: "s1",
          serverName: "cc-assigned-tcp-timeout",
        });
      }

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
          type: "cc-assigned",
          port: 51237,
          cwd: "/usr",
          readiness: { type: "tcp", timeoutMs: 2000 },
        },
      });

      await new Promise((r) => setTimeout(r, 400));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "cc-assigned-cwd",
      });
      const pwdLine = server?.recentOutput.find((l) => l.startsWith("PWD="));
      expect(pwdLine).toBe("PWD=/usr");
    });
  });
});
