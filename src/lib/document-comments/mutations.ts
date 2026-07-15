import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
import { documentCommentKeys } from "./query-keys";
import {
  documentCommentSchema,
  type CommentAnchor,
  type CommentStatus,
  type CreateDocumentCommentRequest,
  type DocumentComment,
  type UpdateDocumentCommentRequest,
} from "./schemas";

/**
 * Create/update/delete mutations for document-scoped comments. All three keep
 * the per-document cached list (`documentCommentKeys.list`) in sync without a
 * manual refetch: each applies an optimistic change in `onMutate`, rolls back
 * on error, and invalidates in `onSettled` so the authoritative server state
 * reconciles. Each hook is bound to one `(projectName, sessionName, docPath)`
 * — the active document — mirroring the route handlers' document scoping.
 */

function commentsUrl(projectName: string, sessionName: string): string {
  return `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/document-comments`;
}

function commentUrl(
  projectName: string,
  sessionName: string,
  id: string,
): string {
  return `${commentsUrl(projectName, sessionName)}/${encodeURIComponent(id)}`;
}

export interface CreateDocumentCommentInput {
  anchor: CommentAnchor;
  note: string;
}

export function useCreateDocumentCommentMutation(
  projectName: string,
  sessionName: string,
  docPath: string,
) {
  const queryClient = useQueryClient();
  const listKey = documentCommentKeys.list(projectName, sessionName, docPath);

  return useMutation({
    mutationFn: (input: CreateDocumentCommentInput) =>
      mutationFetch(
        commentsUrl(projectName, sessionName),
        "create-document-comment",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            docPath,
            anchor: input.anchor,
            note: input.note,
          } satisfies CreateDocumentCommentRequest),
        },
        documentCommentSchema,
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<DocumentComment[]>(listKey);
      // Optimistic placeholder so the highlight/gutter appears immediately. Its
      // `projectPath` is unknown client-side (the route derives it) and its id
      // is temporary — both are reconciled by `onSuccess`/`onSettled`.
      const tempId = `optimistic-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const optimistic: DocumentComment = {
        id: tempId,
        projectPath: "",
        sessionName,
        docPath,
        anchor: input.anchor,
        note: input.note,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        sentAt: null,
      };
      queryClient.setQueryData<DocumentComment[]>(listKey, (old) => [
        ...(old ?? []),
        optimistic,
      ]);
      return { previous, tempId };
    },
    onError: (_err, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSuccess: (created, _input, context) => {
      queryClient.setQueryData<DocumentComment[]>(listKey, (old) =>
        (old ?? []).map((c) => (c.id === context?.tempId ? created : c)),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
}

export interface UpdateDocumentCommentInput extends UpdateDocumentCommentRequest {
  id: string;
}

export function useUpdateDocumentCommentMutation(
  projectName: string,
  sessionName: string,
  docPath: string,
) {
  const queryClient = useQueryClient();
  const listKey = documentCommentKeys.list(projectName, sessionName, docPath);

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({ id, ...body }: UpdateDocumentCommentInput) =>
        mutationFetch(
          commentUrl(projectName, sessionName, id),
          "update-document-comment",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body satisfies UpdateDocumentCommentRequest),
          },
          documentCommentSchema,
        ),
      updates: [
        cacheUpdate<UpdateDocumentCommentInput, DocumentComment[]>({
          key: () => listKey,
          update: (old, { id, note, status }) => {
            const now = new Date().toISOString();
            return (old ?? []).map((c) =>
              c.id === id ? applyUpdate(c, { note, status }, now) : c,
            );
          },
        }),
      ],
    }),
  );
}

/** Apply a note/status change to a cached comment, mirroring the route's
 * `sentAt` bookkeeping so the optimistic state matches what reconciles back. */
function applyUpdate(
  comment: DocumentComment,
  change: { note?: string; status?: CommentStatus },
  now: string,
): DocumentComment {
  const nextStatus = change.status ?? comment.status;
  return {
    ...comment,
    note: change.note ?? comment.note,
    status: nextStatus,
    sentAt: nextStatus === "sent" ? (comment.sentAt ?? now) : null,
    updatedAt: now,
  };
}

export function useDeleteDocumentCommentMutation(
  projectName: string,
  sessionName: string,
  docPath: string,
) {
  const queryClient = useQueryClient();
  const listKey = documentCommentKeys.list(projectName, sessionName, docPath);

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: (id: string) =>
        mutationFetch(
          commentUrl(projectName, sessionName, id),
          "delete-document-comment",
          { method: "DELETE" },
        ),
      updates: [
        cacheUpdate<string, DocumentComment[]>({
          key: () => listKey,
          update: (old, id) => (old ?? []).filter((c) => c.id !== id),
        }),
      ],
    }),
  );
}
