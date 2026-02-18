// ============================================================
// Fuzzy Matching Utility
// ============================================================

export interface FuzzyResult {
  match: boolean;
  score: number;
  indices: number[];
}

/**
 * Score a query string against a target using a 3-tier fuzzy matching algorithm.
 *
 * Tiers:
 * - Prefix match: score 100, indices from position 0
 * - Substring match: score 80, indices at the offset position
 * - Ordered character match: score = max(10, 60 - spread), indices at each char position
 * - No match: score 0, empty indices
 *
 * All matching is case-insensitive. Empty query matches everything with score 100.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult {
  if (query.length === 0) {
    return { match: true, score: 100, indices: [] };
  }

  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();

  // Tier 1: Prefix match
  if (lowerTarget.startsWith(lowerQuery)) {
    const indices: number[] = [];
    for (let i = 0; i < query.length; i++) {
      indices.push(i);
    }
    return { match: true, score: 100, indices };
  }

  // Tier 2: Substring match
  const substringIdx = lowerTarget.indexOf(lowerQuery);
  if (substringIdx !== -1) {
    const indices: number[] = [];
    for (let i = 0; i < query.length; i++) {
      indices.push(substringIdx + i);
    }
    return { match: true, score: 80, indices };
  }

  // Tier 3: Ordered character match
  const indices: number[] = [];
  let targetPos = 0;

  for (let i = 0; i < lowerQuery.length; i++) {
    const charIdx = lowerTarget.indexOf(lowerQuery[i]!, targetPos);
    if (charIdx === -1) {
      return { match: false, score: 0, indices: [] };
    }
    indices.push(charIdx);
    targetPos = charIdx + 1;
  }

  // Score based on character spread: tighter grouping = higher score
  const firstIdx = indices[0]!;
  const lastIdx = indices[indices.length - 1]!;
  const spread = lastIdx - firstIdx;
  const score = Math.max(10, 60 - spread);

  return { match: true, score, indices };
}
