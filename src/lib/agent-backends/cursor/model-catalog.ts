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

export { parseGeneratedCursorModelCatalog } from "./generated-model-catalog-artifact";

const logger = createLogger("cursor:model-catalog");

export type CursorModelCatalogErrorCode =
  | "default_model_disabled"
  | "all_models_disabled";

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
  /** The project's opted-out model ids, or null when it configures none. */
  disabledModels(projectPath: string): Promise<readonly string[] | null>;
}

export function createCursorModelCatalogFacet(
  deps: CursorModelCatalogFacetDeps,
): BackendModelCatalogFacet {
  return {
    async getCatalog(input) {
      const catalog = deps.loadCatalog();
      try {
        const disabledModels =
          input.projectPath === undefined
            ? null
            : await deps.disabledModels(input.projectPath);
        return filterCursorModelCatalog(
          catalog,
          disabledModels,
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

/**
 * Apply a project's opt-out list to the generated catalog.
 *
 * Every generated model is offered unless the project names it in
 * `disabledModels`, so a project that configures nothing gets everything
 * Cursor serves. An id the generated catalog does not contain is inert rather
 * than an error: the build refreshes this catalog from Cursor, so a model the
 * vendor retires would otherwise turn every project that had disabled it into
 * an unreadable configuration.
 */
export function filterCursorModelCatalog(
  catalog: BackendModelCatalog,
  disabledModels: readonly string[] | null | undefined,
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

  const canonicalByIdentifier = new Map<string, string>();
  for (const model of catalog.models) {
    canonicalByIdentifier.set(model.id, model.id);
    for (const alias of model.aliases)
      canonicalByIdentifier.set(alias, model.id);
  }

  const disabledIds = new Set<string>();
  for (const configuredId of disabledModels ?? []) {
    const canonicalId = canonicalByIdentifier.get(configuredId);
    if (canonicalId !== undefined) disabledIds.add(canonicalId);
  }

  const allowedModels = catalog.models.filter(
    (model) => !disabledIds.has(model.id),
  );
  const [firstAllowedModel] = allowedModels;
  if (firstAllowedModel === undefined) {
    throw new CursorModelCatalogError(
      "all_models_disabled",
      "This project disables every Cursor model in the generated catalog.",
    );
  }

  if (disabledIds.has(effectiveDefaultModelId)) {
    if (configuredSelection === undefined) {
      throw new CursorModelCatalogError(
        "default_model_disabled",
        `This project disables the effective default Cursor model "${effectiveDefaultModelId}".`,
        effectiveDefaultModelId,
      );
    }
    effectiveDefaultModelId = disabledIds.has(catalog.defaultModelId)
      ? firstAllowedModel.id
      : catalog.defaultModelId;
  }

  return backendModelCatalogSchema.parse({
    ...catalog,
    defaultModelId: effectiveDefaultModelId,
    models: allowedModels,
  });
}
