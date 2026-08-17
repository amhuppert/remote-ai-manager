import {
  fuzzyMatch,
  type FuzzyResult,
  type MatchTier,
} from "@/lib/shared/fuzzy";
import { formatTicketIdentifier } from "./references";
import type { TicketListItem, TicketStatus } from "./schemas";

export const MAX_DISPLAY_TICKETS = 50;

export interface ScoredTicketItem {
  item: TicketListItem;
  tier: MatchTier;
  coverage: number;
  titleMatchIndices: number[];
}

export interface TicketFilterContext {
  currentProjectName: string | null;
  /**
   * Include tickets that have been finished. Reference pickers default to
   * active work, so `done` and `closed` are withheld unless a caller opts in.
   */
  includeDone?: boolean;
}

export interface TicketFilterResult {
  items: ScoredTicketItem[];
  totalCount: number;
  /** Query matches withheld only because they are done or closed. */
  hiddenDoneCount: number;
}

const FINISHED_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "done",
  "closed",
]);

interface TicketMatch {
  result: FuzzyResult;
  titleMatchIndices: number[];
}

export function filterAndScoreTickets(
  query: string,
  items: readonly TicketListItem[],
  context: TicketFilterContext,
  options?: { maxDisplayItems?: number },
): TicketFilterResult {
  const scored: ScoredTicketItem[] = [];
  const includeDone = context.includeDone ?? false;
  let hiddenDoneCount = 0;

  for (const item of items) {
    const match = bestTicketMatch(query, item);
    if (!match.result.match || match.result.tier === null) continue;
    if (!includeDone && FINISHED_STATUSES.has(item.status)) {
      hiddenDoneCount += 1;
      continue;
    }
    scored.push({
      item,
      tier: match.result.tier,
      coverage: match.result.coverage,
      titleMatchIndices: match.titleMatchIndices,
    });
  }

  scored.sort((a, b) => compareScoredTickets(a, b, query, context));
  const cap = options?.maxDisplayItems ?? MAX_DISPLAY_TICKETS;
  return {
    items: scored.slice(0, cap),
    totalCount: scored.length,
    hiddenDoneCount,
  };
}

function bestTicketMatch(query: string, item: TicketListItem): TicketMatch {
  const title = fuzzyMatch(query, item.title);
  const identifier = fuzzyMatch(
    query,
    formatTicketIdentifier(item.projectName, item.number),
  );
  const project = fuzzyMatch(query, item.projectName);
  const candidates = [
    { result: title, titleMatchIndices: title.indices },
    { result: identifier, titleMatchIndices: [] },
    { result: project, titleMatchIndices: [] },
  ].filter((candidate) => candidate.result.match);

  candidates.sort((a, b) => compareMatch(a.result, b.result));
  return candidates[0] ?? { result: title, titleMatchIndices: [] };
}

function compareMatch(a: FuzzyResult, b: FuzzyResult): number {
  const tierDifference = tierRank(a.tier) - tierRank(b.tier);
  if (tierDifference !== 0) return tierDifference;
  return b.coverage - a.coverage;
}

function compareScoredTickets(
  a: ScoredTicketItem,
  b: ScoredTicketItem,
  query: string,
  context: TicketFilterContext,
): number {
  if (query.length > 0) {
    const tierDifference = tierRank(a.tier) - tierRank(b.tier);
    if (tierDifference !== 0) return tierDifference;
  }

  const projectDifference =
    currentProjectRank(a.item, context) - currentProjectRank(b.item, context);
  if (projectDifference !== 0) return projectDifference;

  if (query.length > 0) {
    const coverageDifference = b.coverage - a.coverage;
    if (coverageDifference !== 0) return coverageDifference;
  }

  const statusDifference =
    statusRank(a.item.status) - statusRank(b.item.status);
  if (statusDifference !== 0) return statusDifference;

  if (a.item.updatedAt > b.item.updatedAt) return -1;
  if (a.item.updatedAt < b.item.updatedAt) return 1;
  return a.item.id.localeCompare(b.item.id);
}

function tierRank(tier: MatchTier | null): number {
  if (tier === "prefix") return 0;
  if (tier === "substring") return 1;
  return 2;
}

function currentProjectRank(
  item: TicketListItem,
  context: TicketFilterContext,
): number {
  if (context.currentProjectName === null) return 0;
  return item.projectName === context.currentProjectName ? 0 : 1;
}

function statusRank(status: TicketStatus): number {
  if (status === "in_progress") return 0;
  if (status === "blocked") return 1;
  if (status === "not_started") return 2;
  if (status === "done") return 3;
  return 4;
}
