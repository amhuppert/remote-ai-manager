// ============================================================
// Fuzzy Matching Utility
// ============================================================

export type MatchTier = "prefix" | "substring";

export interface FuzzyResult {
  match: boolean;
  tier: MatchTier | null;
  coverage: number;
  indices: number[];
}

/**
 * Strip non-alphanumeric characters, returning the cleaned string
 * and a map from stripped indices back to original indices.
 */
function stripSpecial(str: string): { stripped: string; indexMap: number[] } {
  let stripped = "";
  const indexMap: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    if (/[a-z0-9]/i.test(ch)) {
      stripped += ch;
      indexMap.push(i);
    }
  }
  return { stripped, indexMap };
}

const NO_MATCH: FuzzyResult = {
  match: false,
  tier: null,
  coverage: 0,
  indices: [],
};

/**
 * Score a query string against a target using case-insensitive substring
 * matching with special characters stripped.
 *
 * - Strips non-alphanumeric characters from both query and target
 * - Matches consecutive characters only (no gaps)
 * - Prefix matches rank above substring matches (expressed via `tier`)
 * - `coverage` = matched length / stripped target length
 *
 * All matching is case-insensitive. Empty query matches everything
 * with tier "prefix" and coverage 0.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult {
  const { stripped: strippedQuery } = stripSpecial(query);

  if (strippedQuery.length === 0) {
    return { match: true, tier: "prefix", coverage: 0, indices: [] };
  }

  const { stripped: strippedTarget, indexMap } = stripSpecial(target);

  if (strippedQuery.length > strippedTarget.length) {
    return NO_MATCH;
  }

  const lowerQuery = strippedQuery.toLowerCase();
  const lowerTarget = strippedTarget.toLowerCase();

  const pos = lowerTarget.indexOf(lowerQuery);
  if (pos === -1) {
    return NO_MATCH;
  }

  const indices: number[] = [];
  for (let i = 0; i < strippedQuery.length; i++) {
    indices.push(indexMap[pos + i]!);
  }

  const tier: MatchTier = pos === 0 ? "prefix" : "substring";
  const coverage = strippedQuery.length / strippedTarget.length;

  return { match: true, tier, coverage, indices };
}

/**
 * Compare two fuzzy results for sorting.
 * Prefix always ranks above substring. Within the same tier,
 * higher coverage (more of the target matched) ranks first.
 *
 * Returns negative if `a` should sort before `b`.
 */
export function compareFuzzyResults(
  a: Pick<FuzzyResult, "tier" | "coverage">,
  b: Pick<FuzzyResult, "tier" | "coverage">,
): number {
  const tierRank = { prefix: 0, substring: 1 };
  if (a.tier !== b.tier) {
    return tierRank[a.tier!] - tierRank[b.tier!];
  }
  return b.coverage - a.coverage;
}
