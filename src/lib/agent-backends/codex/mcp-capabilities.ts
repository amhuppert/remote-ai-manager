import type { McpBackendCapabilities } from "../mcp-capabilities";

export const codexMcpCapabilities: McpBackendCapabilities = {
  backend: "codex",
  strictAuthoritativeConfig: true,
  serverDisable: "native",
  betweenTurnApply: "next-turn",
  transports: { stdio: true, "streamable-http": true, sse: false },
  toolFiltering: {
    mode: "native",
    byTransport: {
      stdio: "native",
      "streamable-http": "native",
      sse: "unsupported",
    },
  },
  notes: [
    "Plugin MCP servers are not included in this managed inventory. Add a server to MCP configuration to use it here.",
  ],
  toolDiscovery: {
    preferred: "probe",
    probeFallback: true,
  },
};
