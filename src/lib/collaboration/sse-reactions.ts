import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { scopedStatusEventSchema } from "@/lib/api/sse-events";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { invalidateConversationViews } from "@/lib/conversations/sse-reactions";
import { projectKeys } from "@/lib/projects/query-keys";
import { collaborationKeys } from "./query-keys";
export function registerCollaborationSseReactions(
  es: EventSource,
  deps: { queryClient: QueryClient },
): void {
  const { queryClient } = deps;
  addSseListener(es, "scoped-status", scopedStatusEventSchema, (data) => {
    if (data.scope === "collaboration") {
      void queryClient.invalidateQueries({
        queryKey: collaborationKeys.all,
      });
      invalidateConversationViews(
        queryClient,
        data.projectName,
        data.sessionName,
      );
      // The slice writes the final answer onto the conversation
      // transcript via `appendTranscriptEntry`, and progress envelopes
      // can also land while the messages query has stopped polling —
      // refetch only the affected conversation's messages so an open
      // transcript view stays current without invalidating every
      // cached conversation (which can produce a refetch storm under
      // a chatty collaboration). The workflowId arrives as `scopeId`;
      // map it to a conversationId via the cached active list.
      const activeData = queryClient.getQueryData<{
        activeCollaborationExecutions: Array<{
          workflowId: string;
          conversationId: string | null;
        }>;
      }>(conversationKeys.active());
      const collab = activeData?.activeCollaborationExecutions.find(
        (c) => c.workflowId === data.scopeId,
      );
      if (collab?.conversationId) {
        void queryClient.invalidateQueries({
          queryKey: conversationKeys.messages(
            data.projectName,
            data.sessionName,
            collab.conversationId,
          ),
        });
      }
      void queryClient.invalidateQueries({
        queryKey: projectKeys.list(),
      });
      return;
    }
  });
}
