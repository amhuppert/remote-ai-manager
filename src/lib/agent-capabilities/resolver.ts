/**
 * Cascade resolver.
 *
 * Builds the canonical `AgentCapabilityViewResponse` for one cascade by
 * composing four orthogonal concerns:
 *
 *  1. Four-layer inheritance — narrowest explicit override wins; absence at
 *     every layer falls back to the backend's native default.
 *  2. Stale override intent — overrides for ids missing from current
 *     discovery surface as `runtimeVisibility: "stale"` view rows that
 *     preserve the stored value and origin but are not runtime-emittable.
 *  3. Plugin parent-child disable — when a parent plugin resolves disabled,
 *     plugin-owned child rows are forced disabled in `effectiveState` while
 *     `ownEffectiveState` keeps the child's pre-disable resolution so a
 *     parent re-enable restores the child's own intent.
 *  4. Runtime apply status — pending and applied runtime records merge into
 *     per-row `applyStatus`. Status is derived from metadata
 *     (`applySemantics`, `compositionSupport`) plus runtime state, never from
 *     a `cascadeKind === "..."` branch.
 *
 * Determinism: identical inputs (regardless of override or discovery order)
 * produce byte-stable `effectiveHash` values. The hash is computed from a
 * sorted, normalized projection of every view row's identity and effective
 * state so it changes when overrides flip and stays stable across cosmetic
 * input reordering.
 *
 * Purity: this module performs no I/O. Filesystem reads, SDK calls, and
 * persistence belong to the discovery, runtime-apply, and store layers; the
 * resolver only composes their results into the view contract.
 */

import { createHash } from "node:crypto";

import {
  AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP,
  type AgentCapabilityApplyStatus,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCascadeLayer,
  type AgentCapabilityCascadeRuntimeState,
  type AgentCapabilityDiagnostic,
  type AgentCapabilityDiscoveredItem,
  type AgentCapabilityEffectiveState,
  type AgentCapabilityInheritedDisableReason,
  type AgentCapabilityKind,
  type AgentCapabilityMetadata,
  type AgentCapabilityOriginLayer,
  type AgentCapabilityOverrides,
  type AgentCapabilityRuntimeApplicationState,
  type AgentCapabilityRuntimeVisibility,
  type AgentCapabilityScopeContext,
  type AgentCapabilitySourceRef,
  type AgentCapabilityViewResponse,
  type AgentCapabilityViewRow,
} from "./schemas";

export interface ResolveCascadeViewInput {
  cascadeKind: AgentCapabilityCascadeKind;
  scope: AgentCapabilityScopeContext;
  /**
   * Layer overrides ordered from broadest (global) to narrowest (the requested
   * scope level). Entries with `overrides: undefined` are permitted so callers
   * can pass a fixed-shape chain even when a particular layer has nothing
   * stored.
   */
  overrideChain: ReadonlyArray<{
    layer: AgentCapabilityCascadeLayer;
    overrides: AgentCapabilityOverrides | undefined;
  }>;
  discoveredItems: readonly AgentCapabilityDiscoveredItem[];
  metadata: AgentCapabilityMetadata;
  /**
   * For child cascades that participate in plugin parent-child disable
   * (`claude-skills`, `claude-agents`, `codex-skills`). Built by calling
   * `resolvePluginEnablement` against the corresponding `*-plugins` cascade
   * first. Omitted means no plugin overlay is applied.
   */
  pluginResolution?: PluginEnablementMap;
  runtimeApplyState?: AgentCapabilityRuntimeApplicationState;
  /**
   * Diagnostics produced by upstream discovery for this cascade. Carried
   * through verbatim; the resolver only appends stale-override diagnostics.
   */
  discoveryDiagnostics?: readonly AgentCapabilityDiagnostic[];
}

export type PluginEnablementMap = ReadonlyMap<
  string,
  { enabled: boolean; originLayer: AgentCapabilityOriginLayer }
>;

export type PluginCascadeKind = "claude-plugins" | "codex-plugins";

