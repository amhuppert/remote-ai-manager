/**
 * Conversation-start runtime composer.
 *
 * Glues three layers (resolver, plugin enablement map, runtime hash seeding)
 * into a single backend-scoped composition pass that runs at the moment a new
 * conversation runtime is created:
 *
 *   1. Filter the cascades to the active backend's owned set so a Claude
 *      conversation never reads codex discovery and vice versa.
 *   2. Resolve the plugin cascade first when the backend has one, then build
 *      a `PluginEnablementMap` from the same input so child cascades
 *      (claude-skills, claude-agents, codex-skills) see the correct
 *      forced-disable state.
 *   3. Resolve the remaining cascades, threading the plugin map in where it
 *      applies.
 *   4. Project the resolved views into the backend-neutral
 *      `ResolvedCapabilityCascade` (the runtime-config seam input) and seed
 *      the per-cascade runtime hashes from it. Provider translation happens
 *      below the seam — inside the backend factory at runtime creation and
 *      inside the descriptor's runtime-config adapter at apply time.
 *
 * Hash basis: per kind, the rows whose `originLayer !== "native"` — the
 * CC-explicit decisions the cascade carries. Deterministic and seam-neutral;
 * native-state drift (e.g. a user editing settings.json outside CC) does not
 * perturb the hash because the adapter re-translates fresh on every apply.
 *
 * Failure isolation: a cascade listed in `failedCascadeKinds` is skipped
 * entirely — no resolution, no cascade entry, no seed entry. The caller wires
 * those failures back as separate cascade-scoped diagnostics. Sibling
 * cascades on the same backend compose normally.
 *
 * Purity: this module performs no I/O. Discovery results and override chains
 * are all caller-provided so the composer can be exercised deterministically
 * in tests without spawning agent processes or reading the filesystem. The
 * only ambient read is the backend registry (an in-memory descriptor map):
 * the cascade taxonomy for a backend derives from its registered descriptor's
 * declared `capabilityKinds`, never from a closed per-backend map, so a newly
 * registered backend flows through composition with zero edits here.
 */

import {
  defaultAgentCapabilityMetadataRegistry,
  type AgentCapabilityMetadataRegistry,
} from "./metadata";
import {
  filterOverrideChainForScope,
  resolveCascadeView,
  resolvePluginEnablement,
  type PluginCascadeKind,
  type PluginEnablementMap,
} from "./resolver";
import {
  computeCascadeRuntimeHash,
  seedRuntimeApplicationState,
  type SeededCascade,
} from "./runtime-hashes";

import type { AgentBackendId } from "@/lib/shared/schemas";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import type { CapabilityKind } from "@/lib/agent-backends/descriptor";
import type {
  ResolvedCapabilityCascade,
  ResolvedCapabilityItem,
  ResolvedCapabilityKind,
} from "@/lib/agent-backends/runtime-config";
import {
  agentCapabilityCascadeKindSchema,
  decodeCascadeKind,
  encodeCascadeKind,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCascadeLayer,
  type AgentCapabilityDiagnostic,
  type AgentCapabilityDiscoveredItem,
  type AgentCapabilityOverrides,
  type AgentCapabilityRuntimeApplicationState,
  type AgentCapabilityScopeContext,
  type AgentCapabilityViewResponse,
} from "./schemas";

export interface ComposeConversationStartCascadeInput {
  items: readonly AgentCapabilityDiscoveredItem[];
  diagnostics?: readonly AgentCapabilityDiagnostic[];
}

export interface ComposeConversationStartInput {
  backend: AgentBackendId;
  scope: AgentCapabilityScopeContext;
  overrideChain: ReadonlyArray<{
    layer: AgentCapabilityCascadeLayer;
    overrides: AgentCapabilityOverrides | undefined;
  }>;
  /**
   * Per-cascade discovery results. Cascades not owned by `backend` are
   * silently ignored so callers can pass a uniform map across backends.
   */
  discoveryByCascade: Partial<
    Record<AgentCapabilityCascadeKind, ComposeConversationStartCascadeInput>
  >;
  /**
   * Cascades whose upstream discovery failed. The composer omits them
   * entirely — no resolution, no cascade entry, no seeded state — so the
   * runtime falls back to the backend's native defaults for those cascades.
   */
  failedCascadeKinds?: readonly AgentCapabilityCascadeKind[];
  metadataRegistry?: AgentCapabilityMetadataRegistry;
}

