/**
 * Memory Library mutations.
 *
 * Every one of these is a compare-and-swap or a lifecycle act whose outcome the
 * server decides — a stale revision is refused and persists nothing — so none
 * of them applies optimistically. The triggering controls surface `isPending`
 * and the caches reconcile from the authoritative response, per the
 * responsiveness contract's server-shaped-outcome case. Optimism here would
 * show an edit that the CAS check is about to reject.
 *
 * Requests go to the same route handlers `cctl memory` calls, so a refusal the
 * panel renders is the refusal an agent sees.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { mutationFetch } from "@/lib/api/fetcher";
import { ApiCallError } from "@/lib/api/errors";
import { memoryNoteUrl, memoryScopeParams } from "./queries";
import type { MemoryNoteDetail } from "./queries";
import {
  isMemoryDetailKeyFor,
  memoryKeys,
  type MemoryScopeRef,
} from "./query-keys";
import {
  memoryNoteSchema,
  memoryStatusNoteSchema,
  type MemoryIndexMode,
  type MemoryKind,
  type MemoryNote,
  type MemoryScope,
  type MemoryStatusNote,
} from "./schemas";

const noteResponseSchema = z.object({ note: memoryNoteSchema });
const promoteResponseSchema = z.object({
  promoted: memoryNoteSchema,
  superseded: memoryNoteSchema,
});
/**
 * A status re-lease answers with the claim it restored to ambient delivery
 * (R2.2); a note-level review re-asserts nothing and answers null.
 */
const reviewedResponseSchema = z.object({
  note: memoryNoteSchema,
  statusReLease: memoryStatusNoteSchema.nullable(),
});
/** Create answers with advisory overlap and hook warnings the panel surfaces. */
const createResponseSchema = z.object({
  note: memoryNoteSchema,
  advisories: z.unknown().optional(),
});

/**
 * The compare-and-swap refusal, read off the typed error the route already
 * carries. The panel needs the CURRENT revision to offer a retry, and the
 * server names it rather than the client guessing head + 1.
 */
export interface MemoryStaleRevision {
  currentRevision: number;
  baseRevision: number | null;
  slug: string;
}

export function staleRevisionOf(error: unknown): MemoryStaleRevision | null {
  if (!(error instanceof ApiCallError) || error.code !== "stale_revision") {
    return null;
  }
  const details = error.details ?? {};
  const current = details["currentRevision"];
  const base = details["baseRevision"];
  const slug = details["slug"];
  if (typeof current !== "number" || typeof slug !== "string") return null;
  return {
    currentRevision: current,
    baseRevision: typeof base === "number" ? base : null,
    slug,
  };
}

function scopedUrl(
  ref: MemoryScopeRef,
  handle: string,
  sub?: string,
  extra?: Record<string, string>,
): string {
  const params = memoryScopeParams(ref);
  for (const [key, value] of Object.entries(extra ?? {})) {
    params.set(key, value);
  }
  return `${memoryNoteUrl(handle, sub)}?${params.toString()}`;
}

function jsonBody(body: Record<string, unknown>): RequestInit {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Reconcile every read model from an authoritative note. The list and review
 * queues are re-derived server-side (ordering, freshness, candidacy), so they
 * are invalidated rather than patched; only the detail cache holds a record
 * this response can replace outright.
 */
function adoptNote(
  queryClient: QueryClient,
  ref: MemoryScopeRef,
  note: MemoryNote,
): void {
  queryClient.setQueryData<MemoryNoteDetail>(
    memoryKeys.detail(ref, note.id),
    (previous) => (previous === undefined ? previous : { ...previous, note }),
  );
  invalidateLibraryReads(queryClient);
}

/**
 * A note's fields feed the index composer's selection and budget, so every
 * mutation restates the list, the review queue, and every open preview.
 */
function invalidateLibraryReads(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: memoryKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: memoryKeys.reviews() });
  void queryClient.invalidateQueries({ queryKey: memoryKeys.indexPreviews() });
}

/** The editable half of a note, as the update route accepts it. */
export interface MemoryNoteEdit {
  hook?: string;
  body?: string;
  slug?: string;
  statusNote?: string | null;
  indexMode?: MemoryIndexMode;
}

export interface UpdateMemoryNoteVariables {
  ref: MemoryScopeRef;
  handle: string;
  /** The revision the edit is based on — the compare-and-swap token (R1). */
  baseRevision: number;
  fields: MemoryNoteEdit;
}

export function useUpdateMemoryNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ref,
      handle,
      baseRevision,
      fields,
    }: UpdateMemoryNoteVariables) => {
      const response = await mutationFetch(
        scopedUrl(ref, handle),
        "memory.update",
        { method: "PATCH", ...jsonBody({ baseRevision, ...fields }) },
        noteResponseSchema,
      );
      return response.note;
    },
    onSuccess: (note, { ref }) => adoptNote(queryClient, ref, note),
  });
}

export interface MarkMemoryReviewedVariables {
  ref: MemoryScopeRef;
  handle: string;
  /** `note` refreshes the record's own lease; `statusNote` refreshes the line's. */
  target: "note" | "statusNote";
  baseRevision: number;
}

