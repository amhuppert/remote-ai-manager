/**
 * Notepad SSE reactions, registered against the shared `/api/events`
 * EventSource by the client assembly point (`NotificationListener`).
 *
 * The change frame is content-free by contract, so reactions reconcile the
 * narrowest caches they can from what it carries: list rows and chip
 * summaries patch/invalidate from the projected list item, while content
 * always travels through a refetch of the invalidated detail query.
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { isNotepadProjectListKey, notepadKeys } from "./query-keys";
import {
  notepadChangedEventSchema,
  type Notepad,
  type NotepadAuthorKind,
  type NotepadChangedEvent,
} from "./schemas";
import type { NotepadSummaryResolution } from "./queries";

/**
 * A head-advancing write by some party, forwarded to the session-detail store
 * so an open editor can attribute the update (clean-adopt strip vs dirty
 * collision banner). Content never rides this signal — the open view refetches
 * it through the invalidated detail query.
 */
export interface NotepadExternalWrite {
  notepadId: string;
  revision: number;
  authorKind: NotepadAuthorKind;
}

export interface NotepadSseReactionDeps {
  queryClient: QueryClient;
  recordNotepadExternalWrite(write: NotepadExternalWrite): void;
}

/**
 * List queries key by project NAME while the event carries the project PATH;
 * the name is the path's last segment (the same bridge agent-profile reactions
 * use). A path that names nothing falls back to over-invalidation — a stale
 * list is worse than a redundant refetch.
 */
function projectNameFromPath(projectPath: string): string | null {
  const segments = projectPath.split(/[/\\]/).filter((part) => part !== "");
  return segments[segments.length - 1] ?? null;
}

function invalidateListCaches(
  queryClient: QueryClient,
  event: NotepadChangedEvent,
): void {
  // A global notepad is reachable from every project's listing.
  const projectName =
    event.scope === "global" || event.projectPath === null
      ? null
      : projectNameFromPath(event.projectPath);
  if (projectName === null) {
    void queryClient.invalidateQueries({ queryKey: notepadKeys.lists() });
    return;
  }
  void queryClient.invalidateQueries({
    queryKey: notepadKeys.lists(),
    predicate: (query) => isNotepadProjectListKey(query.queryKey, projectName),
  });
}

/** Patch caches only where a query already exists — never seed new entries. */
function reconcileSummaryCache(
  queryClient: QueryClient,
  event: NotepadChangedEvent,
): void {
  const key = notepadKeys.summary(event.notepadId);
  if (event.change === "deleted") {
    queryClient.setQueriesData<NotepadSummaryResolution>(
      { queryKey: key, exact: true },
      () => ({ state: "missing" }),
    );
    return;
  }
  const item = event.listItem;
  if (!item) return;
  queryClient.setQueriesData<NotepadSummaryResolution>(
    { queryKey: key, exact: true },
    (resolution) =>
      resolution?.state === "found"
        ? {
            state: "found",
            summary: {
              id: item.id,
              name: item.name,
              scope: item.scope,
              revision: item.revision,
              writeMode: item.writeMode,
              archived: item.archived,
            },
          }
        : resolution,
  );
}

function reconcileDetailCache(
  queryClient: QueryClient,
  event: NotepadChangedEvent,
): void {
  const key = notepadKeys.detail(event.notepadId);
  if (event.change === "deleted") {
    // Removal (not patching) so an open view's refetch reports not-found
    // instead of presenting a notepad that no longer exists. The revisions
    // key nests under the detail key, so this removes it too.
    queryClient.removeQueries({ queryKey: key });
    return;
  }
  if (event.revision !== null) {
    // Head advanced: content must come from a refetch, and the revisions key
    // nests under the detail key so history goes stale with it.
    void queryClient.invalidateQueries({ queryKey: key });
    return;
  }
  // Organize change: patch display metadata in place. Content and revision
  // stay untouched — an open editor's adopt logic keys off revision, and a
  // revision bump without its content would clobber the buffer with old text.
  const item = event.listItem;
  if (!item) return;
  queryClient.setQueriesData<Notepad>(
    { queryKey: key, exact: true },
    (detail) =>
      detail
        ? {
            ...detail,
            name: item.name,
            writeMode: item.writeMode,
            pinned: item.pinned,
            archived: item.archived,
          }
        : detail,
  );
}

export function registerNotepadSseReactions(
  es: EventSource,
  deps: NotepadSseReactionDeps,
): void {
  const { queryClient } = deps;

  addSseListener(es, "notepad-changed", notepadChangedEventSchema, (event) => {
    invalidateListCaches(queryClient, event);
    reconcileSummaryCache(queryClient, event);
    reconcileDetailCache(queryClient, event);

    if (event.revision !== null && event.authorKind !== null) {
      deps.recordNotepadExternalWrite({
        notepadId: event.notepadId,
        revision: event.revision,
        authorKind: event.authorKind,
      });
    }
  });
}
