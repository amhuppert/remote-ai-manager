import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { devServerKeys } from "@/lib/dev-server/query-keys";
import {
  devServerOverviewResponseSchema,
  type DevServerOverviewResponse,
} from "@/lib/dev-server/schemas";

function fetchDevServerOverview(): Promise<DevServerOverviewResponse> {
  return apiFetch("/api/dev-servers", devServerOverviewResponseSchema);
}

/**
 * Every project's dev servers across sessions. No `refetchInterval`: every
 * status transition publishes `dev-server-status`, and
 * `registerDevServerSseReactions` invalidates this key from it. `staleTime`
 * only governs remounts between pages.
 */
export function useDevServerOverviewQuery() {
  return useQuery({
    queryKey: devServerKeys.overview(),
    queryFn: fetchDevServerOverview,
    staleTime: 30_000,
  });
}

export function countRunningDevServers(
  overview: DevServerOverviewResponse,
): number {
  return overview.projects.reduce(
    (sum, project) =>
      sum +
      project.servers.filter((server) => server.status === "running").length,
    0,
  );
}

/** Running count for the topbar entry; null until loaded. */
export function useRunningDevServerCount(): number | null {
  const query = useQuery({
    queryKey: devServerKeys.overview(),
    queryFn: fetchDevServerOverview,
    staleTime: 30_000,
    select: countRunningDevServers,
  });
  return query.data ?? null;
}
