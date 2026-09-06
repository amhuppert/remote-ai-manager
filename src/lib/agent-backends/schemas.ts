import { z } from "zod";

import { agentBackendSchema } from "@/lib/shared/schemas";

const backendModelIdentifierSchema = z.string().trim().min(1);

/**
 * One complete backend model choice. Parameters are provider-owned string
 * pairs and are interpreted only against the backend's model catalog.
 */
export const backendModelSelectionSchema = z
  .object({
    modelId: backendModelIdentifierSchema,
    parameters: z.record(backendModelIdentifierSchema, z.string()),
  })
  .strict();
export type BackendModelSelection = z.infer<typeof backendModelSelectionSchema>;

/**
 * Presentation weight a catalog assigns to one parameter value. `exceeds-scale`
 * marks a tier beyond the provider's normal range — the design system's rainbow
 * treatment is reserved for exactly these. The catalog decides, because the
 * spelling is provider-owned (`xhigh`, `extra-high`, `max`) and a presentation
 * layer could only rediscover that vocabulary by branching on parameter ids.
 */
export const backendModelParameterValueEmphasisSchema = z.enum([
  "exceeds-scale",
]);
export type BackendModelParameterValueEmphasis = z.infer<
  typeof backendModelParameterValueEmphasisSchema
>;

export const backendModelParameterValueSchema = z
  .object({
    value: z.string(),
    label: z.string().trim().min(1),
    /** Absent means the value sits within the provider's ordinary scale. */
    emphasis: backendModelParameterValueEmphasisSchema.optional(),
  })
  .strict();
export type BackendModelParameterValue = z.infer<
  typeof backendModelParameterValueSchema
>;

export const backendModelParameterDefinitionSchema = z
  .object({
    id: backendModelIdentifierSchema,
    label: z.string().trim().min(1),
    values: z.array(backendModelParameterValueSchema).min(1),
    prominence: z.enum(["primary", "advanced", "hidden"]),
  })
  .strict();
export type BackendModelParameterDefinition = z.infer<
  typeof backendModelParameterDefinitionSchema
>;

export const backendModelVariantSchema = z
  .object({
    selection: backendModelSelectionSchema,
    label: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    isDefault: z.boolean(),
  })
  .strict();
export type BackendModelVariant = z.infer<typeof backendModelVariantSchema>;

export const backendModelDefinitionSchema = z
  .object({
    id: backendModelIdentifierSchema,
    label: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    aliases: z.array(backendModelIdentifierSchema),
    parameters: z.array(backendModelParameterDefinitionSchema),
    variants: z.array(backendModelVariantSchema).min(1),
  })
  .strict();
export type BackendModelDefinition = z.infer<
  typeof backendModelDefinitionSchema
>;

export const backendModelCatalogProvenanceSchema = z
  .object({
    source: z.string().trim().min(1),
    generatedAt: z.string().datetime().optional(),
    sdkVersion: z.string().trim().min(1).optional(),
  })
  .strict();
export type BackendModelCatalogProvenance = z.infer<
  typeof backendModelCatalogProvenanceSchema
>;

function addCatalogIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function validateModelCatalogDefinition(
  model: BackendModelDefinition,
  modelIndex: number,
  context: z.RefinementCtx,
): void {
  const parameterIndexes = new Map<string, number>();

  model.parameters.forEach((parameter, parameterIndex) => {
    const previousParameterIndex = parameterIndexes.get(parameter.id);
    if (previousParameterIndex !== undefined) {
      addCatalogIssue(
        context,
        ["models", modelIndex, "parameters", parameterIndex, "id"],
        `Parameter id "${parameter.id}" duplicates parameters[${previousParameterIndex}].`,
      );
    } else {
      parameterIndexes.set(parameter.id, parameterIndex);
    }

    const values = new Set<string>();
    parameter.values.forEach(({ value }, valueIndex) => {
      if (values.has(value)) {
        addCatalogIssue(
          context,
          [
            "models",
            modelIndex,
            "parameters",
            parameterIndex,
            "values",
            valueIndex,
            "value",
          ],
          `Parameter value "${value}" is duplicated.`,
        );
      }
      values.add(value);
    });

    if (parameter.values.length === 1 && parameter.prominence !== "hidden") {
      addCatalogIssue(
        context,
        ["models", modelIndex, "parameters", parameterIndex, "prominence"],
        "A parameter with one possible value must be hidden.",
      );
    }
  });

  const declaredParameterIds = new Set(model.parameters.map(({ id }) => id));
  const variantKeys = new Set<string>();
  let defaultCount = 0;

  model.variants.forEach((variant, variantIndex) => {
    if (variant.isDefault) defaultCount += 1;

    if (variant.selection.modelId !== model.id) {
      addCatalogIssue(
        context,
        [
          "models",
          modelIndex,
          "variants",
          variantIndex,
          "selection",
          "modelId",
        ],
        `Variant modelId must equal its containing model id "${model.id}".`,
      );
    }

    const suppliedParameterIds = Object.keys(variant.selection.parameters);
    for (const parameterId of suppliedParameterIds) {
      if (declaredParameterIds.has(parameterId)) continue;
      addCatalogIssue(
        context,
        [
          "models",
          modelIndex,
          "variants",
          variantIndex,
          "selection",
          "parameters",
          parameterId,
        ],
        `Variant supplies undeclared parameter "${parameterId}".`,
      );
    }

    for (const parameter of model.parameters) {
      const value = variant.selection.parameters[parameter.id];
      if (value === undefined) {
        addCatalogIssue(
          context,
          [
            "models",
            modelIndex,
            "variants",
            variantIndex,
            "selection",
            "parameters",
          ],
          `Variant is missing parameter "${parameter.id}".`,
        );
        continue;
      }

      if (!parameter.values.some((candidate) => candidate.value === value)) {
        addCatalogIssue(
          context,
          [
            "models",
            modelIndex,
            "variants",
            variantIndex,
            "selection",
            "parameters",
            parameter.id,
          ],
          `Variant value "${value}" is not declared for parameter "${parameter.id}".`,
        );
      }
    }

    const variantKey = JSON.stringify(
      Object.entries(variant.selection.parameters).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    if (variantKeys.has(variantKey)) {
      addCatalogIssue(
        context,
        ["models", modelIndex, "variants", variantIndex, "selection"],
        "A model cannot declare the same complete selection more than once.",
      );
    }
    variantKeys.add(variantKey);
  });

  if (defaultCount !== 1) {
    addCatalogIssue(
      context,
      ["models", modelIndex, "variants"],
      `Model "${model.id}" must declare exactly one default variant; found ${defaultCount}.`,
    );
  }
}

export const backendModelCatalogSchema = z
  .object({
    backend: agentBackendSchema,
    defaultModelId: backendModelIdentifierSchema,
    models: z.array(backendModelDefinitionSchema).min(1),
    provenance: backendModelCatalogProvenanceSchema,
  })
  .strict()
  .superRefine((catalog, context) => {
    const claimedIdentifiers = new Map<string, string>();

    catalog.models.forEach((model, modelIndex) => {
      for (const [identifierIndex, identifier] of [
        model.id,
        ...model.aliases,
      ].entries()) {
        const previousOwner = claimedIdentifiers.get(identifier);
        if (previousOwner !== undefined) {
          addCatalogIssue(
            context,
            identifierIndex === 0
              ? ["models", modelIndex, "id"]
              : ["models", modelIndex, "aliases", identifierIndex - 1],
            `Model identifier "${identifier}" is already owned by "${previousOwner}".`,
          );
        } else {
          claimedIdentifiers.set(identifier, model.id);
        }
      }

      validateModelCatalogDefinition(model, modelIndex, context);
    });

    if (!catalog.models.some((model) => model.id === catalog.defaultModelId)) {
      addCatalogIssue(
        context,
        ["defaultModelId"],
        `Default model "${catalog.defaultModelId}" is not a canonical model id in this catalog.`,
      );
    }
  });
export type BackendModelCatalog = z.infer<typeof backendModelCatalogSchema>;

export const claudeModelSchema = z.enum(["fable", "opus", "sonnet", "haiku"]);
export type ClaudeModel = z.infer<typeof claudeModelSchema>;

/** Returns the default Claude model. */
export function getDefaultClaudeModel(): ClaudeModel {
  return "opus";
}

export const effortLevelSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
  "ultra",
]);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

/** Claude-specific effort levels (subset of EffortLevel accepted by the Claude SDK). */
export const claudeEffortLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ClaudeEffortLevel = z.infer<typeof claudeEffortLevelSchema>;

const MODEL_EFFORT_LEVELS: Record<ClaudeModel, ClaudeEffortLevel[]> = {
  fable: ["low", "medium", "high", "xhigh", "max"],
  opus: ["low", "medium", "high", "xhigh", "max"],
  sonnet: ["low", "medium", "high"],
  haiku: [],
};

/** Returns the effort levels supported by the given model. */
export function getEffortLevelsForModel(
  model: ClaudeModel,
): ClaudeEffortLevel[] {
  return MODEL_EFFORT_LEVELS[model];
}

export const backendTimeoutMsSchema = z.number().int().positive().nullable();

const tokenCountSchema = z.number().int().nonnegative();

/**
 * Backend-neutral per-turn token accounting. Every count is required, so a
 * partially-known record is not representable: a backend that cannot report
 * usage reports the whole record as null rather than filling gaps with zeros.
 * `totalTokens` follows the provider convention of excluding reasoning tokens,
 * and an absent `reasoningTokens` means the backend reported none.
 */
