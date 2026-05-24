import {
  fuzzyMatch,
  compareFuzzyResults,
  type MatchTier,
} from "../shared/fuzzy";
import type { FileItem } from "@/lib/files/schemas";
export const MAX_DISPLAY_ITEMS = 50;

export interface ScoredFileItem {
  item: FileItem;
  tier: MatchTier;
  coverage: number;
  indices: number[];
}

export interface FilterOptions {
  maxDisplayItems?: number;
}

export interface FilterResult {
  items: ScoredFileItem[];
  totalCount: number;
}

/**
 * Filter, score, sort, and cap a list of files for autocomplete display.
 * Pure: no React, no I/O. Safe to call from React Query selectors or memos.
 */
export function filterAndScoreFiles(
  query: string,
  files: readonly FileItem[],
  options?: FilterOptions,
): FilterResult {
  const cap = options?.maxDisplayItems ?? MAX_DISPLAY_ITEMS;
  const scored: ScoredFileItem[] = [];

  for (const file of files) {
    const result = fuzzyMatch(query, file.path);
    if (!result.match || result.tier === null) continue;
    scored.push({
      item: file,
      tier: result.tier,
      coverage: result.coverage,
      indices: result.indices,
    });
  }

  scored.sort(
    (a, b) =>
      compareFuzzyResults(a, b) || a.item.path.localeCompare(b.item.path),
  );

  return {
    items: scored.slice(0, cap),
    totalCount: scored.length,
  };
}
