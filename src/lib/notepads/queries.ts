import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { ApiCallError } from "@/lib/api/errors";
import { apiFetch } from "@/lib/api/fetcher";
import { notepadKeys } from "./query-keys";
import {
  notepadListItemSchema,
  notepadRevisionSchema,
  notepadSchema,
  resolvedNotepadCommentThreadSchema,
  type Notepad,
  type NotepadRevision,
  type NotepadScope,
  type NotepadSort,
  type NotepadWriteMode,
} from "./schemas";

export const notepadDetailResponseSchema = z.object({ notepad: notepadSchema });
const notepadListResponseSchema = z.object({
  notepads: z.array(notepadListItemSchema),
});
const notepadRevisionsResponseSchema = z.object({
  revisions: z.array(notepadRevisionSchema),
});
const notepadCommentsResponseSchema = z.object({
  comments: z.array(resolvedNotepadCommentThreadSchema),
});

/**
 * What a reference chip needs to render: identity, the live name, and the
 * constraints a reader should see. Deliberately content-free — a chip resolves
 * once per notepad id and the content can be arbitrarily large, so it is
 * projected away before it reaches the query cache.
 */
export interface NotepadSummary {
  id: string;
  name: string;
  scope: NotepadScope;
  revision: number;
  writeMode: NotepadWriteMode;
  archived: boolean;
}

/**
 * A deleted notepad is an expected outcome for a captured reference, not a
 * failure: `missing` is data so a chip can render its missing state, rather
 * than an error the chip would have to distinguish from a network fault.
 */
export type NotepadSummaryResolution =
  | { state: "found"; summary: NotepadSummary }
  | { state: "missing" };

/**
 * A revision and its immediate predecessor, resolved by revision number
 * through the API — never against whichever page the bounded history listing
 * happens to hold.
 */
export interface NotepadRevisionResolution {
  target: NotepadRevision;
  /** Null only for the create revision, which genuinely has no predecessor. */
  predecessor: NotepadRevision | null;
}

function toSummary(notepad: Notepad): NotepadSummary {
  return {
    id: notepad.id,
    name: notepad.name,
    scope: notepad.scope,
    revision: notepad.revision,
    writeMode: notepad.writeMode,
    archived: notepad.archived,
  };
}

