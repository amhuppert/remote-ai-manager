import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { alignmentKeys } from "./query-keys";
import {
  alignmentDiffSchema,
  alignmentStateSchema,
  type AlignmentState,
} from "./schemas";

export function useAlignmentStateQuery(
  projectName: string,
  sessionName: string,
  options?: { enabled?: boolean },
) {
  return useQuery<AlignmentState>({
    queryKey: alignmentKeys.state(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/alignment`,
        alignmentStateSchema,
      ),
    ...(options?.enabled !== undefined && { enabled: options.enabled }),
  });
}

export function useAlignmentDiffQuery(
  projectName: string,
  sessionName: string,
  from: number,
  to: number,
  enabled = true,
) {
  return useQuery({
    queryKey: alignmentKeys.diff(projectName, sessionName, from, to),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/alignment/diff?from=${from}&to=${to}`,
        alignmentDiffSchema,
      ),
    enabled,
  });
}
