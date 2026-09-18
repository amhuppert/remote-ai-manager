/**
 * list-filters.ts — the ONE client-safe definition of ticket list filters and
 * ordering. Query keys embed the normalized filter shape, queries build their
 * request params from it, and the optimistic mutation paths and SSE reducer
 * apply the same match/sort semantics to cached lists — one module, no drift.
 *
 * Ordering mirrors the repo SQL exactly (`updated_at DESC, id ASC` /
 * `created_at DESC, id ASC`); timestamps are ISO-8601 strings, so plain
 * bytewise string comparison matches SQLite's TEXT collation.
 *
 * Client-imported: keep this module free of `node:` builtins.
 */

import { z } from "zod";

import {
  ticketListSortSchema,
  ticketStatusSchema,
  ticketWorkTypeSchema,
  type TicketDetail,
  type TicketChildStatusCount,
  type TicketListItem,
  type TicketListSort,
  type TicketStatus,
} from "./schemas";

// Fully explicit (nulls, never absent keys) so query keys hash stably and the
// SSE reducer can recover typed filters from any cached list key. The status
// filter is a SET (null = every status); normalization dedupes and orders it
// canonically so equivalent sets hash to the same query key.
export const ticketListFiltersSchema = z
  .object({
    projectName: z.string().min(1).nullable(),
    statuses: z.array(ticketStatusSchema).min(1).nullable(),
    workType: ticketWorkTypeSchema.nullable(),
    sort: ticketListSortSchema,
  })
  .strict();
export type TicketListFilters = z.infer<typeof ticketListFiltersSchema>;

/**
 * The default status set for the tickets page: everything still open. Done and
 * closed tickets accumulate forever, so they are opt-in via the status filter.
 */
export const DEFAULT_TICKET_STATUSES: readonly TicketStatus[] = [
  "not_started",
  "in_progress",
  "blocked",
];

const CANONICAL_STATUS_ORDER: readonly TicketStatus[] =
  ticketStatusSchema.options;

export function normalizeTicketStatusSet(
  statuses: readonly TicketStatus[] | null | undefined,
): TicketStatus[] | null {
  if (statuses === null || statuses === undefined) return null;
  const set = new Set(statuses);
  if (set.size === 0) return null;
  return CANONICAL_STATUS_ORDER.filter((status) => set.has(status));
}

export function isDefaultTicketStatusSet(
  statuses: readonly TicketStatus[] | null,
): boolean {
  if (statuses === null) return false;
  const normalized = normalizeTicketStatusSet(statuses);
  return (
    normalized !== null &&
    normalized.length === DEFAULT_TICKET_STATUSES.length &&
    DEFAULT_TICKET_STATUSES.every((status) => normalized.includes(status))
  );
}

export interface TicketListFilterInput {
  projectName?: string;
  statuses?: readonly TicketStatus[];
  workType?: TicketListFilters["workType"];
  sort?: TicketListSort;
}

export function normalizeTicketListFilters(
  input: TicketListFilterInput,
): TicketListFilters {
  return {
    projectName: input.projectName ?? null,
    statuses: normalizeTicketStatusSet(input.statuses),
    workType: input.workType ?? null,
    sort: input.sort ?? "updated",
  };
}

export function matchesTicketListFilters(
  filters: TicketListFilters,
  item: TicketListItem,
): boolean {
  if (filters.projectName !== null && item.projectName !== filters.projectName)
    return false;
  if (filters.statuses !== null && !filters.statuses.includes(item.status))
    return false;
  if (filters.workType !== null && item.workType !== filters.workType)
    return false;
  return true;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareTicketListItems(
  sort: TicketListSort,
  a: TicketListItem,
  b: TicketListItem,
): number {
  const timeA = sort === "created" ? a.createdAt : a.updatedAt;
  const timeB = sort === "created" ? b.createdAt : b.updatedAt;
  const byTimeDesc = compareStrings(timeB, timeA);
  return byTimeDesc !== 0 ? byTimeDesc : compareStrings(a.id, b.id);
}

export function sortTicketListItems(
  sort: TicketListSort,
  items: readonly TicketListItem[],
): TicketListItem[] {
  return [...items].sort((a, b) => compareTicketListItems(sort, a, b));
}

/**
 * Pure list delta: drop the identity everywhere, re-insert only when the
 * item matches the list's filters, and re-sort. Idempotent by construction.
 */
export function upsertTicketListItem(
  list: readonly TicketListItem[],
  item: TicketListItem,
  filters: TicketListFilters,
): TicketListItem[] {
  const withoutIdentity = list.filter((row) => row.id !== item.id);
  if (!matchesTicketListFilters(filters, item)) return withoutIdentity;
  return sortTicketListItems(filters.sort, [...withoutIdentity, item]);
}

export function removeTicketListItem(
  list: readonly TicketListItem[],
  ticketId: string,
): TicketListItem[] {
  return list.filter((row) => row.id !== ticketId);
}

/** Request params for the list endpoints; `project` is the global param. */
export function ticketListSearchParams(
  filters: TicketListFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.projectName !== null) params.set("project", filters.projectName);
  if (filters.statuses !== null)
    params.set("status", filters.statuses.join(","));
  if (filters.workType !== null) params.set("workType", filters.workType);
  params.set("sort", filters.sort);
  return params;
}

/**
 * Lean list item derived from a detail payload, for optimistic cache writes.
 * The open link (endedAt null) approximates the server's instance-guarded
 * active derivation; `onSettled` invalidation reconciles any divergence.
 */
export function ticketListItemFromDetail(detail: TicketDetail): TicketListItem {
  const activeLink = detail.sessions.find((link) => link.endedAt === null);
  const childrenByStatus = new Map<TicketStatus, number>();
  const parentTicketNumbers: number[] = [];
  for (const relationship of detail.relationships) {
    if (relationship.role === "parent") {
      parentTicketNumbers.push(relationship.otherTicket.number);
    }
    if (relationship.role !== "child") continue;
    const status = relationship.otherTicket.status;
    childrenByStatus.set(status, (childrenByStatus.get(status) ?? 0) + 1);
  }
  const childStatusCounts: TicketChildStatusCount[] = [...childrenByStatus]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => ({ status, count }));
  return {
    id: detail.id,
    projectPath: detail.projectPath,
    projectName: detail.projectName,
    number: detail.number,
    title: detail.title,
    workType: detail.workType,
    status: detail.status,
    attachmentCount: detail.attachments.length,
    ...(childStatusCounts.length > 0 ? { childStatusCounts } : {}),
    ...(parentTicketNumbers.length > 0 ? { parentTicketNumbers } : {}),
    activeSessionName: activeLink?.sessionName ?? null,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}
