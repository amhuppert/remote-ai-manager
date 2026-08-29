import type { CommentAnchor } from "./schemas";

/**
 * Pure comment-anchoring logic. No DOM, no I/O — only strings and offsets — so
 * it is fully unit-testable and runs identically on the server and in the
 * browser (it is imported by client viewer components). The anchor model is a
 * SINGLE rendered block: cross-block selections are rejected upstream and never
 * reach this layer.
 */

/** Chars of surrounding context stored on each anchor (unused by v1 matching). */
const PREFIX_SUFFIX_CONTEXT_CHARS = 32;

/**
 * Bounded search radius (in chars) for re-anchoring a passage that shifted
 * within its block. A nearby occurrence of the stored quote is accepted ONLY
 * when it is the UNIQUE occurrence of that quote within this radius of the
 * stored offset — the defined unambiguous same-passage rule. A far-away
 * occurrence (outside the window) is never relocated to, and a window that
 * holds zero or more than one occurrence is ambiguous and stays stale: exact
 * matching alone cannot tell a shifted original from a coincidental duplicate,
 * so we refuse to guess (11.4 — never silently relocate to a different passage).
 */
const REANCHOR_SEARCH_RADIUS = 64;

export type ReanchorResult =
  | { status: "anchored"; charStart: number; charEnd: number }
  | { status: "stale" };

/**
 * Deterministic, change-sensitive content revision used to detect that a
 * document changed since a comment was created. A pure 53-bit string hash
 * (cyrb53) keeps the function isomorphic and synchronous — no `node:crypto`,
 * which would not bundle for the browser. This is a change indicator, not a
 * security primitive.
 */
export function computeDocRevision(content: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  // Mix the length in so equal-length collisions are even less likely.
  return `${content.length.toString(36)}-${hash.toString(36)}`;
}

interface SelectionAnchorInput {
  /** The full text of the single block the selection lies within. */
  blockText: string;
  /** 1-based source line of the block. */
  blockLine: number;
  /** Nearest-heading id of the block. */
  sectionId: string;
  /** Human-facing heading label for the block. */
  headingLabel: string;
  /** Selection start offset within `blockText`. */
  charStart: number;
  /** Selection end offset within `blockText`. */
  charEnd: number;
  /** The whole document content, used to stamp the revision. */
  content: string;
}

/**
 * Build the full anchor value object for a fresh single-block selection. The
 * quote is the exact selected slice; prefix/suffix are bounded surrounding
 * context stored with the anchor and unused by v1 matching.
 * Precondition: `0 <= charStart <= charEnd <= blockText.length`.
 */
export function deriveSelectionAnchor(
  input: SelectionAnchorInput,
): CommentAnchor {
  const { blockText, charStart, charEnd } = input;
  const prefixStart = Math.max(0, charStart - PREFIX_SUFFIX_CONTEXT_CHARS);
  const suffixEnd = Math.min(
    blockText.length,
    charEnd + PREFIX_SUFFIX_CONTEXT_CHARS,
  );
  return {
    sectionId: input.sectionId,
    headingLabel: input.headingLabel,
    line: input.blockLine,
    charStart,
    charEnd,
    quote: blockText.slice(charStart, charEnd),
    prefix: blockText.slice(prefixStart, charStart),
    suffix: blockText.slice(charEnd, suffixEnd),
    docRevision: computeDocRevision(input.content),
  };
}

/**
 * Re-anchor a comment against the current text of its block by EXACT quote match
 * (v1). Returns `anchored` only when the same passage can be identified
 * unambiguously; otherwise `stale`. Two — and only two — situations anchor:
 *
 * 1. The stored quote is unchanged at the stored offsets (the strongest
 *    same-passage signal; wins regardless of any other nearby occurrence).
 * 2. The stored quote occurs EXACTLY ONCE within the bounded nearby window —
 *    the unique nearby occurrence is treated as the same passage shifted by an
 *    edit earlier in the block.
 *
 * Anything else is `stale`: the quote is gone, or it appears more than once near
 * the stored offset (ambiguous), or only far outside the window. Exact matching
 * cannot distinguish a shifted original from a coincidental duplicate, so when
 * the nearby match is not unique we refuse to relocate (11.4).
 */
export function tryReanchorExact(
  blockText: string | null,
  // Only the passage and its stored offsets participate in matching, so the
  // parameter asks for exactly those. Notepad comment anchors carry the same
  // block-scoped shape under their own revision field and re-anchor through
  // here rather than through a second matcher.
  anchor: Pick<CommentAnchor, "quote" | "charStart" | "charEnd">,
): ReanchorResult {
  if (blockText === null) return { status: "stale" };
  if (anchor.quote.length === 0) return { status: "stale" };

  // Fast path: unchanged passage at the stored offsets.
  if (blockText.slice(anchor.charStart, anchor.charEnd) === anchor.quote) {
    return {
      status: "anchored",
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
    };
  }

  // Bounded nearby search for a shifted passage. Accept only when the quote
  // occurs exactly once within the window; zero or multiple occurrences are
  // ambiguous and left stale.
  const minStart = Math.max(0, anchor.charStart - REANCHOR_SEARCH_RADIUS);
  const maxStart = anchor.charStart + REANCHOR_SEARCH_RADIUS;
  let match = -1;
  let from = minStart;
  while (true) {
    const idx = blockText.indexOf(anchor.quote, from);
    if (idx === -1 || idx > maxStart) break;
    if (match !== -1) return { status: "stale" }; // second occurrence → ambiguous
    match = idx;
    from = idx + 1;
  }

  if (match === -1) return { status: "stale" };
  return {
    status: "anchored",
    charStart: match,
    charEnd: match + anchor.quote.length,
  };
}
