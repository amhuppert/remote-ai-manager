/**
 * Context-artifact SSE reactions, registered against the shared
 * `/api/events` EventSource by the client assembly point
 * (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { contextArtifactStatusEventSchema } from "@/lib/context-artifacts/schemas";
import { applyContextArtifactStatusEvent } from "@/lib/context-artifacts/sse-cache";

export interface ContextArtifactSseReactionDeps {
  queryClient: QueryClient;
}

export function registerContextArtifactSseReactions(
  es: EventSource,
  deps: ContextArtifactSseReactionDeps,
): void {
  // Compaction run progress → reconcile the context-artifact caches.
  // NOTE: the event name is underscore-separated ("context_artifact_status",
  // design docs/design/conversation-compaction/README.md §9.1), unlike the
  // other hyphenated SSE names — a hyphenated listener would never fire.
  addSseListener(
    es,
    "context_artifact_status",
    contextArtifactStatusEventSchema,
    (data) => {
      applyContextArtifactStatusEvent(deps.queryClient, data);
    },
  );
}
