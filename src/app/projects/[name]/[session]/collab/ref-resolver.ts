export interface RefResolverDocument {
  id: string;
  filePath: string;
}

export interface RefRoundContext {
  workflowId: string;
  roundNumber: number;
}

function stripLineAnchor(ref: string): string {
  const idx = ref.indexOf("#");
  return idx === -1 ? ref : ref.slice(0, idx);
}

const ROUND_AGENT_REF = /^(?:claude|codex)\/round-\d+\//;

/**
 * Canonicalizes a v0.4 review ref to a project-relative path. v0.4 refs are
 * report-relative (e.g. "codex/report.md#L42"); resolving them to the correct
 * artifact requires the round in which the review was emitted. When a ref is
 * already absolute under "memory-bank/" or already includes its own
 * "claude|codex/round-N/" prefix, it is left untouched (apart from the line
 * anchor) so cross-round citations still resolve.
 */
export function canonicalizeReviewRef(
  ref: string,
  context: RefRoundContext,
): string {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return trimmed;
  const anchorIdx = trimmed.indexOf("#");
  const path = anchorIdx === -1 ? trimmed : trimmed.slice(0, anchorIdx);
  const anchor = anchorIdx === -1 ? "" : trimmed.slice(anchorIdx);

  if (path.startsWith("memory-bank/")) {
    return `${path}${anchor}`;
  }
  if (ROUND_AGENT_REF.test(path)) {
    return `memory-bank/collaboration/${context.workflowId}/${path}${anchor}`;
  }
  return `memory-bank/collaboration/${context.workflowId}/round-${context.roundNumber}/${path}${anchor}`;
}

/**
 * Returns the canonical project-relative report path for a given collaboration
 * round/agent. Mirrors the layout written by registerRoundArtifacts in
 * src/lib/workflows/collaboration/slice.ts.
 */
export function canonicalReportPath(
  workflowId: string,
  roundNumber: number,
  agent: "claude" | "codex",
): string {
  return `memory-bank/collaboration/${workflowId}/round-${roundNumber}/${agent}/report.md`;
}

/**
 * Resolves a ref or canonical project-relative path to the registered
 * reference-document id by exact match first, then by path-suffix fallback.
 *
 * Suffix-match is only used when no exact match exists (defensive: e.g. an
 * agent ref escaped canonicalization). Among suffix candidates, the
 * lexicographically last filePath wins, which selects the highest round in the
 * canonical "memory-bank/collaboration/<wf>/round-<n>/<agent>/..." layout.
 */
export function resolveRefToDocumentId(
  ref: string,
  documents: readonly RefResolverDocument[],
): string | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;
  const path = stripLineAnchor(trimmed);
  if (path.length === 0) return null;

  for (const doc of documents) {
    if (doc.filePath === path) return doc.id;
  }

  let bestMatch: RefResolverDocument | null = null;
  for (const doc of documents) {
    if (!doc.filePath.endsWith(`/${path}`)) continue;
    if (bestMatch === null || doc.filePath > bestMatch.filePath) {
      bestMatch = doc;
    }
  }
  return bestMatch?.id ?? null;
}
