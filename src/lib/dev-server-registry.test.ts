import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as registry from "./dev-server-registry";

// Mock tailscale
vi.mock("./tailscale", () => ({
  register: vi.fn().mockResolvedValue("https://mock.ts.net:3000"),
  unregister: vi.fn().mockResolvedValue(undefined),
}));

// Mock sse-broadcaster
vi.mock("./sse-broadcaster", () => ({
  broadcast: vi.fn(),
}));

import * as tailscale from "./tailscale";
import { broadcast } from "./sse-broadcaster";

describe("DevServerRegistry", () => {
  beforeEach(() => {
    registry._resetForTesting();
    vi.clearAllMocks();
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
      expect(server!.pid).toBeGreaterThan(0);
      expect(server!.serverName).toBe("web");

      // SSE broadcast should have been called with 'starting'
      expect(broadcast).toHaveBeenCalledWith(
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
      expect(tailscale.register).not.toHaveBeenCalled();
    });

    it("registers Tailscale after server starts listening on port", async () => {
      // Start a real TCP listener on a port so the deferred check can find it
      const { createServer } = await import("node:net");
      const tcpServer = createServer();
      const port = await new Promise<number>((resolve) => {
        tcpServer.listen(0, "127.0.0.1", () => {
          const addr = tcpServer.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
      });

      try {
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
        expect(tailscale.register).toHaveBeenCalledWith(port);
        expect(server!.remoteUrl).toBe("https://mock.ts.net:3000");
      } finally {
        tcpServer.close();
      }
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

  describe("adopted servers", () => {
    it("detects CC_ADOPTED markers and sets entry.adopted", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-test",
        command:
          "echo CC_ADOPTED=1 && echo CC_ADOPTED_PID=99999 && echo CC_PORT=3000 && exit 0",
        worktreePath: "/tmp",
      });

      // Wait for stdout processing + tailscale
      await new Promise((r) => setTimeout(r, 300));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-test",
      });

      expect(server!.adopted).toBe(true);
      expect(server!.pid).toBe(99999);
      expect(server!.port).toBe(3000);
      expect(server!.status).toBe("running");
    });

    it("does not transition adopted server to stopped when script exits", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-exit",
        command:
          "echo CC_ADOPTED=1 && echo CC_ADOPTED_PID=99999 && echo CC_PORT=3000 && exit 0",
        worktreePath: "/tmp",
      });

      // Wait for stdout processing, tailscale, and exit handler
      await new Promise((r) => setTimeout(r, 500));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-exit",
      });

      // Should still be running despite the script exiting
      expect(server!.status).toBe("running");
      expect(server!.adopted).toBe(true);
    });

    it("stopServer is a no-op for adopted servers", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-stop",
        command:
          "echo CC_ADOPTED=1 && echo CC_ADOPTED_PID=99999 && echo CC_PORT=5000 && exit 0",
        worktreePath: "/tmp",
      });

      await new Promise((r) => setTimeout(r, 300));

      await registry.stopServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-stop",
      });

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "adopted-stop",
      });

      // Should still be running — stopServer is a no-op for adopted servers
      expect(server!.status).toBe("running");
      expect(server!.adopted).toBe(true);
    });

    it("non-adopted servers are not marked as adopted", async () => {
      await registry.startServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "normal-server",
        command: "echo CC_PORT=3000 && sleep 60",
        worktreePath: "/tmp",
      });

      await new Promise((r) => setTimeout(r, 200));

      const server = registry.getServer({
        projectPath: "/proj",
        sessionName: "s1",
        serverName: "normal-server",
      });

      expect(server!.adopted).toBe(false);
      expect(server!.status).toBe("running");
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
      expect(tailscale.unregister).toHaveBeenCalledWith(4000);
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
