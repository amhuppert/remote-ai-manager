import { useEffect } from "react";
import { z } from "zod";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiFetchOptional } from "@/lib/api/fetcher";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { stampedTranscriptMessageSchema } from "@/lib/conversations/schemas";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import { projectConversationKeys } from "./query-keys";
import type { ProjectConversationCreation } from "./mutations";

/**
 * A project conversation is "open" (i.e. rendered as a cockpit tab and counted
 * toward the list-derived open count) when it has not been closed and is not
 * archived. The
 * foundation persists `open` explicitly on project conversations; a missing
 * `open` is treated as open so a record predating the column still surfaces.
 * `closed = open === false && !archived`.
 */
export function isOpenProjectConversation(c: ConversationState): boolean {
  return c.open !== false && c.archived === false;
}

const projectConversationsResponseSchema = z.array(conversationStateSchema);
const projectMessagesResponseSchema = z.array(stampedTranscriptMessageSchema);

/**
 * GET the project's conversations. Returns `[]` when the foundation route is
 * absent (404) so the page degrades to first-run rather than erroring — the
 * read endpoints are consumed as an upstream contract that may not have shipped
 * yet. A malformed 200 payload still rejects (schema parse throws).
 */
async function fetchProjectConversations(
  projectName: string,
): Promise<ConversationState[]> {
  const data = await apiFetchOptional(
    `/api/projects/${encodeURIComponent(projectName)}/conversations`,
    projectConversationsResponseSchema,
  );
  return data ?? [];
}

/**
 * The project's open conversations (cockpit tabs). Server state is authoritative
 * for which conversations are open; ordering/active selection is layered by the
 * cockpit view-state store.
 */
export function useProjectConversationsQuery(
  projectName: string,
): UseQueryResult<ConversationState[]> {
  return useQuery({
    queryKey: projectConversationKeys.list(projectName),
    queryFn: () => fetchProjectConversations(projectName),
    select: (all) => all.filter(isOpenProjectConversation),
  });
}

/**
 * Every conversation the project has with the creation each one records — open,
 * closed, and archived. Shares the list query's key, so this is the same fetch
 * the cockpit tabs already read, and the same cache the scope=project
 * `conversation-created` SSE reaction appends to; a creation therefore reaches
 * this selection without waiting for a refetch.
 *
 * This is the second of the two sources that can name the conversation a
 * create-and-send turn created. It carries `creationRequestId` because
 * membership alone cannot: the list says which conversations exist, never which
 * submission caused one, so pairing a pending turn with an id that merely looks
 * new mistakes a reopen, another tab's creation, or a slow first fetch for the
 * turn's own conversation.
 */
export function useProjectConversationCreationsQuery(
  projectName: string,
): UseQueryResult<ProjectConversationCreation[]> {
  return useQuery({
    queryKey: projectConversationKeys.list(projectName),
    queryFn: () => fetchProjectConversations(projectName),
    // Module-scoped so the selected array keeps its identity across renders;
    // consumers drive an effect off it.
    select: selectConversationCreations,
  });
}

function selectConversationCreations(
  all: ConversationState[],
): ProjectConversationCreation[] {
  return all.map((c) => ({
    conversationId: c.id,
    creationRequestId: c.creationRequestId ?? null,
  }));
}

/**
 * GET an active project conversation's transcript messages. Returns `[]` when
 * the route is absent (404) so the transcript shows its empty state instead of
 * erroring. Disabled until a conversation is selected.
 */
export function useProjectConversationMessagesQuery(
  projectName: string,
  conversationId: string | null,
): UseQueryResult<TranscriptMessage[]> {
  return useQuery({
    queryKey: projectConversationKeys.messages(
      projectName,
      conversationId ?? "",
    ),
    queryFn: async () => {
      const data = await apiFetchOptional(
        `/api/projects/${encodeURIComponent(projectName)}/conversations/${encodeURIComponent(conversationId ?? "")}/messages`,
        projectMessagesResponseSchema,
      );
      return data ?? [];
    },
    enabled: conversationId !== null && conversationId !== "",
  });
}

/**
 * Refetch-on-focus fallback for near-real-time consistency. The global SSE
 * listener (NotificationListener) invalidates `projectConversationKeys` on
 * `scope:"project"` conversation events; this focus refetch is the safety net
 * for silently dropped SSE connections, keeping the cockpit's
 * first-run↔cockpit boundary and tabs correct (Req 12.1 / 12.3).
 */
export function useRefetchProjectConversationsOnFocus(
  projectName: string,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const onFocus = () => {
      void queryClient.invalidateQueries({
        queryKey: projectConversationKeys.list(projectName),
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [queryClient, projectName]);
}
