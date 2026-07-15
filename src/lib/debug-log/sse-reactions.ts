/**
 * Debug-mode SSE reactions, registered against the shared `/api/events`
 * EventSource by the client assembly point (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { debugLogKeys } from "@/lib/debug-log/query-keys";
import {
  debugLogReceivedEventSchema,
  debugModeStatusEventSchema,
} from "@/lib/debug-log/schemas";
import { sessionKeys } from "@/lib/sessions/query-keys";

export interface DebugLogSseReactionDeps {
  queryClient: QueryClient;
}

export function registerDebugLogSseReactions(
  es: EventSource,
  deps: DebugLogSseReactionDeps,
): void {
  const { queryClient } = deps;

  addSseListener(es, "debug-mode-status", debugModeStatusEventSchema, (d) => {
    void queryClient.invalidateQueries({
      queryKey: conversationKeys.active(),
    });
    void queryClient.invalidateQueries({
      queryKey: sessionKeys.detail(d.projectName, d.sessionName),
    });
  });

  addSseListener(es, "debug-log-received", debugLogReceivedEventSchema, (d) => {
    void queryClient.invalidateQueries({
      queryKey: conversationKeys.active(),
    });
    queryClient.setQueryData(
      debugLogKeys.stats(d.projectName, d.sessionName, d.conversationId),
      d.entryCount,
    );
  });
}
