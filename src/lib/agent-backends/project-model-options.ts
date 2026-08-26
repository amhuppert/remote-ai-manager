/**
 * Project-scoped model options (spec D10).
 *
 * The process-global catalog is client-safe, schema-driven and project-agnostic,
 * so it cannot carry a list that varies per project. This projection answers the
 * same question a conversation-creation surface actually has — "which models may
 * I offer for THIS project?" — by asking each registered conversation factory
 * for its project-scoped list and falling back to the catalog for the backends
 * whose models are a Command Center property rather than a project one.
 *
 * `defaultModelId` is what a turn would run with nothing explicitly selected.
 * `null` means that resolution is not permitted here, which a creation surface
 * renders as an invalid selection requiring an explicit choice — never as a
 * licence to substitute a different model.
 */

import { createLogger } from "@/lib/logging";
import type { AgentBackendId } from "@/lib/shared/schemas";

import type { BackendCatalogEntry } from "./catalog";
import type { BackendModelCatalogFacet } from "./descriptor";
import {
  ModelSelectionPolicyError,
  defaultSelectionForModel,
  validateModelSelection,
} from "./model-selection";
import {
  backendModelCatalogSchema,
  effortLevelSchema,
  type BackendModelCatalog,
  type BackendModelSelection,
} from "./schemas";
import type {
  ProjectBackendModelOptions,
  ProjectModelCatalogDiagnostic,
  ProjectModelOptionsResponse,
} from "./project-model-options-schema";

const logger = createLogger("agent-backends:project-model-options");

/** What a backend reports about one project's permitted models. */
export interface ProjectModelOptions {
  /** Permitted model ids, in declared order. */
  models: readonly string[];
  /** What a turn would run with nothing selected; null when nothing would. */
  defaultModelId: string | null;
}

export type ProjectModelOptionsResolver = (input: {
  projectPath: string;
}) => Promise<ProjectModelOptions>;

export interface ProjectModelOptionsDeps {
  entries(): readonly BackendCatalogEntry[];
  /** The backend's project-scoped resolver, or undefined when it declares none. */
  resolver(backend: AgentBackendId): ProjectModelOptionsResolver | undefined;
  /** Complete-variant provider registered by the backend descriptor. */
  catalogFacet?(backend: AgentBackendId): BackendModelCatalogFacet | undefined;
  /** Global atomic default passed to the backend catalog provider. */
  configuredSelection?(
    backend: AgentBackendId,
  ): Promise<BackendModelSelection | undefined>;
}

/**
 * A project may list a model Command Center has never described. Its id is the
 * only honest label, and it declares no effort levels because there is no basis
 * to claim any.
 */
function describeUnknownModel(
  id: string,
): ProjectBackendModelOptions["models"][number] {
  return {
    id,
    label: id,
    description: "Configured for this project.",
    effortLevels: [],
  };
}

function projectOptions(
  entry: BackendCatalogEntry,
  options: ProjectModelOptions,
): ProjectBackendModelOptions {
  return {
    backend: entry.id,
    models: options.models.map(
      (id) =>
        entry.models.find((model) => model.id === id) ??
        describeUnknownModel(id),
    ),
    defaultModelId: options.defaultModelId,
    source: "project",
    modelCatalog: null,
    defaultSelection: null,
    diagnostics: [
      {
        code: "complete_catalog_unavailable",
        message: `Backend "${entry.id}" did not provide complete model variants.`,
      },
    ],
  };
}

function catalogOptions(
  entry: BackendCatalogEntry,
): ProjectBackendModelOptions {
  return {
    backend: entry.id,
    models: [...entry.models],
    defaultModelId: entry.defaultModelId,
    source: "catalog",
    modelCatalog: null,
    defaultSelection: null,
    diagnostics: [
      {
        code: "complete_catalog_unavailable",
        message: `Backend "${entry.id}" did not provide complete model variants.`,
      },
    ],
  };
}

