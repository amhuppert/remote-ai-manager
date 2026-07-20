/**
 * Ticket mutations — optimistic by default per the responsiveness contract.
 *
 * Predictable changes (field/status updates, delete, attachment edit/remove)
 * apply optimistically through the shared list-filter semantics with snapshot
 * rollback; server-shaped outcomes (create, attachment add, start) surface
 * `isPending` and reconcile caches from the response. Every mutation keeps
 * `onSettled` hygiene invalidation so the server stays authoritative.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { z } from "zod";

import { ApiCallError } from "@/lib/api/errors";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import { mutationFetch } from "@/lib/api/fetcher";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AddTicketAttachmentServiceInput } from "./attachment-service";
import { resetDeletedTicketCaches } from "./cache-lifecycle";
import {
  captureTicketEventCursor,
  isAuthoritativelyDeletedTicket,
  rememberAuthoritativeTicketDeletion,
  rememberAuthoritativeTicketVersion,
  ticketChangedEventSince,
  ticketEventVersionSupersedes,
  type TicketEventCursor,
} from "./event-version";
import {
  findCachedTicketListItem,
  removeTicketFromListCaches,
  upsertTicketInListCaches,
} from "./list-cache";
import { ticketListItemFromDetail } from "./list-filters";
import {
  acquireTicketMutationGate,
  beginTicketMutation,
  cancelTicketQueries,
  scheduleTicketCacheInvalidation,
  settleTicketMutation,
} from "./mutation-coordinator";
import { registerPendingTicketOverlay } from "./pending-overlay";
import { ticketKeys } from "./query-keys";
import { replayTicketChangedEvent } from "./sse-reducer";
import {
  createTicketInputSchema,
  createTicketResponseSchema,
  deletedTicketAttachmentSchema,
  deletedTicketSchema,
  startTicketOutputSchema,
  ticketAttachmentSchema,
  ticketDetailSchema,
  type TicketAttachment,
  type TicketDetail,
  type TicketStartMode,
  type UpdateTicketFields,
} from "./schemas";

type AttachmentPayloadInput = AddTicketAttachmentServiceInput["payload"];
export type JsonAttachmentPayloadInput = Exclude<
  AttachmentPayloadInput,
  { kind: "file" }
>;

function nowIso(): string {
  return new Date().toISOString();
}

function ticketUrl(projectName: string, number: number): string {
  return `/api/projects/${encodeURIComponent(projectName)}/tickets/${number}`;
}

function queueTicketInvalidation(
  queryClient: QueryClient,
  projectName: string | null,
  number: number | null,
  includeLists: boolean,
): void {
  scheduleTicketCacheInvalidation(queryClient, {
    includeLists,
    details:
      projectName === null || number === null ? [] : [{ projectName, number }],
  });
}

function invalidateTicketQueries(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): void {
  queueTicketInvalidation(queryClient, projectName, number, true);
}

function replayTicketEventSince(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  cursor: TicketEventCursor,
  resultUpdatedAt?: string,
): void {
  if (isAuthoritativelyDeletedTicket(queryClient, projectName, number)) {
    return;
  }
  const event = ticketChangedEventSince(
    queryClient,
    projectName,
    number,
    cursor,
  );
  if (!event) return;
  if (
    resultUpdatedAt !== undefined &&
    !ticketEventVersionSupersedes(
      queryClient,
      projectName,
      number,
      resultUpdatedAt,
    )
  ) {
    return;
  }
  if (event.change !== "deleted") {
    void queryClient.resetQueries({
      queryKey: ticketKeys.detail(projectName, number),
      exact: true,
    });
  }
  replayTicketChangedEvent(queryClient, event);
}

function ticketWasDeletedSince(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  cursor: TicketEventCursor,
): boolean {
  if (isAuthoritativelyDeletedTicket(queryClient, projectName, number)) {
    return true;
  }
  return (
    ticketChangedEventSince(queryClient, projectName, number, cursor)
      ?.change === "deleted"
  );
}

function resetMissingTicketCaches(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  ticketId: string | undefined,
): void {
  if (ticketId !== undefined) {
    removeTicketFromListCaches(queryClient, ticketId);
  }
  rememberAuthoritativeTicketDeletion(queryClient, projectName, number);
  resetDeletedTicketCaches(queryClient, projectName, number);
}

/** Reconcile detail + lists from an authoritative server detail payload. */
function applyDetailToCaches(
  queryClient: QueryClient,
  detail: TicketDetail,
  options: { preserveActiveSessionName?: boolean } = {},
): void {
  const detailKey = ticketKeys.detail(detail.projectName, detail.number);
  if (
    ticketEventVersionSupersedes(
      queryClient,
      detail.projectName,
      detail.number,
      detail.updatedAt,
    )
  ) {
    const cachedDetail = queryClient.getQueryData<TicketDetail>(detailKey);
    if (
      cachedDetail !== undefined &&
      cachedDetail.updatedAt > detail.updatedAt
    ) {
      return;
    }
    void queryClient.resetQueries({
      queryKey: detailKey,
      exact: true,
    });
    return;
  }
  queryClient.setQueryData(detailKey, detail);
  const projected = ticketListItemFromDetail(detail);
  const cached = findCachedTicketListItem(
    queryClient,
    detail.projectName,
    detail.number,
  );
  upsertTicketInListCaches(queryClient, {
    ...projected,
    activeSessionName:
      options.preserveActiveSessionName && cached
        ? cached.activeSessionName
        : projected.activeSessionName,
  });
  rememberAuthoritativeTicketVersion(
    queryClient,
    detail.projectName,
    detail.number,
    detail.updatedAt,
  );
}

