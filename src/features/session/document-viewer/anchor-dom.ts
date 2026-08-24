import type { CommentAnchor } from "@/lib/document-comments/schemas";
import { deriveSelectionAnchor } from "@/lib/document-comments/anchor";
import {
  CC_LINE_ATTR,
  CC_SECTION_ATTR,
  resolveBlockMeta,
  resolveSelectionBlock,
} from "@/components/markdown/markdown-source-map";
import type { ResolvedMarkdownAnnotation } from "@/components/document-viewer/annotation-contract";

/**
 * Pure DOM helpers that bridge a stored single-block comment anchor to the live
 * rendered markdown: locate the block element by its source-position stamp
 * (stamped by the canonical source-mapped document adapter) and build a DOM Range
 * for the passage. No recogito here — the recogito-specific selector conversion
 * sits in the client-only annotator module — so these stay unit-testable in
 * jsdom.
 *
 * Offsets are counted over the block's ANNOTATABLE text only (descendants marked
 * `.not-annotatable` are skipped), matching the text model the annotator and
 * selection-derivation use.
 */

const NOT_ANNOTATABLE_SELECTOR = ".not-annotatable";

export function findCommentBlockCandidates(
  container: ParentNode,
  anchor: Pick<CommentAnchor, "line" | "sectionId">,
): HTMLElement[] {
  const matching = [
    ...container.querySelectorAll<HTMLElement>(
      `[${CC_LINE_ATTR}="${anchor.line}"][${CC_SECTION_ATTR}="${CSS.escape(anchor.sectionId)}"]`,
    ),
  ];
  return matching.filter(
    (candidate) =>
      !matching.some(
        (other) => other !== candidate && candidate.contains(other),
      ),
  );
}

/** Locate the stamped block a comment anchor points at (by source line + section). */
export function findCommentBlock(
  container: ParentNode,
  anchor: Pick<CommentAnchor, "line" | "sectionId">,
): HTMLElement | null {
  const candidates = findCommentBlockCandidates(container, anchor);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function isAnnotatable(node: Node): boolean {
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return !el?.closest(NOT_ANNOTATABLE_SELECTOR);
}

/**
 * The block's annotatable text: every text node in document order, skipping
 * `.not-annotatable` descendants. This is the exact text model the stored anchor
 * offsets and `tryReanchorExact` operate over, so it is what re-anchoring
 * re-reads from the live DOM.
 */
export function blockAnnotatableText(block: HTMLElement): string {
  const walker = block.ownerDocument.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
  );
  let blockText = "";
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    if (isAnnotatable(text)) blockText += text.data;
    node = walker.nextNode();
  }
  return blockText;
}

/**
 * Build a DOM Range spanning `[charStart, charEnd)` of a block's annotatable
 * text, or null when the offsets fall outside that text. Walks text nodes in
 * document order, skipping `.not-annotatable` descendants.
 */
export function rangeFromBlockOffsets(
  block: HTMLElement,
  charStart: number,
  charEnd: number,
): Range | null {
  if (charStart < 0 || charEnd < charStart) return null;

  const walker = block.ownerDocument.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
  );
  let consumed = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    if (isAnnotatable(text)) {
      const len = text.data.length;
      if (startNode === null && charStart <= consumed + len) {
        startNode = text;
        startOffset = charStart - consumed;
      }
      if (charEnd <= consumed + len) {
        endNode = text;
        endOffset = charEnd - consumed;
        break;
      }
      consumed += len;
    }
    current = walker.nextNode();
  }

  if (startNode === null || endNode === null) return null;
  if (startOffset < 0 || endOffset < 0) return null;

  const range = block.ownerDocument.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/**
 * The annotatable-text offset of a (container, offset) selection point within a
 * block, or null when the point is in non-annotatable content or the container
 * is not one of the block's text nodes (the offset model is over text nodes).
 */
