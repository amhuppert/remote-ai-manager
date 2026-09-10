/**
 * Production MCP SDK client factory used by the direct tool probe.
 *
 * Maps canonical server configs to the appropriate transport, opens a short
 * lived MCP Client, and exposes it through the `DirectToolProbeClient`
 * interface expected by `createDirectToolProbe`. Tests supply their own
 * factory to isolate failure scenarios.
 */
import { resolveMcpHeaders } from "./remote-headers";
import { createLogger } from "@/lib/logging";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { McpDiscoveredTool } from "@/lib/mcp/schemas";
import type {
  DirectToolProbeClient,
  DirectToolProbeClientFactoryInput,
} from "./tool-discovery-probe";

const logger = createLogger("mcp.tool-discovery");

const CLIENT_INFO = {
  name: "command-center-mcp-probe",
  version: "1.0.0",
};

export async function createProductionMcpProbeClient(
  input: DirectToolProbeClientFactoryInput,
): Promise<DirectToolProbeClient> {
  const transport = createTransportFor(input);
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  return {
    async connect(options) {
      await client.connect(transport, {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    },
    async listTools(options) {
      const response = await client.listTools(undefined, {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      return response.tools.map<McpDiscoveredTool>((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined
          ? { description: tool.description }
          : {}),
        inputSchema: tool.inputSchema,
      }));
    },
    async close() {
      try {
        await client.close();
      } finally {
        try {
          await transport.close();
        } catch {
          // Transport close failures are absorbed; the probe has already
          // surfaced any primary error through its own diagnostic.
        }
      }
    },
  };
}

function createTransportFor(
  input: DirectToolProbeClientFactoryInput,
): Transport {
  const { server } = input;
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      ...(server.args !== undefined ? { args: [...server.args] } : {}),
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      ...(server.env !== undefined ? { env: { ...server.env } } : {}),
      stderr: "pipe",
    });
  }
  if (server.transport === "streamable-http") {
    const requestInit = buildRequestInit(
      server.headers,
      server.bearerTokenEnvVar,
    );
    return new StreamableHTTPClientTransport(new URL(server.url), {
      ...(requestInit !== undefined ? { requestInit } : {}),
    });
  }
  const requestInit = buildRequestInit(
    server.headers,
    server.bearerTokenEnvVar,
  );
  return new SSEClientTransport(new URL(server.url), {
    ...(requestInit !== undefined ? { requestInit } : {}),
  });
}

function buildRequestInit(
  headers?: Readonly<Record<string, string>>,
  bearerTokenEnvVar?: string,
): RequestInit | undefined {
  const resolved = resolveMcpHeaders(headers, bearerTokenEnvVar);
  if (resolved.missingBearer !== undefined) {
    logger.warn("probe.bearer_missing", { variable: resolved.missingBearer });
    throw new Error("MCP bearer environment variable is missing");
  }
  return Object.keys(resolved.headers).length
    ? { headers: resolved.headers }
    : undefined;
}