export interface MarkMemoryReviewedResult {
  note: MemoryNote;
  /** The re-asserted claim, so the surface that ran the act can name it. */
  statusReLease: MemoryStatusNote | null;
}

export function useMarkMemoryReviewedMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ref,
      handle,
      target,
      baseRevision,
    }: MarkMemoryReviewedVariables): Promise<MarkMemoryReviewedResult> => {
      const response = await mutationFetch(
        scopedUrl(ref, handle, "reviewed"),
        "memory.mark-reviewed",
        { method: "POST", ...jsonBody({ target, baseRevision }) },
        reviewedResponseSchema,
      );
      return { note: response.note, statusReLease: response.statusReLease };
    },
    onSuccess: ({ note }, { ref }) => adoptNote(queryClient, ref, note),
  });
}

export interface ArchiveMemoryNoteVariables {
  ref: MemoryScopeRef;
  handle: string;
  baseRevision: number;
}

export function useArchiveMemoryNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ref,
      handle,
      baseRevision,
    }: ArchiveMemoryNoteVariables) => {
      const response = await mutationFetch(
        scopedUrl(ref, handle, "archive"),
        "memory.archive",
        { method: "POST", ...jsonBody({ baseRevision }) },
        noteResponseSchema,
      );
      return response.note;
    },
    onSuccess: (note, { ref }) => adoptNote(queryClient, ref, note),
  });
}

export interface RestoreMemoryNoteVariables {
  ref: MemoryScopeRef;
  handle: string;
  /** The snapshot to copy forward; the head keeps advancing (R1.2). */
  revision: number;
  baseRevision: number;
}

export function useRestoreMemoryNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ref,
      handle,
      revision,
      baseRevision,
    }: RestoreMemoryNoteVariables) => {
      const response = await mutationFetch(
        scopedUrl(ref, handle, "restore"),
        "memory.restore",
        { method: "POST", ...jsonBody({ revision, baseRevision }) },
        noteResponseSchema,
      );
      return response.note;
    },
    onSuccess: (note, { ref }) => adoptNote(queryClient, ref, note),
  });
}

export interface PromoteMemoryNoteVariables {
  ref: MemoryScopeRef;
  handle: string;
  baseRevision: number;
  /** A chosen slug: a collision is refused by name, never suffixed (R11). */
  slug?: string;
  hook?: string;
  body?: string;
}

export function usePromoteMemoryNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ref,
      handle,
      baseRevision,
      ...rewrite
    }: PromoteMemoryNoteVariables) =>
      mutationFetch(
        scopedUrl(ref, handle, "promote"),
        "memory.promote",
        { method: "POST", ...jsonBody({ baseRevision, ...rewrite }) },
        promoteResponseSchema,
      ),
    onSuccess: (outcome, { ref }) => {
      adoptNote(queryClient, ref, outcome.superseded);
      adoptNote(queryClient, ref, outcome.promoted);
    },
  });
}

export interface CreateMemoryNoteVariables {
  ref: MemoryScopeRef;
  scope: MemoryScope;
  kind: MemoryKind;
  hook: string;
  body?: string;
  slug?: string;
  /**
   * The predecessor this note replaces. The archival of that record and the
   * creation of this one are one transaction server-side, so the Library never
   * has to sequence "create then archive" and cannot leave the pair half-done.
   */
  supersedes?: string;
}

export function useCreateMemoryNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ref, ...request }: CreateMemoryNoteVariables) => {
      const response = await mutationFetch(
        `/api/memory/notes?${memoryScopeParams(ref).toString()}`,
        "memory.create",
        { method: "POST", ...jsonBody(request) },
        createResponseSchema,
      );
      return response.note;
    },
    onSuccess: () => invalidateLibraryReads(queryClient),
  });
}

export interface DecideMemoryProposalVariables {
  ref: MemoryScopeRef;
  handle: string;
  decision: "approve" | "reject";
  baseRevision: number;
}

export function useDecideMemoryProposalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ref,
      handle,
      decision,
      baseRevision,
    }: DecideMemoryProposalVariables) => {
      const response = await mutationFetch(
        scopedUrl(ref, handle, "proposal"),
        "memory.proposal",
        { method: "POST", ...jsonBody({ decision, baseRevision }) },
        noteResponseSchema,
      );
      return response.note;
    },
    onSuccess: (note, { ref }) => adoptNote(queryClient, ref, note),
  });
}

export interface DeleteMemoryNoteVariables {
  ref: MemoryScopeRef;
  handle: string;
  memoryId: string;
}

/**
 * The irreversible act, behind its own confirmation in the UI. Archive is the
 * ordinary reversible removal; this one drops the record and its history.
 */
export function useDeleteMemoryNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ref, handle }: DeleteMemoryNoteVariables) => {
      const response = await mutationFetch(
        scopedUrl(ref, handle),
        "memory.delete",
        { method: "DELETE" },
        noteResponseSchema,
      );
      return response.note;
    },
    onSuccess: (_note, { memoryId }) => {
      queryClient.removeQueries({
        queryKey: memoryKeys.details(),
        predicate: (query) => isMemoryDetailKeyFor(query.queryKey, memoryId),
      });
      invalidateLibraryReads(queryClient);
    },
  });
}