export interface ResolvePluginEnablementInput {
  /**
   * The specific plugin cascade kind to read. Parent-child disable is a
   * within-backend relationship — Claude plugins force Claude children, Codex
   * plugins force Codex children, never crosswise — so the caller must name
   * the cascade whose plugins own the children being resolved. The function
   * reads ONLY this cascade out of each layer; sibling plugin cascades on
   * the same layer are ignored even when they exist, so two backends with
   * coincidentally identical plugin ids do not collide.
   */
  pluginCascadeKind: PluginCascadeKind;
  discoveredPlugins: readonly AgentCapabilityDiscoveredItem[];
  overrideChain: ReadonlyArray<{
    layer: AgentCapabilityCascadeLayer;
    overrides: AgentCapabilityOverrides | undefined;
  }>;
}

/**
 * Resolves the per-plugin `{ enabled, originLayer }` map used by the child
 * cascade resolver to apply forced-disable semantics. Reads the matching
 * plugin cascade out of each layer's overrides; chooses the narrowest
 * explicit value per plugin id; otherwise uses the plugin's native default.
 *
 * Cascade scoping: the input's `pluginCascadeKind` is the ONLY cascade
 * inspected in each override layer. This keeps parent-child disable within
 * one backend even when callers thread the same broad override chain into
 * both Claude and Codex resolution passes.
 */
export function resolvePluginEnablement(
  input: ResolvePluginEnablementInput,
): PluginEnablementMap {
  const out = new Map<
    string,
    { enabled: boolean; originLayer: AgentCapabilityOriginLayer }
  >();

  // Seed with native defaults so plugins that have no override are still
  // represented; downstream lookups distinguish "unknown plugin" (no entry)
  // from "plugin enabled by default" (entry with originLayer: "native").
  for (const plugin of input.discoveredPlugins) {
    out.set(plugin.itemId, {
      enabled: plugin.nativeDefault.enabled,
      originLayer: "native",
    });
  }

  // Walk from narrowest to broadest so the first explicit value wins. Only
  // read the matching plugin cascade; sibling plugin cascades on the same
  // layer (e.g. codex-plugins while resolving claude-skills' parents) are
  // ignored so cross-backend plugin id collisions cannot leak across.
  for (let i = input.overrideChain.length - 1; i >= 0; i -= 1) {
    const entry = input.overrideChain[i]!;
    const cascade = entry.overrides?.cascades[input.pluginCascadeKind];
    if (!cascade) continue;
    for (const [pluginId, item] of Object.entries(cascade.items)) {
      const existing = out.get(pluginId);
      if (existing && existing.originLayer !== "native") {
        // Already set by a narrower layer; skip.
        continue;
      }
      out.set(pluginId, {
        enabled: item.enabled,
        originLayer: entry.layer,
      });
    }
  }

  return out;
}

