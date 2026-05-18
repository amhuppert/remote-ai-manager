/**
 * Conversation-start runtime composer.
 *
 * Glues four layers (resolver, plugin enablement map, backend translators,
 * runtime hash seeding) into a single backend-scoped composition pass that
 * runs at the moment a new conversation runtime is created:
 *
 *   1. Filter the cascades to the active backend's owned set so a Claude
 *      conversation never reads codex discovery and vice versa.
 *   2. Resolve the plugin cascade first when the backend has one, then build
 *      a `PluginEnablementMap` from the same input so child cascades
 *      (claude-skills, claude-agents, codex-skills) see the correct
 *      forced-disable state.
 *   3. Resolve the remaining cascades, threading the plugin map in where it
 *      applies.
 *   4. Hand the resolved views to the backend translator
 *      (`translateClaudeRuntimeCapabilities` or
 *      `translateCodexRuntimeCapabilities`).
 *   5. Compute a per-cascade runtime hash over each translator emission and
 *      seed the conversation runtime apply state. Verification-gated cascades
 *      are not seeded because they are not runtime-emittable.
 *
 * Failure isolation: a cascade listed in `failedCascadeKinds` is skipped
 * entirely — no resolution, no emission, no seed entry. The caller wires
 * those failures back as separate cascade-scoped diagnostics. Sibling
 * cascades on the same backend compose normally.
 *
 * Purity: this module performs no I/O. Discovery results, native plugin
 * snapshots, and override chains are all caller-provided so the composer can
 * be exercised deterministically in tests without spawning agent processes
 * or reading the filesystem.
 */

import {
  defaultAgentCapabilityMetadataRegistry,
  type AgentCapabilityMetadataRegistry,
} from "./metadata";
import {
  resolveCascadeView,
  resolvePluginEnablement,
  type PluginEnablementMap,
} from "./resolver";
import {
  translateClaudeRuntimeCapabilities,
  type ClaudeRuntimeCapabilityConfig,
} from "./claude-runtime-translator";
import {
  translateCodexRuntimeCapabilities,
  type CodexRuntimeCapabilityConfig,
} from "./codex-runtime-translator";
import {
  computeCascadeRuntimeHash,
  seedRuntimeApplicationState,
  type SeededCascade,
} from "./runtime-hashes";
import type { ClaudePluginNativeRecord } from "./claude-plugin-translator";

import type {
  AgentBackendId,
  AgentCapabilityApplyStatus,
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeLayer,
  AgentCapabilityDiagnostic,
  AgentCapabilityDiscoveredItem,
  AgentCapabilityOverrides,
  AgentCapabilityRuntimeApplicationState,
  AgentCapabilityScopeContext,
  AgentCapabilityViewResponse,
} from "@/lib/schemas";

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
   * entirely — no resolution, no translator call, no seeded state — so the
   * runtime falls back to the backend's native defaults for those cascades.
   */
  failedCascadeKinds?: readonly AgentCapabilityCascadeKind[];
  /**
   * Adapter-private Claude plugin snapshots from `discoverClaudePlugins`.
   * Used by the Claude plugin translator to compute a minimal flag-layer
   * delta against native extended settings. Ignored when `backend !== "claude"`.
   */
  nativePluginRecords?: readonly ClaudePluginNativeRecord[];
  metadataRegistry?: AgentCapabilityMetadataRegistry;
}

