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
  type FsWriteRestrictionSupport,
  type BackendModelInfo,
  type QueueCapability,
  type SkillTriggerPrefix,
} from "./descriptor";
import { effortLevelSchema, type EffortLevel } from "./schemas";
import {
  claudeBackendMetadata,
  claudeConversationCapabilities,
  claudeConversationFsWriteRestriction,
  claudeTaskFsWriteRestriction,
} from "./claude/descriptor";
import {
  codexBackendMetadata,
  codexConversationCapabilities,
  codexConversationFsWriteRestriction,
  codexTaskFsWriteRestriction,
} from "./codex/descriptor";
import {
  cursorBackendMetadata,
  cursorConversationCapabilities,
  cursorConversationFsWriteRestriction,
} from "./cursor/descriptor";

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

/**
 * Which execution facets the backend declares. Client-safe, because the pickers
 * embedded in task, workflow-role, and collaboration surfaces have to decide
 * whether an option is selectable — and the descriptors that own that answer
 * are server-only. Without this the facets were invisible to the client and a
 * picker could only have guessed, or branched on backend identity (spec D13).
 */
export const backendCatalogFacetsSchema = z.object({
  conversation: z.boolean(),
  tasks: z.boolean(),
});

export const backendCatalogEntrySchema = z.object({
  id: agentBackendSchema,
  label: z.string(),
  toneToken: z.string(),
  skillTriggerPrefix: skillTriggerPrefixSchema,
  models: z.array(backendCatalogModelSchema),
  defaultModelId: z.string(),
  defaultTimeoutMs: z.number().nullable(),
  facets: backendCatalogFacetsSchema,
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
  facets: BackendCatalogEntry["facets"],
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
    facets,
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
    {
      conversation: descriptor.conversation !== undefined,
      tasks: descriptor.tasks !== undefined,
    },
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
    { conversation: true, tasks: true },
  ),
  codex: buildCatalogEntry(
    "codex",
    codexBackendMetadata,
    codexConversationCapabilities,
    { conversation: true, tasks: true },
  ),
  cursor: buildCatalogEntry(
    "cursor",
    cursorBackendMetadata,
    cursorConversationCapabilities,
    // Conversation only: Cursor registers no task facet in Phase 1.
    { conversation: true, tasks: false },
  ),
};

const BACKEND_METADATA: Readonly<Record<AgentBackendId, AgentBackendMetadata>> =
  {
    claude: claudeBackendMetadata,
    codex: codexBackendMetadata,
    cursor: cursorBackendMetadata,
  };

const CONVERSATION_CAPABILITIES: Readonly<
  Record<AgentBackendId, BackendConversationCapabilities>
> = {
  claude: claudeConversationCapabilities,
  codex: codexConversationCapabilities,
  cursor: cursorConversationCapabilities,
};

/**
 * The same literals the registered descriptors' task facets are built from —
 * re-exposed here because definition validate is client-imported and cannot
 * reach the registry, which holds the server-only task runners.
 *
 * A backend with no task facet declares "unsupported": there is no task runner
 * to confine writes, so the validator-eligibility gate that reads this refuses
 * it for exactly the right reason rather than by a missing-key accident.
 */
const TASK_FS_WRITE_RESTRICTION: Readonly<
  Record<AgentBackendId, FsWriteRestrictionSupport>
> = {
  claude: claudeTaskFsWriteRestriction,
  codex: codexTaskFsWriteRestriction,
  cursor: "unsupported",
};

/** The conversation-facet twin, for the implementer dispatch gate. */
const CONVERSATION_FS_WRITE_RESTRICTION: Readonly<
  Record<AgentBackendId, FsWriteRestrictionSupport>