export const conversationTokenUsageSchema = z.object({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  totalTokens: tokenCountSchema,
  reasoningTokens: tokenCountSchema.optional(),
});
export type ConversationTokenUsage = z.infer<
  typeof conversationTokenUsageSchema
>;

export const claudeBackendConfigSchema = z
  .object({
    modelSelection: backendModelSelectionSchema,
    timeoutMs: backendTimeoutMsSchema,
    /**
     * Per-turn inactivity bound override; unset falls back to the Claude
     * descriptor's default, explicit null disables the bound.
     */
    stallTimeoutMs: backendTimeoutMsSchema.optional(),
  })
  .strict();
export type ClaudeBackendConfig = z.infer<typeof claudeBackendConfigSchema>;

// ============================================================
// Codex Config
// ============================================================

export const codexModelSchema = z.enum([
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex-spark",
]);
export type CodexModel = z.infer<typeof codexModelSchema>;

/** Returns the default Codex model. */
export function getDefaultCodexModel(): CodexModel {
  return "gpt-5.4";
}

export const codexReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type CodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>;

/** USD per 1M tokens for one Codex model. */
export const codexModelPricingSchema = z.object({
  inputPerMillion: z.number().nonnegative(),
  cachedInputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
});
export type CodexModelPricing = z.infer<typeof codexModelPricingSchema>;

export const codexPricingTableSchema = z.record(
  z.string(),
  codexModelPricingSchema,
);
export type CodexPricingTable = z.infer<typeof codexPricingTableSchema>;

// ============================================================
// Codex Model Reasoning Levels
// ============================================================

// GPT-6 Astra supports low→ultra but not minimal; its "ultra" level was read
// off the Codex CLI's own `gpt-6-astra` model preset (v0.153.3), which lists
// it as "Maximum reasoning with automatic task delegation". Within the GPT-5.6
// family "max" and "ultra" are exclusive to the Sol flagship; Terra and Luna
// expose only the standard low→xhigh range. "minimal" is omitted from every
// model — Codex does not accept it for these models.
//
// Codex Spark's range was read off the Codex CLI's own reasoning-level picker
// (v0.147.0): Low / Medium / High (default) / Extra high, with no minimal and
// no max/ultra. Third-party write-ups claiming Spark takes no reasoning effort
// at all are wrong.
const CODEX_MODEL_REASONING_LEVELS: Record<string, CodexReasoningEffort[]> = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
};

/**
 * Returns the reasoning effort levels supported by a Codex model.
 * Returns null for unknown models (all levels are allowed).
 */
export function getCodexReasoningLevelsForModel(
  model: string,
): CodexReasoningEffort[] | null {
  return CODEX_MODEL_REASONING_LEVELS[model] ?? null;
}

// ============================================================
// Cursor Config
// ============================================================

/**
 * The global Cursor backend profile (spec D10, D12.2).
 *
 * Deliberately narrower than the Claude and Codex profiles. There is no
 * `fastMode` — the speed toggle is Codex's and Cursor gets no copy of it — no
 * `pricing`, because Phase 1 reports `costUsd` null and estimating from tokens
 * would fabricate a figure, and no credential field of any kind: the SDK key
 * comes from the server's `CURSOR_API_KEY` environment variable and never from
 * a settings document. Membership validation for `model` belongs to the
 * adapter's model policy, which is the one place that knows the project's
 * effective supported list; this schema validates shape.
 *
 * `.strict()` rather than the tolerant default: an option this profile does not
 * declare is one Command Center will never read, and stripping it silently
 * tells the operator their setting took effect when nothing did. Cursor can
 * afford to fail closed because it is new — no config file already on disk can
 * carry a stray key under it. The Claude and Codex profiles shipped tolerant,
 * so tightening those is a separate migration decision, not a side effect of
 * registering a third backend.
 */
export const cursorBackendConfigSchema = z
  .object({
    modelSelection: backendModelSelectionSchema,
    timeoutMs: backendTimeoutMsSchema,
  })
  .strict();
export type CursorBackendConfig = z.infer<typeof cursorBackendConfigSchema>;

export const codexConfigSchema = z
  .object({
    modelSelection: backendModelSelectionSchema,
    timeoutMs: backendTimeoutMsSchema,
    /**
     * Per-turn inactivity bound override; unset falls back to the Codex
     * descriptor's default, explicit null disables the bound.
     */
    stallTimeoutMs: backendTimeoutMsSchema.optional(),
    pricing: codexPricingTableSchema.optional(),
  })
  .strict();
export type CodexConfig = z.infer<typeof codexConfigSchema>;
