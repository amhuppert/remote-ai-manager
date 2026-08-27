import type { ModelListItem } from "@cursor/sdk";
import { z } from "zod";

import { reasoningValueEmphasis } from "../model-scale-emphasis";
import {
  backendModelCatalogSchema,
  type BackendModelCatalog,
  type BackendModelParameterValueEmphasis,
} from "../schemas";

import { CURSOR_DEFAULT_MODEL } from "./model-policy";

export interface CursorCatalogGenerationOptions {
  generatedAt: string;
  sdkVersion: string;
}

const sdkModelParameterValueSchema = z
  .object({
    value: z.string().min(1),
    displayName: z.string().min(1).optional(),
  })
  .strict();

const sdkModelParameterDefinitionSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
    values: z.array(sdkModelParameterValueSchema).min(1),
  })
  .strict();

const sdkModelVariantSchema = z
  .object({
    params: z.array(
      z.object({ id: z.string().min(1), value: z.string() }).strict(),
    ),
    displayName: z.string().min(1),
    description: z.string().min(1).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

const sdkModelListSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      displayName: z.string().min(1),
      description: z.string().min(1).optional(),
      aliases: z.array(z.string().min(1)).optional(),
      parameters: z.array(sdkModelParameterDefinitionSchema).optional(),
      variants: z.array(sdkModelVariantSchema).optional(),
    })
    .strict(),
);

interface CatalogParameterValue {
  value: string;
  label: string;
  emphasis?: BackendModelParameterValueEmphasis;
}

interface CatalogParameterDefinition {
  id: string;
  label: string;
  values: CatalogParameterValue[];
  prominence: "primary" | "advanced" | "hidden";
}

export interface CursorAliasOmission {
  alias: string;
  modelIds: readonly string[];
}

export interface CursorAliasAnalysis {
  aliasesByModel: ReadonlyMap<string, readonly string[]>;
  omissions: readonly CursorAliasOmission[];
}

export function analyzeCursorModelAliases(
  models: readonly Pick<ModelListItem, "id" | "aliases">[],
): CursorAliasAnalysis {
  const owners = new Map<string, Set<string>>();
  const canonicalIds = new Set(models.map((model) => model.id));
  for (const model of models) {
    for (const alias of new Set(model.aliases ?? [])) {
      const aliasOwners = owners.get(alias) ?? new Set<string>();
      aliasOwners.add(model.id);
      owners.set(alias, aliasOwners);
    }
  }

  const omissions: CursorAliasOmission[] = [];
  const ambiguousAliases = new Set<string>();
  for (const [alias, aliasOwners] of owners) {
    if (aliasOwners.size === 1 && !canonicalIds.has(alias)) continue;
    ambiguousAliases.add(alias);
    const modelIds = new Set(aliasOwners);
    if (canonicalIds.has(alias)) modelIds.add(alias);
    omissions.push({ alias, modelIds: [...modelIds].sort() });
  }
  omissions.sort((left, right) => left.alias.localeCompare(right.alias));

  const aliasesByModel = new Map<string, readonly string[]>();
  for (const model of models) {
    aliasesByModel.set(
      model.id,
      [...new Set(model.aliases ?? [])].filter(
        (alias) => !ambiguousAliases.has(alias),
      ),
    );
  }
  return { aliasesByModel, omissions };
}

function assertUnique(values: readonly string[], description: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(
        `Cursor model catalog has a duplicate ${description} "${value}".`,
      );
    }
    seen.add(value);
  }
}

function parameterProminence(
  id: string,
  valueCount: number,
): CatalogParameterDefinition["prominence"] {
  if (valueCount === 1) return "hidden";
  return id === "effort" || id === "reasoning" ? "primary" : "advanced";
}

