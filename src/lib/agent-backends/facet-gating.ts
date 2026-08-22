import type { AgentBackendId } from "@/lib/shared/schemas";
import { getBackendCatalogEntry, type BackendCatalogEntry } from "./catalog";

/**
 * An execution facet a surface requires before it can dispatch a backend.
 *
 * Keyed off the catalog's own facet record rather than restated, so a facet
 * added to the catalog is gateable here without a parallel vocabulary that
 * could drift out of step with the descriptors.
 */
export type GatedBackendFacet = keyof BackendCatalogEntry["facets"];

/** Stable code for the bounded 4xx a facet-gated API returns (spec R15.2). */
export const GATED_BACKEND_FACET_ERROR_CODE = "backend-facet-unsupported";

const FACET_NOUNS: Readonly<Record<GatedBackendFacet, string>> = {
  conversation: "conversation",
  tasks: "task",
};

/**
 * Why a surface requiring `facet` cannot dispatch this backend, or null when it
 * can — the one text every facet-gated surface uses, so the reason a picker
 * shows and the reason its API returns cannot disagree (spec D13).
 *
 * The answer comes from the entry's registered facet flags, never from the
 * backend's identity: a backend that later registers the facet opens every
 * gated surface at once, and one that drops it closes them (spec R15.3).
 */
export function backendFacetRefusal(
  entry: BackendCatalogEntry,
  facet: GatedBackendFacet,
): string | null {
  if (entry.facets[facet]) return null;
  return `${entry.label} does not support ${FACET_NOUNS[facet]} execution: it registers no ${FACET_NOUNS[facet]} facet`;
}

/** {@link backendFacetRefusal} from a backend id, for server surfaces holding one. */
export function backendFacetRefusalFor(
  backend: AgentBackendId,
  facet: GatedBackendFacet,
): string | null {
  return backendFacetRefusal(getBackendCatalogEntry(backend), facet);
}

/**
 * {@link backendFacetRefusal} resolved against a live catalog listing — the form
 * for pickers that render backend ids and hold `useBackendCatalogQuery()` data,
 * so the answer comes from the server's catalog rather than the build-time seed.
 */
export function backendFacetRefusalIn(
  entries: readonly BackendCatalogEntry[],
  backend: AgentBackendId,
  facet: GatedBackendFacet,
): string | null {
  const entry = entries.find((candidate) => candidate.id === backend);
  return entry
    ? backendFacetRefusal(entry, facet)
    : backendFacetRefusalFor(backend, facet);
}
