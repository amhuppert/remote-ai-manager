import { z } from "zod";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import {
  capabilityApplyTimingSchema,
  capabilityKindSchema,
  continuationStrengthSchema,
  forkSupportSchema,
  queueDeliveryTimingSchema,
  skillTriggerPrefixSchema,
  structuredOutputSupportSchema,
  type AgentBackendDescriptor,
  type AgentBackendMetadata,
  type BackendConversationCapabilities,
  type BackendModelInfo,
  type QueueCapability,
  type SkillTriggerPrefix,
} from "./descriptor";
import { effortLevelSchema, type EffortLevel } from "./schemas";
import {
  claudeBackendMetadata,
  claudeConversationCapabilities,
} from "./claude/descriptor";
import {
  codexBackendMetadata,
  codexConversationCapabilities,
} from "./codex/descriptor";

// ---------------------------------------------------------------------------
// Wire shape — served by GET /api/agent-backends and parsed by the UI hook.
// Metadata + capability labels only; no provider config payloads.
// ---------------------------------------------------------------------------

export const backendCatalogModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  effortLevels: z.array(effortLevelSchema),
});

export const backendCatalogCapabilitiesSchema = z.object({
  queue: z.object({
    acceptsWhileRunning: z.boolean(),
    deliveryTiming: queueDeliveryTimingSchema,
  }),
  continuationStrength: continuationStrengthSchema,
  fork: forkSupportSchema,
  structuredOutput: structuredOutputSupportSchema,
  contextWindowMetrics: z.boolean(),
  nativeMidTurnAskUser: z.boolean(),
  externalTurns: z.boolean(),
  capabilityKinds: z.array(
    z.object({
      kind: capabilityKindSchema,
      applyTiming: capabilityApplyTimingSchema,
    }),
  ),
});

export const backendCatalogEntrySchema = z.object({
  id: agentBackendSchema,
  label: z.string(),
  toneToken: z.string(),
  skillTriggerPrefix: skillTriggerPrefixSchema,
  models: z.array(backendCatalogModelSchema),
  defaultModelId: z.string(),
  defaultTimeoutMs: z.number().nullable(),
  /** Null for a backend without a conversation facet. */
  capabilities: backendCatalogCapabilitiesSchema.nullable(),
});
export type BackendCatalogEntry = z.infer<typeof backendCatalogEntrySchema>;

export const backendCatalogResponseSchema = z.object({
  backends: z.array(backendCatalogEntrySchema),
});
export type BackendCatalogResponse = z.infer<
  typeof backendCatalogResponseSchema
>;

function buildCatalogEntry(
  id: AgentBackendId,
  metadata: AgentBackendMetadata,
  capabilities: BackendConversationCapabilities | null,
): BackendCatalogEntry {
  return backendCatalogEntrySchema.parse({
    id,
    label: metadata.label,
    toneToken: metadata.toneToken,
    skillTriggerPrefix: metadata.skillTriggerPrefix,
    models: metadata.models.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      effortLevels: [...m.effortLevels],
    })),
    defaultModelId: metadata.defaultModelId,
    defaultTimeoutMs: metadata.defaultTimeoutMs,
    capabilities,
  });
}

/** Wire projection of a registered descriptor, used by the catalog route. */
export function catalogEntryFromDescriptor(
  descriptor: AgentBackendDescriptor,
): BackendCatalogEntry {
  return buildCatalogEntry(
    descriptor.id,
    descriptor.metadata,
    descriptor.conversation?.capabilities ?? null,
  );
}

// ---------------------------------------------------------------------------
// Client-safe catalog — the same metadata/capability literals the registered
// descriptors embed, importable from client components (the full registry
// pulls the SDK-backed adapters and is server-only).
// ---------------------------------------------------------------------------

const CATALOG: Readonly<Record<AgentBackendId, BackendCatalogEntry>> = {
  claude: buildCatalogEntry(
    "claude",
    claudeBackendMetadata,
    claudeConversationCapabilities,
  ),
  codex: buildCatalogEntry(
    "codex",
    codexBackendMetadata,
    codexConversationCapabilities,
  ),
};

const CONVERSATION_CAPABILITIES: Readonly<
  Record<AgentBackendId, BackendConversationCapabilities>
> = {
  claude: claudeConversationCapabilities,
  codex: codexConversationCapabilities,
};

/**
 * The declared conversation capabilities for a backend, importable without
 * crossing into the adapter directories. Same literals the registered
 * descriptors embed.
 */
export function conversationCapabilitiesForBackend(
  backend: AgentBackendId,
): BackendConversationCapabilities {
  const capabilities = CONVERSATION_CAPABILITIES[backend];
  if (!capabilities) {
    throw new Error(`Unknown agent backend: ${backend}`);
  }
  return capabilities;
}

/**
 * Safe lookup for untrusted/runtime ids: parses through the canonical backend
 * schema and returns null on any unknown id — never coerces to a default
 * backend. Presentation components use this to render an explicit
 * unknown-backend state.
 */
export function findBackendCatalogEntry(
  id: string,
): BackendCatalogEntry | null {
  const parsed = agentBackendSchema.safeParse(id);
  if (!parsed.success) return null;
  return CATALOG[parsed.data] ?? null;
}

/** Throws on an id outside the catalog — never silently falls back. */
export function getBackendCatalogEntry(
  backend: AgentBackendId,
): BackendCatalogEntry {
  const entry = CATALOG[backend];
  if (!entry) {
    throw new Error(`Unknown agent backend: ${backend}`);
  }
  return entry;
}

export function listBackendCatalogEntries(): readonly BackendCatalogEntry[] {
  return Object.values(CATALOG);
}

export function queueCapabilityForBackend(
  backend: AgentBackendId,
): QueueCapability {
  const capabilities = getBackendCatalogEntry(backend).capabilities;
  if (!capabilities) {
    throw new Error(`Backend "${backend}" declares no conversation facet`);
  }
  return capabilities.queue;
}

export function getModelsForBackend(
  backend: AgentBackendId,
): readonly BackendModelInfo[] {
  return getBackendCatalogEntry(backend).models;
}

export function getDefaultModelForBackend(backend: AgentBackendId): string {
  return getBackendCatalogEntry(backend).defaultModelId;
}

/**
 * Effort/reasoning levels for a backend + optional model. An unknown model id
 * (custom Codex models are legal config) resolves to the union of every level
 * some cataloged model of that backend supports.
 */
export function getEffortLevelsForBackend(
  backend: AgentBackendId,
  model?: string,
): EffortLevel[] {
  return effortLevelsForCatalogEntry(getBackendCatalogEntry(backend), model);
}

/**
 * Same resolution over an already-resolved catalog entry — the form for
 * consumers holding live `useBackendCatalogQuery()` data.
 */
export function effortLevelsForCatalogEntry(
  entry: BackendCatalogEntry,
  model?: string,
): EffortLevel[] {
  const match = entry.models.find(
    (m) => m.id === (model ?? entry.defaultModelId),
  );
  if (match) return [...match.effortLevels];
  const declared = new Set(entry.models.flatMap((m) => m.effortLevels));
  return effortLevelSchema.options.filter((level) => declared.has(level));
}

export function backendLabel(backend: AgentBackendId): string {
  return getBackendCatalogEntry(backend).label;
}

export function backendToneToken(backend: AgentBackendId): string {
  return getBackendCatalogEntry(backend).toneToken;
}

export function skillTriggerPrefixForBackend(
  backend: AgentBackendId,
): SkillTriggerPrefix {
  return getBackendCatalogEntry(backend).skillTriggerPrefix;
}
