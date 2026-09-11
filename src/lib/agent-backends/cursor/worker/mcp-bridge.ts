import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { McpServerConfig } from "@cursor/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createLogger } from "@/lib/logging";
import { cursorWorkerMcpServerSchema, type CursorWorkerMcpServer } from "./ipc";

const logger = createLogger("cursor-mcp-bridge");

export interface CursorMcpBridge {
  servers: Record<string, McpServerConfig>;
  close(): Promise<void>;
}

function transportFor(config: CursorWorkerMcpServer): Transport {
  if ("command" in config) {
    // The MCP SDK supplies its OS baseline (HOME/PATH/etc.); explicit values
    // override it. Arbitrary worker variables and credentials are not inherited.
    return new StdioClientTransport({ ...config, stderr: "ignore" });
  }
  const requestInit = { headers: config.headers };
  if (config.type === "http")
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit,
    });
  return new SSEClientTransport(new URL(config.url), { requestInit });
}

function allowed(config: CursorWorkerMcpServer, name: string): boolean {
  if (config.disabledTools?.includes(name)) return false;
  return !config.enabledTools?.length || config.enabledTools.includes(name);
}

function safeFailure(id: string, phase: string, error: unknown): Error {
  const status =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const timedOut =
    error instanceof Error &&
    (error.name === "TimeoutError" || status === ErrorCode.RequestTimeout);
  const auth =
    status === 401 ||
    status === 403 ||
    (error instanceof Error &&
      /(?:\b401\b|\b403\b|unauthorized)/i.test(error.message));
  const reason = timedOut
    ? `${phase} timed out; check the configured timeout`
    : auth
      ? "authentication failed; check the configured headers or bearer credential"
      : `${phase} failed or disconnected; check server availability and configuration`;
  logger.warn("mcp.bridge.failed", {
    serverId: id,
    phase,
    reason: timedOut ? "timeout" : auth ? "auth" : "connection",
  });
  return new Error(`MCP server ${id}: ${reason}`);
}

async function deadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("MCP deadline", "TimeoutError");
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

interface Upstream {
  id: string;
  config: CursorWorkerMcpServer;
  client: Client;
  tools: Tool[];
}

/** Only admitted tools are advertised; direct calls re-check the same policy. */
export async function openCursorMcpBridge(
  servers: Record<string, CursorWorkerMcpServer>,
): Promise<CursorMcpBridge> {
  const entries = Object.entries(servers).map(([id, config]) => {
    const parsed = cursorWorkerMcpServerSchema.safeParse(config);
    if (!parsed.success)
      throw new Error(
        `MCP server ${id}: unsupported transport or control fields`,
      );
    return { id, config: parsed.data };
  });
  if (!entries.length) return { servers: {}, async close() {} };

  const upstreams: Upstream[] = [];
  const requests = new Set<Server>();
  const secret = randomUUID();
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401).end();
      return;
    }
    const upstream = upstreams.find(
      (_value, index) => req.url === `/mcp/${index}`,
    );
    if (!upstream) {
      res.writeHead(404).end();
      return;
    }
    const downstream = new Server(
      { name: "command-center-mcp", version: "1" },
      { capabilities: { tools: {} } },
    );
    requests.add(downstream);
    downstream.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: upstream.tools,
    }));
    downstream.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const name = request.params.name;
        if (
          !allowed(upstream.config, name) ||
          !upstream.tools.some((tool) => tool.name === name)
        ) {
          logger.info("mcp.bridge.tool_denied", {
            serverId: upstream.id,
            toolName: name,
          });
          throw new McpError(
            ErrorCode.InvalidParams,
            `MCP tool ${name} is not allowed`,
          );
        }
        try {
          const result = await deadline(
            (upstream.config.toolTimeoutSec ?? 60) * 1000,
            (signal) =>
              upstream.client.callTool(request.params, undefined, {
                signal: AbortSignal.any([signal, extra.signal]),
                timeout: (upstream.config.toolTimeoutSec ?? 60) * 1000,
              }),
          );
          if (result.isError) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: safeFailure(upstream.id, "tool call", null).message,
                },
              ],
            };
          }
          logger.debug("mcp.bridge.tool_completed", {
            serverId: upstream.id,
            toolName: name,
          });
          return result;
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            safeFailure(upstream.id, "tool call", error).message,
          );
        }
      },
    );
    res.on("close", () => {
      requests.delete(downstream);
      void downstream.close();
    });
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await downstream.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      logger.warn("mcp.bridge.request_failed", { serverId: upstream.id });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...requests].map((request) => request.close()));
    http.closeAllConnections();
    if (http.listening)
      await new Promise<void>((resolve) => http.close(() => resolve()));
    await Promise.allSettled(
      upstreams.map((upstream) => upstream.client.close()),
    );
    logger.debug("mcp.bridge.closed", { serverCount: upstreams.length });
  }

  try {
    for (const { id, config } of entries) {
      const client = new Client({
        name: "command-center-cursor",
        version: "1",
      });
      const upstream: Upstream = { id, config, client, tools: [] };
      upstreams.push(upstream);
      try {
        await deadline(
          (config.startupTimeoutSec ?? 10) * 1000,
          async (signal) => {
            await client.connect(transportFor(config), {
              signal,
              timeout: (config.startupTimeoutSec ?? 10) * 1000,
            });
            let cursor: string | undefined;
            const seen = new Set<string>();
            do {
              const page = await client.listTools(
                cursor ? { cursor } : undefined,
                { signal, timeout: (config.startupTimeoutSec ?? 10) * 1000 },
              );
              upstream.tools.push(
                ...page.tools.filter((tool) => allowed(config, tool.name)),
              );
              cursor = page.nextCursor;
              if (cursor && seen.has(cursor))
                throw new Error("Repeated inventory cursor");
              if (cursor) seen.add(cursor);
            } while (cursor);
          },
        );
      } catch (error) {
        throw safeFailure(id, "startup", error);
      }
      logger.info("mcp.bridge.ready", {
        serverId: id,
        transport: "command" in config ? "stdio" : config.type,
        toolCount: upstream.tools.length,
      });
    }
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string")
      throw new Error("MCP bridge listener unavailable");
    return {
      servers: Object.fromEntries(
        upstreams.map((upstream, index) => [
          upstream.id,
          {
            type: "http",
            url: `http://127.0.0.1:${address.port}/mcp/${index}`,
            headers: { Authorization: `Bearer ${secret}` },
          },
        ]),
      ),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
