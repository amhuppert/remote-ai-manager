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
import type { CapabilityApplyTiming } from "@/lib/agent-backends/descriptor";
import { conversationCapabilitiesForBackend } from "@/lib/agent-backends/catalog";
import {
  AGENT_CAPABILITY_CASCADE_KINDS,
  agentCapabilityMetadataSchema,
  decodeCascadeKind,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityMetadata,
} from "./schemas";

export {
  AGENT_CAPABILITY_CASCADE_KINDS,
  agentCapabilityMetadataSchema,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityMetadata,
};

/**
 * Apply timing for a cascade, read from the backend descriptor's declared
 * `capabilityKinds` — the single source of truth for when a runtime-config
 * change reaches the live agent. Throws for a pair no descriptor declares.
 */
export function applyTimingForCascade(
  cascadeKind: AgentCapabilityCascadeKind,
): CapabilityApplyTiming {
  const ref = decodeCascadeKind(cascadeKind);
  const support = conversationCapabilitiesForBackend(
    ref.backend,
  ).capabilityKinds.find((entry) => entry.kind === ref.kind);
  if (!support) {
    throw new Error(
      `backend '${ref.backend}' does not declare capability kind '${ref.kind}'`,
    );
  }
  return support.applyTiming;
}

/** Wire-shape projection of the descriptor's per-kind apply timing; the API
 * view still serves `applySemantics`, but the descriptor owns the value. */
const APPLY_SEMANTICS_FOR_TIMING: Readonly<
  Record<
    CapabilityApplyTiming,
    "idle-live-apply" | "next-turn" | "next-conversation"
  >
> = {
  idle_live: "idle-live-apply",
  next_turn: "next-turn",
  next_conversation: "next-conversation",
};

function applySemanticsForCascade(
  cascadeKind: AgentCapabilityCascadeKind,
): "idle-live-apply" | "next-turn" | "next-conversation" {
  return APPLY_SEMANTICS_FOR_TIMING[applyTimingForCascade(cascadeKind)];
}

export interface AgentCapabilityMetadataRegistry {
  get(cascadeKind: AgentCapabilityCascadeKind): AgentCapabilityMetadata;
  listForBackend(backend: AgentBackendId): readonly AgentCapabilityMetadata[];
}

export const agentCapabilityMetadata: readonly AgentCapabilityMetadata[] =
  AGENT_CAPABILITY_CASCADE_KINDS.map((cascadeKind) => {
    const { backend, kind } = decodeCascadeKind(cascadeKind);
    const support = conversationCapabilitiesForBackend(
      backend,
    ).capabilityKinds.find((entry) => entry.kind === kind);
    if (!support?.catalog)
      throw new Error(`No capability catalog metadata for ${cascadeKind}`);
    return agentCapabilityMetadataSchema.parse({
      cascadeKind,
      backend,
      capabilityKind:
        kind === "skills" ? "skill" : kind === "plugins" ? "plugin" : "agent",
      applySemantics: applySemanticsForCascade(cascadeKind),
      ...support.catalog,
    });
  });

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

/**
 * The plugin and skill cascades a backend owns, or null where it owns none.
 *
 * The composer needs both to know which disabled entries filter a discovered
 * command. Asking the registry rather than deriving `<backend>-plugins` keeps a
 * backend that registers no capability kinds — Cursor attaches under
 * `settingSources: []` — from naming a cascade that does not exist.
 */
export function commandCascadesForBackend(
  backend: AgentBackendId,
  registry: AgentCapabilityMetadataRegistry = defaultAgentCapabilityMetadataRegistry,
): {
  plugins: AgentCapabilityCascadeKind | null;
  skills: AgentCapabilityCascadeKind | null;
} {
  const owned = registry.listForBackend(backend);
  const kindOf = (
    capabilityKind: AgentCapabilityMetadata["capabilityKind"],
  ): AgentCapabilityCascadeKind | null =>
    owned.find((entry) => entry.capabilityKind === capabilityKind)
      ?.cascadeKind ?? null;

  return { plugins: kindOf("plugin"), skills: kindOf("skill") };
}
