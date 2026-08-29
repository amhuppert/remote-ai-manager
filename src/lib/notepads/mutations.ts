/**
 * Notepad mutations — optimistic by default per the responsiveness contract.
 *
 * Organization changes (rename, pin, archive, write mode) are predictable, so
 * they apply optimistically across every cache that shows the field — list
 * rows, the open detail, the chip summary — with snapshot rollback. Create and
 * delete are server-shaped outcomes: their triggering controls surface
 * `isPending`, and caches reconcile from the response. Content writes and
 * restore adopt the returned head revision so the editor always knows the base
 * of its next flush.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { mutationFetch } from "@/lib/api/fetcher";
import {
  notepadDetailResponseSchema,
  type NotepadSummaryResolution,
} from "./queries";
import { notepadKeys } from "./query-keys";
import { notepadCommentSchema } from "./schemas";
import type {
  Notepad,
  NotepadCommentAnchor,
  NotepadCommentStatus,
  NotepadListItem,
  NotepadScope,
  UpdateNotepadInput,
} from "./schemas";

function notepadUrl(notepadId: string): string {
  return `/api/notepads/${encodeURIComponent(notepadId)}`;
}

/** Patch a notepad's row wherever a mounted list query holds it. */
function patchListCaches(
  queryClient: QueryClient,
  notepadId: string,
  patch: Partial<NotepadListItem>,
): void {
  queryClient.setQueriesData<NotepadListItem[]>(
    { queryKey: notepadKeys.lists() },
    (rows) =>
      rows?.map((row) => (row.id === notepadId ? { ...row, ...patch } : row)),
  );
}

function removeFromListCaches(
  queryClient: QueryClient,
  notepadId: string,
): void {
  queryClient.setQueriesData<NotepadListItem[]>(
    { queryKey: notepadKeys.lists() },
    (rows) => rows?.filter((row) => row.id !== notepadId),
  );
}

/** Reconcile every read model from an authoritative detail response. */
function adoptNotepad(queryClient: QueryClient, notepad: Notepad): void {
  // A response can arrive after a newer head is already cached (a slow user
  // write racing an external write's SSE refetch). Adopting it would hide the
  // newer head, so a strictly older revision is dropped; an equal revision
  // still adopts — organization changes reuse the head's revision number.
  const cached = queryClient.getQueryData<Notepad>(
    notepadKeys.detail(notepad.id),
  );
  if (cached && cached.revision > notepad.revision) return;
  queryClient.setQueryData<Notepad>(notepadKeys.detail(notepad.id), notepad);
  queryClient.setQueryData<NotepadSummaryResolution>(
    notepadKeys.summary(notepad.id),
    {
      state: "found",
      summary: {
        id: notepad.id,
        name: notepad.name,
        scope: notepad.scope,
        revision: notepad.revision,
        writeMode: notepad.writeMode,
        archived: notepad.archived,
      },
    },
  );
}

export interface CreateNotepadVariables {
  scope: NotepadScope;
  /** Required for project scope: the project whose scope the notepad joins. */
  projectName?: string;
  name: string;
}

export function useCreateNotepadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: CreateNotepadVariables) => {
      const response = await mutationFetch(
        "/api/notepads",
        "notepads.create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: variables.scope,
            ...(variables.projectName !== undefined
              ? { project: variables.projectName }
              : {}),
            name: variables.name,
          }),
        },
        notepadDetailResponseSchema,
      );
      return response.notepad;
    },
    onSuccess: (notepad) => {
      adoptNotepad(queryClient, notepad);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notepadKeys.lists() });
    },
  });
}

export interface UpdateNotepadVariables {
  notepadId: string;
  fields: UpdateNotepadInput;
}

interface UpdateSnapshot {
  lists: Array<[readonly unknown[], NotepadListItem[] | undefined]>;
  detail: Notepad | undefined;
  summary: NotepadSummaryResolution | undefined;
}

export function useUpdateNotepadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ notepadId, fields }: UpdateNotepadVariables) => {
      const response = await mutationFetch(
        notepadUrl(notepadId),
        "notepads.update",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        },
        notepadDetailResponseSchema,
      );
      return response.notepad;
    },
    onMutate: async ({ notepadId, fields }): Promise<UpdateSnapshot> => {
      await queryClient.cancelQueries({ queryKey: notepadKeys.all });

      const snapshot: UpdateSnapshot = {
        lists: queryClient.getQueriesData<NotepadListItem[]>({
          queryKey: notepadKeys.lists(),
        }),
        detail: queryClient.getQueryData<Notepad>(
          notepadKeys.detail(notepadId),
        ),
        summary: queryClient.getQueryData<NotepadSummaryResolution>(
          notepadKeys.summary(notepadId),
        ),
      };

      patchListCaches(queryClient, notepadId, fields);
      if (snapshot.detail) {
        queryClient.setQueryData<Notepad>(notepadKeys.detail(notepadId), {
          ...snapshot.detail,
          ...fields,
        });
      }
      if (snapshot.summary?.state === "found") {
        const { name, writeMode, archived } = fields;
        queryClient.setQueryData<NotepadSummaryResolution>(
          notepadKeys.summary(notepadId),
          {
            state: "found",
            summary: {
              ...snapshot.summary.summary,
              ...(name !== undefined ? { name } : {}),
              ...(writeMode !== undefined ? { writeMode } : {}),
              ...(archived !== undefined ? { archived } : {}),
            },
          },
        );
      }
      return snapshot;
    },
    onError: (_error, { notepadId }, snapshot) => {
      if (!snapshot) return;
      for (const [key, rows] of snapshot.lists) {
        queryClient.setQueryData(key, rows);
      }
      queryClient.setQueryData(notepadKeys.detail(notepadId), snapshot.detail);
      queryClient.setQueryData(
        notepadKeys.summary(notepadId),
        snapshot.summary,
      );
    },
    onSuccess: (notepad) => {
      adoptNotepad(queryClient, notepad);
    },
    onSettled: (_notepad, _error, { notepadId }) => {
      void queryClient.invalidateQueries({ queryKey: notepadKeys.lists() });
      void queryClient.invalidateQueries({
        queryKey: notepadKeys.detail(notepadId),
      });
    },
  });
}

