import { z } from "zod";
import {
  backendExecutionSchema,
  type BackendExecution,
} from "./execution-admission";
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
import {
  backendModelCatalogSchema,
  effortLevelSchema,
  type BackendModelCatalog,
  type BackendModelDefinition,
  type BackendModelParameterDefinition,
  type BackendModelSelection,
  type EffortLevel,
} from "./schemas";
import { reasoningValueEmphasis } from "./model-scale-emphasis";
import { defaultSelectionForModel } from "./model-selection";
import {
  ModelSelectionPolicyError,
  validateModelSelection,
} from "./model-selection";
import { readGeneratedCursorModelCatalog } from "./cursor/generated-model-catalog-artifact";
import {
  claudeBackendMetadata,
  claudeConversationExecution,
  claudeTaskExecution,
  claudeConversationCapabilities,
  claudeConversationFsWriteRestriction,
  claudeNativeMemory,
  claudeTaskFsWriteRestriction,
} from "./claude/descriptor";
import {
  codexBackendMetadata,
  codexConversationExecution,
  codexTaskExecution,
  codexConversationCapabilities,
  codexConversationFsWriteRestriction,
  codexNativeMemory,
  codexTaskFsWriteRestriction,
} from "./codex/descriptor";
import {
  cursorBackendMetadata,
  cursorConversationExecution,
  cursorConversationCapabilities,
  cursorConversationFsWriteRestriction,
  cursorNativeMemory,
} from "./cursor/descriptor";
import {
  backendNativeMemorySchema,
  type BackendNativeMemory,
} from "./native-memory";

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
  execution: backendExecutionSchema,
  /** Null for a backend without a conversation facet. */
  capabilities: backendCatalogCapabilitiesSchema.nullable(),
  /**
   * What Command Center does about the provider's own memory. Client-safe for
   * the same reason the facets are: the Memory Library has to disclose a
   * backend running a second memory system, and the descriptor that owns the
   * answer is server-only.
   */
  nativeMemory: backendNativeMemorySchema,
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
  nativeMemory: BackendNativeMemory,
  execution: BackendExecution,
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
    nativeMemory,
    execution,
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
    descriptor.nativeMemory,
    {
      conversation: descriptor.conversation
        ? {
            ...descriptor.conversation.execution,
            fsWriteRestriction: descriptor.conversation.fsWriteRestriction,
          }
        : null,
      tasks: descriptor.tasks
        ? {
            ...descriptor.tasks.execution,
            fsWriteRestriction: descriptor.tasks.fsWriteRestriction,
          }
        : null,
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
    claudeNativeMemory,
    {
      conversation: {
        ...claudeConversationExecution,
        fsWriteRestriction: claudeConversationFsWriteRestriction,
      },
      tasks: {
        ...claudeTaskExecution,
        fsWriteRestriction: claudeTaskFsWriteRestriction,
      },
    },
  ),
  codex: buildCatalogEntry(
    "codex",
    codexBackendMetadata,
    codexConversationCapabilities,
    { conversation: true, tasks: true },
    codexNativeMemory,
    {
      conversation: {
        ...codexConversationExecution,
        fsWriteRestriction: codexConversationFsWriteRestriction,
      },
      tasks: {
        ...codexTaskExecution,
        fsWriteRestriction: codexTaskFsWriteRestriction,
      },
    },
  ),
  cursor: buildCatalogEntry(
    "cursor",
    cursorBackendMetadata,
    cursorConversationCapabilities,
    // Conversation only: Cursor registers no task facet in Phase 1.
    { conversation: true, tasks: false },
    cursorNativeMemory,
    {
      conversation: {
        ...cursorConversationExecution,
        fsWriteRestriction: cursorConversationFsWriteRestriction,
      },
      tasks: null,
    },
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
  configuredModel?: string,
): boolean {
  if (model.trim().length === 0) return false;
  const entry = getBackendCatalogEntry(backend);
  if (entry.models.some((option) => option.id === model)) return true;
  return (
    entry.id === "codex" &&
    configuredModel === model &&
    isModelCompatibleWithBackend(backend, model)
  );
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

export type BackendValueMap<Value> = Readonly<{
  [Backend in AgentBackendId]: Value;
}>;

export type BackendSelectionDefaultsById =
  BackendValueMap<BackendModelSelection>;
export type BackendSelectionDefaults = BackendModelSelection;

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
        modelSelection: BackendModelSelection;
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
      return [
        backend,
        {
          modelId: config.agentBackends[backend].modelSelection.modelId,
          parameters: {
            ...config.agentBackends[backend].modelSelection.parameters,
          },
        },
      ];
    }),
  ) as Record<AgentBackendId, BackendModelSelection>;
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
      const catalog = getConfiguredBackendModelCatalog(backend);
      const selection = defaultSelectionForModel(
        catalog,
        catalog.defaultModelId,
      );
      return [backend, selection];
    }),
  ) as Record<AgentBackendId, BackendModelSelection>;
}

