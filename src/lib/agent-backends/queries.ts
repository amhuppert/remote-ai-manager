import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { backendCatalogKeys } from "./query-keys";
import {
  backendCatalogResponseSchema,
  listBackendCatalogEntries,
  type BackendCatalogEntry,
} from "./catalog";

/** How long a fetched server catalog stays fresh before revalidation. */
const CATALOG_STALE_TIME_MS = 5 * 60_000;

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
