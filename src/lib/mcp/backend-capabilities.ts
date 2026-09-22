import { createLogger } from "@/lib/logging";
import type { McpServerDefinition } from "./types";
import type { McpServerCompatibilityView } from "./schemas";
import type {
  McpBackendCapabilities,
  McpCapabilityRegistry,
} from "@/lib/agent-backends/mcp-capabilities";
export {
  createMcpCapabilityRegistry,
  defaultMcpCapabilityRegistry,
} from "@/lib/agent-backends/mcp-capabilities";
const logger = createLogger("mcp.backend-capabilities");

export function buildCompatibilityLookup(
  registry: McpCapabilityRegistry,
): (definition: McpServerDefinition) => McpServerCompatibilityView {
  const backends = registry.listBackends();
  return function compatibilityLookup(definition) {
    const entries = backends.map((backend) => {
      const capabilities = registry.getCapabilities(backend);
      return {
        backend,
        ...serverCompatibilityForBackend(definition, capabilities),
      };
    });
    return { backends: entries };
  };
}

/**
 * Whether the backend can run this server at all. Reads `transports` — the
 * transport question — and never `toolFiltering`, which answers the different
 * question of how allow/deny lists are enforced. A backend that speaks a
 * transport but filters no tools on it is compatible; the cascade's filtering
 * refusal is the translator's business, not this badge's.
 */
function serverCompatibilityForBackend(
  definition: McpServerDefinition,
  capabilities: McpBackendCapabilities,
): Omit<McpServerCompatibilityView["backends"][number], "backend"> {
  const transport = definition.transport;

  if (!capabilities.transports[transport]) {
    logger.debug("Server transport unsupported by backend", {
      backend: capabilities.backend,
      serverKey: definition.serverKey,
      transport,
    });
    return {
      supported: false,
      reason: `${capabilities.backend} does not support the '${transport}' transport`,
    };
  }

  return {
    supported: true,
    toolControl: capabilities.toolControl,
    notes: capabilities.notes,
  };
}