export function resolveCascadeView(
  input: ResolveCascadeViewInput,
): AgentCapabilityViewResponse {
  const backend = AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[input.cascadeKind];
  const overrideChain = filterOverrideChainForScope(
    input.scope,
    input.overrideChain,
  );

  const cascadeIsVerificationGated =
    input.metadata.compositionSupport === "verification-gated";

  const runtimeState = input.runtimeApplyState?.cascades[input.cascadeKind];

  const discoveredById = new Map<string, AgentCapabilityDiscoveredItem>();
  for (const item of input.discoveredItems) {
    discoveredById.set(item.itemId, item);
  }

  const allItemIds = collectKnownItemIds(
    input.cascadeKind,
    overrideChain,
    discoveredById,
  );

  const rows: AgentCapabilityViewRow[] = [];
  const diagnostics: AgentCapabilityDiagnostic[] = [
    ...(input.discoveryDiagnostics ?? []),
  ];

  for (const itemId of allItemIds) {
    const discovered = discoveredById.get(itemId);
    const stale = discovered === undefined;

    const resolved = resolveItemEffective(
      itemId,
      input.cascadeKind,
      overrideChain,
      discovered?.nativeDefault.enabled ?? false,
    );
    const currentLayerValue = resolveCurrentLayerValue(
      itemId,
      input.cascadeKind,
      input.scope.level,
      overrideChain,
    );
    const inheritedEffectiveState = resolveInheritedEffective(
      itemId,
      input.cascadeKind,
      input.scope.level,
      overrideChain,
      discovered?.nativeDefault.enabled ?? false,
    );

    const ownEffective: AgentCapabilityEffectiveState = {
      enabled: resolved.enabled,
      originLayer: resolved.originLayer,
    };

    let effective: AgentCapabilityEffectiveState = ownEffective;
    let inheritedDisableReason:
      | AgentCapabilityInheritedDisableReason
      | undefined;

    if (!stale && discovered.owningPluginId && input.pluginResolution) {
      const parent = input.pluginResolution.get(discovered.owningPluginId);
      if (parent && !parent.enabled) {
        effective = {
          enabled: false,
          originLayer: parent.originLayer,
        };
        inheritedDisableReason = {
          pluginId: discovered.owningPluginId,
          originLayer: parent.originLayer,
        };
      }
    }

    const runtimeVisibility: AgentCapabilityRuntimeVisibility = stale
      ? "stale"
      : discovered.runtimeVisibility;

    const runtimeEmittable =
      !stale &&
      !cascadeIsVerificationGated &&
      runtimeVisibility !== "unavailable";

    const applyStatus = computeApplyStatus({
      metadata: input.metadata,
      runtimeState,
      itemId,
      runtimeEmittable,
    });

    if (stale) {
      diagnostics.push({
        severity: "info",
        code: "agent-capability-stale-override",
        message: `Override for ${itemId} no longer matches a discovered item; the row is preserved but not runtime-emittable.`,
        cascadeKind: input.cascadeKind,
        layer: layerFromOrigin(resolved.originLayer),
        itemId,
        backend,
      });
    }

    // Surface failed apply attempts as per-row diagnostics so the UI/operator
    // sees the sanitized error message alongside the `rejected` badge. The
    // runtime apply service stores `lastApplyError` already sanitized.
    //
    // When the runtime records `pendingItemIds`, only those items were the
    // target of the failed attempt; sibling rows that read "rejected" from
    // the cascade-level `lastApplyStatus` did not cause the failure and must
    // not be tagged with the same error.
    const rowDiagnostics: AgentCapabilityDiagnostic[] = [];
    if (
      applyStatus === "rejected" &&
      runtimeState &&
      runtimeState.lastApplyError &&
      isRowResponsibleForApplyFailure(itemId, runtimeState)
    ) {
      const applyFailedDiagnostic: AgentCapabilityDiagnostic = {
        severity: "error",
        code: "agent-capability-apply-failed",
        message: runtimeState.lastApplyError,
        cascadeKind: input.cascadeKind,
        itemId,
        backend,
      };
      rowDiagnostics.push(applyFailedDiagnostic);
      diagnostics.push(applyFailedDiagnostic);
    }

    const row: AgentCapabilityViewRow = {
      itemId,
      displayName: discovered?.displayName ?? itemId,
      backend,
      capabilityKind:
        discovered?.capabilityKind ??
        capabilityKindForCascade(input.cascadeKind),
      cascadeKind: input.cascadeKind,
      source:
        discovered?.source ?? staleSourceRefForLayer(resolved.originLayer),
      nativeDefault: discovered?.nativeDefault ?? { enabled: false },
      ownEffectiveState: ownEffective,
      currentLayerValue,
      inheritedEffectiveState,
      effectiveState: effective,
      originLayer: effective.originLayer,
      owningPluginId: discovered?.owningPluginId,
      inheritedDisableReason,
      runtimeVisibility,
      runtimeEmittable,
      stale,
      applyStatus,
      diagnostics: rowDiagnostics,
    };

    rows.push(row);
  }

  rows.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

  return {
    level: input.scope.level,
    projectName: input.scope.projectName,
    conversationScope: input.scope.conversationScope,
    sessionName: input.scope.sessionName,
    conversationId: input.scope.conversationId,
    cascadeKind: input.cascadeKind,
    backend,
    items: rows,
    diagnostics,
    effectiveHash: computeEffectiveHash(input.cascadeKind, rows),
    metadata: input.metadata,
  };
}

