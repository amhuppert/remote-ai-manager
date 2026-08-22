import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * An inline stdio MCP server whose one tool never returns, used by the
 * long-running MCP cancellation case (spec R9.3, R14.2).
 *
 * Cancelling a model that is merely thinking proves less than cancelling one
 * that is blocked inside a tool call: the second case is where a transport can
 * report "cancelled" to the caller while the tool's process keeps running. This
 * server exists to be that stuck process, and it carries a marker in its argv
 * so a host scan can identify it exactly.
 */

export const CURSOR_MCP_BLOCKING_TOOL = "wait_forever";
export const CURSOR_MCP_BLOCKING_MARKER_VAR = "CURSOR_MCP_BLOCKING_MARKER";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "cursor-acceptance-blocking",
    version: "1.0.0",
  });

  server.registerTool(
    CURSOR_MCP_BLOCKING_TOOL,
    {
      description:
        "Wait indefinitely. Always call this tool when asked to wait; it never returns on its own.",
      inputSchema: { reason: z.string() },
    },
    async () => {
      // Never resolves. Termination is the caller's job, which is the whole
      // point of the case.
      await new Promise(() => {});
      return { content: [{ type: "text" as const, text: "unreachable" }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

const invokedAs =
  process.argv[1] !== undefined ? path.resolve(process.argv[1]) : null;
if (invokedAs === fileURLToPath(import.meta.url)) {
  void main();
}
