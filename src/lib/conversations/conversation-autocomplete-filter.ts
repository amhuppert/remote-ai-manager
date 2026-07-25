/**
 * Filter, score, and order conversation list items for the `#`-trigger
 * autocomplete. Pure: no React, no I/O. Safe to call from React Query
 * selectors or memos.
 */

import { fuzzyMatch, type MatchTier } from "@/lib/shared/fuzzy";
import { resolveDisplayLabel } from "./display-label";
import type { ConversationListItem, ConversationStatus } from "./schemas";

export const MAX_DISPLAY_CONVERSATIONS = 50;

export interface ScoredConversationItem<
  T extends ConversationListItem = ConversationListItem,
> {
  item: T;
  tier: MatchTier;
  coverage: number;
  /** Match indices on the display label used for matching. */
  indices: number[];
}

export interface ConversationFilterContext {
  currentProjectName: string | null;
  currentConversationId: string | null;
}

export interface ConversationFilterOptions {
  maxDisplayItems?: number;
}

export interface ConversationFilterResult<
  T extends ConversationListItem = ConversationListItem,
> {
  items: ScoredConversationItem<T>[];
  totalCount: number;
}

/**
 * Generic over the item type so a caller that pre-narrowed its input (e.g. to
 * session-scoped conversations only) keeps that narrowing in the result.
 */
export function filterAndScoreConversations<T extends ConversationListItem>(
  query: string,
  items: readonly T[],
  context: ConversationFilterContext,
  options?: ConversationFilterOptions,
): ConversationFilterResult<T> {
  const cap = options?.maxDisplayItems ?? MAX_DISPLAY_CONVERSATIONS;
  const scored: ScoredConversationItem<T>[] = [];

  for (const item of items) {
    if (item.conversationId === context.currentConversationId) continue;

    const label = resolveDisplayLabel({
      conversationName: item.conversationName,
      summary: item.summary,
      firstPromptSnippet: item.firstPromptSnippet,
      conversationId: item.conversationId,
    });
    const result = fuzzyMatch(query, label);
    if (!result.match || result.tier === null) continue;

    scored.push({
      item,
      tier: result.tier,
      coverage: result.coverage,
      indices: result.indices,
    });
  }

  scored.sort((a, b) => compareScored(a, b, query, context));

  return {
    items: scored.slice(0, cap),
    totalCount: scored.length,
  };
}

function compareScored(
  a: ScoredConversationItem,
  b: ScoredConversationItem,
  query: string,
  context: ConversationFilterContext,
): number {
  if (query.length === 0) {
    // Empty-query ordering: archived → current project → status → recency.
    const archivedDiff = boolRank(a.item.archived) - boolRank(b.item.archived);
    if (archivedDiff !== 0) return archivedDiff;

    const projectDiff =
      currentProjectRank(a.item, context) - currentProjectRank(b.item, context);
    if (projectDiff !== 0) return projectDiff;

    const statusDiff = statusRank(a.item.status) - statusRank(b.item.status);
    if (statusDiff !== 0) return statusDiff;

    return compareRecency(a.item.lastActivityAt, b.item.lastActivityAt);
  }

  // Non-empty query: tier → archived → coverage → current project → recency.
  const tierDiff = tierRank(a.tier) - tierRank(b.tier);
  if (tierDiff !== 0) return tierDiff;

  const archivedDiff = boolRank(a.item.archived) - boolRank(b.item.archived);
  if (archivedDiff !== 0) return archivedDiff;

  const coverageDiff = b.coverage - a.coverage;
  if (coverageDiff !== 0) return coverageDiff;

  const projectDiff =
    currentProjectRank(a.item, context) - currentProjectRank(b.item, context);
  if (projectDiff !== 0) return projectDiff;

  return compareRecency(a.item.lastActivityAt, b.item.lastActivityAt);
}

function boolRank(value: boolean): number {
  return value ? 1 : 0;
}

function tierRank(tier: MatchTier): number {
  return tier === "prefix" ? 0 : 1;
}

function currentProjectRank(
  item: ConversationListItem,
  context: ConversationFilterContext,
): number {
  if (context.currentProjectName === null) return 0;
  return item.projectName === context.currentProjectName ? 0 : 1;
}

function statusRank(status: ConversationStatus): number {
  if (status === "running" || status === "awaiting") return 0;
  return 1;
}

function compareRecency(a: string, b: string): number {
  // ISO 8601 timestamps sort lexicographically; reverse for "desc".
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}
