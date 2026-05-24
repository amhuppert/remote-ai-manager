import { describe, expect, it, vi } from "vitest";

import type { McpDiscoveredTool } from "@/lib/mcp/schemas";
import {
  createDirectToolProbe,
  type DirectToolProbeClient,
  type DirectToolProbeDeps,
} from "./tool-discovery-probe";
import type { McpCanonicalServerConfig } from "./types";

// ---------------------------------------------------------------------------
// Helpers — stub client factory with controllable connect/listTools/close
// ---------------------------------------------------------------------------

interface StubState {
  connectCalls: number;
  listToolsCalls: number;
  closeCalls: number;
  lastTransport: "stdio" | "streamable-http" | "sse" | "unknown";
}

function stdioServer(): McpCanonicalServerConfig {
  return {
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    env: { SECRET: "shh" },
  };
}

function httpServer(): McpCanonicalServerConfig {
  return {
    transport: "streamable-http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer xxx" },
  };
}

function sseServer(): McpCanonicalServerConfig {
  return {
    transport: "sse",
    url: "https://example.com/sse",
    headers: { Authorization: "Bearer xxx" },
  };
}

function createStubClient(options: {
  tools?: McpDiscoveredTool[];
  connect?: () => Promise<void>;
  listTools?: () => Promise<McpDiscoveredTool[]>;
  close?: () => Promise<void>;
  transport: StubState["lastTransport"];
  state: StubState;
}): DirectToolProbeClient {
  return {
    async connect() {
      options.state.connectCalls += 1;
      options.state.lastTransport = options.transport;
      if (options.connect) await options.connect();
    },
    async listTools(opts) {
      options.state.listToolsCalls += 1;
      void opts;
      if (options.listTools) return options.listTools();
      return options.tools ?? [];
    },
    async close() {
      options.state.closeCalls += 1;
      if (options.close) await options.close();
    },
  };
}

function depsWithStub(
  state: StubState,
  build: (server: McpCanonicalServerConfig) => DirectToolProbeClient,
): DirectToolProbeDeps {
  return {
    async createClient(input) {
      state.lastTransport = (input.server.transport ??
        "unknown") as StubState["lastTransport"];
      return build(input.server);
    },
    startupTimeoutMs: 200,
    toolTimeoutMs: 200,
  };
}

// ---------------------------------------------------------------------------
// Transport coverage — stdio, streamable-http, sse
// ---------------------------------------------------------------------------

