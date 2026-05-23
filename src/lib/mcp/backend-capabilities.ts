/**
 * MCP backend capability registry.
 *
 * Publishes typed capability metadata for every supported agent backend so that
 * UI compatibility labels and runtime emission decisions can branch on
 * capability — not on backend identity. Adding a new backend requires only a
 * new entry in this registry plus a translator at the emission boundary.
 *
 * Capabilities covered:
 * - `strictAuthoritativeConfig`: whether CC's resolved list is the entire MCP
 *   set the backend uses (bypassing filesystem sources).
 * - `serverDisable`: how a disabled server is communicated to the backend
 *   (drop from emission, emit a native disabled flag, or unsupported).
 * - `betweenTurnApply`: whether config changes can be applied to a live idle
 *   runtime or must wait for the next turn.
 * - `toolFiltering`: per-transport mechanism for allow/deny filters on tools.
 * - `toolDiscovery`: preferred mechanism for listing a server's tool inventory
 *   and whether a direct probe is available as a fallback.
 */

import { createLogger } from "@/lib/logging";
import type { McpServerDefinition } from "@/lib/mcp/types";
import type {
  AgentBackendId,
  McpServerCompatibilityView,
  McpTransport,
} from "@/lib/schemas";

const logger = createLogger("mcp.backend-capabilities");

// ---------------------------------------------------------------------------
// Capability shape
// ---------------------------------------------------------------------------

type McpServerDisableMechanism = "native" | "omit" | "unsupported";

type McpBetweenTurnApplyMode = "live-when-idle" | "next-turn" | "unsupported";

export type McpToolFilteringMode =
  | "native"
  | "permission-layer"
  | "unsupported";

interface McpToolFilteringCapability {
  /** Aggregated mode across all transports. `mixed` indicates that different
   * transports use different mechanisms and the UI should lean on `byTransport`
   * for accurate rendering. */
  mode: McpToolFilteringMode | "mixed";
  byTransport: Record<McpTransport, McpToolFilteringMode>;
}

type McpToolDiscoveryMode = "runtime-status" | "probe" | "unsupported";

interface McpToolDiscoveryCapability {
  preferred: McpToolDiscoveryMode;
  /** When `preferred` is not `probe`, whether a direct MCP SDK probe is
   * available as a secondary path (e.g. for inactive runtimes or manual
   * refresh). */
  probeFallback: boolean;
}

export interface McpBackendCapabilities {
  backend: AgentBackendId;
  strictAuthoritativeConfig: boolean;
  serverDisable: McpServerDisableMechanism;
  betweenTurnApply: McpBetweenTurnApplyMode;
  toolFiltering: McpToolFilteringCapability;
  toolDiscovery: McpToolDiscoveryCapability;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface McpCapabilityRegistry {
  getCapabilities(backend: AgentBackendId): McpBackendCapabilities;
  listBackends(): readonly AgentBackendId[];
}

export function createMcpCapabilityRegistry(
  entries: readonly McpBackendCapabilities[],
): McpCapabilityRegistry {
  const byBackend = new Map<AgentBackendId, McpBackendCapabilities>();
  for (const entry of entries) {
    byBackend.set(entry.backend, entry);
  }
  const ordered = entries.map((e) => e.backend);

  return {
    getCapabilities(backend) {
      const capabilities = byBackend.get(backend);
      if (!capabilities) {
        throw new Error(
          `No MCP capabilities registered for backend: ${backend}`,
        );
      }
      return capabilities;
    },
    listBackends() {
      return ordered;
    },
  };
}

// ---------------------------------------------------------------------------
// Default entries — Claude and Codex
// ---------------------------------------------------------------------------

export const claudeMcpCapabilities: McpBackendCapabilities = {
  backend: "claude",
  strictAuthoritativeConfig: true,
  serverDisable: "omit",
  betweenTurnApply: "live-when-idle",
  toolFiltering: {
    mode: "mixed",
    byTransport: {
      stdio: "permission-layer",
      "streamable-http": "native",
      sse: "native",
    },
  },
  toolDiscovery: {
    preferred: "runtime-status",
    probeFallback: true,
  },
};

export const codexMcpCapabilities: McpBackendCapabilities = {
  backend: "codex",
  strictAuthoritativeConfig: true,
  serverDisable: "native",
  betweenTurnApply: "next-turn",
  toolFiltering: {
    mode: "native",
    byTransport: {
      stdio: "native",
      "streamable-http": "native",
      sse: "unsupported",
    },
  },
  toolDiscovery: {
    preferred: "probe",
    probeFallback: true,
  },
};

export const defaultMcpCapabilityRegistry: McpCapabilityRegistry =
  createMcpCapabilityRegistry([claudeMcpCapabilities, codexMcpCapabilities]);

// ---------------------------------------------------------------------------
// Compatibility lookup — consumed by the resolver
// ---------------------------------------------------------------------------

/**
 * Build a compatibility lookup keyed off the registry. The returned function
 * is shape-compatible with the resolver's `compatibilityLookup` seam so the
 * resolver remains free of any backend-identity branching.
 */
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

function serverCompatibilityForBackend(
  definition: McpServerDefinition,
  capabilities: McpBackendCapabilities,
): { supported: boolean; reason?: string } {
  const transport = definition.transport;
  const filteringForTransport =
    capabilities.toolFiltering.byTransport[transport];

  if (filteringForTransport === "unsupported") {
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

  return { supported: true };
}