> = {
  claude: claudeConversationFsWriteRestriction,
  codex: codexConversationFsWriteRestriction,
  cursor: cursorConversationFsWriteRestriction,
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

function isModelOwnedByAnotherBackend(
  backend: AgentBackendId,
  model: string,
): boolean {
  return agentBackendSchema.options.some(
    (candidate) =>
      candidate !== backend &&
      getBackendCatalogEntry(candidate).models.some(
        (option) => option.id === model,
      ),
  );
}

export function isModelCompatibleWithBackend(
  backend: AgentBackendId,
  model: string,
): boolean {
  return (
    model.trim().length > 0 && !isModelOwnedByAnotherBackend(backend, model)
  );
}

export function modelOptionsForCatalogEntry(
  entry: BackendCatalogEntry,
  configuredModel?: string,
): BackendCatalogEntry["models"] {
  if (
    entry.id !== "codex" ||
    !configuredModel?.trim() ||
    entry.models.some((model) => model.id === configuredModel) ||
    isModelOwnedByAnotherBackend(entry.id, configuredModel)
  ) {
    return entry.models;
  }

  return [
    {
      id: configuredModel,
      label: configuredModel,
      description: "Custom Codex model configured globally.",
      effortLevels: [...effortLevelSchema.options],
    },
    ...entry.models,
  ];
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

export function isSelectableModelForBackend(
  backend: AgentBackendId,
  model: string,
): boolean {
  if (model.trim().length === 0) return false;
  const entry = getBackendCatalogEntry(backend);
  if (entry.models.some((option) => option.id === model)) return true;
  return entry.id === "codex" && isModelCompatibleWithBackend(backend, model);
}

export function getDefaultModelForBackend(backend: AgentBackendId): string {
  return getBackendCatalogEntry(backend).defaultModelId;
}

/**
 * Whether the backend's task facet can mechanically enforce a write allowlist
 * (see {@link FsWriteRestrictionSupport}). Read by definition validate to refuse
 * a validator assignment that could only be asked to stay read-only.
 */
export function getFsWriteRestrictionForBackend(
  backend: AgentBackendId,
): FsWriteRestrictionSupport {
  return TASK_FS_WRITE_RESTRICTION[backend];
}

/**
 * The same question for the CONVERSATION facet, which is the path graph-workflow
 * implementers dispatch through. Read before an owning or read-only implementer
 * turn so a backend that cannot confine writes is refused rather than run.
 */
export function getConversationFsWriteRestrictionForBackend(
  backend: AgentBackendId,
): FsWriteRestrictionSupport {
  return CONVERSATION_FS_WRITE_RESTRICTION[backend];
}

/** Runtime inactivity default declared by the backend metadata. */
export function getDefaultStallTimeoutForBackend(
  backend: AgentBackendId,
): number | null | undefined {
  return BACKEND_METADATA[backend].defaultStallTimeoutMs;
}

/**
 * Effort/reasoning levels for a backend + optional model. An unknown model id
 * (custom Codex models are legal config) accepts the canonical cross-backend
 * effort vocabulary; the backend adapter remains the authority for a custom
 * model's actual support.
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
  return [...effortLevelSchema.options];
}

export interface BackendSelectionDefaults {
  modelId: string;
  /** UI preference retained even when the selected model hides effort input. */
  effort: EffortLevel;
  codexFastMode?: boolean;
}

export type BackendSelectionDefaultsById = Readonly<
  Record<AgentBackendId, BackendSelectionDefaults>
>;

/**
 * The per-backend profile fields that selection defaults derive from — the
 * structural subset of the global config satisfied by both `GlobalConfig`
 * and `ConversationTurnConfig`.
 */
export interface ConfiguredBackendSelectionProfiles {
  agentBackends: Readonly<
    Record<
      AgentBackendId,
      {
        model: string;
        reasoningEffort?: string | undefined;
        fastMode?: boolean | undefined;
      }
    >
  >;
}

/** Project configured backend profiles into conversation selection controls. */
export function resolveConfiguredBackendSelectionDefaults(
  config: ConfiguredBackendSelectionProfiles,
): BackendSelectionDefaultsById {
  return Object.fromEntries(
    agentBackendSchema.options.map((backend) => {
      const profile = config.agentBackends[backend];
      const parsed = effortLevelSchema.safeParse(profile.reasoningEffort);
      return [
        backend,
        {
          modelId: profile.model,
          effort: parsed.success ? parsed.data : "high",
          ...(backend === "codex"
            ? { codexFastMode: profile.fastMode ?? false }
            : {}),
        },
      ];
    }),
  ) as Record<AgentBackendId, BackendSelectionDefaults>;
}

export function backendLabel(backend: AgentBackendId): string {
  return getBackendCatalogEntry(backend).label;
}

/**
 * The canonical long name for a model id. Selectors and persisted config hold
 * the SHORT id (`opus`, `sonnet`); every surface that displays a model shows
 * this instead, so no consumer hand-maps ids to names. An id the catalog does
 * not know (a globally configured custom Codex model) displays verbatim —
 * showing the raw id beats inventing a label for it.
 */
export function modelDisplayLabel(
  backend: AgentBackendId,
  model: string,
): string {
  const entry = findBackendCatalogEntry(backend);
  return entry?.models.find((option) => option.id === model)?.label ?? model;
}

/**
 * Catalog-derived selection defaults for client surfaces that have no global
 * config in hand (e.g. pane bodies that only display collaboration state).
 * Surfaces that render selection CONTROLS should thread the config-resolved
 * `resolveConfiguredBackendSelectionDefaults` instead.
 */
export function catalogBackendSelectionDefaults(): BackendSelectionDefaultsById {
  return Object.fromEntries(
    agentBackendSchema.options.map((backend) => {
      const entry = getBackendCatalogEntry(backend);
      const levels = getEffortLevelsForBackend(backend, entry.defaultModelId);
      return [
        backend,
        {
          modelId: entry.defaultModelId,
          effort: levels.includes("high")
            ? ("high" as const)
            : (levels[levels.length - 1] ?? ("high" as const)),
          ...(backend === "codex" ? { codexFastMode: false } : {}),
        },
      ];
    }),
  ) as Record<AgentBackendId, BackendSelectionDefaults>;
}

export function backendToneToken(backend: AgentBackendId): string {
  return getBackendCatalogEntry(backend).toneToken;
}

export function backendSupportsFastMode(backend: AgentBackendId): boolean {
  return backend === "codex";
}

export function skillTriggerPrefixForBackend(
  backend: AgentBackendId,
): SkillTriggerPrefix {
  return getBackendCatalogEntry(backend).skillTriggerPrefix;
}
