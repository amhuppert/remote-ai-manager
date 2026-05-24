import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AmbiguousDevServerError,
  NoDevServersConfiguredError,
  UnknownDevServerError,
  type DevServerService,
  type DevServerStatusItem,
} from "./service";
import { registerDevServerTools, type DevServerToolContext } from "./mcp-tools";

type ToolHandler = (args: unknown) => Promise<unknown>;

interface CapturedTool {
  name: string;
  config: { description: string; inputSchema: Record<string, unknown> };
  handler: ToolHandler;
}

function createCapturingServer() {
  const captured = new Map<string, CapturedTool>();
  const server = {
    registerTool(
      name: string,
      config: CapturedTool["config"],
      handler: ToolHandler,
    ) {
      captured.set(name, { name, config, handler });
    },
  };
  return { server, captured };
}

const CONTEXT: DevServerToolContext = {
  projectPath: "/projects/test",
  sessionName: "s1",
};

function makeStatusItem(
  overrides: Partial<DevServerStatusItem> = {},
): DevServerStatusItem {
  return {
    serverName: "nextjs",
    command: "next.sh",
    status: "running",
    port: 3000,
    localUrl: "http://localhost:3000",
    remoteUrl: null,
    startedAt: "2026-05-16T00:00:00.000Z",
    errorMessage: null,
    recentOutput: [],
    source: "cc-started",
    ownedByThisSession: true,
    worktreePath: "/projects/test/.worktrees/s1",
    ownerPid: 1234,
    ...overrides,
  };
}

