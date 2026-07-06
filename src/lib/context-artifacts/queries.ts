import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch } from "@/lib/api/fetcher";
import { contextArtifactRowSchema } from "./schemas";
import { contextArtifactKeys, type ContextArtifactTarget } from "./query-keys";

/**
 * Read-time freshness flags the artifact endpoints derive onto every response
 * row (never stored server-side — see route-handlers.ts `freshnessFor`).
 */
const freshnessFlagsShape = {
  stale: z.boolean(),
  staleBehindMessages: z.number().int(),
  outdated: z.boolean(),
};

/** GET list item: a row without its payload, plus derived freshness. */
export const contextArtifactListItemSchema = contextArtifactRowSchema
  .omit({ payload: true })
  .extend(freshnessFlagsShape);
export type ContextArtifactListItem = z.infer<
  typeof contextArtifactListItemSchema
>;

export const contextArtifactListResponseSchema = z.array(
  contextArtifactListItemSchema,
);

/** GET one: the full row including the payload envelope, plus freshness. */
export const contextArtifactDetailSchema =
  contextArtifactRowSchema.extend(freshnessFlagsShape);
export type ContextArtifactDetail = z.infer<typeof contextArtifactDetailSchema>;

export function contextArtifactsBaseUrl(target: ContextArtifactTarget): string {
  const project = encodeURIComponent(target.projectName);
  const conversation = encodeURIComponent(target.conversationId);
  if (target.scope === "session") {
    const session = encodeURIComponent(target.sessionName);
    return `/api/projects/${project}/sessions/${session}/conversations/${conversation}/context-artifacts`;
  }
  return `/api/projects/${project}/conversations/${conversation}/context-artifacts`;
}

export function useContextArtifacts(
  target: ContextArtifactTarget,
  options?: { enabled?: boolean; staleTime?: number },
) {
  return useQuery({
    queryKey: contextArtifactKeys.list(target),
    queryFn: () =>
      apiFetch(
        contextArtifactsBaseUrl(target),
        contextArtifactListResponseSchema,
      ),
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime,
  });
}

export function useContextArtifact(
  target: ContextArtifactTarget,
  artifactId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: contextArtifactKeys.detail(target, artifactId),
    queryFn: () =>
      apiFetch(
        `${contextArtifactsBaseUrl(target)}/${encodeURIComponent(artifactId)}`,
        contextArtifactDetailSchema,
      ),
    enabled: options?.enabled ?? true,
  });
}
