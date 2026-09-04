import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch } from "@/lib/api/fetcher";
import { useSessionQuery } from "@/lib/sessions/queries";
import {
  memoryKeys,
  type MemoryIncarnationRef,
  type MemoryListFilters,
  type MemoryReviewFilters,
  type MemoryIndexRender,
  type MemoryScopeRef,
} from "./query-keys";
import {
  memoryLinkSchema,
  memoryNoteRevisionSchema,
  memoryNoteSchema,
  memoryIndexBudgetSchema,
  memoryIndexDeliveryKindSchema,
  memoryReviewQueueEntrySchema,
  memoryScopeSchema,
} from "./schemas";

/**
 * The Memory Library's reads, against the same route handlers `cctl memory`
 * calls (`src/lib/memory/route-handlers.ts`). There is no Library-only
 * endpoint: a refusal the panel renders is the refusal an agent sees, and the
 * Index Preview is the index verb's own response.
 *
 * The caller's scope rides the query string rather than a body, uniformly with
 * the CLI, so it reads the same on a GET and on a mutation.
 */

export const memoryListResponseSchema = z.object({
  notes: z.array(memoryNoteSchema),
});
export const memoryDetailResponseSchema = z.object({
  note: memoryNoteSchema,
  links: z.array(memoryLinkSchema),
  /**
   * The lineage pointers resolved to `<scope>:<slug>` handles. Null where the
   * pointer is unset OR its target is outside this reader's reach — the pane
   * names nothing rather than an id nobody can address.
   */
  lineage: z.object({
    supersedes: z.string().nullable(),
    supersededBy: z.string().nullable(),
  }),
});
export const memoryRevisionsResponseSchema = z.object({
  revisions: z.array(memoryNoteRevisionSchema),
});
export const memoryReviewResponseSchema = z.object({
  entries: z.array(memoryReviewQueueEntrySchema),
});

/**
 * Only the fields the preview renders and reports. The block is composed,
 * budgeted, and closed with its own omission and withheld lines server-side,
 * so the preview relays that text rather than re-deriving a rendering — the
 * criterion is byte equality with the turn's block, which only holds if
 * nothing here reformats it.
 */
export const memoryIndexBlockSchema = z.object({
  /** Which render came back, so the surface labels the text it actually holds. */
  kind: memoryIndexDeliveryKindSchema,
  /** The instant a delta is computed against; null for a full block. */
  since: z.string().nullable(),
  text: z.string(),
  bytes: z.number().int().nonnegative(),
  budget: memoryIndexBudgetSchema,
  omitted: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  withheld: z.object({
    reviewDue: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    proposed: z.number().int().nonnegative(),
  }),
  entries: z.array(
    z.object({
      memoryId: z.string(),
      revision: z.number().int().positive(),
      slug: z.string(),
      scope: memoryScopeSchema,
      section: z.string(),
      statusDelivered: z.boolean(),
    }),
  ),
});
export type MemoryIndexBlockView = z.infer<typeof memoryIndexBlockSchema>;

export const memoryIndexResponseSchema = z.object({
  block: memoryIndexBlockSchema.nullable(),
});

/** The `project`/`session` pair every scoped read and write sends. */
export function memoryScopeParams(ref: MemoryScopeRef): URLSearchParams {
  const params = new URLSearchParams({ project: ref.projectName });
  if (ref.sessionName !== null) params.set("session", ref.sessionName);
  return params;
}

export function memoryNotesUrl(
  ref: MemoryScopeRef,
  filters: MemoryListFilters,
): string {
  const params = memoryScopeParams(ref);
  if (filters.scope !== undefined) params.set("scope", filters.scope);
  if (filters.lifecycle !== undefined)
    params.set("lifecycle", filters.lifecycle);
  if (filters.includeArchived) params.set("archived", "true");
  return `/api/memory/notes?${params.toString()}`;
}

export function memoryNoteUrl(handle: string, sub?: string): string {
  const base = `/api/memory/notes/${encodeURIComponent(handle)}`;
  return sub === undefined ? base : `${base}/${sub}`;
}

export function memoryReviewUrl(
  ref: MemoryScopeRef,
  filters: MemoryReviewFilters,
): string {
  const params = memoryScopeParams(ref);
  if (filters.promotionCandidates) params.set("promotionCandidates", "true");
  if (filters.session !== null) {
    // `finished` is deliberately absent: it is a cache-key input, not a filter
    // the server accepts (see MemoryIncarnationRef).
    params.set("sessionName", filters.session.sessionName);
    params.set("sessionCreatedAt", filters.session.sessionCreatedAt);
  }
  return `/api/memory/review?${params.toString()}`;
}

