import { createServer } from "node:http";
import { once } from "node:events";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export async function startMcpRemoteFixture(
  type: "http" | "sse",
  options: { auth?: boolean; hang?: boolean; toolError?: boolean } = {},
) {
  const calls: string[] = [];
  const activity = { requests: 0 };
  const sessions = new Map<string, SSEServerTransport>();
  function mcp() {
    const server = new Server(
      { name: "upstream", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ["allowed", "denied", "slow"].map((name) => ({
        name,
        inputSchema: { type: "object" as const },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      calls.push(request.params.name);
      if (options.toolError)
        return {
          isError: true,
          content: [{ type: "text", text: "401 fixture-secret" }],
        };
      if (request.params.name === "slow")
        await new Promise<void>((resolve) =>
          extra.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      return {
        content: [{ type: "text", text: `executed:${request.params.name}` }],
      };
    });
    return server;
  }
  const http = createServer(async (req, res) => {
    activity.requests++;
    if (options.hang) return;
    if (options.auth && req.headers.authorization !== "Bearer fixture-secret") {
      res.writeHead(401).end("fixture-secret must never escape");
      return;
    }
    if (type === "http") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = mcp();
      res.on("close", () => {
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    if (req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);
      await mcp().connect(transport);
      return;
    }
    const session = sessions.get(
      new URL(req.url ?? "/", "http://localhost").searchParams.get(
        "sessionId",
      ) ?? "",
    );
    if (!session) {
      res.writeHead(404).end();
      return;
    }
    await session.handlePostMessage(req, res);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  async function close() {
    for (const session of sessions.values()) await session.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("missing fixture port");
  return {
    type,
    close,
    activity,
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
  };
}