function annotatableOffsetOfPoint(
  block: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  const walker = block.ownerDocument.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
  );
  let consumed = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const annotatable = isAnnotatable(text);
    if (text === container) {
      if (!annotatable) return null;
      return consumed + Math.min(offset, text.data.length);
    }
    if (annotatable) consumed += text.data.length;
    node = walker.nextNode();
  }
  return null;
}

/**
 * Map a DOM selection range onto annotatable-text offsets within a single block
 * (the chevron and other `.not-annotatable` content are excluded), plus the
 * block's annotatable text. Null when either endpoint cannot be mapped.
 */
export function selectionOffsetsInBlock(
  block: HTMLElement,
  range: Range,
): { blockText: string; charStart: number; charEnd: number } | null {
  const charStart = annotatableOffsetOfPoint(
    block,
    range.startContainer,
    range.startOffset,
  );
  const charEnd = annotatableOffsetOfPoint(
    block,
    range.endContainer,
    range.endOffset,
  );
  if (charStart === null || charEnd === null) return null;

  const blockText = blockAnnotatableText(block);

  if (charStart < 0 || charEnd > blockText.length || charEnd < charStart) {
    return null;
  }
  return { blockText, charStart, charEnd };
}

/**
 * Derive a single-block comment anchor from a DOM selection range, or null when
 * the selection spans more than one block, is collapsed, or cannot be mapped to
 * annotatable text. Combines the 4.1 block resolver with the pure
 * `deriveSelectionAnchor`, so the resulting anchor carries the exact quote plus
 * its section/heading/line reference (5.7).
 */
export function deriveAnchorFromSelection(
  range: Range,
  content: string,
): CommentAnchor | null {
  const block = resolveSelectionBlock(range);
  if (!block) return null;
  const meta = resolveBlockMeta(block);
  if (!meta) return null;
  const offsets = selectionOffsetsInBlock(block, range);
  if (!offsets) return null;
  if (offsets.charEnd <= offsets.charStart) return null;
  return deriveSelectionAnchor({
    blockText: offsets.blockText,
    blockLine: meta.line,
    sectionId: meta.sectionId,
    headingLabel: meta.headingLabel,
    charStart: offsets.charStart,
    charEnd: offsets.charEnd,
    content,
  });
}

/** Annotations whose stored quote resolves against a concrete rendered block. */
export function selectRenderableAnnotations(
  annotations: readonly ResolvedMarkdownAnnotation[],
): ResolvedMarkdownAnnotation[] {
  return annotations.filter(
    (annotation) =>
      annotation.block !== null && annotation.anchorState.status !== "stale",
  );
}

/** One left-gutter marker per runtime block, collapsing co-located annotations. */
export interface GutterGroup {
  /** Stable within one annotation projection. */
  key: string;
  block: HTMLElement;
  ids: readonly string[];
  /** Active if any co-located annotation is active, otherwise settled. */
  tone: ResolvedMarkdownAnnotation["tone"];
  count: number;
}

/**
 * Group annotations by the exact runtime block used to resolve their offsets.
 * Object identity prevents two ambiguous blocks with the same source stamps
 * from being collapsed into an arbitrary passage.
 */
export function groupResolvedAnnotations(
  annotations: readonly ResolvedMarkdownAnnotation[],
): GutterGroup[] {
  const byBlock = new Map<HTMLElement, ResolvedMarkdownAnnotation[]>();
  for (const annotation of selectRenderableAnnotations(annotations)) {
    const block = annotation.block;
    if (block === null) continue;
    const existing = byBlock.get(block);
    if (existing) {
      existing.push(annotation);
    } else {
      byBlock.set(block, [annotation]);
    }
  }
  return [...byBlock.entries()].map(([block, group]) => {
    const ids = group.map(({ id }) => id);
    return {
      key: ids.join(":"),
      block,
      ids,
      tone: group.some(({ tone }) => tone === "active") ? "active" : "settled",
      count: group.length,
    };
  });
}
