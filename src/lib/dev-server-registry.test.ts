import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDevServerRegistry,
  type DevServerRegistryDeps,
} from "./dev-server-registry";

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
      stateFilePath: "/tmp/state.json",
      claudeTimeoutMs: 300_000,
    }),
    livenessStart: vi.fn(),
    getLanUrl: vi.fn((port: number) => `http://192.168.1.100:${port}`),
    checkPortListening: vi.fn().mockResolvedValue(false),
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
});
