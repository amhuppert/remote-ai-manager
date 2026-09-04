import type { MemoryLifecycle, MemoryScope } from "./schemas";

/**
 * Query keys for the Memory Library's reads.
 *
 * Every key carries the caller's own scope (project, and the session
 * incarnation when one is in view) because the server derives visibility from
 * exactly those request parameters: two sessions of one project see different
 * note sets, so a key that omitted the session would serve one incarnation's
 * rows to another.
 *
 * Notes are addressed by SLUG on the wire, but cached by internal id: a rename
 * changes the slug while the record is the same one the change event names, and
 * the event carries the id. Keying by slug would strand the cache entry under
 * the old handle on every rename.
 */

/**
 * Which render of a conversation's index is being read: what its NEXT turn
 * would actually be given — a delta once it already holds a block — or the
 * whole index whatever it is due.
 */
export type MemoryIndexRender = "next-turn" | "full";

/** The caller's own scope — the `project`/`session` parameters every read sends. */
export interface MemoryScopeRef {
  projectName: string;
  /** Null for a project-only view; a name binds the session incarnation. */
  sessionName: string | null;
}

export interface MemoryListFilters {
  scope?: MemoryScope;
  lifecycle?: MemoryLifecycle;
  includeArchived: boolean;
}

export interface MemoryReviewFilters {
  promotionCandidates: boolean;
  /** The incarnation a session-filtered queue names, or null for the whole scope. */
  session: MemoryIncarnationRef | null;
}

/**
 * The incarnation a session-filtered queue is asked about, as the CLIENT last
 * observed it.
 *
 * `finished` is not a request parameter and is never sent — the server derives
 * candidacy itself, and a client that could state it would be free to disagree.
 * It is here because it is an INPUT to the answer that the request URL cannot
 * express: a durable note becomes a promotion candidate the moment the
 * incarnation is over, and that transition writes no note, so no
 * `memory-changed` frame accompanies it. Keyed only on which incarnation this
 * is, the running session's empty queue would keep being served for the whole
 * staleTime after the merge — precisely when the promotion decision is owed.
 * Carrying the transition in the key makes the post-completion question a
 * different question, so it cannot be answered from the pre-completion cache.
 */
export interface MemoryIncarnationRef {
  sessionName: string;
  sessionCreatedAt: string;
  finished: boolean;
}

function scopeSegments(ref: MemoryScopeRef): readonly [string, string | null] {
  return [ref.projectName, ref.sessionName] as const;
}

export const memoryKeys = {
  all: ["memory"] as const,
  lists: () => [...memoryKeys.all, "list"] as const,
  list: (ref: MemoryScopeRef, filters: MemoryListFilters) =>
    [...memoryKeys.lists(), ...scopeSegments(ref), filters] as const,
  details: () => [...memoryKeys.all, "detail"] as const,
  /** One note with its links — keyed by internal id so a rename invalidates in place. */
  detail: (ref: MemoryScopeRef, memoryId: string) =>
    [...memoryKeys.details(), ...scopeSegments(ref), memoryId] as const,
  /** Bounded revision history, nested under the detail key so both go stale together. */
  revisions: (ref: MemoryScopeRef, memoryId: string) =>
    [...memoryKeys.detail(ref, memoryId), "revisions"] as const,
  reviews: () => [...memoryKeys.all, "review"] as const,
  review: (ref: MemoryScopeRef, filters: MemoryReviewFilters) =>
    [...memoryKeys.reviews(), ...scopeSegments(ref), filters] as const,
  indexPreviews: () => [...memoryKeys.all, "index"] as const,
  /**
   * The block one conversation is due. Keyed by the conversation and the RENDER
   * asked for: the block is composed for that conversation's own scope and role
   * server-side, so the viewer's scope is not part of it, but the next-turn
   * delivery and the full index are two different answers from the same route
   * and a shared key would serve one where the other was asked for.
   */
  indexPreview: (conversationId: string, render: MemoryIndexRender) =>
    [...memoryKeys.indexPreviews(), conversationId, render] as const,
} as const;

/**
 * True when a scoped key (list or review queue) belongs to the named project.
 * Both shapes place the project name at index 2 — colocated with the factory
 * above so a key-shape change updates this check in the same file.
 */
export function isMemoryProjectScopedKey(
  queryKey: readonly unknown[],
  projectName: string,
): boolean {
  return queryKey[2] === projectName;
}

/**
 * True when a detail-family key (the note or its nested revisions) addresses
 * this record. The id sits at index 4, after the two scope segments.
 */
export function isMemoryDetailKeyFor(
  queryKey: readonly unknown[],
  memoryId: string,
): boolean {
  return queryKey[4] === memoryId;
}
