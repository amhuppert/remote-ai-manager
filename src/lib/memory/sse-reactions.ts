/**
 * Memory SSE reactions, registered against the shared `/api/events`
 * EventSource by the client assembly point (`NotificationListener`).
 *
 * The change frame is content-free by contract — identity, scope owner,
 * lifecycle, head revision, never the hook or body — so every reaction here
 * invalidates and lets the panel refetch what it shows. Nothing patches prose
 * into a cache from the wire.
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener, type SseEventTarget } from "@/lib/api/sse";
import {
  isMemoryDetailKeyFor,
  isMemoryProjectScopedKey,
  memoryKeys,
} from "./query-keys";
import { memoryChangedEventSchema, type MemoryChangedEvent } from "./schemas";

export interface MemorySseReactionDeps {
  queryClient: QueryClient;
}

/**
 * Scoped queries key by project NAME while the event carries the project PATH;
 * the name is the path's last segment (the bridge the notepad and agent-profile
 * reactions already use). A path that names nothing falls back to
 * over-invalidation — a stale Library is worse than a redundant refetch.
 */
function projectNameFromPath(projectPath: string): string | null {
  const segments = projectPath.split(/[/\\]/).filter((part) => part !== "");
  return segments[segments.length - 1] ?? null;
}

/**
 * Invalidate the list and review-queue caches the change can be seen in. A
 * global note is reachable from every project's Library, so its owner cannot
 * narrow anything and every scope is invalidated.
 */
function invalidateScopedCaches(
  queryClient: QueryClient,
  event: MemoryChangedEvent,
): void {
  const projectName =
    event.scope === "global" || event.projectPath === null
      ? null
      : projectNameFromPath(event.projectPath);
  for (const familyKey of [memoryKeys.lists(), memoryKeys.reviews()]) {
    if (projectName === null) {
      void queryClient.invalidateQueries({ queryKey: familyKey });
      continue;
    }
    void queryClient.invalidateQueries({
      queryKey: familyKey,
      predicate: (query) =>
        isMemoryProjectScopedKey(query.queryKey, projectName),
    });
  }
}

function reconcileDetailCaches(
  queryClient: QueryClient,
  event: MemoryChangedEvent,
): void {
  const matches = (queryKey: readonly unknown[]) =>
    isMemoryDetailKeyFor(queryKey, event.memoryId);
  if (event.change === "deleted") {
    // Reset, not remove. Removing an entry notifies no observer: a detail
    // already on screen would keep rendering the deleted record until some
    // unrelated render rebuilt the query. Reset clears the entry AND tells its
    // observers, and the refetch it triggers for a mounted pane makes the
    // server report the record gone — this reaction states an absence it was
    // told about, it does not synthesize the not-found itself. Revision
    // history nests under the detail key, so it resets with the note.
    void queryClient.resetQueries({
      queryKey: memoryKeys.details(),
      predicate: (query) => matches(query.queryKey),
    });
    return;
  }
  void queryClient.invalidateQueries({
    queryKey: memoryKeys.details(),
    predicate: (query) => matches(query.queryKey),
  });
}

export function registerMemorySseReactions(
  es: SseEventTarget,
  deps: MemorySseReactionDeps,
): void {
  const { queryClient } = deps;

  addSseListener(es, "memory-changed", memoryChangedEventSchema, (event) => {
    invalidateScopedCaches(queryClient, event);
    reconcileDetailCaches(queryClient, event);
    // A block is composed from the whole visible library, so any note's change
    // can change any conversation's next injection — including a preview of a
    // conversation in another project, which a global note reaches. There is
    // nothing in the frame that could narrow this safely.
    void queryClient.invalidateQueries({
      queryKey: memoryKeys.indexPreviews(),
    });
  });
}
