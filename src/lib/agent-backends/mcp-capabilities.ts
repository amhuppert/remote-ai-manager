import type { AgentBackendId } from "@/lib/shared/schemas";
import type { McpTransport } from "@/lib/mcp/schemas";
import { claudeMcpCapabilities } from "./claude/mcp-capabilities";
import { codexMcpCapabilities } from "./codex/mcp-capabilities";
import { cursorMcpCapabilities } from "./cursor/mcp-capabilities";
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
  toolControl?: {
    configurable: boolean;
    notes: string[];
    applyTiming?: "next-turn" | "next-conversation";
  };
  notes?: string[];
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

export const defaultMcpCapabilityRegistry = createMcpCapabilityRegistry([
  claudeMcpCapabilities,
  codexMcpCapabilities,
  cursorMcpCapabilities,
]);
