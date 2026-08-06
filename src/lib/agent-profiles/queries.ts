import { queryOptions, useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api/fetcher";

import { agentProfileKeys } from "./query-keys";
import {
  agentProfileDeletionReportSchema,
  agentProfileLibraryEntrySchema,
  agentProfileLibraryListingSchema,
  type AgentProfileTier,
} from "./schemas";

/**
 * Library reads for the pickers and the management surface.
 *
 * A listing is scoped: the global-scope read shows the tiers that exist outside
 * any project, the project-scope read shows those plus the project's own. The
 * detail read is the one surface that carries instruction text (R6.3), so it is
 * addressed by the qualified reference an editor already holds — nothing
 * prefetches it for a whole listing.
 */
const GLOBAL_LIBRARY_PATH = "/api/agent-profiles";

function projectLibraryPath(projectName: string): string {
  return `/api/projects/${encodeURIComponent(projectName)}/agent-profiles`;
}

export const agentProfileQueries = {
  globalLibrary: () =>
    queryOptions({
      queryKey: agentProfileKeys.globalList(),
      queryFn: ({ signal }) =>
        apiFetch(GLOBAL_LIBRARY_PATH, agentProfileLibraryListingSchema, {
          signal,
        }),
    }),

  projectLibrary: (projectName: string) =>
    queryOptions({
      queryKey: agentProfileKeys.projectList(projectName),
      queryFn: ({ signal }) =>
        apiFetch(
          projectLibraryPath(projectName),
          agentProfileLibraryListingSchema,
          { signal },
        ),
    }),

  globalProfile: (tier: AgentProfileTier, id: string) =>
    queryOptions({
      queryKey: agentProfileKeys.globalDetail(tier, id),
      queryFn: ({ signal }) =>
        apiFetch(
          `/api/agent-profiles/${tier}/${encodeURIComponent(id)}`,
          agentProfileLibraryEntrySchema,
          { signal },
        ),
    }),

  projectProfile: (projectName: string, tier: AgentProfileTier, id: string) =>
    queryOptions({
      queryKey: agentProfileKeys.projectDetail(projectName, tier, id),
      queryFn: ({ signal }) =>
        apiFetch(
          `/api/projects/${encodeURIComponent(projectName)}/agent-profiles/${tier}/${encodeURIComponent(id)}`,
          agentProfileLibraryEntrySchema,
          { signal },
        ),
    }),

  /**
   * What deleting this profile would cost. A read, so it is a query rather
   * than a mutation — a mount-time mutation loses its result on remount, and
   * this one has to survive the dialog re-rendering around it.
   */
  projectDeletionPreview: (
    projectName: string,
    tier: AgentProfileTier,
    id: string,
  ) =>
    queryOptions({
      queryKey: agentProfileKeys.projectDeletionPreview(projectName, tier, id),
      queryFn: ({ signal }) =>
        apiFetch(
          `/api/projects/${encodeURIComponent(projectName)}/agent-profiles/${tier}/${encodeURIComponent(id)}/deletion-preview`,
          agentProfileDeletionReportSchema,
          { signal },
        ),
    }),
} as const;

export function useGlobalAgentProfileLibrary() {
  return useQuery(agentProfileQueries.globalLibrary());
}

export function useProjectAgentProfileLibrary(projectName: string) {
  return useQuery(agentProfileQueries.projectLibrary(projectName));
}

/**
 * The listing for whichever scope a surface belongs to.
 *
 * The global-defaults form has no project to scope by, and a picker that
 * demanded one would either invent a project or be excluded from that surface.
 * Absent project name means the global scope — the tiers that exist outside any
 * project — rather than an empty listing.
 */
export function useAgentProfileLibrary(projectName: string | null | undefined) {
  // One `queryOptions` with a scoped key rather than a ternary between the two
  // above: those carry different literal key tuples, and a union of them is not
  // one query for `useQuery` to run.
  const scoped =
    projectName === null || projectName === undefined || projectName === ""
      ? null
      : projectName;
  return useQuery(
    queryOptions({
      queryKey:
        scoped === null
          ? agentProfileKeys.globalList()
          : agentProfileKeys.projectList(scoped),
      queryFn: ({ signal }) =>
        apiFetch(
          scoped === null ? GLOBAL_LIBRARY_PATH : projectLibraryPath(scoped),
          agentProfileLibraryListingSchema,
          { signal },
        ),
    }),
  );
}

export function useGlobalAgentProfile(tier: AgentProfileTier, id: string) {
  return useQuery(agentProfileQueries.globalProfile(tier, id));
}

/**
 * The one read that carries instruction text, so it is addressed by a qualified
 * reference the caller already holds. `enabled` exists because an editor with
 * nothing open has no reference to ask about — fetching `""` would be a
 * guaranteed miss, not a read.
 */
export function useProjectAgentProfile(
  projectName: string,
  tier: AgentProfileTier,
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...agentProfileQueries.projectProfile(projectName, tier, id),
    enabled: (options?.enabled ?? true) && id.length > 0,
  });
}

/**
 * The deletion preview, fetched only while the confirmation dialog is open.
 *
 * `enabled` is the dialog's open state on purpose: the server scans the
 * filesystem on every call, and the enumeration is a photograph of the moment
 * the human is looking at it (D14) — nothing is gained by holding a stale one
 * while the dialog is closed.
 */
export function useAgentProfileDeletionPreview(
  projectName: string,
  tier: AgentProfileTier,
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...agentProfileQueries.projectDeletionPreview(projectName, tier, id),
    enabled: (options?.enabled ?? true) && id.length > 0,
  });
}
