import type { McpBackendCapabilities } from "../mcp-capabilities";

export const cursorMcpCapabilities: McpBackendCapabilities = {
  backend: "cursor",
  strictAuthoritativeConfig: false,
  serverDisable: "omit",
  betweenTurnApply: "next-turn",
  transports: { stdio: true, "streamable-http": true, sse: true },
  toolFiltering: {
    mode: "bridge",
    byTransport: {
      stdio: "bridge",
      "streamable-http": "bridge",
      sse: "bridge",
    },
  },
  notes: [
    "Provider administrative settings may limit access. Plugin MCP components are not imported; add a server to MCP configuration to use it here.",
  ],
  toolDiscovery: {
    preferred: "probe",
    probeFallback: true,
  },
};