export function useDeleteNotepadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (notepadId: string) => {
      await mutationFetch(notepadUrl(notepadId), "notepads.delete", {
        method: "DELETE",
      });
      return notepadId;
    },
    onSuccess: (notepadId) => {
      removeFromListCaches(queryClient, notepadId);
      // A deleted notepad is expected data for a captured reference: chips
      // flip to their missing state rather than erroring on the next resolve.
      queryClient.setQueryData<NotepadSummaryResolution>(
        notepadKeys.summary(notepadId),
        { state: "missing" },
      );
      queryClient.removeQueries({ queryKey: notepadKeys.detail(notepadId) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notepadKeys.lists() });
    },
  });
}

export interface WriteNotepadContentVariables {
  notepadId: string;
  content: string;
  /**
   * The head revision the editor loaded. A user write is never refused for
   * staleness — the server records it as the new head regardless — but stating
   * the base keeps the revision chain honest in history.
   */
  baseRevision: number;
}

export function useWriteNotepadContentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      notepadId,
      content,
      baseRevision,
    }: WriteNotepadContentVariables) => {
      const response = await mutationFetch(
        `${notepadUrl(notepadId)}/content`,
        "notepads.write_content",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "update", content, baseRevision }),
        },
        notepadDetailResponseSchema,
      );
      return response.notepad;
    },
    onSuccess: (notepad) => {
      adoptNotepad(queryClient, notepad);
      void queryClient.invalidateQueries({
        queryKey: notepadKeys.revisions(notepad.id),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

/**
 * Every comment act is a server-shaped outcome, never optimistic: creation
 * mints an id and resolves the passage server-side, and resolve/reopen/delete
 * change a listing the same response re-derives. Each settles by invalidating
 * the notepad's comment list, which is also what a comment-activity event from
 * another writer invalidates — one reconciliation path, whoever wrote.
 */
const commentResponseSchema = z.object({ comment: notepadCommentSchema });

function commentsUrl(notepadId: string): string {
  return `${notepadUrl(notepadId)}/comments`;
}

function commentUrl(notepadId: string, commentId: string): string {
  return `${commentsUrl(notepadId)}/${encodeURIComponent(commentId)}`;
}

function invalidateComments(queryClient: QueryClient, notepadId: string): void {
  void queryClient.invalidateQueries({
    queryKey: notepadKeys.comments(notepadId),
  });
}

export interface CreateNotepadCommentVariables {
  notepadId: string;
  anchor: NotepadCommentAnchor;
  body: string;
}

export function useCreateNotepadCommentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      notepadId,
      anchor,
      body,
    }: CreateNotepadCommentVariables) => {
      const response = await mutationFetch(
        commentsUrl(notepadId),
        "notepads.comment_create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anchor, body }),
        },
        commentResponseSchema,
      );
      return response.comment;
    },
    onSettled: (_comment, _error, { notepadId }) => {
      invalidateComments(queryClient, notepadId);
    },
  });
}

export interface SetNotepadCommentStatusVariables {
  notepadId: string;
  commentId: string;
  status: NotepadCommentStatus;
}

/** Resolve and reopen — user acts; the agent surface has no such verb. */
export function useSetNotepadCommentStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      notepadId,
      commentId,
      status,
    }: SetNotepadCommentStatusVariables) => {
      const response = await mutationFetch(
        commentUrl(notepadId, commentId),
        "notepads.comment_set_status",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
        commentResponseSchema,
      );
      return response.comment;
    },
    onSettled: (_comment, _error, { notepadId }) => {
      invalidateComments(queryClient, notepadId);
    },
  });
}

export interface DeleteNotepadCommentVariables {
  notepadId: string;
  commentId: string;
}

export function useDeleteNotepadCommentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      notepadId,
      commentId,
    }: DeleteNotepadCommentVariables) => {
      await mutationFetch(
        commentUrl(notepadId, commentId),
        "notepads.comment_delete",
        { method: "DELETE" },
      );
      return commentId;
    },
    onSettled: (_commentId, _error, { notepadId }) => {
      invalidateComments(queryClient, notepadId);
    },
  });
}

export interface RestoreNotepadRevisionVariables {
  notepadId: string;
  revision: number;
}

export function useRestoreNotepadRevisionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      notepadId,
      revision,
    }: RestoreNotepadRevisionVariables) => {
      const response = await mutationFetch(
        `${notepadUrl(notepadId)}/restore`,
        "notepads.restore",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision }),
        },
        notepadDetailResponseSchema,
      );
      return response.notepad;
    },
    onSuccess: (notepad) => {
      adoptNotepad(queryClient, notepad);
      void queryClient.invalidateQueries({
        queryKey: notepadKeys.revisions(notepad.id),
      });
      void queryClient.invalidateQueries({ queryKey: notepadKeys.lists() });
    },
  });
}