function makeService(
  overrides: Partial<DevServerService> = {},
): DevServerService {
  return {
    list: vi.fn(async () => []),
    ensure: vi.fn(async () => makeStatusItem()),
    stop: vi.fn(async () => makeStatusItem({ status: "stopped" })),
    ...overrides,
  };
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

describe("dev-server-mcp-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers get_dev_servers, ensure_dev_server, and stop_dev_server", () => {
    const { server, captured } = createCapturingServer();
    registerDevServerTools(server as never, CONTEXT, makeService());
    expect(captured.has("get_dev_servers")).toBe(true);
    expect(captured.has("ensure_dev_server")).toBe(true);
    expect(captured.has("stop_dev_server")).toBe(true);
  });

  describe("get_dev_servers", () => {
    it("returns a JSON payload with reconciled status", async () => {
      const service = makeService({
        list: vi.fn(async () => [
          makeStatusItem({
            serverName: "nextjs",
            status: "running",
            port: 3001,
            localUrl: "http://localhost:3001",
          }),
          makeStatusItem({
            serverName: "storybook",
            status: "stopped",
            port: null,
            localUrl: null,
            ownedByThisSession: false,
            source: null,
            ownerPid: null,
          }),
        ]),
      });

      const { server, captured } = createCapturingServer();
      registerDevServerTools(server as never, CONTEXT, service);
      const handler = captured.get("get_dev_servers")!.handler;
      const result = (await handler({})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(service.list).toHaveBeenCalledWith({
        projectPath: "/projects/test",
        sessionName: "s1",
      });
      const payload = parseJson(result.content[0]!.text) as {
        servers: DevServerStatusItem[];
      };
      expect(payload.servers).toHaveLength(2);
      expect(payload.servers[0]!.serverName).toBe("nextjs");
      expect(payload.servers[0]!.localUrl).toBe("http://localhost:3001");
      expect(payload.servers[1]!.status).toBe("stopped");
    });
  });

  describe("ensure_dev_server", () => {
    it("returns the resolved server payload on success", async () => {
      const ensured = makeStatusItem({
        serverName: "nextjs",
        port: 3001,
        localUrl: "http://localhost:3001",
        source: "external-adopted",
      });
      const service = makeService({
        ensure: vi.fn(async () => ensured),
      });
      const { server, captured } = createCapturingServer();
      registerDevServerTools(server as never, CONTEXT, service);
      const handler = captured.get("ensure_dev_server")!.handler;
      const result = (await handler({ wait: true })) as {
        content: Array<{ text: string }>;
      };

      expect(service.ensure).toHaveBeenCalledWith({
        projectPath: "/projects/test",
        sessionName: "s1",
        wait: true,
      });
      const payload = parseJson(result.content[0]!.text) as {
        server: DevServerStatusItem;
      };
      expect(payload.server.serverName).toBe("nextjs");
      expect(payload.server.localUrl).toBe("http://localhost:3001");
      expect(payload.server.source).toBe("external-adopted");
    });

    it("forwards name and timeout_ms to the service", async () => {
      const service = makeService();
      const { server, captured } = createCapturingServer();
      registerDevServerTools(server as never, CONTEXT, service);
      const handler = captured.get("ensure_dev_server")!.handler;
      await handler({ name: "storybook", wait: false, timeout_ms: 1234 });
      expect(service.ensure).toHaveBeenCalledWith({
        projectPath: "/projects/test",
        sessionName: "s1",
        serverName: "storybook",
        wait: false,
        timeoutMs: 1234,
      });
    });

    it("returns isError with AMBIGUOUS_DEV_SERVER code and candidate names", async () => {
      const service = makeService({
        ensure: vi.fn(async () => {
          throw new AmbiguousDevServerError(["nextjs", "storybook"]);
        }),
      });
      const { server, captured } = createCapturingServer();
      registerDevServerTools(server as never, CONTEXT, service);
      const handler = captured.get("ensure_dev_server")!.handler;
      const result = (await handler({})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      const payload = parseJson(result.content[0]!.text) as {
        error: { code: string; availableNames: string[] };
      };
      expect(payload.error.code).toBe("AMBIGUOUS_DEV_SERVER");
      expect(payload.error.availableNames).toEqual(["nextjs", "storybook"]);
    });

    it("returns isError with NO_DEV_SERVERS_CONFIGURED code when project has none", async () => {
      const service = makeService({
        ensure: vi.fn(async () => {
          throw new NoDevServersConfiguredError();
        }),
      });
      const { server, captured } = createCapturingServer();
      registerDevServerTools(server as never, CONTEXT, service);
      const handler = captured.get("ensure_dev_server")!.handler;
      const result = (await handler({})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      const payload = parseJson(result.content[0]!.text) as {
        error: { code: string };
      };
      expect(payload.error.code).toBe("NO_DEV_SERVERS_CONFIGURED");
    });

    it("returns isError with UNKNOWN_DEV_SERVER when the named server is missing", async () => {
      const service = makeService({
        ensure: vi.fn(async () => {
          throw new UnknownDevServerError("ghost");
        }),
      });
      const { server, captured } = createCapturingServer();
      registerDevServerTools(server as never, CONTEXT, service);
      const handler = captured.get("ensure_dev_server")!.handler;
      const result = (await handler({ name: "ghost" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      const payload = parseJson(result.content[0]!.text) as {
        error: { code: string };
      };
      expect(payload.error.code).toBe("UNKNOWN_DEV_SERVER");
    });
  });

  describe("stop_dev_server", () => {
    it("delegates to service.stop and returns confirmation payload", async () => {
      const stopped = makeStatusItem({
        serverName: "nextjs",
        status: "stopped",
        port: null,
        localUrl: null,
        ownedByThisSession: false,
      });
      const service = makeService({
        stop: vi.fn(async () => stopped),
      });
      const { server, captured } = createCapturingServer();
      registerDevServerTools(server as never, CONTEXT, service);
      const handler = captured.get("stop_dev_server")!.handler;
      const result = (await handler({ name: "nextjs" })) as {
        content: Array<{ text: string }>;
      };
      expect(service.stop).toHaveBeenCalledWith({
        projectPath: "/projects/test",
        sessionName: "s1",
        serverName: "nextjs",
      });
      const payload = parseJson(result.content[0]!.text) as {
        server: DevServerStatusItem;
      };
      expect(payload.server.status).toBe("stopped");
      expect(payload.server.ownedByThisSession).toBe(false);
    });

    it("returns isError when service throws UnknownDevServerError", async () => {
      const service = makeService({
        stop: vi.fn(async () => {
          throw new UnknownDevServerError("ghost");
        }),
      });
      const { server, captured } = createCapturingServer();
      registerDevServerTools(server as never, CONTEXT, service);
      const handler = captured.get("stop_dev_server")!.handler;
      const result = (await handler({ name: "ghost" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      const payload = parseJson(result.content[0]!.text) as {
        error: { code: string };
      };
      expect(payload.error.code).toBe("UNKNOWN_DEV_SERVER");
    });
  });
});
