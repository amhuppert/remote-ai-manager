import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { gitKeys, conflictKeys } from "./query-keys";
import { apiFetch } from "@/lib/api/fetcher";
import { sessionDiffSchema, commitsResponseSchema } from "./schemas";
import { conflictEntrySchema } from "@/lib/jobs/schemas";

const conflictsResponseSchema = z.object({
  conflicts: z.array(conflictEntrySchema).optional(),
  jobId: z.string().optional(),
});

export type ConflictsQueryResult = z.infer<
  typeof conflictsResponseSchema
> | null;

export function useConflictsQuery(projectName: string, sessionName: string) {
  return useQuery<ConflictsQueryResult>({
    queryKey: conflictKeys.detail(projectName, sessionName),
    queryFn: async () => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conflicts`,
      );
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`Failed to load conflicts: ${res.status}`);
      }

      return conflictsResponseSchema.parse(await res.json());
    },
  });
}

export function useSessionDiffQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: gitKeys.diff(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/diff`,
        sessionDiffSchema,
      ),
  });
}

export function useCommitsQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: gitKeys.commits(projectName, sessionName),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commits`,
        commitsResponseSchema,
      );
      return data.commits;
    },
  });
}

export function useCommitDiffQuery(
  projectName: string,
  sessionName: string,
  hash: string | null,
) {
  return useQuery({
    queryKey: gitKeys.commitDiff(projectName, sessionName, hash ?? ""),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commits/${encodeURIComponent(hash!)}/diff`,
        sessionDiffSchema,
      ),
    enabled: !!hash,
  });
}
