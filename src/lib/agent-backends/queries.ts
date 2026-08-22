import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import { backendCatalogKeys } from "./query-keys";
import {
  backendCatalogResponseSchema,
  listBackendCatalogEntries,
  type BackendCatalogEntry,
} from "./catalog";
import {
  projectModelOptionsResponseSchema,
  type ProjectBackendModelOptions,
} from "./project-model-options";

/** How long a fetched server catalog stays fresh before revalidation. */
const CATALOG_STALE_TIME_MS = 5 * 60_000;

/**
 * Shorter than the catalog's: this list follows a file in the repository that
 * an operator can edit at any moment, not a Command Center release.
 */
const PROJECT_MODEL_OPTIONS_STALE_TIME_MS = 60_000;

/**
 * The registered backend catalog (`GET /api/agent-backends`) — the single
 * client access point for backend metadata. The client-safe catalog literals
 * seed `initialData` so consumers render synchronously with no loading state,
 * but the seed is hydration only: `initialDataUpdatedAt: 0` marks it stale
 * immediately, so the server registry is fetched on first mount and remains
 * the authority.
 */
export function useBackendCatalogQuery() {
  return useQuery({
    queryKey: backendCatalogKeys.catalog(),
    queryFn: async () => {
      const response = await apiFetch(
        "/api/agent-backends",
        backendCatalogResponseSchema,
      );
      return response.backends;
    },
    initialData: (): readonly BackendCatalogEntry[] =>
      listBackendCatalogEntries(),
    initialDataUpdatedAt: 0,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

/**
 * The project's effective model options (`GET /api/projects/[name]/model-options`).
 *
 * No `initialData` seed, unlike the catalog: the answer depends on the
 * project's configuration, and seeding it from the process-global catalog would
 * briefly offer models the project may refuse. Consumers render the catalog
 * only while this is undefined, and never treat the seed as the project's list.
 */
export function useProjectModelOptionsQuery(projectName: string | null) {
  return useQuery({
    queryKey: backendCatalogKeys.projectModelOptions(projectName ?? ""),
    queryFn: async () => {
      const response = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName ?? "")}/model-options`,
        projectModelOptionsResponseSchema,
      );
      return response.backends;
    },
    enabled: projectName !== null,
    staleTime: PROJECT_MODEL_OPTIONS_STALE_TIME_MS,
  });
}

/**
 * The project-effective options for one backend, or null while they are
 * unknown (no project context, or the fetch has not resolved). Null means "use
 * the catalog"; an entry with an empty `models` list means "this project
 * permits nothing", which is a different answer and must not be conflated.
 */
export function useProjectBackendModelOptions(
  projectName: string | null,
  backend: AgentBackendId,
): ProjectBackendModelOptions | null {
  const { data } = useProjectModelOptionsQuery(projectName);
  return data?.find((entry) => entry.backend === backend) ?? null;
}

/**
 * Catalog entry for one backend id, from the live catalog query. The id is
 * parsed through the canonical backend schema; an unknown id resolves to null
 * (never coerced to a default backend) so callers can render an explicit
 * unknown-backend state.
 */
export function useBackendCatalogEntry(
  backend: string,
): BackendCatalogEntry | null {
  const { data: backends } = useBackendCatalogQuery();
  const parsed = agentBackendSchema.safeParse(backend);
  if (!parsed.success) return null;
  return backends.find((b) => b.id === parsed.data) ?? null;
}
