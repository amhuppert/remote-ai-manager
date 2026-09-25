/**
 * Dev-server SSE reactions, registered against the shared `/api/events`
 * EventSource by the client assembly point (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { devServerKeys } from "@/lib/dev-server/query-keys";
import { devServerStatusEventSchema } from "@/lib/dev-server/schemas";

export interface DevServerSseReactionDeps {
  queryClient: QueryClient;
}

export function registerDevServerSseReactions(
  es: EventSource,
  deps: DevServerSseReactionDeps,
): void {
  // The event carries the project/session it belongs to, so only that
  // owner's dev-server list is refetched instead of every session's. The
  // cross-project overview lists every owner, so any change refreshes it.
  addSseListener(
    es,
    "dev-server-status",
    devServerStatusEventSchema,
    (data) => {
      void deps.queryClient.invalidateQueries({
        queryKey:
          data.scope === "project"
            ? devServerKeys.project(data.projectName)
            : devServerKeys.list(data.projectName, data.sessionName),
      });
      void deps.queryClient.invalidateQueries({
        queryKey: devServerKeys.overview(),
      });
    },
  );
}