export interface ComposeConversationStartResult {
  backend: AgentBackendId;
  /** Present when `backend === "claude"`. */
  claudeRuntime?: ClaudeRuntimeCapabilityConfig;
  /** Present when `backend === "codex"`. */
  codexRuntime?: {
    config: CodexRuntimeCapabilityConfig["config"];
    applySemantics: "next-turn";
  };
  /** All cascade diagnostics, in resolver-then-translator order. */
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

const BACKEND_CASCADES: Readonly<
  Record<AgentBackendId, readonly AgentCapabilityCascadeKind[]>
> = {
  claude: ["claude-plugins", "claude-skills", "claude-agents"],
  codex: ["codex-plugins", "codex-skills"],
};

const PLUGIN_CASCADE_FOR_BACKEND: Readonly<
  Record<AgentBackendId, "claude-plugins" | "codex-plugins">
> = {
  claude: "claude-plugins",
  codex: "codex-plugins",
};

const CHILD_CASCADES_USING_PLUGIN_MAP: Readonly<
  Record<AgentBackendId, readonly AgentCapabilityCascadeKind[]>
> = {
  claude: ["claude-skills", "claude-agents"],
  codex: ["codex-skills"],
};

export function composeConversationStartRuntime(
  input: ComposeConversationStartInput,
): ComposeConversationStartResult {
  const metadataRegistry =
    input.metadataRegistry ?? defaultAgentCapabilityMetadataRegistry;
  const failed = new Set<AgentCapabilityCascadeKind>(
    input.failedCascadeKinds ?? [],
  );

  const ownedCascades = BACKEND_CASCADES[input.backend];
  const pluginCascadeKind = PLUGIN_CASCADE_FOR_BACKEND[input.backend];
  const childCascadesUsingPluginMap = new Set<AgentCapabilityCascadeKind>(
    CHILD_CASCADES_USING_PLUGIN_MAP[input.backend],
  );

  // Resolve the plugin cascade first when present and not failed so child
  // cascades can consume the resulting enablement map.
  let pluginResolution: PluginEnablementMap | undefined;
  const views: Partial<
    Record<AgentCapabilityCascadeKind, AgentCapabilityViewResponse>
  > = {};

  if (!failed.has(pluginCascadeKind)) {
    const pluginCascade = input.discoveryByCascade[pluginCascadeKind];
    if (pluginCascade) {
      views[pluginCascadeKind] = resolveCascadeView({
        cascadeKind: pluginCascadeKind,
        scope: input.scope,
        overrideChain: input.overrideChain,
        discoveredItems: pluginCascade.items,
        metadata: metadataRegistry.get(pluginCascadeKind),
        discoveryDiagnostics: pluginCascade.diagnostics,
      });
      pluginResolution = resolvePluginEnablement({
        pluginCascadeKind,
        discoveredPlugins: pluginCascade.items,
        overrideChain: input.overrideChain,
      });
    }
  }

  for (const cascadeKind of ownedCascades) {
    if (cascadeKind === pluginCascadeKind) continue;
    if (failed.has(cascadeKind)) continue;
    const cascade = input.discoveryByCascade[cascadeKind];
    if (!cascade) continue;
    views[cascadeKind] = resolveCascadeView({
      cascadeKind,
      scope: input.scope,
      overrideChain: input.overrideChain,
      discoveredItems: cascade.items,
      metadata: metadataRegistry.get(cascadeKind),
      discoveryDiagnostics: cascade.diagnostics,
      pluginResolution: childCascadesUsingPluginMap.has(cascadeKind)
        ? pluginResolution
        : undefined,
    });
  }

  const failedCascadeKinds = [...failed];
  const failedCascadeDiagnostics = collectFailedCascadeDiagnostics({
    discoveryByCascade: input.discoveryByCascade,
    failedCascadeKinds,
    metadataRegistry,
  });

  if (input.backend === "claude") {
    return composeClaude({
      scope: input.scope,
      views,
      nativePluginRecords: input.nativePluginRecords ?? [],
      metadataRegistry,
      failedCascadeKinds,
      failedCascadeDiagnostics,
    });
  }

  return composeCodex({
    views,
    metadataRegistry,
    failedCascadeKinds,
    failedCascadeDiagnostics,
  });
}

interface ComposeClaudeInput {
  scope: AgentCapabilityScopeContext;
  views: Partial<
    Record<AgentCapabilityCascadeKind, AgentCapabilityViewResponse>
  >;
  nativePluginRecords: readonly ClaudePluginNativeRecord[];
  metadataRegistry: AgentCapabilityMetadataRegistry;
  failedCascadeKinds: readonly AgentCapabilityCascadeKind[];
  failedCascadeDiagnostics: readonly AgentCapabilityDiagnostic[];
}

function composeClaude(
  input: ComposeClaudeInput,
): ComposeConversationStartResult {
  const translation = translateClaudeRuntimeCapabilities({
    skillsView: input.views["claude-skills"],
    pluginsView: input.views["claude-plugins"],
    agentsView: input.views["claude-agents"],
    nativePluginRecords: input.nativePluginRecords,
  });

  const diagnostics: AgentCapabilityDiagnostic[] = [
    ...input.failedCascadeDiagnostics,
    ...collectViewDiagnostics(input.views),
    ...translation.diagnostics,
  ];

  const runtimeState = buildRuntimeState({
    emissions: translation.emissions.map((e) => ({
      cascadeKind: e.cascadeKind,
      emittedRows: e.emittedRows,
    })),
    statusFor: () => "staged-next-turn",
    metadataRegistry: input.metadataRegistry,
  });

  return {
    backend: "claude",
    claudeRuntime: translation.config,
    diagnostics,
    runtimeState,
    views: input.views,
    failedCascadeKinds: input.failedCascadeKinds,
  };
}

interface ComposeCodexInput {
  views: Partial<
    Record<AgentCapabilityCascadeKind, AgentCapabilityViewResponse>
  >;
  metadataRegistry: AgentCapabilityMetadataRegistry;
  failedCascadeKinds: readonly AgentCapabilityCascadeKind[];
  failedCascadeDiagnostics: readonly AgentCapabilityDiagnostic[];
}

function composeCodex(
  input: ComposeCodexInput,
): ComposeConversationStartResult {
  const translation = translateCodexRuntimeCapabilities({
    skillsView: input.views["codex-skills"],
    pluginsView: input.views["codex-plugins"],
  });

  const diagnostics: AgentCapabilityDiagnostic[] = [
    ...input.failedCascadeDiagnostics,
    ...collectViewDiagnostics(input.views),
    ...translation.diagnostics,
  ];

  const runtimeState = buildRuntimeState({
    emissions: translation.emissions.map((e) => ({
      cascadeKind: e.cascadeKind,
      emittedRows: e.emittedRows,
    })),
    statusFor: () => "staged-next-turn",
    metadataRegistry: input.metadataRegistry,
  });
  const hasRuntimeEmission = Object.keys(runtimeState.cascades).length > 0;

  return {
    backend: "codex",
    ...(hasRuntimeEmission
      ? {
          codexRuntime: {
            config: translation.config,
            applySemantics: translation.applySemantics,
          },
        }
      : {}),
    diagnostics,
    runtimeState,
    views: input.views,
    failedCascadeKinds: input.failedCascadeKinds,
  };
}

interface BuildRuntimeStateInput {
  emissions: readonly {
    cascadeKind: AgentCapabilityCascadeKind;
    emittedRows: readonly { itemId: string; enabled: boolean }[];
  }[];
  statusFor(
    cascadeKind: AgentCapabilityCascadeKind,
  ): AgentCapabilityApplyStatus;
  metadataRegistry: AgentCapabilityMetadataRegistry;
}

function buildRuntimeState(
  input: BuildRuntimeStateInput,
): AgentCapabilityRuntimeApplicationState {
  const seededCascades: SeededCascade[] = [];
  for (const emission of input.emissions) {
    const metadata = input.metadataRegistry.get(emission.cascadeKind);
    if (metadata.compositionSupport === "verification-gated") {
      continue;
    }
    seededCascades.push({
      cascadeKind: emission.cascadeKind,
      pendingHash: computeCascadeRuntimeHash({
        cascadeKind: emission.cascadeKind,
        rows: emission.emittedRows,
      }),
      pendingItemIds: emission.emittedRows.map((row) => row.itemId),
      lastApplyStatus: input.statusFor(emission.cascadeKind),
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
