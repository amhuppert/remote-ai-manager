import { resolveEnabled, resolveToolFilters } from "./policy-resolution";
import {
  buildCompatibilityLookup,
  defaultMcpCapabilityRegistry,
} from "./backend-capabilities";
/**
 * MCP cascade resolver.
 *
 * Pure domain module that merges override chains (global → project → session →
 * conversation) with discovered MCP server definitions and produces:
 *
 * - `mergeOverrideChain` — patch-model merge of the override cascade up to the
 *   requested view level, yielding per-server effective enabled state and per
 *   tool enabled/disabled lists plus origin-level tracking.
 * - `resolveView` — full view-model assembly, layering discovery, overrides,
 *   tool inventories, gateway protection, and pending state into a validated
 *   `McpConfigViewResponse`.
 *
 * The resolver never branches on backend identity; backend-specific decisions
 * are deferred to the runtime composer / translators at emission time.
 */

import type {
  McpConfigLevel,
  McpConfigViewResponse,
  McpDiagnostic,
  McpInheritanceStatus,
  McpOverrides,
  McpServerView,
  McpToolInventoryResult,
  McpToolListView,
  McpToolView,
  ToolDiscoveryState,
} from "@/lib/mcp/schemas";
import type { McpServerDefinition } from "./types";

// ---------------------------------------------------------------------------
// Cascade merge
// ---------------------------------------------------------------------------

export interface McpOverrideChain {
  global: McpOverrides;
  project?: McpOverrides;
  session?: McpOverrides;
  conversation?: McpOverrides;
}

export interface McpEffectiveServerResolution {
  serverKey: string;
  /** Effective enabled state after the cascade. Defaults to true when no
   * level overrides `enabled`. */
  enabled: boolean;
  /** Tools explicitly enabled via overrides (last write wins per toolName). */
  enabledTools: readonly string[];
  /** Tools explicitly disabled via overrides (last write wins per toolName). */
  disabledTools: readonly string[];
  /** Level that last set `enabled`, or `undefined` when no override applied. */
  enabledOriginLevel?: McpConfigLevel;
  /** Level that last set each tool override. */
  toolOriginLevels: Readonly<Record<string, McpConfigLevel>>;
}

const CASCADE_ORDER: readonly McpConfigLevel[] = [
  "global",
  "project",
  "session",
  "conversation",
];

function levelsUpTo(view: McpConfigLevel): readonly McpConfigLevel[] {
  const end = CASCADE_ORDER.indexOf(view) + 1;
  return CASCADE_ORDER.slice(0, end);
}

/**
 * Walk the override chain top-down from `global` through the requested view
 * level, applying field-level patches. Removing a field at a child level falls
 * through to the nearest ancestor that provided it. Pure function — does not
 * mutate its inputs.
 */
export function mergeOverrideChain(
  chain: McpOverrideChain,
  viewLevel: McpConfigLevel,
): Map<string, McpEffectiveServerResolution> {
  const effective = new Map<string, McpEffectiveServerResolution>();
  const toolOrigins = new Map<string, Map<string, McpConfigLevel>>();

  for (const level of levelsUpTo(viewLevel)) {
    const source = chain[level];
    if (!source) continue;
    for (const [serverKey, serverOverride] of Object.entries(source.servers)) {
      let row = effective.get(serverKey);
      if (!row) {
        row = {
          serverKey,
          enabled: true,
          enabledTools: [],
          disabledTools: [],
          toolOriginLevels: {},
        };
        toolOrigins.set(serverKey, new Map());
      }

      if (serverOverride.enabled !== undefined) {
        row = {
          ...row,
          enabled: serverOverride.enabled,
          enabledOriginLevel: level,
        };
      }

      if (serverOverride.tools) {
        const origins =
          toolOrigins.get(serverKey) ?? new Map<string, McpConfigLevel>();
        const enabledSet = new Set(row.enabledTools);
        const disabledSet = new Set(row.disabledTools);
        for (const [toolName, toolOverride] of Object.entries(
          serverOverride.tools,
        )) {
          if (toolOverride.enabled === undefined) continue;
          if (toolOverride.enabled) {
            enabledSet.add(toolName);
            disabledSet.delete(toolName);
          } else {
            disabledSet.add(toolName);
            enabledSet.delete(toolName);
          }
          origins.set(toolName, level);
        }
        toolOrigins.set(serverKey, origins);
        row = {
          ...row,
          enabledTools: Array.from(enabledSet),
          disabledTools: Array.from(disabledSet),
          toolOriginLevels: Object.fromEntries(origins),
        };
      }

      effective.set(serverKey, row);
    }
  }

  return effective;
}

