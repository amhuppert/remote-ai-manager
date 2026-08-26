import { createLogger } from "@/lib/logging";

import {
  backendModelCatalogSchema,
  type BackendModelCatalog,
} from "../schemas";
import {
  ModelSelectionPolicyError,
  validateModelSelection,
} from "../model-selection";
import type { BackendModelSelection } from "../schemas";
import type { BackendModelCatalogFacet } from "../descriptor";

import { readGeneratedCursorModelCatalog } from "./generated-model-catalog-artifact";
import { CURSOR_DEFAULT_SUPPORTED_MODELS } from "./model-policy";

export { parseGeneratedCursorModelCatalog } from "./generated-model-catalog-artifact";

const logger = createLogger("cursor:model-catalog");

export type CursorModelCatalogErrorCode =
  | "model_not_in_generated_catalog"
  | "default_model_not_allowed"
  | "no_models_allowed";

export class CursorModelCatalogError extends Error {
  readonly code: CursorModelCatalogErrorCode;
  readonly modelId: string | null;

  constructor(
    code: CursorModelCatalogErrorCode,
    message: string,
    modelId: string | null = null,
  ) {
    super(message);
    this.name = "CursorModelCatalogError";
    this.code = code;
    this.modelId = modelId;
  }
}

export interface CursorModelCatalogFacetDeps {
  loadCatalog(): BackendModelCatalog;
  supportedModels(projectPath: string): Promise<readonly string[] | null>;
}

export function createCursorModelCatalogFacet(
  deps: CursorModelCatalogFacetDeps,
): BackendModelCatalogFacet {
  return {
    async getCatalog(input) {
      const catalog = deps.loadCatalog();
      try {
        const supportedModels =
          input.projectPath === undefined
            ? undefined
            : await deps.supportedModels(input.projectPath);
        return filterCursorModelCatalog(
          catalog,
          supportedModels,
          input.configuredSelection,
        );
      } catch (error) {
        const code =
          error instanceof CursorModelCatalogError
            ? error.code
            : error instanceof ModelSelectionPolicyError
              ? (error.issues[0]?.code ?? "selection_invalid")
              : "catalog_unavailable";
        logger.warn("model_catalog.rejected", {
          backend: "cursor",
          code,
          source: catalog.provenance.source,
        });
        throw error;
      }
    },
  };
}

export function loadGeneratedCursorModelCatalog(): BackendModelCatalog {
  try {
    const catalog = readGeneratedCursorModelCatalog();
    logger.debug("model_catalog.loaded", {
      backend: "cursor",
      modelCount: catalog.models.length,
      source: catalog.provenance.source,
      sdkVersion: catalog.provenance.sdkVersion,
    });
    return catalog;
  } catch (error) {
    logger.warn("model_catalog.rejected", {
      backend: "cursor",
      code: "generated_catalog_invalid",
      source: "Cursor.models.list",
    });
    throw error;
  }
}

export function filterCursorModelCatalog(
  catalog: BackendModelCatalog,
  supportedModels: readonly string[] | null | undefined,
  configuredSelection?: BackendModelSelection,
): BackendModelCatalog {
  let effectiveDefaultModelId = catalog.defaultModelId;
  if (configuredSelection !== undefined) {
    const validation = validateModelSelection(catalog, configuredSelection);
    if (!validation.valid) {
      throw new ModelSelectionPolicyError(validation.issues);
    }
    effectiveDefaultModelId = validation.selection.modelId;
  }

  if (supportedModels === undefined) {
    return backendModelCatalogSchema.parse({
      ...catalog,
      defaultModelId: effectiveDefaultModelId,
    });
  }
  const effectiveSupportedModels =
    supportedModels ?? CURSOR_DEFAULT_SUPPORTED_MODELS;
  if (effectiveSupportedModels.length === 0) {
    throw new CursorModelCatalogError(
      "no_models_allowed",
      "This project's Cursor supported-model list is empty.",
    );
  }

  const canonicalByIdentifier = new Map<string, string>();
  for (const model of catalog.models) {
    canonicalByIdentifier.set(model.id, model.id);
    for (const alias of model.aliases)
      canonicalByIdentifier.set(alias, model.id);
  }

  const allowedIds = new Set<string>();
  for (const configuredId of effectiveSupportedModels) {
    const canonicalId = canonicalByIdentifier.get(configuredId);
    if (canonicalId === undefined) {
      throw new CursorModelCatalogError(
        "model_not_in_generated_catalog",
        `Cursor model "${configuredId}" is not present in the generated model catalog.`,
        configuredId,
      );
    }
    allowedIds.add(canonicalId);
  }

  const allowedModels = catalog.models.filter((model) =>
    allowedIds.has(model.id),
  );
  if (!allowedIds.has(effectiveDefaultModelId)) {
    if (configuredSelection === undefined) {
      throw new CursorModelCatalogError(
        "default_model_not_allowed",
        `The Cursor supported-model list does not include the effective default "${effectiveDefaultModelId}".`,
        effectiveDefaultModelId,
      );
    }
    effectiveDefaultModelId = allowedIds.has(catalog.defaultModelId)
      ? catalog.defaultModelId
      : allowedModels[0]!.id;
  }

  return backendModelCatalogSchema.parse({
    ...catalog,
    defaultModelId: effectiveDefaultModelId,
    models: allowedModels,
  });
}
