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

import { z } from "zod";

import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";

import { backendCatalogModelSchema, type BackendCatalogEntry } from "./catalog";

export const projectBackendModelOptionsSchema = z.object({
  backend: agentBackendSchema,
  models: z.array(backendCatalogModelSchema),
  defaultModelId: z.string().nullable(),
  /** Where the list came from, so a surface can explain an empty one. */
  source: z.enum(["catalog", "project"]),
});
export type ProjectBackendModelOptions = z.infer<
  typeof projectBackendModelOptionsSchema
>;

export const projectModelOptionsResponseSchema = z.object({
  backends: z.array(projectBackendModelOptionsSchema),
});
export type ProjectModelOptionsResponse = z.infer<
  typeof projectModelOptionsResponseSchema
>;

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
}

/**
 * A project may list a model Command Center has never described. Its id is the
 * only honest label, and it declares no effort levels because there is no basis
 * to claim any.
 */
function describeUnknownModel(
  id: string,
): z.infer<typeof backendCatalogModelSchema> {
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
  };
}

export async function buildProjectModelOptions(
  projectPath: string,
  deps: ProjectModelOptionsDeps,
): Promise<ProjectModelOptionsResponse> {
  const backends = await Promise.all(
    deps.entries().map(async (entry) => {
      const resolver = deps.resolver(entry.id);
      if (resolver === undefined) return catalogOptions(entry);
      return projectOptions(entry, await resolver({ projectPath }));
    }),
  );

  return { backends };
}