export const notepadQueries = {
  summary: (notepadId: string) =>
    queryOptions({
      queryKey: notepadKeys.summary(notepadId),
      queryFn: async ({ signal }): Promise<NotepadSummaryResolution> => {
        try {
          const response = await apiFetch(
            `/api/notepads/${encodeURIComponent(notepadId)}`,
            notepadDetailResponseSchema,
            { signal },
          );
          return { state: "found", summary: toSummary(response.notepad) };
        } catch (error) {
          if (error instanceof ApiCallError && error.status === 404) {
            return { state: "missing" };
          }
          throw error;
        }
      },
      refetchOnReconnect: false,
    }),

  /**
   * Everything reachable from one project: its own notepads merged with the
   * global ones, archived excluded, pinned-then-recency ordered by the server.
   */
  pickerList: (projectName: string) =>
    queryOptions({
      queryKey: notepadKeys.pickerList(projectName),
      queryFn: async ({ signal }) => {
        const params = new URLSearchParams({ project: projectName });
        const response = await apiFetch(
          `/api/notepads?${params.toString()}`,
          notepadListResponseSchema,
          { signal },
        );
        return response.notepads;
      },
      refetchOnReconnect: false,
    }),

  /** The full notepad, content included — what the open panel edits. */
  detail: (notepadId: string) =>
    queryOptions({
      queryKey: notepadKeys.detail(notepadId),
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          `/api/notepads/${encodeURIComponent(notepadId)}`,
          notepadDetailResponseSchema,
          { signal },
        );
        return response.notepad;
      },
      refetchOnReconnect: false,
    }),

  /**
   * Global notepads alone. The picker and panel lists both need a project to
   * merge against; a capture raised outside every project has none, and must
   * still see the global pool it will land in.
   */
  globalList: (sort: NotepadSort, includeArchived: boolean) =>
    queryOptions({
      queryKey: notepadKeys.globalList(sort, includeArchived),
      queryFn: async ({ signal }) => {
        const params = new URLSearchParams({ scope: "global", sort });
        if (includeArchived) params.set("archived", "true");
        const response = await apiFetch(
          `/api/notepads?${params.toString()}`,
          notepadListResponseSchema,
          { signal },
        );
        return response.notepads;
      },
      refetchOnReconnect: false,
    }),

  /** The browse list: global + one project's notepads, server-ordered. */
  panelList: (
    projectName: string,
    sort: NotepadSort,
    includeArchived: boolean,
  ) =>
    queryOptions({
      queryKey: notepadKeys.panelList(projectName, sort, includeArchived),
      queryFn: async ({ signal }) => {
        const params = new URLSearchParams({ project: projectName, sort });
        if (includeArchived) params.set("archived", "true");
        const response = await apiFetch(
          `/api/notepads?${params.toString()}`,
          notepadListResponseSchema,
          { signal },
        );
        return response.notepads;
      },
      refetchOnReconnect: false,
    }),

  /**
   * Id-addressed resolution for history selection and diff targets: the
   * revision and its immediate predecessor, independent of the bounded
   * listing window. A missing revision resolves to null — like a deleted
   * notepad on the summary query, absence is expected data, not an error.
   */
  revisionResolution: (notepadId: string, revision: number) =>
    queryOptions({
      queryKey: [
        ...notepadKeys.revisions(notepadId),
        { at: revision },
      ] as const,
      queryFn: async ({
        signal,
      }): Promise<NotepadRevisionResolution | null> => {
        try {
          const response = await apiFetch(
            `/api/notepads/${encodeURIComponent(notepadId)}/revisions?at=${revision}`,
            notepadRevisionsResponseSchema,
            { signal },
          );
          const target =
            response.revisions.find((rev) => rev.revision === revision) ?? null;
          if (target === null) return null;
          const predecessor = response.revisions.reduce<NotepadRevision | null>(
            (best, rev) =>
              rev.revision < revision &&
              (best === null || rev.revision > best.revision)
                ? rev
                : best,
            null,
          );
          return { target, predecessor };
        } catch (error) {
          if (error instanceof ApiCallError && error.status === 404) {
            return null;
          }
          throw error;
        }
      },
      refetchOnReconnect: false,
    }),

  /**
   * Every review comment on one notepad — open and resolved alike — each with
   * its passage resolved against the current content. Unfiltered because the
   * panel shows both sets: a resolved comment must stay reachable to reopen.
   */
  comments: (notepadId: string) =>
    queryOptions({
      queryKey: notepadKeys.comments(notepadId),
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          `/api/notepads/${encodeURIComponent(notepadId)}/comments`,
          notepadCommentsResponseSchema,
          { signal },
        );
        return response.comments;
      },
      refetchOnReconnect: false,
    }),

  /** Bounded revision history, newest first, for the history drawer. */
  revisions: (notepadId: string, limit?: number) =>
    queryOptions({
      // The limit is part of the key so differently-sized windows never serve
      // each other; invalidation on the unbounded key still prefix-matches.
      queryKey: [
        ...notepadKeys.revisions(notepadId),
        { limit: limit ?? null },
      ] as const,
      queryFn: async ({ signal }) => {
        const search = limit === undefined ? "" : `?limit=${limit}`;
        const response = await apiFetch(
          `/api/notepads/${encodeURIComponent(notepadId)}/revisions${search}`,
          notepadRevisionsResponseSchema,
          { signal },
        );
        return response.revisions;
      },
      refetchOnReconnect: false,
    }),
} as const;

export function useNotepadSummaryQuery(notepadId: string) {
  return useQuery({
    ...notepadQueries.summary(notepadId),
    enabled: notepadId.length > 0,
  });
}

export function useNotepadPickerListQuery(projectName: string) {
  return useQuery({
    ...notepadQueries.pickerList(projectName),
    enabled: projectName.length > 0,
  });
}

export function useNotepadDetailQuery(
  notepadId: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...notepadQueries.detail(notepadId ?? ""),
    enabled:
      notepadId !== null && notepadId.length > 0 && (options?.enabled ?? true),
  });
}

export function useNotepadPanelListQuery(
  projectName: string,
  sort: NotepadSort,
  includeArchived: boolean,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...notepadQueries.panelList(projectName, sort, includeArchived),
    enabled: projectName.length > 0 && (options?.enabled ?? true),
  });
}

export function useNotepadRevisionResolutionQuery(
  notepadId: string,
  revision: number | null,
) {
  return useQuery({
    ...notepadQueries.revisionResolution(notepadId, revision ?? 0),
    enabled: notepadId.length > 0 && revision !== null,
  });
}

export function useNotepadCommentsQuery(
  notepadId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...notepadQueries.comments(notepadId),
    enabled: notepadId.length > 0 && (options?.enabled ?? true),
  });
}

export function useNotepadRevisionsQuery(
  notepadId: string,
  options?: { enabled?: boolean; limit?: number },
) {
  return useQuery({
    ...notepadQueries.revisions(notepadId, options?.limit),
    enabled: notepadId.length > 0 && (options?.enabled ?? true),
  });
}