// ---------------------------------------------------------------------------
// View-model assembly
// ---------------------------------------------------------------------------

export interface McpResolveViewInput {
  level: McpConfigLevel;
  overrides: McpOverrideChain;
  /** Discovered native server definitions (before gateway protection). */
  discovered: readonly McpServerDefinition[];
  /** Diagnostics produced during discovery — surfaced into the response. */
  discoveryDiagnostics: readonly McpDiagnostic[];
  /** Tool inventory per server key (optional — absent inventories render as
   * `not-loaded`). */
  toolInventories: Readonly<Record<string, McpToolInventoryResult>>;
  /** Server keys for CC-injected gateway servers appended after user servers.
   * Gateway definitions themselves must also appear in `discovered` when they
   * should be visible in the view model. */
  gatewayServerKeys: readonly string[];
  /** Subset of server keys that are reserved (gateway-owned) and must not be
   * togglable in the UI. Typically the same as `gatewayServerKeys`. */
  reservedGatewayServerKeys: readonly string[];
  /** Server keys with pending apply state (mid-turn updates waiting). */
  pendingServerKeys: readonly string[];
  /** Optional identifiers surfaced on the response. */
  projectName?: string;
  sessionName?: string;
  conversationId?: string;
}

/** Orphaned placeholder used when an override references a server that no
 * longer appears in discovery. Kept visible in the view model per spec. */
function orphanDefinition(serverKey: string): McpServerDefinition {
  return {
    serverKey,
    nativeId: serverKey,
    transport: "stdio",
    config: { transport: "stdio", command: "" },
    sourceRefs: [],
    configSignature: "",
    reserved: false,
    diagnostics: [],
  };
}

export function resolveView(input: McpResolveViewInput): McpConfigViewResponse {
  const {
    level,
    overrides,
    discovered,
    discoveryDiagnostics,
    toolInventories,
    pendingServerKeys,
    reservedGatewayServerKeys,
  } = input;

  const effective = mergeOverrideChain(overrides, level);
  const discoveredByKey = new Map<string, McpServerDefinition>();
  for (const def of discovered) {
    discoveredByKey.set(def.serverKey, def);
  }
  const pendingSet = new Set(pendingServerKeys);
  const reservedSet = new Set(reservedGatewayServerKeys);

  const allKeys = new Set<string>();
  for (const key of discoveredByKey.keys()) allKeys.add(key);
  for (const key of effective.keys()) allKeys.add(key);

  const compatibility = buildCompatibilityLookup(defaultMcpCapabilityRegistry);
  const rows: McpServerView[] = [];
  for (const serverKey of allKeys) {
    const def = discoveredByKey.get(serverKey) ?? orphanDefinition(serverKey);
    const orphaned = !discoveredByKey.has(serverKey);
    const eff =
      effective.get(serverKey) ??
      ({
        serverKey,
        enabled: true,
        enabledTools: [],
        disabledTools: [],
        toolOriginLevels: {},
      } satisfies McpEffectiveServerResolution);

    const policy = resolveToolFilters(effective.get(serverKey), def.native);
    const resolved = {
      ...eff,
      enabled: resolveEnabled(effective.get(serverKey), def.native) ?? true,
      enabledTools: policy.enabledTools ?? [],
      disabledTools: policy.disabledTools ?? [],
    };
    const inventory = toolInventories[serverKey];
    const reserved = def.reserved || reservedSet.has(serverKey);

    rows.push({
      serverKey,
      displayName: serverKey,
      nativeId: def.nativeId,
      transport: def.transport,
      enabled: resolved.enabled,
      compatibility: compatibility(def),
      inheritanceStatus: determineInheritanceStatus({
        viewLevel: level,
        effective: resolved,
        definition: def,
        orphaned,
      }),
      sourceRefs: [...def.sourceRefs],
      reserved,
      orphaned,
      pending: pendingSet.has(serverKey),
      tools: buildToolListView(resolved, inventory, level),
      diagnostics: [...def.diagnostics],
    });
  }

  return {
    level,
    ...(input.projectName !== undefined
      ? { projectName: input.projectName }
      : {}),
    ...(input.sessionName !== undefined
      ? { sessionName: input.sessionName }
      : {}),
    ...(input.conversationId !== undefined
      ? { conversationId: input.conversationId }
      : {}),
    servers: rows,
    diagnostics: [...discoveryDiagnostics],
    pendingServerKeys: [...pendingServerKeys],
  };
}

