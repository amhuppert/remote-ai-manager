import type { QueryClient } from "@tanstack/react-query";

import type { ContextArtifactStatusEvent } from "./schemas";
import { contextArtifactKeys, type ContextArtifactTarget } from "./query-keys";
import type { ContextArtifactDetail, ContextArtifactListItem } from "./queries";

function targetFromStatusEvent(
  event: ContextArtifactStatusEvent,
): ContextArtifactTarget {
  if (event.scope === "session") {
    return {
      scope: "session",
      projectName: event.projectName,
      sessionName: event.sessionName,
      conversationId: event.conversationId,
    };
  }
  return {
    scope: "project",
    projectName: event.projectName,
    conversationId: event.conversationId,
  };
}

/**
 * Rows match by server id first, then by the mutation's `optimistic-*`
 * placeholder for the same logical slot (kind, and messageIndex for message
 * compactions) — the SSE event is how a placeholder learns its real id when
 * it beats the POST response (arrival order is not guaranteed).
 */
function findEventRow(
  rows: ContextArtifactListItem[],
  event: ContextArtifactStatusEvent,
): number {
  const byId = rows.findIndex((row) => row.id === event.artifactId);
  if (byId !== -1) return byId;
  const messageIndex = event.messageIndex ?? null;
  return rows.findIndex(
    (row) =>
      row.id.startsWith("optimistic-") &&
      row.kind === event.kind &&
      (event.kind === "conversation_compaction" ||
        row.messageIndex === messageIndex),
  );
}

/**
 * Conversation-status fields the turn-end invalidator needs. Structurally
 * satisfied by both arms of `conversationStatusEventSchema` (the project arm
 * simply has no `sessionName`).
 */
export interface ConversationStatusForArtifacts {
  scope: "session" | "project";
  projectName: string;
  sessionName?: string;
  conversationId: string;
  status: string;
}

/**
 * Artifact freshness (`stale`) is derived at fetch time, so a "Fresh" chip
 * goes silently wrong the moment a turn appends transcript lines — until an
 * unrelated refetch lands (staleTime). This tracker watches conversation
 * status transitions and refetches the conversation's artifact queries (list
 * + detail share the conversation key prefix) exactly when a status LEAVES
 * "running" — the turn ended and the transcript advanced. Message-append
 * events are deliberately not used: invalidating per append would refetch on
 * every streamed block.
 */
export function createTurnEndArtifactInvalidator(): (
  queryClient: QueryClient,
  event: ConversationStatusForArtifacts,
) => void {
  const lastStatusByConversation = new Map<string, string>();
  return (queryClient, event) => {
    const previous = lastStatusByConversation.get(event.conversationId);
    lastStatusByConversation.set(event.conversationId, event.status);
    if (previous !== "running" || event.status === "running") return;
    const target: ContextArtifactTarget =
      event.scope === "session" && event.sessionName !== undefined
        ? {
            scope: "session",
            projectName: event.projectName,
            sessionName: event.sessionName,
            conversationId: event.conversationId,
          }
        : {
            scope: "project",
            projectName: event.projectName,
            conversationId: event.conversationId,
          };
    void queryClient.invalidateQueries({
      queryKey: contextArtifactKeys.conversation(target),
    });
  };
}

/**
 * Reconcile the artifact query caches with a `context_artifact_status` SSE
 * event. Status flips are patched in place (idempotent by id); terminal events
 * additionally invalidate so the authoritative row — payload, coverage,
 * freshness — is refetched, since the event deliberately carries none of it
 * (SSE frames stay small per data-fetching-and-sse.md).
 */
export function applyContextArtifactStatusEvent(
  queryClient: QueryClient,
  event: ContextArtifactStatusEvent,
): void {
  const target = targetFromStatusEvent(event);
  const listKey = contextArtifactKeys.list(target);
  const detailKey = contextArtifactKeys.detail(target, event.artifactId);
  const error =
    event.status === "failed" ? (event.error ?? "Compaction failed") : null;

  let patched = false;
  const cachedList =
    queryClient.getQueryData<ContextArtifactListItem[]>(listKey);
  if (cachedList !== undefined) {
    const index = findEventRow(cachedList, event);
    if (index !== -1) {
      patched = true;
      queryClient.setQueryData<ContextArtifactListItem[]>(
        listKey,
        cachedList.map((row, i) =>
          i === index
            ? { ...row, id: event.artifactId, status: event.status, error }
            : row,
        ),
      );
    }
  }

  const cachedDetail =
    queryClient.getQueryData<ContextArtifactDetail>(detailKey);
  if (cachedDetail !== undefined) {
    queryClient.setQueryData<ContextArtifactDetail>(detailKey, {
      ...cachedDetail,
      status: event.status,
      error,
    });
  }

  // An unmatched event means a row this client has never seen (e.g. a cctl or
  // agent trigger) — only a refetch can supply it.
  if (!patched || event.status !== "pending") {
    void queryClient.invalidateQueries({ queryKey: listKey });
  }
  if (event.status !== "pending") {
    void queryClient.invalidateQueries({ queryKey: detailKey });
  }
}
