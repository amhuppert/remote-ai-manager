import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { mutationFetch } from "@/lib/api/fetcher";
import {
  cacheUpdate,
  createOptimisticMutation,
  type OptimisticCacheUpdate,
} from "@/lib/api/optimistic";
import { CONTEXT_ARTIFACT_SCHEMA_VERSION, type ArtifactKind } from "./schemas";
import { contextArtifactKeys, type ContextArtifactTarget } from "./query-keys";
import {
  contextArtifactDetailSchema,
  contextArtifactListItemSchema,
  contextArtifactsBaseUrl,
  type ContextArtifactListItem,
} from "./queries";

export interface CompactVariables {
  kind: ArtifactKind;
  /** Required for `message_compaction`, forbidden for `conversation_compaction`. */
  messageIndex?: number;
  force?: boolean;
}

/** POST → 202 pending (background run started) or 200 artifact (wait / already fresh). */
export const compactResponseSchema = z.union([
  z.object({
    artifact: contextArtifactDetailSchema,
    hint: z.string().optional(),
  }),
  z.object({ artifactId: z.string(), status: z.literal("pending") }),
]);
export type CompactResponse = z.infer<typeof compactResponseSchema>;

const deleteResponseSchema = z.object({ deleted: z.literal(true) });

/**
 * One artifact slot exists per conversation (conversation kind) or per
 * (conversation, messageIndex) pair (message kind) — the repo's partial unique
 * indexes. Optimistic updates target rows by that logical key so a refresh
 * flips the existing row to pending instead of appending a duplicate.
 */
function matchesLogicalKey(
  row: ContextArtifactListItem,
  kind: ArtifactKind,
  messageIndex: number | null,
): boolean {
  if (row.kind !== kind) return false;
  return (
    kind === "conversation_compaction" || row.messageIndex === messageIndex
  );
}

/**
 * Rung-2 optimistic placeholder (data-fetching-and-sse.md): the run's result
 * can't be predicted client-side, so a `pending` row with an `optimistic-*` id
 * stands in until the 202 response or the `context_artifact_status` SSE event
 * reconciles it by id. Fields the client can't know (projectPath, selection,
 * coverage) carry inert placeholders that the post-settle refetch replaces.
 */
function makeOptimisticRow(
  target: ContextArtifactTarget,
  variables: CompactVariables,
): ContextArtifactListItem {
  const nowIso = new Date().toISOString();
  return {
    id: `optimistic-${crypto.randomUUID()}`,
    kind: variables.kind,
    scope: target.scope,
    projectPath: "",
    sessionName: target.scope === "session" ? target.sessionName : null,
    conversationId: target.conversationId,
    messageId: null,
    messageIndex: variables.messageIndex ?? null,
    coveredStartSeq: -1,
    coveredEndSeq: -1,
    sourceHash: "",
    status: "pending",
    error: null,
    backend: "claude",
    modelSelection: { modelId: "pending", parameters: {} },
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: "",
    normalizerVersion: "",
    createdBy: "user",
    createdByConversationId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    stale: false,
    staleBehindMessages: 0,
    outdated: false,
  };
}

export function useCompactMutation(target: ContextArtifactTarget) {
  const queryClient = useQueryClient();
  const listKey = contextArtifactKeys.list(target);

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: (variables: CompactVariables) =>
        mutationFetch(
          contextArtifactsBaseUrl(target),
          "compact-conversation",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: variables.kind,
              messageIndex: variables.messageIndex,
              mode: "create_or_refresh",
              force: variables.force,
            }),
          },
          compactResponseSchema,
        ),
      updates: [
        cacheUpdate<CompactVariables, ContextArtifactListItem[]>({
          key: () => listKey,
          update: (old, variables) => {
            const messageIndex = variables.messageIndex ?? null;
            const rows = old ?? [];
            if (
              rows.some((row) =>
                matchesLogicalKey(row, variables.kind, messageIndex),
              )
            ) {
              return rows.map((row) =>
                matchesLogicalKey(row, variables.kind, messageIndex)
                  ? { ...row, status: "pending" as const, error: null }
                  : row,
              );
            }
            return [...rows, makeOptimisticRow(target, variables)];
          },
        }),
      ],
      invalidateKeys: () => [contextArtifactKeys.conversation(target)],
      onSuccess: (data, variables) => {
        const messageIndex = variables.messageIndex ?? null;
        if ("artifact" in data) {
          const { artifact } = data;
          queryClient.setQueryData(
            contextArtifactKeys.detail(target, artifact.id),
            artifact,
          );
          const { payload: _payload, ...listItemCandidate } = artifact;
          const listItem =
            contextArtifactListItemSchema.parse(listItemCandidate);
          queryClient.setQueryData<ContextArtifactListItem[]>(
            listKey,
            (old) => {
              if (!old) return old;
              return old.map((row) =>
                matchesLogicalKey(row, variables.kind, messageIndex)
                  ? listItem
                  : row,
              );
            },
          );
          return;
        }
        queryClient.setQueryData<ContextArtifactListItem[]>(listKey, (old) => {
          if (!old) return old;
          // The SSE status event may have already adopted the server id.
          if (old.some((row) => row.id === data.artifactId)) return old;
          return old.map((row) =>
            matchesLogicalKey(row, variables.kind, messageIndex)
              ? { ...row, id: data.artifactId }
              : row,
          );
        });
      },
    }),
  );
}

export function useDeleteArtifactMutation(target: ContextArtifactTarget) {
  const queryClient = useQueryClient();
  const listKey = contextArtifactKeys.list(target);

  // The detail entry is dropped outright (not patched); an error rollback
  // restores its snapshot like any other touched key.
  const detailRemoval: OptimisticCacheUpdate<string> = {
    cancelKey: (artifactId) => contextArtifactKeys.detail(target, artifactId),
    snapshotKeys: (_client, artifactId) => [
      contextArtifactKeys.detail(target, artifactId),
    ],
    apply: (client, artifactId) => {
      client.removeQueries({
        queryKey: contextArtifactKeys.detail(target, artifactId),
      });
    },
  };

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: (artifactId: string) =>
        mutationFetch(
          `${contextArtifactsBaseUrl(target)}/${encodeURIComponent(artifactId)}`,
          "delete-context-artifact",
          { method: "DELETE" },
          deleteResponseSchema,
        ),
      updates: [
        cacheUpdate<string, ContextArtifactListItem[]>({
          key: () => listKey,
          update: (old, artifactId) =>
            old?.filter((row) => row.id !== artifactId),
        }),
        detailRemoval,
      ],
      invalidateKeys: () => [contextArtifactKeys.conversation(target)],
    }),
  );
}