// ---------------------------------------------------------------------------
// Inheritance status derivation
// ---------------------------------------------------------------------------

interface InheritanceInput {
  viewLevel: McpConfigLevel;
  effective: McpEffectiveServerResolution;
  definition: McpServerDefinition;
  orphaned: boolean;
}

function determineInheritanceStatus(
  input: InheritanceInput,
): McpInheritanceStatus {
  const { viewLevel, effective, definition } = input;

  // "disabled" means the disable override was set AT the current view level.
  // If the disable originates higher in the cascade, it reads as "inherited" —
  // the UI still shows the effective off state via `server.enabled === false`.
  if (effective.enabled === false) {
    if (effective.enabledOriginLevel === viewLevel) return "disabled";
    return "inherited";
  }

  if (effective.enabledOriginLevel === viewLevel) {
    return viewLevel === "global" ? "explicit" : "overridden";
  }

  if (effective.enabledOriginLevel !== undefined) {
    return "inherited";
  }

  // No override in the cascade — derive from source scope alignment.
  if (viewLevel === "global") {
    return "explicit";
  }

  if (viewLevel === "project" && hasProjectScope(definition)) {
    return "explicit";
  }

  return "inherited";
}

function hasProjectScope(def: McpServerDefinition): boolean {
  for (const ref of def.sourceRefs) {
    if (ref.scope === "project") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tool list view assembly + orphan detection
// ---------------------------------------------------------------------------

function buildToolListView(
  eff: McpEffectiveServerResolution,
  inventory: McpToolInventoryResult | undefined,
  viewLevel: McpConfigLevel,
): McpToolListView {
  const state: ToolDiscoveryState = inventory?.state ?? "not-loaded";
  const discoveredToolsByName = new Map(
    (inventory?.tools ?? []).map((tool) => [tool.name, tool] as const),
  );

  const overrideToolNames = new Set<string>([
    ...eff.enabledTools,
    ...eff.disabledTools,
  ]);

  const resolvedToolNames = new Set<string>();
  for (const name of discoveredToolsByName.keys()) resolvedToolNames.add(name);
  for (const name of overrideToolNames) resolvedToolNames.add(name);

  const tools: McpToolView[] = [];
  for (const name of resolvedToolNames) {
    const overriddenAnywhere = overrideToolNames.has(name);
    const originLevel = eff.toolOriginLevels[name];
    const disabled =
      eff.disabledTools.includes(name) ||
      (eff.enabledTools.length > 0 && !eff.enabledTools.includes(name));
    const setAtViewLevel = originLevel === viewLevel;
    const inherited = !setAtViewLevel;
    const discoveredTool = discoveredToolsByName.get(name);
    const present = discoveredTool !== undefined;
    const orphaned =
      overriddenAnywhere &&
      !present &&
      (state === "ready" || state === "stale");

    tools.push({
      name,
      enabled: !disabled,
      inherited,
      inheritanceStatus: determineToolInheritanceStatus({
        viewLevel,
        originLevel,
        disabled,
      }),
      orphaned,
      pending: false,
      ...(discoveredTool?.description !== undefined
        ? { description: discoveredTool.description }
        : {}),
      ...(discoveredTool?.inputSchema !== undefined
        ? { inputSchema: discoveredTool.inputSchema }
        : {}),
    });
  }

  return {
    state,
    tools,
    diagnostics: inventory?.diagnostics ? [...inventory.diagnostics] : [],
    ...(inventory?.refreshedAt !== undefined
      ? { refreshedAt: inventory.refreshedAt }
      : {}),
  };
}

function determineToolInheritanceStatus(input: {
  viewLevel: McpConfigLevel;
  originLevel: McpConfigLevel | undefined;
  disabled: boolean;
}): McpInheritanceStatus {
  const { viewLevel, originLevel, disabled } = input;
  // A "disabled" badge only applies when the disable override lives at the
  // current view level; an ancestor disable reads as "inherited".
  if (disabled) {
    if (originLevel === viewLevel) return "disabled";
    return "inherited";
  }
  if (originLevel === viewLevel) {
    return viewLevel === "global" ? "explicit" : "overridden";
  }
  if (originLevel !== undefined) return "inherited";
  return viewLevel === "global" ? "explicit" : "inherited";
}