describe("createDirectToolProbe", () => {
  it("probes stdio servers and returns tool list in ready state", async () => {
    const state: StubState = {
      connectCalls: 0,
      listToolsCalls: 0,
      closeCalls: 0,
      lastTransport: "unknown",
    };
    const tools: McpDiscoveredTool[] = [
      { name: "ping", description: "ping tool" },
    ];
    const probe = createDirectToolProbe(
      depsWithStub(state, () =>
        createStubClient({ transport: "stdio", state, tools }),
      ),
    );

    const result = await probe({
      serverKey: "srv1",
      server: stdioServer(),
    });

    expect(result.state).toBe("ready");
    expect(result.tools).toEqual(tools);
    expect(result.diagnostics).toEqual([]);
    expect(state.connectCalls).toBe(1);
    expect(state.listToolsCalls).toBe(1);
    expect(state.closeCalls).toBe(1);
    expect(state.lastTransport).toBe("stdio");
  });

  it("probes streamable-http servers", async () => {
    const state: StubState = {
      connectCalls: 0,
      listToolsCalls: 0,
      closeCalls: 0,
      lastTransport: "unknown",
    };
    const probe = createDirectToolProbe(
      depsWithStub(state, () =>
        createStubClient({
          transport: "streamable-http",
          state,
          tools: [{ name: "http-tool" }],
        }),
      ),
    );

    const result = await probe({
      serverKey: "srv",
      server: httpServer(),
    });

    expect(result.state).toBe("ready");
    expect(result.tools.map((t) => t.name)).toEqual(["http-tool"]);
    expect(state.lastTransport).toBe("streamable-http");
    expect(state.closeCalls).toBe(1);
  });

  it("probes sse servers", async () => {
    const state: StubState = {
      connectCalls: 0,
      listToolsCalls: 0,
      closeCalls: 0,
      lastTransport: "unknown",
    };
    const probe = createDirectToolProbe(
      depsWithStub(state, () =>
        createStubClient({
          transport: "sse",
          state,
          tools: [{ name: "sse-tool" }],
        }),
      ),
    );

    const result = await probe({
      serverKey: "srv",
      server: sseServer(),
    });

    expect(result.state).toBe("ready");
    expect(result.tools.map((t) => t.name)).toEqual(["sse-tool"]);
    expect(state.lastTransport).toBe("sse");
    expect(state.closeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Timeouts — startup and tool listing
// ---------------------------------------------------------------------------

describe("createDirectToolProbe timeouts", () => {
  it("returns an error state when startup exceeds timeout and still closes the client", async () => {
    vi.useFakeTimers();
    try {
      const state: StubState = {
        connectCalls: 0,
        listToolsCalls: 0,
        closeCalls: 0,
        lastTransport: "unknown",
      };
      let resolveConnect: (() => void) | undefined;
      const probe = createDirectToolProbe(
        depsWithStub(state, () =>
          createStubClient({
            transport: "stdio",
            state,
            connect: () =>
              new Promise<void>((resolve) => {
                resolveConnect = resolve;
              }),
            tools: [{ name: "never" }],
          }),
        ),
      );

      const pending = probe({
        serverKey: "srv",
        server: stdioServer(),
      });

      await vi.advanceTimersByTimeAsync(250);
      const result = await pending;

      expect(result.state).toBe("error");
      expect(result.tools).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.severity).toBe("error");
      expect(result.diagnostics[0]?.code).toBe("mcp.probe.startup_timeout");
      expect(state.closeCalls).toBe(1);
      expect(state.listToolsCalls).toBe(0);

      // Resolve dangling promise so vitest doesn't leak timers
      resolveConnect?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an error state when listTools exceeds timeout and still closes the client", async () => {
    vi.useFakeTimers();
    try {
      const state: StubState = {
        connectCalls: 0,
        listToolsCalls: 0,
        closeCalls: 0,
        lastTransport: "unknown",
      };
      const probe = createDirectToolProbe(
        depsWithStub(state, () =>
          createStubClient({
            transport: "stdio",
            state,
            listTools: () => new Promise<McpDiscoveredTool[]>(() => {}),
          }),
        ),
      );

      const pending = probe({
        serverKey: "srv",
        server: stdioServer(),
      });

      await vi.advanceTimersByTimeAsync(250);
      const result = await pending;

      expect(result.state).toBe("error");
      expect(result.diagnostics[0]?.code).toBe("mcp.probe.list_tools_timeout");
      expect(state.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Sanitized diagnostics — never leak raw error text or stderr
// ---------------------------------------------------------------------------

describe("createDirectToolProbe diagnostics", () => {
  it("sanitizes raw exception messages before surfacing as diagnostics", async () => {
    const state: StubState = {
      connectCalls: 0,
      listToolsCalls: 0,
      closeCalls: 0,
      lastTransport: "unknown",
    };
    const probe = createDirectToolProbe(
      depsWithStub(state, () =>
        createStubClient({
          transport: "stdio",
          state,
          listTools: () =>
            Promise.reject(
              new Error(
                "raw leak: ENV secret=shh path=/tmp/socket line 37 foo.ts: fullStack",
              ),
            ),
        }),
      ),
    );

    const result = await probe({
      serverKey: "srv",
      server: stdioServer(),
    });

    expect(result.state).toBe("error");
    expect(result.diagnostics).toHaveLength(1);
    const diag = result.diagnostics[0];
    expect(diag?.code).toBe("mcp.probe.list_tools_failed");
    expect(diag?.severity).toBe("error");
    // Must not contain raw error text
    expect(diag?.message).not.toContain("raw leak");
    expect(diag?.message).not.toContain("secret=shh");
    expect(diag?.message).not.toContain("/tmp/socket");
    expect(state.closeCalls).toBe(1);
  });

  it("sanitizes connection failure messages", async () => {
    const state: StubState = {
      connectCalls: 0,
      listToolsCalls: 0,
      closeCalls: 0,
      lastTransport: "unknown",
    };
    const probe = createDirectToolProbe(
      depsWithStub(state, () =>
        createStubClient({
          transport: "stdio",
          state,
          connect: () =>
            Promise.reject(
              new Error("ENOENT /usr/bin/does-not-exist stderr: password=abc"),
            ),
        }),
      ),
    );

    const result = await probe({
      serverKey: "srv",
      server: stdioServer(),
    });

    expect(result.state).toBe("error");
    expect(result.diagnostics[0]?.code).toBe("mcp.probe.connect_failed");
    expect(result.diagnostics[0]?.message).not.toContain("password=abc");
    expect(result.diagnostics[0]?.message).not.toContain("ENOENT");
    // close still called on connect failure
    expect(state.closeCalls).toBe(1);
  });

  it("always calls close even when listTools throws synchronously", async () => {
    const state: StubState = {
      connectCalls: 0,
      listToolsCalls: 0,
      closeCalls: 0,
      lastTransport: "unknown",
    };
    const probe = createDirectToolProbe(
      depsWithStub(state, () =>
        createStubClient({
          transport: "stdio",
          state,
          listTools: () => {
            throw new Error("boom");
          },
        }),
      ),
    );

    const result = await probe({
      serverKey: "srv",
      server: stdioServer(),
    });

    expect(result.state).toBe("error");
    expect(state.closeCalls).toBe(1);
  });

  it("swallows errors during close so they do not override the primary result", async () => {
    const state: StubState = {
      connectCalls: 0,
      listToolsCalls: 0,
      closeCalls: 0,
      lastTransport: "unknown",
    };
    const probe = createDirectToolProbe(
      depsWithStub(state, () =>
        createStubClient({
          transport: "stdio",
          state,
          tools: [{ name: "ok" }],
          close: () => Promise.reject(new Error("close boom")),
        }),
      ),
    );

    const result = await probe({
      serverKey: "srv",
      server: stdioServer(),
    });

    expect(result.state).toBe("ready");
    expect(result.tools.map((t) => t.name)).toEqual(["ok"]);
    expect(state.closeCalls).toBe(1);
  });
});
