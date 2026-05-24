/**
 * Agent capability metadata registry.
 *
 * Encodes per-cascade backend ownership, discovery availability, runtime
 * visibility, composition strategy, and apply semantics so that UI and runtime
 * decisions can branch on data rather than scattered backend identity checks.
 *
 * The `AgentCapabilityMetadata` shape is derived from
 * `agentCapabilityMetadataSchema` in `./schemas` (the same Zod schema also
 * powers the API view's `metadata` field). Every record handed to
 * `createAgentCapabilityMetadataRegistry()` is parsed at the boundary so
 * cascade/backend ownership and field completeness are enforced structurally —
 * there are no hand-written types or trust-the-caller paths in this module.
 */

import { type AgentBackendId } from "@/lib/shared/schemas";
import {
  AGENT_CAPABILITY_CASCADE_KINDS,
  agentCapabilityMetadataSchema,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityMetadata,
} from "./schemas";

export {
  AGENT_CAPABILITY_CASCADE_KINDS,
  agentCapabilityMetadataSchema,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityMetadata,
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
  agentCapabilityMetadataSchema.parse({
    cascadeKind: "codex-skills",
    backend: "codex",
    capabilityKind: "skill",
    applySemantics: "next-turn",
    discoverySupport: "available",
    runtimeVisibility: "source-only",
    compositionSupport: "translator",
  }),
  agentCapabilityMetadataSchema.parse({
    cascadeKind: "codex-plugins",
    backend: "codex",
    capabilityKind: "plugin",
    applySemantics: "next-turn",
    discoverySupport: "available",
    runtimeVisibility: "source-only",
    compositionSupport: "translator",
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