export function backendToneToken(backend: AgentBackendId): string {
  return getBackendCatalogEntry(backend).toneToken;
}

const MODEL_DEFINITIONS_BY_BACKEND = new Map<
  AgentBackendId,
  ReadonlyMap<string, BackendModelDefinition>
>();

/**
 * Read-only lookup of a catalog model definition by canonical id or alias.
 *
 * For DISPLAY surfaces holding a persisted selection (transcript metadata) that
 * need the catalog's presentation signals but have no catalog in hand. It
 * neither resolves nor validates a selection — surfaces that submit one go
 * through the project-effective catalog. Returns null for an id this backend's
 * catalog does not know (a custom Codex model, or a selection recorded before a
 * catalog refresh) and for a catalog that cannot be loaded at all.
 */
export function findBackendModelDefinition(
  backend: AgentBackendId,
  modelId: string,
): BackendModelDefinition | null {
  let definitions = MODEL_DEFINITIONS_BY_BACKEND.get(backend);
  if (definitions === undefined) {
    const byIdentifier = new Map<string, BackendModelDefinition>();
    try {
      for (const model of getConfiguredBackendModelCatalog(backend).models) {
        for (const identifier of [model.id, ...model.aliases]) {
          byIdentifier.set(identifier, model);
        }
      }
    } catch {
      // A catalog that cannot load blocks submission elsewhere; a transcript
      // row still renders, just without the catalog's presentation signals.
    }
    definitions = byIdentifier;
    MODEL_DEFINITIONS_BY_BACKEND.set(backend, definitions);
  }
  return definitions.get(modelId) ?? null;
}

export function backendSupportsFastMode(backend: AgentBackendId): boolean {
  return backend === "codex";
}

export function skillTriggerPrefixForBackend(
  backend: AgentBackendId,
): SkillTriggerPrefix {
  return getBackendCatalogEntry(backend).skillTriggerPrefix;
}

function parameterValueLabel(value: string): string {
  if (value === "xhigh") return "Extra high";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function effortParameter(
  id: "effort" | "reasoning",
  levels: readonly string[],
): BackendModelParameterDefinition {
  return {
    id,
    label: id === "effort" ? "Effort" : "Reasoning",
    values: levels.map((value) => {
      const emphasis = reasoningValueEmphasis(id, value);
      return {
        value,
        label: parameterValueLabel(value),
        ...(emphasis === undefined ? {} : { emphasis }),
      };
    }),
    prominence: "primary",
  };
}

function defaultEffort(levels: readonly string[]): string {
  return levels.includes("high") ? "high" : levels[levels.length - 1]!;
}

function claudeModelDefinition(
  model: BackendModelInfo,
): BackendModelDefinition {
  if (model.effortLevels.length === 0) {
    return {
      id: model.id,
      label: model.label,
      description: model.description,
      aliases: [],
      parameters: [],
      variants: [
        {
          selection: { modelId: model.id, parameters: {} },
          label: model.label,
          isDefault: true,
        },
      ],
    };
  }

  const defaultValue = defaultEffort(model.effortLevels);
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    aliases: [],
    parameters: [effortParameter("effort", model.effortLevels)],
    variants: model.effortLevels.map((effort) => ({
      selection: { modelId: model.id, parameters: { effort } },
      label: parameterValueLabel(effort),
      isDefault: effort === defaultValue,
    })),
  };
}

