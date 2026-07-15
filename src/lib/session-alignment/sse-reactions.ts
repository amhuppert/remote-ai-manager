/**
 * Session-alignment SSE reactions, registered against the shared
 * `/api/events` EventSource by the client assembly point
 * (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { sessionAlignmentUpdatedEventSchema } from "@/lib/session-alignment/schemas";
import { computeAlignmentInvalidations } from "@/lib/session-alignment/sse-invalidation";

export interface SessionAlignmentSseReactionDeps {
  queryClient: QueryClient;
}

export function registerSessionAlignmentSseReactions(
  es: EventSource,
  deps: SessionAlignmentSseReactionDeps,
): void {
  addSseListener(
    es,
    "session-alignment-updated",
    sessionAlignmentUpdatedEventSchema,
    (data) => {
      for (const { queryKey } of computeAlignmentInvalidations(data)) {
        void deps.queryClient.invalidateQueries({ queryKey });
      }
    },
  );
}