export interface ComposeConversationStartResult {
  backend: AgentBackendId;
  /**
   * Backend-neutral resolved cascade — the runtime-config seam input. Seeded
   * onto new runtimes via `ConversationToolingOverrides.capabilities` and
   * handed to `descriptor.conversation.runtimeConfig.apply()` on live apply.
   * Contains one kind entry per resolved (non-failed) cascade view.
   */
  capabilities: ResolvedCapabilityCascade;
  /** All cascade diagnostics, in resolver order. */
  diagnostics: readonly AgentCapabilityDiagnostic[];
  /** Initial runtime apply state to attach to the new conversation runtime. */
  runtimeState: AgentCapabilityRuntimeApplicationState;
  /** Resolved views the composer produced. Cascades not owned by the active
   * backend, marked failed, or absent from discovery are omitted. */
  views: Partial<
    Record<AgentCapabilityCascadeKind, AgentCapabilityViewResponse>
  >;
  /**
   * Cascades the caller marked as discovery-failed. Forwarded verbatim so the
   * apply service can distinguish "no emission because the cascade is empty"
   * from "no emission because upstream discovery failed" — the latter must
   * surface as a retryable `rejected` disposition rather than an idempotent
   * no-op.
   */
  failedCascadeKinds: readonly AgentCapabilityCascadeKind[];
}

export interface OwnedCascade {
  cascadeKind: AgentCapabilityCascadeKind;
  kind: CapabilityKind;
}

/**
 * Cascade taxonomy for a backend, derived from its registered descriptor's
 * declared conversation `capabilityKinds`. The plugin cascade (when declared)
 * is ordered first because child cascades consume its enablement map. A
 * declared kind whose `(backend, kind)` pair has no persisted cascade
 * encoding is omitted: `agentCapabilityCascadeKindSchema` is the intentional
 * storage-boundary rejection point (overrides, metadata, and runtime hashes
 * are keyed by the persisted cascade kind), mirroring how
 * `agentSessionRefSchema` rejects unknown ids at the ref seam — declaring a
 * new backend's cascades is the schema edit that opens this path.
 */
export function ownedCascadesForBackend(
  backend: AgentBackendId,
): readonly OwnedCascade[] {
  const declared =
    getBackendDescriptor(backend).conversation?.capabilities.capabilityKinds ??
    [];
  const encoded: OwnedCascade[] = [];
  for (const support of declared) {
    const parsed = agentCapabilityCascadeKindSchema.safeParse(
      `${backend}-${support.kind}`,
    );
    if (!parsed.success) continue;
    encoded.push({ cascadeKind: parsed.data, kind: support.kind });
  }
  return [
    ...encoded.filter((cascade) => cascade.kind === "plugins"),
    ...encoded.filter((cascade) => cascade.kind !== "plugins"),
  ];
}

function isPluginCascadeKind(
  cascadeKind: AgentCapabilityCascadeKind,
): cascadeKind is PluginCascadeKind {
  return decodeCascadeKind(cascadeKind).kind === "plugins";
}

export function composeConversationStartRuntime(
  input: ComposeConversationStartInput,
): ComposeConversationStartResult {
  const metadataRegistry =
    input.metadataRegistry ?? defaultAgentCapabilityMetadataRegistry;
  const failed = new Set<AgentCapabilityCascadeKind>(
    input.failedCascadeKinds ?? [],
  );
  const overrideChain = filterOverrideChainForScope(
    input.scope,
    input.overrideChain,
  );

  const ownedCascades = ownedCascadesForBackend(input.backend);
  const ownedCascadeKinds = ownedCascades.map((c) => c.cascadeKind);
  const pluginCandidate = ownedCascades.find(
    (c) => c.kind === "plugins",
  )?.cascadeKind;
  const pluginCascadeKind =
    pluginCandidate !== undefined && isPluginCascadeKind(pluginCandidate)
      ? pluginCandidate
      : undefined;

  // Resolve the plugin cascade first when present and not failed so child
  // cascades can consume the resulting enablement map.
  let pluginResolution: PluginEnablementMap | undefined;
  const views: Partial<
    Record<AgentCapabilityCascadeKind, AgentCapabilityViewResponse>
  > = {};

  if (pluginCascadeKind !== undefined && !failed.has(pluginCascadeKind)) {
    const pluginCascade = input.discoveryByCascade[pluginCascadeKind];
    if (pluginCascade) {
      views[pluginCascadeKind] = resolveCascadeView({
        cascadeKind: pluginCascadeKind,
        scope: input.scope,
        overrideChain,
        discoveredItems: pluginCascade.items,
        metadata: metadataRegistry.get(pluginCascadeKind),
        discoveryDiagnostics: pluginCascade.diagnostics,
      });
      pluginResolution = resolvePluginEnablement({
        pluginCascadeKind,
        discoveredPlugins: pluginCascade.items,
        overrideChain,
      });
    }
  }

  for (const cascadeKind of ownedCascadeKinds) {
    if (cascadeKind === pluginCascadeKind) continue;
    if (failed.has(cascadeKind)) continue;
    const cascade = input.discoveryByCascade[cascadeKind];
    if (!cascade) continue;
    views[cascadeKind] = resolveCascadeView({
      cascadeKind,
      scope: input.scope,
      overrideChain,
      discoveredItems: cascade.items,
      metadata: metadataRegistry.get(cascadeKind),
      discoveryDiagnostics: cascade.diagnostics,
      // Every non-plugin cascade consumes the plugin enablement map (plugins
      // can contribute skills/agents that a plugin-level disable must drop).
      pluginResolution,
    });
  }

  const failedCascadeKinds = [...failed];
  const diagnostics: AgentCapabilityDiagnostic[] = [
    ...collectFailedCascadeDiagnostics({
      discoveryByCascade: input.discoveryByCascade,
      failedCascadeKinds,
      metadataRegistry,
    }),
    ...collectViewDiagnostics(views),
  ];

  const capabilities = projectResolvedCascade(input.backend, views);

  return {
    backend: input.backend,
    capabilities,
    diagnostics,
    runtimeState: buildRuntimeState({
      capabilities,
      metadataRegistry,
    }),
    views,
    failedCascadeKinds,
  };
}