function effortLevelsForDefinition(
  catalogModel: BackendModelCatalog["models"][number],
): ProjectBackendModelOptions["models"][number]["effortLevels"] {
  const primary = catalogModel.parameters.find(
    ({ prominence }) => prominence === "primary",
  );
  if (primary === undefined) return [];

  return primary.values.flatMap(({ value }) => {
    const parsed = effortLevelSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

function summarizeCatalogModels(
  catalog: BackendModelCatalog,
): ProjectBackendModelOptions["models"] {
  return catalog.models.map((model) => ({
    id: model.id,
    label: model.label,
    description: model.description ?? "",
    effortLevels: effortLevelsForDefinition(model),
  }));
}

function diagnosticFromError(error: unknown): ProjectModelCatalogDiagnostic {
  if (error instanceof ModelSelectionPolicyError) {
    const [issue] = error.issues;
    return {
      code: issue?.code ?? "model_selection_invalid",
      message: error.message,
      ...(issue?.modelId === undefined ? {} : { modelId: issue.modelId }),
    };
  }

  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : "model_catalog_unavailable";
    const modelId =
      "modelId" in error && typeof error.modelId === "string"
        ? error.modelId
        : undefined;
    return {
      code,
      message: error.message,
      ...(modelId === undefined ? {} : { modelId }),
    };
  }

  return {
    code: "model_catalog_unavailable",
    message: "The backend model catalog could not be loaded.",
  };
}

async function catalogBackedOptions(
  entry: BackendCatalogEntry,
  projectPath: string,
  deps: ProjectModelOptionsDeps,
  facet: BackendModelCatalogFacet,
): Promise<ProjectBackendModelOptions> {
  try {
    const configuredSelection = await deps.configuredSelection?.(entry.id);
    const catalog = backendModelCatalogSchema.parse(
      await facet.getCatalog({ projectPath, configuredSelection }),
    );
    if (catalog.backend !== entry.id) {
      throw new Error(
        `Backend "${entry.id}" returned a model catalog for "${catalog.backend}".`,
      );
    }

    const candidate =
      configuredSelection ??
      defaultSelectionForModel(catalog, catalog.defaultModelId);
    const validation = validateModelSelection(catalog, candidate);
    if (!validation.valid) {
      if (configuredSelection !== undefined) {
        const issue = validation.issues[0];
        logger.warn("model_selection.rejected", {
          backend: entry.id,
          modelId: issue?.modelId ?? configuredSelection.modelId,
          code: issue?.code ?? "selection_invalid",
          ...(issue?.parameterId === undefined
            ? {}
            : { parameterId: issue.parameterId }),
          sourceLayer: "global_config",
        });
        return {
          backend: entry.id,
          models: summarizeCatalogModels(catalog),
          defaultModelId: null,
          source: deps.resolver(entry.id) === undefined ? "catalog" : "project",
          modelCatalog: catalog,
          defaultSelection: null,
          diagnostics: [],
        };
      }
      throw new ModelSelectionPolicyError(validation.issues);
    }

    return {
      backend: entry.id,
      models: summarizeCatalogModels(catalog),
      defaultModelId: validation.selection.modelId,
      source: deps.resolver(entry.id) === undefined ? "catalog" : "project",
      modelCatalog: catalog,
      defaultSelection: validation.selection,
      diagnostics: [],
    };
  } catch (error) {
    return {
      backend: entry.id,
      models: [],
      defaultModelId: null,
      source: deps.resolver(entry.id) === undefined ? "catalog" : "project",
      modelCatalog: null,
      defaultSelection: null,
      diagnostics: [diagnosticFromError(error)],
    };
  }
}

export async function buildProjectModelOptions(
  projectPath: string,
  deps: ProjectModelOptionsDeps,
): Promise<ProjectModelOptionsResponse> {
  const backends = await Promise.all(
    deps.entries().map(async (entry) => {
      const catalogFacet = deps.catalogFacet?.(entry.id);
      if (catalogFacet !== undefined) {
        return catalogBackedOptions(entry, projectPath, deps, catalogFacet);
      }

      const resolver = deps.resolver(entry.id);
      if (resolver === undefined) return catalogOptions(entry);
      return projectOptions(entry, await resolver({ projectPath }));
    }),
  );

  return { backends };
}
