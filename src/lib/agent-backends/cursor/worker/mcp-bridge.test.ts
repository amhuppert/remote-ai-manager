import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpRemoteFixture } from "../testing/mcp-remote-fixture";
import { openCursorMcpBridge, type CursorMcpBridge } from "./mcp-bridge";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  type: "http" | "sse",
  options: { auth?: boolean; hang?: boolean; toolError?: boolean } = {},
) {
  const server = await startMcpRemoteFixture(type, options);
  cleanup.push(server.close);
  return server;
}

async function connect(bridge: CursorMcpBridge) {
  cleanup.push(() => bridge.close());
  const config = bridge.servers.fixture;
  expect(config, "bridge must expose the admitted server").toBeDefined();
  if (!config || !("url" in config)) throw new Error("missing bridge endpoint");
  const client = new Client({ name: "bridge-verifier", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    }),
  );
  cleanup.push(() => client.close());
  return client;
}

describe("Cursor MCP enforcing bridge", () => {
  it.each(["http", "sse"] as const)(
    "connects authenticated %s, filters inventory and rejects direct denied calls",
    async (type) => {
      const upstream = await fixture(type, { auth: true });
      const client = await connect(
        await openCursorMcpBridge({
          fixture: {
            type,
            url: upstream.url,
            headers: { Authorization: "Bearer fixture-secret" },
            enabledTools: ["allowed", "denied"],
            disabledTools: ["denied"],
          },
        }),
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["allowed"],
      );
      expect(await client.callTool({ name: "allowed" })).toMatchObject({
        content: [{ text: "executed:allowed" }],
      });
      await expect(client.callTool({ name: "denied" })).rejects.toThrow(
        /not allowed/,
      );
      expect(upstream.calls).toEqual(["allowed"]);
    },
  );
  it("returns an actionable authentication failure without upstream response or credentials", async () => {
    const upstream = await fixture("http", { auth: true });
    const error = await openCursorMcpBridge({
      fixture: { type: "http", url: upstream.url },
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/authentication.*headers/i);
    expect(String(error)).not.toContain("fixture-secret");
  });
  it("sanitizes protocol tool errors that include credentials", async () => {
    const upstream = await fixture("http", { toolError: true });
    const client = await connect(
      await openCursorMcpBridge({
        fixture: { type: "http", url: upstream.url },
      }),
    );
    const result = await client.callTool({ name: "allowed" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/tool call failed.*server/i);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
  it("reports a disconnected server without leaking its headers", async () => {
    const upstream = await fixture("http");
    const client = await connect(
      await openCursorMcpBridge({
        fixture: {
          type: "http",
          url: upstream.url,
          headers: { Authorization: "Bearer fixture-secret" },
        },
      }),
    );
    await upstream.close();
    await expect(client.callTool({ name: "allowed" })).rejects.toThrow(
      /disconnected.*availability/i,
    );
  });
  it("enforces startup deadlines against a server that never initializes", async () => {
    const upstream = await fixture("http", { hang: true });
    await expect(
      openCursorMcpBridge({
        fixture: { type: "http", url: upstream.url, startupTimeoutSec: 0.05 },
      }),
    ).rejects.toThrow(/startup.*timed out/i);
  });
  it("enforces tool deadlines after discovery", async () => {
    const upstream = await fixture("http");
    const client = await connect(
      await openCursorMcpBridge({
        fixture: { type: "http", url: upstream.url, toolTimeoutSec: 0.05 },
      }),
    );
    await expect(client.callTool({ name: "slow" })).rejects.toThrow(
      /tool.*timed out/i,
    );
  });
  it("connects stdio with explicit environment and without arbitrary ambient variables", async () => {
    const script = `const readline = require("node:readline");
      readline.createInterface({input:process.stdin}).on("line", line => {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        let result = {};
        if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stdio-fixture", version: "1" } };
        if (msg.method === "tools/list") result = { tools: [{ name: "environment", inputSchema: { type: "object" } }] };
        if (msg.method === "tools/call") result = { content: [{type:"text", text: JSON.stringify({marker:process.env.CC_MCP_MARKER, ambient:process.env.CC_MCP_AMBIENT ?? null})}] };
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result})+"\\n");
      });`;
    const previous = process.env.CC_MCP_AMBIENT;
    process.env.CC_MCP_AMBIENT = "must-not-be-inherited";
    try {
      const client = await connect(
        await openCursorMcpBridge({
          fixture: {
            command: process.execPath,
            args: ["-e", script],
            env: { CC_MCP_MARKER: "chosen" },
          },
        }),
      );
      expect(await client.callTool({ name: "environment" })).toMatchObject({
        content: [
          { text: JSON.stringify({ marker: "chosen", ambient: null }) },
        ],
      });
    } finally {
      if (previous === undefined) delete process.env.CC_MCP_AMBIENT;
      else process.env.CC_MCP_AMBIENT = previous;
    }
  });
  it("refuses unsupported controls before opening a server", async () => {
    const config = {
      type: "http" as const,
      url: "http://127.0.0.1:1/mcp",
      auth: { CLIENT_ID: "unsupported" },
    };
    await expect(openCursorMcpBridge({ fixture: config })).rejects.toThrow(
      /unsupported.*control/,
    );
  });
  it("emits an empty map when there are no servers", async () => {
    const bridge = await openCursorMcpBridge({});
    expect(bridge.servers).toEqual({});
    await bridge.close();
  });
});
