import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDevServerRegistry,
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

      await new Promise((r) => setTimeout(r, 500));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "port-test",
      });

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

    it("transitions to error when process exits before the port is listening", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "fail-test",
        command: "echo 'server failed' && exit 1",
        worktreePath: "/tmp",
        startMode: startMode(59803),
      });

      await new Promise((r) => setTimeout(r, 200));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "fail-test",
      });

      expect(server!.status).toBe("error");
      expect(server!.errorMessage).toContain("before port 59803 ever listening");
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
      vi.mocked(deps.checkPortListening).mockResolvedValue(true);

      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "stop-test",
        command: "sleep 60",
        worktreePath: "/tmp",
        startMode: startMode(4000, { readinessTimeoutMs: 2000 }),
      });

      await new Promise((r) => setTimeout(r, 500));

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
        startMode: startMode(59820),
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
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

      expect(isProcessGroupAlive(pid)).toBe(true);

      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
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
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const contents = readFileSync(filePath, "utf-8");
          if (contents.includes(needle)) return contents;
        } catch {
          // not created yet
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`log file ${filePath} never contained ${needle}`);
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
          port: 51236,
          readinessTimeoutMs: 400,
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
          port: 51237,
          cwd: "/usr",
          readinessTimeoutMs: 2000,
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
