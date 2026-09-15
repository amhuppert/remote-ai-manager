import type { CommentAnchor } from "@/lib/document-comments/schemas";
import { deriveSelectionAnchor } from "@/lib/document-comments/anchor";
import {
  CC_LINE_ATTR,
  CC_SECTION_ATTR,
  resolveBlockMeta,
} from "@/components/markdown/markdown-source-map";
import {
  NOT_ANNOTATABLE_CLASS,
  type ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";

/**
 * Pure DOM helpers that bridge a stored comment anchor to the live
 * rendered markdown: locate the block element by its source-position stamp
 * (stamped by the canonical source-mapped document adapter) and build a DOM Range
 * for the passage. No recogito here — the recogito-specific selector conversion
 * sits in the client-only annotator module — so these stay unit-testable in
 * jsdom.
 *
 * Offsets are counted over ANNOTATABLE text only (descendants marked
 * `.not-annotatable` are skipped). A passage spanning blocks inserts two
 * newlines whenever the nearest stamped text owner changes.
 */

const NOT_ANNOTATABLE_SELECTOR = `.${NOT_ANNOTATABLE_CLASS}`;

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
 * block, or null when the point is outside the block or in non-annotatable
 * content. Element boundaries count the annotatable text before that child.
 */
function annotatableOffsetOfPoint(
  block: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  if (!isAnnotatable(container) || !block.contains(container)) return null;
  if (container.nodeType === Node.ELEMENT_NODE) {
    const before = block.ownerDocument.createRange();
    before.selectNodeContents(block);
    before.setEnd(container, offset);
    const walker = block.ownerDocument.createTreeWalker(
      block,
      NodeFilter.SHOW_TEXT,
    );
    let consumed = 0;
    let current = walker.nextNode();
    while (current) {
      if (isAnnotatable(current) && before.intersectsNode(current)) {
        consumed += current.textContent?.length ?? 0;
      }
      current = walker.nextNode();
    }
    return consumed;
  }
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
 * Derive the selected passage in the host's annotatable text coordinates.
 * Paragraph boundaries have a stable separator independent of DOM formatting
 * whitespace; inline nodes and literal code retain their own text.
 */
export function deriveAnchorFromSelection(
  range: Range,
  content: string,
  container?: HTMLElement,
): CommentAnchor | null {
  if (
    range.collapsed ||
    !isAnnotatable(range.startContainer) ||
    !isAnnotatable(range.endContainer)
  )
    return null;
  const common = range.commonAncestorContainer;
  const element =
    common.nodeType === Node.ELEMENT_NODE
      ? (common as HTMLElement)
      : common.parentElement;
  const host =
    container ?? element?.closest<HTMLElement>(`[${CC_LINE_ATTR}]`) ?? element;
  if (
    !host ||
    !host.contains(range.startContainer) ||
    !host.contains(range.endContainer)
  )
    return null;
  const stream = annotatableTextStream(host);
  const selected = stream.runs.flatMap((run) => {
    if (!range.intersectsNode(run.node)) return [];
    const start = run.node === range.startContainer ? range.startOffset : 0;
    const end =
      run.node === range.endContainer ? range.endOffset : run.node.length;
    return end > start ? [{ run, start, end }] : [];
  });
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) return null;
  const meta = resolveBlockMeta(first.run.block);
  const endMeta = resolveBlockMeta(last.run.block);
  if (!meta || !endMeta) return null;
  const spansBlocks = selected.some(({ run }) => run.block !== first.run.block);
  if (!spansBlocks) {
    const start = annotatableOffsetOfPoint(
      first.run.block,
      first.run.node,
      first.start,
    );
    const end = annotatableOffsetOfPoint(
      first.run.block,
      last.run.node,
      last.end,
    );
    if (start === null || end === null || end <= start) return null;
    return deriveSelectionAnchor({
      blockText: blockAnnotatableText(first.run.block),
      blockLine: meta.line,
      sectionId: meta.sectionId,
      headingLabel: meta.headingLabel,
      charStart: start,
      charEnd: end,
      content,
    });
  }
  const passage = passageBetweenBlocks(stream, first.run.block, last.run.block);
  if (!passage) return null;
  const anchor = deriveSelectionAnchor({
    blockText: passage.text,
    blockLine: meta.line,
    sectionId: meta.sectionId,
    headingLabel: meta.headingLabel,
    charStart: first.run.start + first.start - passage.start,
    charEnd: last.run.start + last.end - passage.start,
    content,
  });
  return {
    ...anchor,
    endBlock: { line: endMeta.line, sectionId: endMeta.sectionId },
  };
}

interface AnnotatableTextRun {
  node: Text;
  block: HTMLElement;
  start: number;
  end: number;
}

interface AnnotatableTextStream {
  text: string;
  runs: AnnotatableTextRun[];
}

function annotatableTextStream(container: HTMLElement): AnnotatableTextStream {
  const runs: AnnotatableTextRun[] = [];
  let text = "";
  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
  );
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const block = node.parentElement?.closest<HTMLElement>(`[${CC_LINE_ATTR}]`);
    if (
      block &&
      container.contains(block) &&
      isAnnotatable(node) &&
      node.length > 0 &&
      !(node.data.trim() === "" && block.querySelector(`[${CC_LINE_ATTR}]`))
    ) {
      if (runs.length > 0 && runs.at(-1)?.block !== block) text += "\n\n";
      const start = text.length;
      text += node.data;
      runs.push({ node, block, start, end: text.length });
    }
    current = walker.nextNode();
  }
  return { text, runs };
}

