import { describe, expect, it } from "vitest";
import type {
  AppServerClient,
  AppServerClientOptions,
} from "./app-server-client";
import type { NativeCodexMcpServer } from "./native-mcp-suppression";
import { forkCodexThread, type CodexThreadForkDeps } from "./thread-fork";

const INPUT = {
  projectPath: "/repo",
  threadId: "thread-source",
  lastTurnId: "turn-3",
};

interface FakeServer {
  deps: CodexThreadForkDeps;
  launches: AppServerClientOptions[];
  calls: Array<{ kind: "request" | "notify"; method: string; params: unknown }>;
  closed: () => number;
}

function fakeServer(
  options: {
    forkResult?: () => Promise<unknown>;
    nativeServers?: NativeCodexMcpServer[];
    listNativeMcpServers?: CodexThreadForkDeps["listNativeMcpServers"];
    close?: () => Promise<void>;
    failTransport?: Error;
  } = {},
): FakeServer {
  const launches: AppServerClientOptions[] = [];
  const calls: FakeServer["calls"] = [];
  let closed = 0;
  const deps: CodexThreadForkDeps = {
    buildEnv: () => ({ PATH: "/bin" }),
    listNativeMcpServers:
      options.listNativeMcpServers ?? (async () => options.nativeServers ?? []),
    createAppServer(launch) {
      launches.push(launch);
      const client: AppServerClient = {
        async request(method, params) {
          calls.push({ kind: "request", method, params });
          if (method === "initialize") return { userAgent: "codex" };
          if (method === "thread/fork") {
            if (options.failTransport) launch.onFailure(options.failTransport);
            return options.forkResult
              ? options.forkResult()
              : { thread: { id: "thread-forked", path: "/r.jsonl" } };
          }
          throw new Error(`unexpected method ${method}`);
        },
        notify(method, params) {
          calls.push({ kind: "notify", method, params });
        },
        barrier: () => ({ release() {}, fail() {} }),
        flush: async () => {},
        async close() {
          closed += 1;
          if (options.close) await options.close();
        },
        stderrTail: "",
      };
      return client;
    },
  };
  return { deps, launches, calls, closed: () => closed };
}

describe("forkCodexThread", () => {
  it("initializes, forks the thread through the last turn, and closes the one-shot server", async () => {
    const server = fakeServer();

    await expect(forkCodexThread(INPUT, server.deps)).resolves.toBe(
      "thread-forked",
    );

    expect(server.calls).toEqual([
      {
        kind: "request",
        method: "initialize",
        params: {
          clientInfo: { name: "command-center", version: "1.0.0" },
          capabilities: { experimentalApi: false },
        },
      },
      { kind: "notify", method: "initialized", params: undefined },
      {
        kind: "request",
        method: "thread/fork",
        params: {
          threadId: "thread-source",
          lastTurnId: "turn-3",
          excludeTurns: true,
        },
      },
    ]);
    expect(server.closed()).toBe(1);
  });

  it("launches in the project with native memory off and every listed native MCP server disabled", async () => {
    const server = fakeServer({
      nativeServers: [
        { name: "docs", configEntry: { url: "https://docs.example/mcp" } },
      ],
    });

    await forkCodexThread(INPUT, server.deps);

    expect(server.launches).toHaveLength(1);
    const launch = server.launches[0];
    expect(launch?.cwd).toBe("/repo");
    expect(launch?.env).toEqual({ PATH: "/bin" });
    expect(launch?.config).toMatchObject({
      memories: expect.any(Object),
      mcp_servers: {
        docs: { url: "https://docs.example/mcp", enabled: false },
      },
    });
  });

  it("adds no MCP override when no native servers are configured", async () => {
    const server = fakeServer();

    await forkCodexThread(INPUT, server.deps);

    expect(server.launches[0]?.config).not.toHaveProperty("mcp_servers");
  });

  it("rejects with the provider error and still closes the server", async () => {
    const server = fakeServer({
      forkResult: async () => {
        throw new Error("turn not found: turn-3");
      },
    });

    await expect(forkCodexThread(INPUT, server.deps)).rejects.toThrow(
      "turn not found: turn-3",
    );
    expect(server.closed()).toBe(1);
  });

  it("rejects a response without a thread id and still closes the server", async () => {
    const server = fakeServer({ forkResult: async () => ({ thread: {} }) });

    await expect(forkCodexThread(INPUT, server.deps)).rejects.toThrow(
      /thread\/fork/,
    );
    expect(server.closed()).toBe(1);
  });

  it("rejects when the transport reports a failure during the fork", async () => {
    const server = fakeServer({
      failTransport: new Error("app-server exited"),
    });

    await expect(forkCodexThread(INPUT, server.deps)).rejects.toThrow(
      "app-server exited",
    );
    expect(server.closed()).toBe(1);
  });

  it("rejects without launching when native MCP servers cannot be listed", async () => {
    const server = fakeServer({
      listNativeMcpServers: async () => {
        throw new Error("codex mcp list failed");
      },
    });

    await expect(forkCodexThread(INPUT, server.deps)).rejects.toThrow(
      "codex mcp list failed",
    );
    expect(server.launches).toHaveLength(0);
  });

  it("returns the forked thread when only cleanup fails, because the thread exists", async () => {
    const server = fakeServer({
      close: async () => {
        throw new Error("cleanup unverified");
      },
    });

    await expect(forkCodexThread(INPUT, server.deps)).resolves.toBe(
      "thread-forked",
    );
  });
});