export function filterOverrideChainForScope(
  scope: AgentCapabilityScopeContext,
  overrideChain: ResolveCascadeViewInput["overrideChain"],
): ResolveCascadeViewInput["overrideChain"] {
  if (scope.level !== "conversation" || scope.conversationScope !== "project") {
    return overrideChain;
  }
  return overrideChain.filter((entry) => entry.layer !== "session");
}

function collectKnownItemIds(
  cascadeKind: AgentCapabilityCascadeKind,
  overrideChain: ResolveCascadeViewInput["overrideChain"],
  discoveredById: ReadonlyMap<string, AgentCapabilityDiscoveredItem>,
): readonly string[] {
  const set = new Set<string>(discoveredById.keys());
  for (const entry of overrideChain) {
    const cascade = entry.overrides?.cascades[cascadeKind];
    if (!cascade) continue;
    for (const id of Object.keys(cascade.items)) {
      set.add(id);
    }
  }
  return Array.from(set);
}

interface ResolvedItemState {
  enabled: boolean;
  originLayer: AgentCapabilityOriginLayer;
}

function resolveItemEffective(
  itemId: string,
  cascadeKind: AgentCapabilityCascadeKind,
  overrideChain: ResolveCascadeViewInput["overrideChain"],
  nativeEnabled: boolean,
): ResolvedItemState {
  for (let i = overrideChain.length - 1; i >= 0; i -= 1) {
    const entry = overrideChain[i]!;
    const cascade = entry.overrides?.cascades[cascadeKind];
    const item = cascade?.items[itemId];
    if (item === undefined) continue;
    return { enabled: item.enabled, originLayer: entry.layer };
  }
  return { enabled: nativeEnabled, originLayer: "native" };
}

function resolveCurrentLayerValue(
  itemId: string,
  cascadeKind: AgentCapabilityCascadeKind,
  currentLayer: AgentCapabilityCascadeLayer,
  overrideChain: ResolveCascadeViewInput["overrideChain"],
): AgentCapabilityEffectiveState | undefined {
  const current = overrideChain.find((entry) => entry.layer === currentLayer);
  const item = current?.overrides?.cascades[cascadeKind]?.items[itemId];
  if (item === undefined) return undefined;
  return {
    enabled: item.enabled,
    originLayer: currentLayer,
  };
}

function resolveInheritedEffective(
  itemId: string,
  cascadeKind: AgentCapabilityCascadeKind,
  currentLayer: AgentCapabilityCascadeLayer,
  overrideChain: ResolveCascadeViewInput["overrideChain"],
  nativeEnabled: boolean,
): AgentCapabilityEffectiveState {
  const currentLayerIndex = layerOrderIndex(currentLayer);
  const inheritedChain = overrideChain.filter(
    (entry) => layerOrderIndex(entry.layer) < currentLayerIndex,
  );
  const resolved = resolveItemEffective(
    itemId,
    cascadeKind,
    inheritedChain,
    nativeEnabled,
  );
  return {
    enabled: resolved.enabled,
    originLayer: resolved.originLayer,
  };
}

function layerOrderIndex(layer: AgentCapabilityCascadeLayer): number {
  switch (layer) {
    case "global":
      return 0;
    case "project":
      return 1;
    case "session":
      return 2;
    case "conversation":
      return 3;
  }
}

interface ComputeApplyStatusInput {
  metadata: AgentCapabilityMetadata;
  runtimeState: AgentCapabilityCascadeRuntimeState | undefined;
  itemId: string;
  runtimeEmittable: boolean;
}

