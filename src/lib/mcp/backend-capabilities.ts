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
 * - `transports`: which MCP transports the backend can talk at all.
 * - `toolFiltering`: per-transport mechanism for allow/deny filters on tools.
 * - `toolDiscovery`: preferred mechanism for listing a server's tool inventory
 *   and whether a direct probe is available as a fallback.
 */

import { createLogger } from "@/lib/logging";
import type { McpServerDefinition } from "@/lib/mcp/types";
import type {
  McpServerCompatibilityView,
  McpTransport,
} from "@/lib/mcp/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
const logger = createLogger("mcp.backend-capabilities");

// ---------------------------------------------------------------------------
// Capability shape
// ---------------------------------------------------------------------------

type McpServerDisableMechanism = "native" | "omit" | "unsupported";

type McpBetweenTurnApplyMode = "live-when-idle" | "next-turn" | "unsupported";

export type McpToolFilteringMode =
  | "native"
  | "permission-layer"
  | "bridge"
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

/**
 * Whether the backend can connect to a server over each transport at all.
 *
 * Declared separately from {@link McpToolFilteringCapability} because they are
 * different questions: a backend can speak a transport perfectly and still
 * offer no per-tool allow/deny mechanism on it. Reading filtering as transport
 * support would render such a backend as "does not support stdio", which is
 * false.
 */
type McpTransportSupport = Record<McpTransport, boolean>;

export interface McpBackendCapabilities {
  backend: AgentBackendId;
  strictAuthoritativeConfig: boolean;
  serverDisable: McpServerDisableMechanism;
  betweenTurnApply: McpBetweenTurnApplyMode;
  transports: McpTransportSupport;
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
// Default entries — Claude, Codex, and Cursor
// ---------------------------------------------------------------------------

export const claudeMcpCapabilities: McpBackendCapabilities = {
  backend: "claude",
  strictAuthoritativeConfig: true,
  serverDisable: "omit",
  betweenTurnApply: "live-when-idle",
  transports: { stdio: true, "streamable-http": true, sse: true },
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
  transports: { stdio: true, "streamable-http": true, sse: false },
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

/**
 * Cursor's worker bridge enforces transport, filters, and deadlines before
 * exposing its inline endpoints. Provider admin controls remain outside CC's
 * resolved settings, so strict configuration authority is not declared.
 */
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
  toolDiscovery: {
    preferred: "probe",
    probeFallback: true,
  },
};

export const defaultMcpCapabilityRegistry: McpCapabilityRegistry =
  createMcpCapabilityRegistry([
    claudeMcpCapabilities,
    codexMcpCapabilities,
    cursorMcpCapabilities,
  ]);

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
): { supported: boolean; reason?: string } {
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

  return { supported: true };
}
