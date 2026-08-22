import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * A deterministic inline stdio MCP server, run as a real child process by the
 * Cursor inline-MCP tests (spec D18).
 *
 * It advertises exactly one tool whose result is a pure function of its
 * argument and of the marker Command Center put in this process's environment.
 * That makes the reply evidence of the whole path rather than of the call
 * alone: a reply carrying the marker proves the translated entry's `env`
 * reached the spawned server, and a reply carrying the argument proves the
 * negotiated session actually round-tripped a call.
 *
 * Nothing here reads or writes Cursor configuration — the server learns
 * everything it needs from the argv and env of the entry that launched it.
 */

export const CURSOR_MCP_FIXTURE_TOOL = "fixture_echo";
export const CURSOR_MCP_FIXTURE_MARKER_VAR = "CURSOR_MCP_FIXTURE_MARKER";

/** The reply the tool produces, stated once so tests assert the same rule. */
export function cursorMcpFixtureReply(marker: string, value: string): string {
  return `fixture:${marker}:${value}`;
}

async function main(): Promise<void> {
  const marker = process.env[CURSOR_MCP_FIXTURE_MARKER_VAR] ?? "unset";
  const server = new McpServer({
    name: "cursor-inline-fixture",
    version: "1.0.0",
  });

  server.registerTool(
    CURSOR_MCP_FIXTURE_TOOL,
    {
      description: "Echo the supplied value back with this server's marker.",
      inputSchema: { value: z.string() },
    },
    async ({ value }) => ({
      content: [
        { type: "text" as const, text: cursorMcpFixtureReply(marker, value) },
      ],
    }),
  );

  await server.connect(new StdioServerTransport());
}

// Only when executed as a process: the tests also import the contract above.
const invokedAs =
  process.argv[1] !== undefined ? path.resolve(process.argv[1]) : null;
if (invokedAs === fileURLToPath(import.meta.url)) {
  void main();
}
