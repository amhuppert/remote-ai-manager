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
  type TicketListItem,
  type TicketListSort,
} from "./schemas";

// Fully explicit (nulls, never absent keys) so query keys hash stably and the
// SSE reducer can recover typed filters from any cached list key.
export const ticketListFiltersSchema = z
  .object({
    projectName: z.string().min(1).nullable(),
    status: ticketStatusSchema.nullable(),
    workType: ticketWorkTypeSchema.nullable(),
    sort: ticketListSortSchema,
  })
  .strict();
export type TicketListFilters = z.infer<typeof ticketListFiltersSchema>;

export interface TicketListFilterInput {
  projectName?: string;
  status?: TicketListFilters["status"];
  workType?: TicketListFilters["workType"];
  sort?: TicketListSort;
}

export function normalizeTicketListFilters(
  input: TicketListFilterInput,
): TicketListFilters {
  return {
    projectName: input.projectName ?? null,
    status: input.status ?? null,
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
  if (filters.status !== null && item.status !== filters.status) return false;
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
  if (filters.status !== null) params.set("status", filters.status);
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
  return {
    id: detail.id,
    projectPath: detail.projectPath,
    projectName: detail.projectName,
    number: detail.number,
    title: detail.title,
    workType: detail.workType,
    status: detail.status,
    attachmentCount: detail.attachments.length,
    activeSessionName: activeLink?.sessionName ?? null,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}
