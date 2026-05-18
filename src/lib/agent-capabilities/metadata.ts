/**
 * Agent capability metadata registry.
 *
 * Encodes per-cascade backend ownership, discovery availability, runtime
 * visibility, composition strategy, and apply semantics so that UI and runtime
 * decisions can branch on data rather than scattered backend identity checks.
 *
 * The `AgentCapabilityMetadata` shape is derived from
 * `agentCapabilityMetadataSchema` in `@/lib/schemas` (the same Zod schema also
 * powers the API view's `metadata` field). Every record handed to
 * `createAgentCapabilityMetadataRegistry()` is parsed at the boundary so
 * cascade/backend ownership and field completeness are enforced structurally —
 * there are no hand-written types or trust-the-caller paths in this module.
 *
 * Verification-gated cascades (currently `codex-plugins`) are represented here
 * with `discoverySupport: "unavailable-pending-verification"` so the UI and
 * runtime composer can keep the panel present while refusing to emit runtime
 * configuration until an authoritative discovery source is proven.
 */

import {
  AGENT_CAPABILITY_CASCADE_KINDS,
  agentCapabilityMetadataSchema,
  type AgentBackendId,
  type AgentCapabilityApplySemantics,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCompositionSupport,
  type AgentCapabilityDiscoverySupport,
  type AgentCapabilityKind,
  type AgentCapabilityMetadata,
  type AgentCapabilityMetadataRuntimeVisibility as AgentCapabilityRuntimeVisibility,
} from "@/lib/schemas";

export {
  AGENT_CAPABILITY_CASCADE_KINDS,
  agentCapabilityMetadataSchema,
  type AgentCapabilityApplySemantics,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCompositionSupport,
  type AgentCapabilityDiscoverySupport,
  type AgentCapabilityKind,
  type AgentCapabilityMetadata,
  type AgentCapabilityRuntimeVisibility,
};

export interface AgentCapabilityMetadataRegistry {
  get(cascadeKind: AgentCapabilityCascadeKind): AgentCapabilityMetadata;
  listForBackend(backend: AgentBackendId): readonly AgentCapabilityMetadata[];
}

export const agentCapabilityMetadata: readonly AgentCapabilityMetadata[] = [
  agentCapabilityMetadataSchema.parse({
    cascadeKind: "claude-skills",
    backend: "claude",
    capabilityKind: "skill",
    applySemantics: "idle-live-apply",
    discoverySupport: "available",
    runtimeVisibility: "sdk-runtime",
    compositionSupport: "translator",
  }),
  agentCapabilityMetadataSchema.parse({
    cascadeKind: "claude-plugins",
    backend: "claude",
    capabilityKind: "plugin",
    applySemantics: "idle-live-apply",
    discoverySupport: "available",
    runtimeVisibility: "sdk-runtime",
    compositionSupport: "translator",
  }),
  // The installed Claude SDK `Settings` has no typed per-agent disable map.
  // Verified suppression strategy is permission-layer denial of Task tool
  // invocations on disabled agents; that callback is bound at session
  // creation so live-flip during a turn is unsupported. Plugin-level disable
  // remains the only path that drops a plugin-contributed agent mid-session
  // via `reloadPlugins()`.
  agentCapabilityMetadataSchema.parse({
    cascadeKind: "claude-agents",
    backend: "claude",
    capabilityKind: "agent",
    applySemantics: "next-conversation",
    discoverySupport: "available",
    runtimeVisibility: "sdk-runtime",
    compositionSupport: "translator",
  }),
  // Skill files are readable from disk so discovery is available, but the
  // installed @openai/codex-sdk typings expose only a generic
  // `CodexOptions.config` pass-through with no documented per-skill key.
  // Until the concrete config key is verified against the installed CLI,
  // composition is verification-gated: the translator must refuse to emit
  // runtime config and the UI must refuse to expose editable runtime
  // behavior for this cascade.
  agentCapabilityMetadataSchema.parse({
    cascadeKind: "codex-skills",
    backend: "codex",
    capabilityKind: "skill",
    applySemantics: "next-turn",
    discoverySupport: "available",
    runtimeVisibility: "source-only",
    compositionSupport: "verification-gated",
  }),
  // Codex SDK exposes no typed plugin API and the design has not yet
  // verified an authoritative installed/enabled plugin discovery source.
  // Until 1.1 verification lands, this cascade is present (so the UI can
  // render a placeholder panel with diagnostics) but neither discovery nor
  // composition is permitted to emit runtime configuration.
  agentCapabilityMetadataSchema.parse({
    cascadeKind: "codex-plugins",
    backend: "codex",
    capabilityKind: "plugin",
    applySemantics: "next-turn",
    discoverySupport: "unavailable-pending-verification",
    runtimeVisibility: "unsupported",
    compositionSupport: "verification-gated",
  }),
];

export function createAgentCapabilityMetadataRegistry(
  entries: readonly unknown[],
): AgentCapabilityMetadataRegistry {
  const parsed: AgentCapabilityMetadata[] = entries.map((entry, index) => {
    const result = agentCapabilityMetadataSchema.safeParse(entry);
    if (!result.success) {
      throw new Error(
        `Invalid agent capability metadata record at index ${index}: ${result.error.message}`,
      );
    }
    return result.data;
  });

  const byCascade = new Map<
    AgentCapabilityCascadeKind,
    AgentCapabilityMetadata
  >();
  for (const entry of parsed) {
    if (byCascade.has(entry.cascadeKind)) {
      throw new Error(
        `Duplicate agent capability metadata record for cascade: ${entry.cascadeKind}`,
      );
    }
    byCascade.set(entry.cascadeKind, entry);
  }
  return {
    get(cascadeKind) {
      const record = byCascade.get(cascadeKind);
      if (!record) {
        throw new Error(
          `No agent capability metadata registered for cascade: ${cascadeKind}`,
        );
      }
      return record;
    },
    listForBackend(backend) {
      return parsed.filter((entry) => entry.backend === backend);
    },
  };
}

export const defaultAgentCapabilityMetadataRegistry: AgentCapabilityMetadataRegistry =
  createAgentCapabilityMetadataRegistry(agentCapabilityMetadata);