// ---------------------------------------------------------------------------
// Create — server assigns identity, so the feedback is visible pending
// ---------------------------------------------------------------------------

export interface CreateTicketVars {
  projectName: string;
  input: z.input<typeof createTicketInputSchema>;
}

export function useCreateTicketMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectName, input }: CreateTicketVars) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/tickets`,
        "create-ticket",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
        createTicketResponseSchema,
      ),
    onSuccess: async ({ ticket }) => {
      const releaseGate = await acquireTicketMutationGate(
        queryClient,
        ticket.projectName,
        ticket.number,
      );
      try {
        await cancelTicketQueries(
          queryClient,
          ticket.projectName,
          ticket.number,
        ).catch(() => undefined);
        applyDetailToCaches(queryClient, ticket);
      } finally {
        releaseGate();
      }
    },
    onSettled: (created, _err, { projectName }) => {
      queueTicketInvalidation(
        queryClient,
        created ? projectName : null,
        created?.ticket.number ?? null,
        true,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Update — optimistic field/status patch with snapshot rollback
// ---------------------------------------------------------------------------

export interface UpdateTicketVars {
  projectName: string;
  number: number;
  fields: UpdateTicketFields;
}

export function useUpdateTicketMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectName, number, fields }: UpdateTicketVars) =>
      mutationFetch(
        ticketUrl(projectName, number),
        "update-ticket",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        },
        ticketDetailSchema,
      ),
    onMutate: async ({ projectName, number, fields }) => {
      const releaseGate = await beginTicketMutation(
        queryClient,
        projectName,
        number,
      );

      const detailKey = ticketKeys.detail(projectName, number);
      const previousDetail = queryClient.getQueryData<TicketDetail>(detailKey);
      const previousListItem =
        findCachedTicketListItem(queryClient, projectName, number) ??
        (previousDetail ? ticketListItemFromDetail(previousDetail) : null);
      const eventCursor = captureTicketEventCursor(
        queryClient,
        projectName,
        number,
      );

      const bumpedAt = nowIso();
      const optimisticDetail = previousDetail
        ? { ...previousDetail, ...fields, updatedAt: bumpedAt }
        : undefined;
      if (optimisticDetail) {
        queryClient.setQueryData(detailKey, optimisticDetail);
      }

      // Only the lean-item subset of the fields; `description` lives on the
      // detail alone and must not leak onto cached list rows.
      const listPatch = {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.workType !== undefined ? { workType: fields.workType } : {}),
        ...(fields.status !== undefined ? { status: fields.status } : {}),
      };
      const baseItem =
        previousListItem ??
        (optimisticDetail ? ticketListItemFromDetail(optimisticDetail) : null);
      if (baseItem) {
        upsertTicketInListCaches(queryClient, {
          ...baseItem,
          ...listPatch,
          updatedAt: bumpedAt,
        });
      }

      const unregisterOverlay = registerPendingTicketOverlay(
        queryClient,
        projectName,
        number,
        { kind: "patch", fields: { ...listPatch, updatedAt: bumpedAt } },
      );

      return {
        previousDetail,
        previousListItem,
        detailKey,
        eventCursor,
        unregisterOverlay,
        releaseGate,
      };
    },
    onError: (_err, { projectName, number }, context) => {
      if (!context) return;
      if (_err instanceof ApiCallError && _err.status === 404) {
        resetMissingTicketCaches(
          queryClient,
          projectName,
          number,
          context.previousListItem?.id,
        );
        return;
      }
      if (
        ticketWasDeletedSince(
          queryClient,
          projectName,
          number,
          context.eventCursor,
        )
      ) {
        return;
      }
      if (context.previousListItem) {
        upsertTicketInListCaches(queryClient, context.previousListItem);
      }
      queryClient.setQueryData(context.detailKey, context.previousDetail);
    },
    onSuccess: (updated) => {
      applyDetailToCaches(queryClient, updated, {
        preserveActiveSessionName: true,
      });
    },
    onSettled: (_data, _err, { projectName, number }, context) => {
      context?.unregisterOverlay();
      if (
        context &&
        (_err || _data) &&
        !(_err instanceof ApiCallError && _err.status === 404)
      ) {
        replayTicketEventSince(
          queryClient,
          projectName,
          number,
          context.eventCursor,
          _data?.updatedAt,
        );
      }
      settleTicketMutation(
        queryClient,
        projectName,
        number,
        context?.releaseGate,
        true,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Delete — optimistic removal everywhere with snapshot rollback
// ---------------------------------------------------------------------------

export interface DeleteTicketVars {
  projectName: string;
  number: number;
}

export function useDeleteTicketMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectName, number }: DeleteTicketVars) =>
      mutationFetch(
        ticketUrl(projectName, number),
        "delete-ticket",
        { method: "DELETE" },
        deletedTicketSchema,
      ),
    onMutate: async ({ projectName, number }) => {
      const releaseGate = await beginTicketMutation(
        queryClient,
        projectName,
        number,
      );

      const detailKey = ticketKeys.detail(projectName, number);
      const previousDetail = queryClient.getQueryData<TicketDetail>(detailKey);
      const previousListItem =
        findCachedTicketListItem(queryClient, projectName, number) ??
        (previousDetail ? ticketListItemFromDetail(previousDetail) : null);
      const eventCursor = captureTicketEventCursor(
        queryClient,
        projectName,
        number,
      );
      const ticketId = previousListItem?.id;
      if (ticketId !== undefined) {
        removeTicketFromListCaches(queryClient, ticketId);
      }
      queryClient.removeQueries({ queryKey: detailKey });

      const unregisterOverlay = registerPendingTicketOverlay(
        queryClient,
        projectName,
        number,
        { kind: "remove" },
      );

      return {
        previousDetail,
        previousListItem,
        detailKey,
        eventCursor,
        unregisterOverlay,
        releaseGate,
      };
    },
    onError: (_err, { projectName, number }, context) => {
      if (!context) return;
      if (_err instanceof ApiCallError && _err.status === 404) {
        resetMissingTicketCaches(
          queryClient,
          projectName,
          number,
          context.previousListItem?.id,
        );
        return;
      }
      if (
        ticketWasDeletedSince(
          queryClient,
          projectName,
          number,
          context.eventCursor,
        )
      ) {
        return;
      }
      if (context.previousListItem) {
        upsertTicketInListCaches(queryClient, context.previousListItem);
      }
      if (context.previousDetail) {
        queryClient.setQueryData(context.detailKey, context.previousDetail);
      }
    },
    onSuccess: (_deleted, { projectName, number }) => {
      rememberAuthoritativeTicketDeletion(queryClient, projectName, number);
      resetDeletedTicketCaches(queryClient, projectName, number);
    },
    onSettled: (_data, _err, { projectName, number }, context) => {
      context?.unregisterOverlay();
      if (
        _err &&
        context &&
        !(_err instanceof ApiCallError && _err.status === 404)
      ) {
        replayTicketEventSince(
          queryClient,
          projectName,
          number,
          context.eventCursor,
        );
      }
      settleTicketMutation(
        queryClient,
        projectName,
        number,
        context?.releaseGate,
        true,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Attachment add — server derives snapshots/ids, so pending + reconcile
// ---------------------------------------------------------------------------

export type AddTicketAttachmentVars = {
  projectName: string;
  number: number;
  description: string;
} & (
  | { payload: JsonAttachmentPayloadInput; file?: never }
  | { file: File; fileName?: string; mediaType?: string; payload?: never }
);

function addAttachmentRequest(vars: AddTicketAttachmentVars): {
  options: RequestInit;
} {
  if (vars.file !== undefined) {
    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        description: vars.description,
        ...(vars.fileName !== undefined ? { fileName: vars.fileName } : {}),
        ...(vars.mediaType !== undefined ? { mediaType: vars.mediaType } : {}),
      }),
    );
    form.set("file", vars.file);
    return { options: { method: "POST", body: form } };
  }
  return {
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: vars.description,
        payload: vars.payload,
      }),
    },
  };
}

function patchDetailAttachments(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  patch: (attachments: TicketAttachment[]) => TicketAttachment[],
  updatedAt?: string,
): void {
  const detailKey = ticketKeys.detail(projectName, number);
  const previous = queryClient.getQueryData<TicketDetail>(detailKey);
  if (!previous) return;
  const next = {
    ...previous,
    attachments: patch(previous.attachments),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
  queryClient.setQueryData(detailKey, next);
  const projected = ticketListItemFromDetail(next);
  const cached = findCachedTicketListItem(queryClient, projectName, number);
  upsertTicketInListCaches(queryClient, {
    ...projected,
    activeSessionName:
      cached !== null ? cached.activeSessionName : projected.activeSessionName,
  });
}

function restoreAttachmentInDetail(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  previousAttachment: TicketAttachment,
  previousIndex: number,
  parentUpdatedAt?: string,
): void {
  patchDetailAttachments(
    queryClient,
    projectName,
    number,
    (attachments) => {
      const currentIndex = attachments.findIndex(
        (attachment) => attachment.id === previousAttachment.id,
      );
      if (currentIndex !== -1) {
        return attachments.map((attachment, index) =>
          index === currentIndex ? previousAttachment : attachment,
        );
      }
      const restored = [...attachments];
      restored.splice(
        Math.min(Math.max(previousIndex, 0), restored.length),
        0,
        previousAttachment,
      );
      return restored;
    },
    parentUpdatedAt,
  );
}

export function useAddTicketAttachmentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    onMutate: ({ projectName, number }) => ({
      eventCursor: captureTicketEventCursor(queryClient, projectName, number),
    }),
    mutationFn: (vars: AddTicketAttachmentVars) =>
      mutationFetch(
        `${ticketUrl(vars.projectName, vars.number)}/attachments`,
        "add-ticket-attachment",
        addAttachmentRequest(vars).options,
        ticketAttachmentSchema,
      ),
    onSuccess: async (created, { projectName, number }) => {
      const releaseGate = await acquireTicketMutationGate(
        queryClient,
        projectName,
        number,
      );
      try {
        // The server write has already committed, so cache cancellation is
        // best-effort and must not discard the authoritative attachment.
        await cancelTicketQueries(queryClient, projectName, number).catch(
          () => undefined,
        );
        if (
          ticketEventVersionSupersedes(
            queryClient,
            projectName,
            number,
            created.updatedAt,
          )
        ) {
          void queryClient.resetQueries({
            queryKey: ticketKeys.detail(projectName, number),
            exact: true,
          });
          return;
        }
        patchDetailAttachments(
          queryClient,
          projectName,
          number,
          (attachments) => [
            ...attachments.filter((a) => a.id !== created.id),
            created,
          ],
          created.updatedAt,
        );
        rememberAuthoritativeTicketVersion(
          queryClient,
          projectName,
          number,
          created.updatedAt,
        );
      } finally {
        releaseGate();
      }
    },
    onSettled: (_data, _err, { projectName, number }) => {
      invalidateTicketQueries(queryClient, projectName, number);
    },
  });
}

// ---------------------------------------------------------------------------
// Attachment edit — optimistic patch with rollback
// ---------------------------------------------------------------------------

export interface EditTicketAttachmentVars {
  projectName: string;
  number: number;
  attachmentId: string;
  description?: string;
  markdown?: string;
}

export function useEditTicketAttachmentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      number,
      attachmentId,
      ...fields
    }: EditTicketAttachmentVars) =>
      mutationFetch(
        `${ticketUrl(projectName, number)}/attachments/${encodeURIComponent(attachmentId)}`,
        "edit-ticket-attachment",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        },
        ticketAttachmentSchema,
      ),
    onMutate: async ({
      projectName,
      number,
      attachmentId,
      description,
      markdown,
    }) => {
      const releaseGate = await beginTicketMutation(
        queryClient,
        projectName,
        number,
      );

      const detailKey = ticketKeys.detail(projectName, number);
      const previousDetail = queryClient.getQueryData<TicketDetail>(detailKey);
      const previousAttachmentIndex =
        previousDetail?.attachments.findIndex(
          (attachment) => attachment.id === attachmentId,
        ) ?? -1;
      const previousAttachment =
        previousAttachmentIndex === -1
          ? undefined
          : previousDetail?.attachments[previousAttachmentIndex];
      const eventCursor = captureTicketEventCursor(
        queryClient,
        projectName,
        number,
      );

      patchDetailAttachments(queryClient, projectName, number, (attachments) =>
        attachments.map((a) => {
          if (a.id !== attachmentId) return a;
          return {
            ...a,
            ...(description !== undefined ? { description } : {}),
            payload:
              markdown !== undefined && a.payload.kind === "note"
                ? { ...a.payload, markdown }
                : a.payload,
          };
        }),
      );

      // No lean fields change, but the empty patch keeps a mid-flight
      // attachments event from invalidating (and refetching over) the
      // optimistically patched detail.
      const unregisterOverlay = previousDetail
        ? registerPendingTicketOverlay(queryClient, projectName, number, {
            kind: "patch",
            fields: {},
          })
        : () => {};

      return {
        previousAttachment,
        previousAttachmentIndex,
        eventCursor,
        unregisterOverlay,
        releaseGate,
      };
    },
    onError: (_err, { projectName, number }, context) => {
      if (!context?.previousAttachment) return;
      if (
        ticketWasDeletedSince(
          queryClient,
          projectName,
          number,
          context.eventCursor,
        )
      ) {
        return;
      }
      restoreAttachmentInDetail(
        queryClient,
        projectName,
        number,
        context.previousAttachment,
        context.previousAttachmentIndex,
      );
    },
    onSuccess: (updated, { projectName, number }) => {
      if (
        ticketEventVersionSupersedes(
          queryClient,
          projectName,
          number,
          updated.updatedAt,
        )
      ) {
        void queryClient.resetQueries({
          queryKey: ticketKeys.detail(projectName, number),
          exact: true,
        });
        return;
      }
      patchDetailAttachments(
        queryClient,
        projectName,
        number,
        (attachments) =>
          attachments.map((a) => (a.id === updated.id ? updated : a)),
        updated.updatedAt,
      );
      rememberAuthoritativeTicketVersion(
        queryClient,
        projectName,
        number,
        updated.updatedAt,
      );
    },
    onSettled: (_data, _err, { projectName, number }, context) => {
      context?.unregisterOverlay();
      if (context && (_err || _data)) {
        replayTicketEventSince(
          queryClient,
          projectName,
          number,
          context.eventCursor,
          _data?.updatedAt,
        );
      }
      settleTicketMutation(
        queryClient,
        projectName,
        number,
        context?.releaseGate,
        false,
      );
    },
  });
}

export interface RefreshConversationSnapshotVars {
  projectName: string;
  number: number;
  attachmentId: string;
}

export function useRefreshConversationSnapshotMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      number,
      attachmentId,
    }: RefreshConversationSnapshotVars) =>
      mutationFetch(
        `${ticketUrl(projectName, number)}/attachments/${encodeURIComponent(attachmentId)}/refresh-snapshot`,
        "refresh-conversation-snapshot",
        { method: "POST" },
        ticketAttachmentSchema,
      ),
    onSuccess: (updated, { projectName, number }) => {
      patchDetailAttachments(
        queryClient,
        projectName,
        number,
        (attachments) =>
          attachments.map((attachment) =>
            attachment.id === updated.id ? updated : attachment,
          ),
        updated.updatedAt,
      );
    },
    onSettled: (_data, _error, { projectName, number, attachmentId }) => {
      void queryClient.invalidateQueries({
        queryKey: ticketKeys.detail(projectName, number),
        exact: true,
      });
      void queryClient.invalidateQueries({
        queryKey: ticketKeys.attachmentResolve(
          projectName,
          number,
          attachmentId,
        ),
        exact: true,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Attachment remove — optimistic removal with rollback
// ---------------------------------------------------------------------------

export interface RemoveTicketAttachmentVars {
  projectName: string;
  number: number;
  attachmentId: string;
}

export function useRemoveTicketAttachmentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      number,
      attachmentId,
    }: RemoveTicketAttachmentVars) =>
      mutationFetch(
        `${ticketUrl(projectName, number)}/attachments/${encodeURIComponent(attachmentId)}`,
        "remove-ticket-attachment",
        { method: "DELETE" },
        deletedTicketAttachmentSchema,
      ),
    onMutate: async ({ projectName, number, attachmentId }) => {
      const releaseGate = await beginTicketMutation(
        queryClient,
        projectName,
        number,
      );

      const detailKey = ticketKeys.detail(projectName, number);
      const previousDetail = queryClient.getQueryData<TicketDetail>(detailKey);
      const previousAttachmentIndex =
        previousDetail?.attachments.findIndex(
          (attachment) => attachment.id === attachmentId,
        ) ?? -1;
      const previousAttachment =
        previousAttachmentIndex === -1
          ? undefined
          : previousDetail?.attachments[previousAttachmentIndex];
      const previousParentUpdatedAt = previousDetail?.updatedAt;
      const eventCursor = captureTicketEventCursor(
        queryClient,
        projectName,
        number,
      );
      const bumpedAt = nowIso();

      patchDetailAttachments(
        queryClient,
        projectName,
        number,
        (attachments) => attachments.filter((a) => a.id !== attachmentId),
        bumpedAt,
      );

      const unregisterOverlay = previousDetail
        ? registerPendingTicketOverlay(queryClient, projectName, number, {
            kind: "patch",
            fields: {
              attachmentCount: previousDetail.attachments.filter(
                (a) => a.id !== attachmentId,
              ).length,
              updatedAt: bumpedAt,
            },
          })
        : () => {};

      return {
        previousAttachment,
        previousAttachmentIndex,
        previousParentUpdatedAt,
        eventCursor,
        unregisterOverlay,
        releaseGate,
      };
    },
    onError: (_err, { projectName, number }, context) => {
      if (!context?.previousAttachment) return;
      if (
        ticketWasDeletedSince(
          queryClient,
          projectName,
          number,
          context.eventCursor,
        )
      ) {
        return;
      }
      restoreAttachmentInDetail(
        queryClient,
        projectName,
        number,
        context.previousAttachment,
        context.previousAttachmentIndex,
        context.previousParentUpdatedAt,
      );
    },
    onSuccess: (deleted, { projectName, number }) => {
      if (
        ticketEventVersionSupersedes(
          queryClient,
          projectName,
          number,
          deleted.ticketUpdatedAt,
        )
      ) {
        void queryClient.resetQueries({
          queryKey: ticketKeys.detail(projectName, number),
          exact: true,
        });
        return;
      }
      patchDetailAttachments(
        queryClient,
        projectName,
        number,
        (attachments) => attachments,
        deleted.ticketUpdatedAt,
      );
      rememberAuthoritativeTicketVersion(
        queryClient,
        projectName,
        number,
        deleted.ticketUpdatedAt,
      );
    },
    onSettled: (_data, _err, { projectName, number }, context) => {
      context?.unregisterOverlay();
      if (context && (_err || _data)) {
        replayTicketEventSince(
          queryClient,
          projectName,
          number,
          context.eventCursor,
          _data?.ticketUpdatedAt,
        );
      }
      settleTicketMutation(
        queryClient,
        projectName,
        number,
        context?.releaseGate,
        true,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Start work — provisioning; pending indicator + reconcile from the output
// ---------------------------------------------------------------------------

export interface StartTicketVars {
  projectName: string;
  number: number;
  mode: TicketStartMode;
  backend?: AgentBackendId;
  model?: string;
  reasoningEffort?: EffortLevel;
}

export function useStartTicketMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      number,
      mode,
      backend,
      model,
      reasoningEffort,
    }: StartTicketVars) =>
      mutationFetch(
        `${ticketUrl(projectName, number)}/start`,
        "start-ticket",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, backend, model, reasoningEffort }),
        },
        startTicketOutputSchema,
      ),
    onMutate: async ({ projectName, number }) => {
      const releaseGate = await beginTicketMutation(
        queryClient,
        projectName,
        number,
      );
      return {
        eventCursor: captureTicketEventCursor(queryClient, projectName, number),
        releaseGate,
      };
    },
    onSuccess: (output) => {
      applyDetailToCaches(queryClient, output.ticket);
    },
    onSettled: (_data, _err, { projectName, number }, context) => {
      settleTicketMutation(
        queryClient,
        projectName,
        number,
        context?.releaseGate,
        true,
      );
      void queryClient.invalidateQueries({
        queryKey: ticketKeys.sessionLinks(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}