const FAST_PARAMETER: BackendModelParameterDefinition = {
  id: "fast",
  label: "Fast mode",
  values: [
    { value: "false", label: "Off" },
    { value: "true", label: "On" },
  ],
  prominence: "advanced",
};

function codexModelDefinition(
  model: Omit<BackendModelInfo, "effortLevels"> & {
    effortLevels: readonly string[];
  },
): BackendModelDefinition {
  const defaultValue = defaultEffort(model.effortLevels);
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    aliases: [],
    parameters: [
      effortParameter("reasoning", model.effortLevels),
      FAST_PARAMETER,
    ],
    variants: model.effortLevels.flatMap((reasoning) =>
      ["false", "true"].map((fast) => ({
        selection: {
          modelId: model.id,
          parameters: { reasoning, fast },
        },
        label: `${parameterValueLabel(reasoning)} · ${fast === "true" ? "Fast" : "Standard"}`,
        isDefault: reasoning === defaultValue && fast === "false",
      })),
    ),
  };
}

function customCodexModelDefinition(
  configuredSelection: BackendModelSelection | undefined,
  knownModels: readonly BackendModelInfo[],
): BackendModelDefinition | null {
  const id = configuredSelection?.modelId;
  if (
    id === undefined ||
    knownModels.some((model) => model.id === id) ||
    isModelOwnedByAnotherBackend("codex", id)
  ) {
    return null;
  }

  return codexModelDefinition({
    id,
    label: id,
    description: "Custom Codex model configured globally.",
    effortLevels: effortLevelSchema.options,
  });
}

/** Static complete-variant catalog for backends whose models ship with CC. */
export function getStaticBackendModelCatalog(
  backend: "claude" | "codex",
  configuredSelection?: BackendModelSelection,
): BackendModelCatalog {
  const entry = getBackendCatalogEntry(backend);
  const customModel =
    backend === "codex"
      ? customCodexModelDefinition(configuredSelection, entry.models)
      : null;
  const models =
    backend === "claude"
      ? entry.models.map(claudeModelDefinition)
      : [
          ...entry.models.map(codexModelDefinition),
          ...(customModel === null ? [] : [customModel]),
        ];

  return backendModelCatalogSchema.parse({
    backend,
    defaultModelId: entry.defaultModelId,
    models,
    provenance: { source: "Command Center static catalog" },
  });
}

type ConfiguredCatalogLoader = (
  selection?: BackendModelSelection,
) => BackendModelCatalog;

const CONFIGURED_CATALOG_LOADERS = {
  claude: (selection) => getStaticBackendModelCatalog("claude", selection),
  codex: (selection) => getStaticBackendModelCatalog("codex", selection),
  cursor: () => readGeneratedCursorModelCatalog(),
} satisfies { [Backend in AgentBackendId]: ConfiguredCatalogLoader };

/**
 * Complete checked-in catalog for one configured backend profile.
 *
 * Provider sourcing and custom-model admission stay below this boundary; UI
 * consumers render only catalogs and complete selections.
 */
export function getConfiguredBackendModelCatalog(
  backend: AgentBackendId,
  configuredSelection?: BackendModelSelection,
): BackendModelCatalog {
  const catalog = CONFIGURED_CATALOG_LOADERS[backend](configuredSelection);
  if (configuredSelection === undefined) return catalog;
  const validation = validateModelSelection(catalog, configuredSelection);
  if (!validation.valid) {
    throw new ModelSelectionPolicyError(validation.issues);
  }
  return catalog;
}