export interface CommentPassage {
  block: HTMLElement;
  text: string;
  /** Offset of this passage within the host's text stream. */
  start: number;
  runs: readonly AnnotatableTextRun[];
}

function passageBetweenBlocks(
  stream: AnnotatableTextStream,
  block: HTMLElement,
  endBlock: HTMLElement,
): CommentPassage | null {
  const first = stream.runs.findIndex((run) => run.block === block);
  const last = stream.runs.findLastIndex((run) => run.block === endBlock);
  const start = stream.runs[first]?.start;
  const end = stream.runs[last]?.end;
  if (first < 0 || last < first || start === undefined || end === undefined)
    return null;
  return {
    block,
    text: stream.text.slice(start, end),
    start,
    runs: stream.runs.slice(first, last + 1),
  };
}

export function findCommentPassageCandidates(
  container: HTMLElement,
  anchor: CommentAnchor,
): CommentPassage[] {
  const blocks = findCommentBlockCandidates(container, anchor);
  if (!anchor.endBlock) {
    return blocks.map((block) => ({
      block,
      text: blockAnnotatableText(block),
      start: 0,
      runs: [],
    }));
  }
  const endBlocks = findCommentBlockCandidates(container, anchor.endBlock);
  const stream = annotatableTextStream(container);
  return blocks.flatMap((block) =>
    endBlocks.flatMap((endBlock) => {
      const passage = passageBetweenBlocks(stream, block, endBlock);
      return passage ? [passage] : [];
    }),
  );
}

export function rangesFromCommentPassage(
  passage: CommentPassage,
  charStart: number,
  charEnd: number,
): Range[] {
  if (charStart < 0 || charEnd <= charStart || charEnd > passage.text.length)
    return [];
  if (passage.runs.length === 0) {
    const range = rangeFromBlockOffsets(passage.block, charStart, charEnd);
    return range ? [range] : [];
  }
  return passage.runs.flatMap((run) => {
    const start = Math.max(charStart + passage.start, run.start);
    const end = Math.min(charEnd + passage.start, run.end);
    if (end <= start) return [];
    const range = run.node.ownerDocument.createRange();
    range.setStart(run.node, start - run.start);
    range.setEnd(run.node, end - run.start);
    return [range];
  });
}

export function rangesFromCommentAnchor(
  container: HTMLElement,
  anchor: CommentAnchor,
  charStart = anchor.charStart,
  charEnd = anchor.charEnd,
): Range[] {
  const passages = findCommentPassageCandidates(container, anchor).filter(
    (passage) => passage.text.slice(charStart, charEnd) === anchor.quote,
  );
  const passage = passages.length === 1 ? passages[0] : undefined;
  return passage ? rangesFromCommentPassage(passage, charStart, charEnd) : [];
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