function buildParameterDefinitions(
  model: z.infer<typeof sdkModelListSchema>[number],
): CatalogParameterDefinition[] {
  const providerDefinitions = model.parameters ?? [];
  assertUnique(
    providerDefinitions.map((definition) => definition.id),
    `parameter id on model ${model.id}`,
  );

  const definitions: CatalogParameterDefinition[] = providerDefinitions.map(
    (definition) => {
      assertUnique(
        definition.values.map((value) => value.value),
        `value for parameter ${model.id}.${definition.id}`,
      );
      return {
        id: definition.id,
        label: definition.displayName ?? definition.id,
        values: definition.values.map((value) => {
          const emphasis = reasoningValueEmphasis(definition.id, value.value);
          return {
            value: value.value,
            label: value.displayName ?? value.value,
            ...(emphasis === undefined ? {} : { emphasis }),
          };
        }),
        prominence: parameterProminence(
          definition.id,
          definition.values.length,
        ),
      };
    },
  );

  const knownIds = new Set(definitions.map((definition) => definition.id));
  const fixedValues = new Map<string, string[]>();
  for (const variant of model.variants ?? []) {
    assertUnique(
      variant.params.map((parameter) => parameter.id),
      `variant parameter id on model ${model.id}`,
    );
    for (const parameter of variant.params) {
      if (knownIds.has(parameter.id)) continue;
      const values = fixedValues.get(parameter.id) ?? [];
      if (!values.includes(parameter.value)) values.push(parameter.value);
      fixedValues.set(parameter.id, values);
    }
  }

  for (const [id, values] of fixedValues) {
    definitions.push({
      id,
      label: id,
      values: values.map((value) => ({ value, label: value })),
      prominence: "hidden",
    });
  }
  return definitions;
}

function buildModel(
  model: z.infer<typeof sdkModelListSchema>[number],
  aliases: readonly string[],
): BackendModelCatalog["models"][number] {
  const parameters = buildParameterDefinitions(model);
  const providerVariants = model.variants ?? [];
  if (parameters.length > 0 && providerVariants.length === 0) {
    throw new Error(
      `Cursor model "${model.id}" declares parameters but no complete variants.`,
    );
  }

  const variants =
    providerVariants.length === 0
      ? [
          {
            selection: { modelId: model.id, parameters: {} },
            label: model.displayName,
            isDefault: true,
          },
        ]
      : providerVariants.map((variant) => {
          const parameterRecord = Object.fromEntries(
            [...variant.params]
              .sort((left, right) => left.id.localeCompare(right.id))
              .map((parameter) => [parameter.id, parameter.value]),
          );
          return {
            selection: { modelId: model.id, parameters: parameterRecord },
            label: variant.displayName,
            ...(variant.description !== undefined
              ? { description: variant.description }
              : {}),
            isDefault: variant.isDefault === true,
          };
        });

  const parameterById = new Map(
    parameters.map((definition) => [definition.id, definition]),
  );
  const expectedIds = new Set(parameterById.keys());
  for (const variant of variants) {
    const actualIds = Object.keys(variant.selection.parameters);
    if (
      actualIds.length !== expectedIds.size ||
      actualIds.some((id) => !expectedIds.has(id))
    ) {
      throw new Error(
        `Cursor model "${model.id}" has a variant that is not a complete parameter selection.`,
      );
    }
    for (const [id, value] of Object.entries(variant.selection.parameters)) {
      const definition = parameterById.get(id);
      if (!definition?.values.some((candidate) => candidate.value === value)) {
        throw new Error(
          `Cursor model "${model.id}" has unsupported value "${value}" for parameter "${id}".`,
        );
      }
    }
  }

  if (variants.filter((variant) => variant.isDefault).length !== 1) {
    throw new Error(
      `Cursor model "${model.id}" must declare exactly one default variant.`,
    );
  }

  return {
    id: model.id,
    label: model.displayName,
    ...(model.description !== undefined
      ? { description: model.description }
      : {}),
    aliases: [...aliases],
    parameters,
    variants,
  };
}

export function buildCursorModelCatalog(
  models: readonly ModelListItem[],
  options: CursorCatalogGenerationOptions,
): BackendModelCatalog {
  const parsedModels = sdkModelListSchema.parse(models);
  if (!Number.isFinite(Date.parse(options.generatedAt))) {
    throw new Error("Cursor model catalog generation timestamp is invalid.");
  }
  if (options.sdkVersion.trim().length === 0) {
    throw new Error("Cursor model catalog SDK version is required.");
  }

  assertUnique(
    parsedModels.map((model) => model.id),
    "model id",
  );
  const canonicalIds = new Set(parsedModels.map((model) => model.id));
  const aliasAnalysis = analyzeCursorModelAliases(parsedModels);
  if (!canonicalIds.has(CURSOR_DEFAULT_MODEL)) {
    throw new Error(
      `Cursor model catalog does not contain the default model "${CURSOR_DEFAULT_MODEL}".`,
    );
  }

  return backendModelCatalogSchema.parse({
    backend: "cursor",
    defaultModelId: CURSOR_DEFAULT_MODEL,
    models: parsedModels.map((model) =>
      buildModel(model, aliasAnalysis.aliasesByModel.get(model.id) ?? []),
    ),
    provenance: {
      source: "Cursor.models.list",
      generatedAt: options.generatedAt,
      sdkVersion: options.sdkVersion,
    },
  });
}