export const memoryQueries = {
  /** The browse list for one scope selection. */
  list: (ref: MemoryScopeRef, filters: MemoryListFilters) =>
    queryOptions({
      queryKey: memoryKeys.list(ref, filters),
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          memoryNotesUrl(ref, filters),
          memoryListResponseSchema,
          { signal },
        );
        return response.notes;
      },
      refetchOnReconnect: false,
    }),

  /**
   * One note with its links — the detail pane's read. Addressed by internal id
   * (a handle the routes accept alongside a slug) so the read survives the
   * rename the panel itself can perform.
   */
  detail: (ref: MemoryScopeRef, memoryId: string) =>
    queryOptions({
      queryKey: memoryKeys.detail(ref, memoryId),
      queryFn: ({ signal }) =>
        apiFetch(
          `${memoryNoteUrl(memoryId)}?${withArchived(ref)}`,
          memoryDetailResponseSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),

  /** Bounded revision history, newest first — the restore-forward list. */
  revisions: (ref: MemoryScopeRef, memoryId: string) =>
    queryOptions({
      queryKey: memoryKeys.revisions(ref, memoryId),
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          `${memoryNoteUrl(memoryId, "revisions")}?${memoryScopeParams(ref).toString()}`,
          memoryRevisionsResponseSchema,
          { signal },
        );
        return response.revisions;
      },
      refetchOnReconnect: false,
    }),

  /**
   * The freshness engine's own queue. The Library never evaluates a lease
   * itself: review-due rows, their attributed staleness, and promotion
   * candidacy all come from here (R8, R10).
   */
  review: (ref: MemoryScopeRef, filters: MemoryReviewFilters) =>
    queryOptions({
      queryKey: memoryKeys.review(ref, filters),
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          memoryReviewUrl(ref, filters),
          memoryReviewResponseSchema,
          { signal },
        );
        return response.entries;
      },
      refetchOnReconnect: false,
    }),

  /**
   * The block the named conversation is due as it stands, composed by the same
   * provider the turn uses. Null is data, not an error: a conversation whose
   * policy tells it nothing genuinely has no block.
   *
   * Both freshness overrides are deliberate. The block is composed from inputs
   * no memory event announces — the passage of time against every note's review
   * lease, and which artifacts are active for the conversation this turn — so a
   * cached block can assert something the next turn would no longer inject.
   * Opening the surface is the
   * moment the human is asking what the agent is told, so it is the moment to
   * ask the composer.
   *
   * `refetchOnMount: "always"` covers opening the preview from elsewhere in the
   * panel. It is not enough on its own: the right pane FORCE-MOUNTS its tabs, so
   * tabbing away and back never remounts the surface — the query is merely
   * disabled and re-enabled, and a re-enabled query only refetches when it is
   * stale. `staleTime: 0` is what makes that reopen ask again.
   *
   * This is not polling. Nothing refetches while the surface sits open: window
   * focus is off application-wide, and drift while open is what the typed
   * reactions cover.
   */
  indexPreview: (conversationId: string, render: MemoryIndexRender) =>
    queryOptions({
      queryKey: memoryKeys.indexPreview(conversationId, render),
      refetchOnMount: "always",
      staleTime: 0,
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          `/api/memory/index?conversation=${encodeURIComponent(conversationId)}${
            render === "full" ? "&full=true" : ""
          }`,
          memoryIndexResponseSchema,
          { signal },
        );
        return response.block;
      },
      refetchOnReconnect: false,
    }),
} as const;

/**
 * The detail read always admits archived records: the panel is the repair
 * surface, and a note it archived a moment ago has to stay open so it can be
 * restored from the same view.
 */
function withArchived(ref: MemoryScopeRef): string {
  const params = memoryScopeParams(ref);
  params.set("archived", "true");
  return params.toString();
}

export function useMemoryNotesQuery(
  ref: MemoryScopeRef,
  filters: MemoryListFilters,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...memoryQueries.list(ref, filters),
    enabled: ref.projectName.length > 0 && (options?.enabled ?? true),
  });
}

export function useMemoryNoteQuery(
  ref: MemoryScopeRef,
  memoryId: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...memoryQueries.detail(ref, memoryId ?? ""),
    enabled:
      memoryId !== null && memoryId.length > 0 && (options?.enabled ?? true),
  });
}

export function useMemoryRevisionsQuery(
  ref: MemoryScopeRef,
  memoryId: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...memoryQueries.revisions(ref, memoryId ?? ""),
    enabled:
      memoryId !== null && memoryId.length > 0 && (options?.enabled ?? true),
  });
}

export function useMemoryReviewQueueQuery(
  ref: MemoryScopeRef,
  filters: MemoryReviewFilters,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...memoryQueries.review(ref, filters),
    enabled: ref.projectName.length > 0 && (options?.enabled ?? true),
  });
}

export function useMemoryIndexPreviewQuery(
  conversationId: string | null,
  render: MemoryIndexRender,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...memoryQueries.indexPreview(conversationId ?? "", render),
    enabled:
      conversationId !== null &&
      conversationId.length > 0 &&
      (options?.enabled ?? true),
  });
}

/**
 * The per-session promotion-candidate queue — the ONE client binding of the
 * candidate contract (spec R11).
 *
 * Both consumers go through it (the Library badge and the session-completion
 * count) so they cannot build different keys for the same question: they
 * previously shared a key by coincidence of both spelling the same filters,
 * which is what let one surface serve the other's stale answer. The incarnation
 * is read from the session itself rather than passed in, so its created-at and
 * its over/not-over state always come from the same observation.
 */
export function useSessionPromotionCandidatesQuery(
  projectName: string,
  sessionName: string,
  options?: { enabled?: boolean },
) {
  const session = useSessionQuery(projectName, sessionName);
  const incarnation: MemoryIncarnationRef | null =
    session.data === undefined
      ? null
      : {
          sessionName,
          sessionCreatedAt: session.data.createdAt,
          finished: session.data.finished,
        };
  return useMemoryReviewQueueQuery(
    { projectName, sessionName },
    { promotionCandidates: true, session: incarnation },
    { enabled: incarnation !== null && (options?.enabled ?? true) },
  );
}

/** One note with its links — what the detail read resolves to. */
export type MemoryNoteDetail = z.infer<typeof memoryDetailResponseSchema>;
