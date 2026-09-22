import type { McpBackendCapabilities } from "../mcp-capabilities";

export const claudeMcpCapabilities: McpBackendCapabilities = {
  backend: "claude",
  strictAuthoritativeConfig: true,
  serverDisable: "omit",
  betweenTurnApply: "next-turn",
  transports: { stdio: true, "streamable-http": true, sse: true },
  toolFiltering: {
    mode: "native",
    byTransport: {
      stdio: "native",
      "streamable-http": "native",
      sse: "native",
    },
  },
  toolControl: {
    configurable: true,
    applyTiming: "next-conversation",
    notes: [
      "Individual tool exclusions apply to new conversations. Tool allowlists cannot be applied completely.",
    ],
  },
  notes: [
    "Per-server startup timeouts are not supported.",
    "Plugin MCP servers are not included in this managed inventory. Add a server to MCP configuration to use it here.",
  ],
  toolDiscovery: {
    preferred: "runtime-status",
    probeFallback: true,
  },
};