function computeApplyStatus(
  input: ComputeApplyStatusInput,
): AgentCapabilityApplyStatus {
  // Verification-gated cascades cannot apply runtime config regardless of
  // override or runtime state, so the row's apply status reflects that.
  if (input.metadata.compositionSupport === "verification-gated") {
    return "unsupported";
  }

  if (!input.runtimeEmittable) {
    return "none";
  }

  const runtime = input.runtimeState;
  if (!runtime) return "none";

  const pending = runtime.pendingItemIds ?? [];
  const isPendingForItem = pending.includes(input.itemId);

  // When an item is in the pending set, its status follows the last apply
  // attempt's disposition (staged-idle, staged-next-turn, deferred-next-
  // conversation, rejected, ...). When not pending, items reflect the
  // cascade's most recent terminal status (applied, rejected, ...) so the UI
  // can display per-item context without recomputing from raw hashes.
  if (isPendingForItem && runtime.lastApplyStatus) {
    return runtime.lastApplyStatus;
  }

  if (runtime.lastApplyStatus === "rejected") {
    return "rejected";
  }

  if (runtime.lastApplyStatus === "applied") {
    return "applied";
  }

  if (runtime.lastApplyStatus) {
    return runtime.lastApplyStatus;
  }

  if (runtime.appliedHash) {
    return "applied";
  }

  return "none";
}

// Returns true when this row was part of the apply attempt that produced
// `lastApplyError`. When the runtime tracked specific `pendingItemIds`, only
// those rows are responsible. When there is no per-item pending set, the
// failure is treated as cascade-wide and every row is in scope.
function isRowResponsibleForApplyFailure(
  itemId: string,
  runtime: AgentCapabilityCascadeRuntimeState,
): boolean {
  const pending = runtime.pendingItemIds;
  if (pending === undefined || pending.length === 0) return true;
  return pending.includes(itemId);
}

function capabilityKindForCascade(
  kind: AgentCapabilityCascadeKind,
): AgentCapabilityKind {
  switch (kind) {
    case "claude-skills":
    case "codex-skills":
      return "skill";
    case "claude-plugins":
    case "codex-plugins":
      return "plugin";
    case "claude-agents":
      return "agent";
  }
}

function layerFromOrigin(
  origin: AgentCapabilityOriginLayer,
): AgentCapabilityCascadeLayer | undefined {
  if (origin === "native") return undefined;
  return origin;
}

// Stale rows do not have a real discovered source. We synthesize a source
// matching the layer that holds the stale override so the view row still
// parses against `agentCapabilitySourceRefSchema`. Path is empty because the
// resolver does not know the physical persistence path; the UI shows the
// row as stale via `runtimeVisibility` / `stale` rather than via the path.
function staleSourceRefForLayer(
  origin: AgentCapabilityOriginLayer,
): AgentCapabilitySourceRef {
  switch (origin) {
    case "global":
      return { kind: "global-file", path: "" };
    case "project":
    case "session":
    case "conversation":
      return { kind: "project-file", path: "" };
    case "native":
      // Defensive: a stale row should never resolve to "native" origin
      // because it has no discovery record. If this branch is reached the
      // safest non-leaky source is sdk-runtime (no path).
      return { kind: "sdk-runtime" };
  }
}

// Effective hash inputs deliberately exclude apply status and runtime
// metadata: those reflect a different conversation's transient state and
// would flap the hash on every apply lifecycle event. The hash captures the
// resolved view's identity (cascade + per-item enabled/origin) so concurrent
// patch detection compares apples to apples.
function computeEffectiveHash(
  cascadeKind: AgentCapabilityCascadeKind,
  rows: readonly AgentCapabilityViewRow[],
): string {
  const parts: string[] = [`cascade:${cascadeKind}`];
  for (const row of rows) {
    parts.push(
      [
        row.itemId,
        row.effectiveState.enabled ? "1" : "0",
        row.effectiveState.originLayer,
        row.ownEffectiveState.enabled ? "1" : "0",
        row.ownEffectiveState.originLayer,
        row.currentLayerValue
          ? `${row.currentLayerValue.enabled ? "1" : "0"}:${row.currentLayerValue.originLayer}`
          : "none",
        row.inheritedEffectiveState
          ? `${row.inheritedEffectiveState.enabled ? "1" : "0"}:${row.inheritedEffectiveState.originLayer}`
          : "none",
        row.stale ? "stale" : "live",
      ].join("|"),
    );
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// Re-export for downstream consumers that need to know the cascade backend
// ownership without re-importing from schemas.
