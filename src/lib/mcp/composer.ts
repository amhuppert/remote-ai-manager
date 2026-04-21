/**
 * MCP runtime composer.
 *
 * Sits between the cascade resolver and the backend translators. Produces the
 * final backend-neutral `PortableMcpConfig` emitted to an agent turn by:
 *
 * 1. Filtering discovered server definitions to those usable by the active
 *    backend (matching `backend` or `shared`).
 * 2. Overlaying the effective override chain (from `mergeOverrideChain`) onto
 *    each discovered server's native filter baseline to produce `enabled`,
 *    `enabledTools`, and `disabledTools` per entry.
 * 3. Excluding orphaned server overrides (serverKeys with overrides but no
 *    discovered definition) from the emitted set — callers keep them visible
 *    in the view model through the resolver.
 * 4. Preserving disabled servers as `enabled: false` so Codex does not fall
 *    back to its native TOML (the Claude translator drops them; Codex emits
 *    them natively).
 * 5. Appending CC-injected gateway server definitions last and protecting
 *    their identifiers on collision with user-configured servers.
 *
 * Transports that are not representable in the portable shape (SSE today) are
 * dropped with diagnostics; the portable type only supports stdio and
 * streamable-http.
 */

import { createLogger } from "@/lib/logging";
import type {
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "@/lib/agent-backends/portable-mcp";
import type { AgentBackendId } from "@/lib/schemas";

import type { McpEffectiveServerResolution } from "./resolver";
import type {
  McpCanonicalServerConfig,
  McpNativeFilterFields,
  McpServerDefinition,
} from "./types";

const logger = createLogger("mcp.composer");

export interface McpComposeInput {
  /** Active agent backend. Used to filter discovered servers whose backend
   * availability (`claude` / `codex` / `shared`) does not match. Emission
   * decisions themselves remain in the translators. */
  backend: AgentBackendId;
  /** Discovered server definitions produced by source discovery. */
  discovered: readonly McpServerDefinition[];
  /** Effective override resolution from `mergeOverrideChain`. Servers absent
   * from this map use their native filter fields (or defaults) as baseline. */
  effective: ReadonlyMap<string, McpEffectiveServerResolution>;
  /** CC-injected gateway server definitions, always appended last. */
  gatewayServers: readonly PortableMcpServerConfig[];
}

export interface McpComposeResult {
  /** Final emitted portable config (user-configured servers + gateway). */
  portable: PortableMcpConfig;
  /** Server keys present in the effective map but absent from discovery. */
  omittedOrphanServerKeys: readonly string[];
  /** Gateway ids that collided with a user-configured server's portable id. */
  collidedGatewayIds: readonly string[];
  /** Gateway ids — surfaced so view models can mark them reserved. */
  reservedServerIds: readonly string[];
  /** Discovered server keys skipped because their transport is not
   * representable in the portable shape (e.g. `sse`). */
  droppedServerKeys: readonly string[];
}

export function composeRuntimeMcpConfig(
  input: McpComposeInput,
): McpComposeResult {
  const { backend, discovered, effective, gatewayServers } = input;

  const gatewayIds = new Set(gatewayServers.map((g) => g.id));
  const userEntries: PortableMcpServerConfig[] = [];
  const droppedServerKeys: string[] = [];
  const collidedGatewayIds: string[] = [];
  const emittedUserKeys = new Set<string>();

  for (const def of discovered) {
    if (!isBackendMatch(def, backend)) continue;

    const resolution = effective.get(def.serverKey);
    const portableEntry = buildPortableEntry(def, resolution);
    if (!portableEntry) {
      droppedServerKeys.push(def.serverKey);
      continue;
    }

    if (gatewayIds.has(portableEntry.id)) {
      collidedGatewayIds.push(portableEntry.id);
      continue;
    }

    userEntries.push(portableEntry);
    emittedUserKeys.add(def.serverKey);
  }

  const omittedOrphanServerKeys: string[] = [];
  for (const serverKey of effective.keys()) {
    if (!discovered.some((d) => d.serverKey === serverKey)) {
      omittedOrphanServerKeys.push(serverKey);
    }
  }

  const servers: PortableMcpServerConfig[] = [
    ...userEntries,
    ...gatewayServers,
  ];
  const reservedServerIds = gatewayServers.map((g) => g.id);

  logger.debug("composed runtime mcp", {
    backend,
    userServerCount: userEntries.length,
    gatewayServerCount: gatewayServers.length,
    orphanedCount: omittedOrphanServerKeys.length,
    droppedCount: droppedServerKeys.length,
    collidedGatewayCount: collidedGatewayIds.length,
  });

  return {
    portable: { servers },
    omittedOrphanServerKeys,
    collidedGatewayIds,
    reservedServerIds,
    droppedServerKeys,
  };
}

function isBackendMatch(
  def: McpServerDefinition,
  backend: AgentBackendId,
): boolean {
  return def.backend === backend || def.backend === "shared";
}

function buildPortableEntry(
  def: McpServerDefinition,
  resolution: McpEffectiveServerResolution | undefined,
): PortableMcpServerConfig | null {
  const base = canonicalToPortable(def.nativeId, def.config);
  if (!base) return null;

  const enabled = resolveEnabled(resolution, def.native);
  const { enabledTools, disabledTools } = resolveToolFilters(
    resolution,
    def.native,
  );

  return {
    ...base,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(enabledTools !== undefined ? { enabledTools: [...enabledTools] } : {}),
    ...(disabledTools !== undefined
      ? { disabledTools: [...disabledTools] }
      : {}),
  };
}

function canonicalToPortable(
  id: string,
  config: McpCanonicalServerConfig,
): PortableMcpServerConfig | null {
  if (config.transport === "stdio") {
    return {
      id,
      transport: "stdio",
      command: config.command,
      ...(config.args !== undefined ? { args: [...config.args] } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(config.env !== undefined ? { env: { ...config.env } } : {}),
      ...(config.startupTimeoutSec !== undefined
        ? { startupTimeoutSec: config.startupTimeoutSec }
        : {}),
      ...(config.toolTimeoutSec !== undefined
        ? { toolTimeoutSec: config.toolTimeoutSec }
        : {}),
    };
  }

  if (config.transport === "streamable-http") {
    return {
      id,
      transport: "streamable-http",
      url: config.url,
      ...(config.headers !== undefined
        ? { headers: { ...config.headers } }
        : {}),
      ...(config.bearerTokenEnvVar !== undefined
        ? { bearerTokenEnvVar: config.bearerTokenEnvVar }
        : {}),
      ...(config.startupTimeoutSec !== undefined
        ? { startupTimeoutSec: config.startupTimeoutSec }
        : {}),
      ...(config.toolTimeoutSec !== undefined
        ? { toolTimeoutSec: config.toolTimeoutSec }
        : {}),
    };
  }

  // SSE has no portable representation today.
  return null;
}

function resolveEnabled(
  resolution: McpEffectiveServerResolution | undefined,
  native: McpNativeFilterFields | undefined,
): boolean | undefined {
  if (resolution?.enabledOriginLevel !== undefined) {
    return resolution.enabled;
  }
  if (native?.enabled !== undefined) {
    return native.enabled;
  }
  return undefined;
}

function resolveToolFilters(
  resolution: McpEffectiveServerResolution | undefined,
  native: McpNativeFilterFields | undefined,
): {
  enabledTools?: readonly string[];
  disabledTools?: readonly string[];
} {
  const overrideEnabled = resolution?.enabledTools ?? [];
  const overrideDisabled = resolution?.disabledTools ?? [];

  const enabledTools =
    overrideEnabled.length > 0 ? overrideEnabled : native?.enabledTools;
  const disabledTools =
    overrideDisabled.length > 0 ? overrideDisabled : native?.disabledTools;

  return {
    ...(enabledTools !== undefined ? { enabledTools } : {}),
    ...(disabledTools !== undefined ? { disabledTools } : {}),
  };
}
