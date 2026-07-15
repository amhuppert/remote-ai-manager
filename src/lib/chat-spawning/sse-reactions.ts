/**
 * Chat-spawning SSE reactions, registered against the shared `/api/events`
 * EventSource by the client assembly point (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { spawnResultEventSchema } from "@/lib/chat-spawning/schemas";
import { sessionKeys } from "@/lib/sessions/query-keys";

export interface ChatSpawningSseReactionDeps {
  queryClient: QueryClient;
}

export function registerChatSpawningSseReactions(
  es: EventSource,
  deps: ChatSpawningSseReactionDeps,
): void {
  // The spawn card in the submitting tab shows the result from its own
  // mutation state; every tab's card resolves spawned-session statuses by
  // cross-referencing the project's sessions list (selectSpawnedSessionStatuses),
  // and the payload lacks full SessionListItem rows — so the reaction is a
  // narrow refetch of that list rather than a setQueryData patch.
  addSseListener(es, "spawn-result", spawnResultEventSchema, (d) => {
    void deps.queryClient.invalidateQueries({
      queryKey: sessionKeys.list(d.projectName),
    });
  });
}
