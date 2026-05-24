"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { imageCountResponseSchema } from "@/lib/images/schemas";
import { imageIndexKeys } from "@/lib/images/query-keys";
/**
 * Cumulative count of images persisted across all turns of a single
 * conversation. Used by the prompt editor to render the next inline
 * `[Image #N]` marker (next index = count + 1).
 */
export function useImageIndexCountQuery(
  projectName: string,
  sessionName: string,
  conversationId: string,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: imageIndexKeys.count(projectName, sessionName, conversationId),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/image-count`,
        imageCountResponseSchema,
      ).then((r) => r.count),
    enabled,
  });
}
