/**
 * `GET /api/projects/[name]/model-options` — the project-scoped model options a
 * conversation-creation surface offers (spec D10).
 *
 * Project-scoped rather than global because the answer varies per project: the
 * process-global catalog stays project-agnostic and cannot carry a per-project
 * list. Addressing composes `RouteResolution`, so an unknown project is the
 * same 404 every other project route returns rather than an unscoped catalog.
 */

import { NextResponse } from "next/server";

import { createLogger, withTracing } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  jsonError,
  resolveProjectOr404,
  type ResolveProjectDeps,
} from "@/lib/shared/route-resolution";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { readConfig } from "@/lib/config/loader";

import { getBackendCatalogEntry, listBackendCatalogEntries } from "./catalog";
import {
  buildProjectModelOptions,
  type ProjectModelOptionsDeps,
} from "./project-model-options";
import { projectModelOptionsResponseSchema } from "./project-model-options-schema";
import {
  getBackendDescriptor,
  getConversationBackendFactory,
} from "./registry";

const logger = createLogger("agent-backends:project-model-options");

export interface ProjectModelOptionsRouteDeps
  extends ResolveProjectDeps, ProjectModelOptionsDeps {}

const defaultDeps: ProjectModelOptionsRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  entries: () => listBackendCatalogEntries(),
  resolver: (backend) => {
    // A backend with no conversation facet has no conversation factory to ask,
    // and asking would throw. Its catalog models are the honest answer rather
    // than an error that takes every other backend's options down with it.
    if (!getBackendCatalogEntry(backend).facets.conversation) return undefined;
    const factory = getConversationBackendFactory(backend);
    const resolve = factory.resolveProjectModelOptions;
    return resolve === undefined ? undefined : (input) => resolve(input);
  },
  catalogFacet: (backend) => getBackendDescriptor(backend).modelCatalog,
  configuredSelection: async (backend) =>
    (await readConfig()).agentBackends[backend].modelSelection,
};

type RouteContext = { params: Promise<Record<string, string>> };

export function createProjectModelOptionsRouteHandlers(
  deps: ProjectModelOptionsRouteDeps = defaultDeps,
) {
  async function GET(context: RouteContext): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;

    try {
      const response = await buildProjectModelOptions(project.value, deps);
      for (const entry of response.backends) {
        for (const diagnostic of entry.diagnostics) {
          logger.warn("model_catalog.rejected", {
            backend: entry.backend,
            code: diagnostic.code,
            ...(diagnostic.modelId === undefined
              ? {}
              : { modelId: diagnostic.modelId }),
          });
        }
      }
      return NextResponse.json(
        projectModelOptionsResponseSchema.parse(response),
      );
    } catch (err) {
      // A backend that cannot report its project options leaves the surface
      // with no honest list, and serving the catalog instead would offer
      // models the project may refuse.
      logger.error("project_model_options.resolution_failed", {
        projectName: name,
        error: getErrorMessage(err),
      });
      return jsonError("Failed to resolve project model options", 500);
    }
  }

  return { GET };
}

const handlers = createProjectModelOptionsRouteHandlers();

export const GET = withTracing(
  (_request: Request, context: RouteContext): Promise<Response> =>
    handlers.GET(context),
);
