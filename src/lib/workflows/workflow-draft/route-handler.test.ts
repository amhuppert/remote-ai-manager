import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getMcpGatewayBearerToken } from "./auth";

interface RouteHandlers {
  GET: (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
  POST: (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
  DELETE: (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
}

async function startServer(
  handlers: RouteHandlers,
  params: Record<string, string> = {},
) {
  const server = http.createServer(async (req, res) => {
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) {
      bodyChunks.push(Buffer.from(chunk));
    }

    const method = req.method ?? "GET";
    const handler =
      method === "GET"
        ? handlers.GET
        : method === "POST"
          ? handlers.POST
          : method === "DELETE"
            ? handlers.DELETE
            : null;

    if (!handler) {
      res.statusCode = 405;
      res.end();
      return;
    }

    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const request = new Request(requestUrl, {
      method,
      headers: req.headers as HeadersInit,
      body: bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined,
    });
    const response = await handler(request, {
      params: Promise.resolve(params),
    });

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const body = await response.arrayBuffer();
    res.end(Buffer.from(body));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

describe("workflow-draft/route-handler", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("returns 401 when authorization is missing", async () => {
    const { createMcpRouteHandlers } = await import("./route-handler");

    const handlers = createMcpRouteHandlers(async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      return server;
    });

    const response = await handlers.POST(
      new Request("http://localhost/api/projects/p/sessions/s/mcp", {
        method: "POST",
        body: "{}",
      }),
      { params: Promise.resolve({ name: "p", session: "s" }) },
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 when authorization is invalid", async () => {
    const { createMcpRouteHandlers } = await import("./route-handler");

    const handlers = createMcpRouteHandlers(async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      return server;
    });

    const response = await handlers.POST(
      new Request("http://localhost/api/projects/p/sessions/s/mcp", {
        method: "POST",
        body: "{}",
        headers: {
          Authorization: "Bearer wrong-token",
        },
      }),
      { params: Promise.resolve({ name: "p", session: "s" }) },
    );

    expect(response.status).toBe(401);
  });

  it("passes through to a real MCP server over streamable HTTP", async () => {
    const { createMcpRouteHandlers } = await import("./route-handler");

    const handlers = createMcpRouteHandlers(async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      server.registerTool(
        "greet",
        {
          description: "Greets the caller",
          inputSchema: {
            name: z.string(),
          },
        },
        async ({ name }) => ({
          content: [{ type: "text", text: `Hello, ${name}!` }],
        }),
      );
      return server;
    });

    const testServer = await startServer(handlers, {
      name: "project",
      session: "session",
    });
    cleanups.push(() => testServer.close());

    const transport = new StreamableHTTPClientTransport(
      new URL(`${testServer.url}/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${getMcpGatewayBearerToken()}`,
          },
        },
      },
    );
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
    cleanups.push(async () => {
      await transport.close();
    });

    const tools = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema,
    );
    expect(tools.tools.map((tool) => tool.name)).toContain("greet");

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "greet",
          arguments: { name: "Alex" },
        },
      },
      CallToolResultSchema,
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Hello, Alex!",
      },
    ]);
  });

  it("returns the route error status for known MCP route failures", async () => {
    const { McpRouteError, createMcpRouteHandlers } =
      await import("./route-handler");

    const handlers = createMcpRouteHandlers(async () => {
      throw new McpRouteError(404, "Session not found");
    });

    const response = await handlers.POST(
      new Request("http://localhost/api/projects/p/sessions/missing/mcp", {
        method: "POST",
        body: "{}",
        headers: {
          Authorization: `Bearer ${getMcpGatewayBearerToken()}`,
        },
      }),
      { params: Promise.resolve({ name: "p", session: "missing" }) },
    );

    expect(response.status).toBe(404);
  });
});