/**
 * Project resolved views into the neutral seam cascade: one kind entry per
 * resolved view, carrying the runtime-emittable rows with their effective
 * enablement + deciding layer. Stale and verification-gated rows never reach
 * the seam.
 */
export function projectResolvedCascade(
  backend: AgentBackendId,
  views: Partial<
    Record<AgentCapabilityCascadeKind, AgentCapabilityViewResponse>
  >,
): ResolvedCapabilityCascade {
  const kinds: ResolvedCapabilityKind[] = [];
  for (const { cascadeKind } of ownedCascadesForBackend(backend)) {
    const view = views[cascadeKind];
    if (!view) continue;
    const items: ResolvedCapabilityItem[] = [];
    for (const row of view.items) {
      if (!row.runtimeEmittable) continue;
      items.push({
        itemId: row.itemId,
        enabled: row.effectiveState.enabled,
        originLayer: row.effectiveState.originLayer,
      });
    }
    kinds.push({ kind: decodeCascadeKind(cascadeKind).kind, items });
  }
  return { backend, kinds };
}

interface BuildRuntimeStateInput {
  capabilities: ResolvedCapabilityCascade;
  metadataRegistry: AgentCapabilityMetadataRegistry;
}

function buildRuntimeState(
  input: BuildRuntimeStateInput,
): AgentCapabilityRuntimeApplicationState {
  const seededCascades: SeededCascade[] = [];
  for (const kind of input.capabilities.kinds) {
    const cascadeKind = encodeCascadeKind({
      backend: input.capabilities.backend,
      kind: kind.kind,
    });
    const metadata = input.metadataRegistry.get(cascadeKind);
    if (metadata.compositionSupport === "verification-gated") {
      continue;
    }
    const hashRows = kind.items.filter((item) => item.originLayer !== "native");
    seededCascades.push({
      cascadeKind,
      pendingHash: computeCascadeRuntimeHash({
        cascadeKind,
        rows: hashRows,
      }),
      pendingItemIds: hashRows.map((row) => row.itemId),
      lastApplyStatus: "staged-next-turn",
    });
  }
  return seedRuntimeApplicationState(seededCascades);
}

function collectViewDiagnostics(
  views: Partial<
    Record<AgentCapabilityCascadeKind, AgentCapabilityViewResponse>
  >,
): readonly AgentCapabilityDiagnostic[] {
  const out: AgentCapabilityDiagnostic[] = [];
  for (const view of Object.values(views)) {
    if (!view) continue;
    out.push(...view.diagnostics);
  }
  return out;
}

function collectFailedCascadeDiagnostics(input: {
  discoveryByCascade: ComposeConversationStartInput["discoveryByCascade"];
  failedCascadeKinds: readonly AgentCapabilityCascadeKind[];
  metadataRegistry: AgentCapabilityMetadataRegistry;
}): readonly AgentCapabilityDiagnostic[] {
  const out: AgentCapabilityDiagnostic[] = [];
  for (const cascadeKind of input.failedCascadeKinds) {
    const cascadeDiagnostics =
      input.discoveryByCascade[cascadeKind]?.diagnostics ?? [];
    if (cascadeDiagnostics.length > 0) {
      out.push(...cascadeDiagnostics);
      continue;
    }
    const metadata = input.metadataRegistry.get(cascadeKind);
    out.push({
      severity: "error",
      code: "agent-capability-compose-failed",
      message:
        "Capability composition was skipped for this cascade; native backend defaults will be used.",
      backend: metadata.backend,
      cascadeKind,
    });
  }
  return out;
}
