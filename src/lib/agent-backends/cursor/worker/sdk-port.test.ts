import { describe, expect, it } from "vitest";

import {
  toCursorModelSelection,
  wrapCursorSdkAgent,
  resumeWithAbandonedRunRecovery,
} from "./sdk-port";

describe("toCursorModelSelection", () => {
  it("translates the complete parameter record in stable key order", () => {
    expect(
      toCursorModelSelection({
        modelId: "claude-opus-5",
        parameters: {
          context: "1m",
          cyber: "false",
          effort: "high",
          fast: "false",
          thinking: "true",
        },
      }),
    ).toEqual({
      id: "claude-opus-5",
      params: [
        { id: "context", value: "1m" },
        { id: "cyber", value: "false" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
        { id: "thinking", value: "true" },
      ],
    });
  });

  it("keeps an explicit empty parameter array for parameterless models", () => {
    expect(
      toCursorModelSelection({ modelId: "default", parameters: {} }),
    ).toEqual({ id: "default", params: [] });
  });
});

describe("abandoned local run recovery", () => {
  it("clears a persisted active run even when resume itself succeeds", async () => {
    let active = true;
    const result = await resumeWithAbandonedRunRecovery(
      {
        resume: async () => ({ canSend: !active }),
        listRuns: async () => ({
          items: [{ id: "abandoned", status: "running" as const }],
        }),
        cancelRun: async () => {
          active = false;
        },
      },
      true,
    );
    expect(result.canSend).toBe(true);
  });
  it.each([false, true])(
    "recovers a busy agent only with worker ownership (%s)",
    async (allowed) => {
      const busy = new Error("active run");
      let active = true;
      const cancelled: string[] = [];
      const result = resumeWithAbandonedRunRecovery(
        {
          resume: async () => {
            if (active) throw busy;
            return "same-agent";
          },
          listRuns: async (cursor) =>
            cursor === undefined
              ? {
                  items: [{ id: "finished", status: "finished" as const }],
                  nextCursor: "next",
                }
              : { items: [{ id: "abandoned", status: "running" as const }] },
          cancelRun: async (id) => {
            cancelled.push(id);
            if (id === "abandoned") active = false;
          },
        },
        allowed,
      );
      if (!allowed) {
        await expect(result).rejects.toBe(busy);
        expect(active).toBe(true);
        expect(cancelled).toEqual([]);
        return;
      }
      await expect(result).resolves.toBe("same-agent");
      expect(cancelled).toEqual(["abandoned"]);
    },
  );

  it("propagates a resume failure after one cancellation", async () => {
    const busy = new Error("active run");
    let attempts = 0;
    await expect(
      resumeWithAbandonedRunRecovery(
        {
          resume: async () => {
            attempts++;
            throw busy;
          },
          listRuns: async () => ({
            items: [{ id: "abandoned", status: "running" as const }],
          }),
          cancelRun: async () => {},
        },
        true,
      ),
    ).rejects.toBe(busy);
    expect(attempts).toBe(1);
  });
});

describe("SDK port MCP replacement lifecycle", () => {
  it("replaces authenticated endpoints and removes them on an explicit empty send", async () => {
    const { startMcpRemoteFixture } =
      await import("../testing/mcp-remote-fixture");
    const { openCursorMcpBridge } = await import("./mcp-bridge");
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const upstream = await startMcpRemoteFixture("http", { auth: true });
    const config = {
      fixture: {
        type: "http" as const,
        url: upstream.url,
        headers: { Authorization: "Bearer fixture-secret" },
      },
    };
    const bridge = await openCursorMcpBridge(config);
    const inventories: string[][] = [];
    const received = new Error("dispatch inspected");
    let disposed = false;
    const wrapped = wrapCursorSdkAgent(
      {
        agentId: "fixture-agent",
        async send(_message, options) {
          const servers = options?.mcpServers ?? {};
          const endpoint = servers.fixture;
          if (!endpoint || !("url" in endpoint)) {
            inventories.push([]);
            throw received;
          }
          const client = new Client({ name: "sdk-consumer", version: "1" });
          try {
            await client.connect(
              new StreamableHTTPClientTransport(new URL(endpoint.url), {
                requestInit: { headers: endpoint.headers },
              }),
            );
            inventories.push(
              (await client.listTools()).tools.map((tool) => tool.name),
            );
            await client.callTool({ name: "allowed" });
          } finally {
            await client.close();
          }
          throw received;
        },
        async [Symbol.asyncDispose]() {
          disposed = true;
        },
      },
      bridge,
      { mcpServers: config },
    );
    const send = (
      mcpServers: import("./entry").CursorWorkerSendOptions["mcpServers"],
    ) =>
      wrapped.send(
        { text: "fixture", images: [] },
        {
          modelSelection: { modelId: "default", parameters: {} },
          mcpServers,
          forceExpirePersistedRun: false,
        },
      );
    try {
      await expect(send(config)).rejects.toBe(received);
      await expect(
        send({ fixture: { ...config.fixture, enabledTools: ["allowed"] } }),
      ).rejects.toBe(received);
      await expect(send({})).rejects.toBe(received);
      expect(inventories).toEqual([
        ["allowed", "denied", "slow"],
        ["allowed"],
        [],
      ]);
      expect(upstream.calls).toEqual(["allowed", "allowed"]);
      const endpoint = bridge.servers.fixture;
      if (!endpoint || !("url" in endpoint))
        throw new Error("missing initial endpoint");
      await expect(
        fetch(endpoint.url, { headers: endpoint.headers }),
      ).rejects.toThrow();
    } finally {
      await wrapped.dispose();
      await upstream.close();
    }
    expect(disposed).toBe(true);
  });
});

it("forwards public nested task deltas without duplicating parent content", async () => {
  const nested = {
    type: "tool-call-delta" as const,
    callId: "task-1",
    modelCallId: "model-1",
    taskUpdate: { type: "text-delta" as const, text: "child progress" },
  };
  const received: unknown[] = [];
  const done = new Error("dispatch inspected");
  const wrapped = wrapCursorSdkAgent(
    {
      agentId: "fixture-agent",
      async send(_message, options) {
        await options?.onDelta?.({
          update: { type: "text-delta", text: "parent" },
        });
        await options?.onDelta?.({ update: nested });
        throw done;
      },
      async [Symbol.asyncDispose]() {},
    },
    { servers: {}, async close() {} },
    { mcpServers: {} },
  );
  await expect(
    wrapped.send(
      { text: "run", images: [] },
      {
        modelSelection: { modelId: "default", parameters: {} },
        mcpServers: {},
        forceExpirePersistedRun: false,
        onTaskUpdate: (update) => received.push(update),
      },
    ),
  ).rejects.toBe(done);
  expect(received).toEqual([nested]);
  await wrapped.dispose();
});
