import { markdownTokenSourceSpans } from "@/components/markdown/markdown-source-map";
import { tryReanchorExact } from "@/lib/document-comments/anchor";
import { projectMarkdownPassage } from "@/components/markdown/markdown-source-map";
import { createClientLogger } from "@/lib/logging/client-logger";
import { notepadChipPartSpans } from "@/lib/notepads/content-parts";

import {
  NOTEPAD_ANCHOR_CONTEXT_CHARS,
  notepadBlockTextAtLine,
  resolveNotepadCommentAnchor,
} from "./comment-anchors";
import type { NotepadCommentAnchor } from "./schemas";

const log = createClientLogger("notepad-annotation-projection");

/**
 * The bridge between the two coordinate spaces a notepad comment lives in: the
 * CANONICAL text an anchor is stated over (what `cctl notepad get` returns) and
 * the ANNOTATABLE text the review rendering measures selections and highlights
 * over. They differ because the renderer replaces every reference tag and image
 * token with a chip the annotation seam excludes from selectable text, so those
 * characters exist in one space and not the other.
 *
 * That difference is UNBOUNDED — a reference tag is routinely longer than the
 * re-anchor search window — so it is mapped exactly here rather than searched
 * for. Which characters actually differ is not restated here: it is asked of
 * the Markdown module that performs the replacement, so a token it renders as
 * a chip and a token it leaves literal (a tag whose attributes fail schema
 * validation, or anything typed inside a code span or fence) are told apart the
 * same way in both places.
 *
 * What remains between the two spaces is ordinary Markdown syntax (`**`, `## `,
 * `> `, code fences), a small local difference the seam's bounded exact-match
 * re-anchoring absorbs; a pathological case (a link with a very long
 * destination) fails closed as a refusal or a stale anchor, never as a comment
 * relocated onto text the reader did not select.
 *
 * CLIENT-ONLY. Resolving the excluded spans reaches the reference registry,
 * which pulls React chip components and Tiptap nodes into the module graph —
 * server code resolves anchors through `comment-anchors.ts`, which stays free
 * of it.
 */

export interface NotepadTextSpan {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * A passage as the RENDERED view reports it: the block it sits in (by section
 * and canonical line) plus the selected run of that block's annotatable text.
 * Structurally the annotation seam's `CommentAnchor` minus the fields only
 * storage carries, so a seam-derived selection satisfies it as-is.
 */
export interface NotepadSelectionAnchor {
  sectionId: string;
  headingLabel: string;
  line: number;
  endBlock?: NotepadCommentAnchor["endBlock"];
  charStart: number;
  charEnd: number;
  quote: string;
}

/**
 * The spans of canonical text the review rendering keeps out of annotatable
 * text: the reference tags and image tokens it replaces with chips carrying the
 * seam's not-annotatable class. The Markdown module answers this from the same
 * parse its transform runs on, so every case where a token is NOT chipped — one
 * whose attributes fail schema validation, or one typed inside a code span or
 * fence, which the transform never reaches — leaves its characters here too,
 * exactly as the reader can still select them.
 */
export function notepadNonAnnotatableSpans(text: string): NotepadTextSpan[] {
  return markdownTokenSourceSpans(text, notepadChipPartSpans);
}

/**
 * A block's canonical text paired with the index tables that map it onto its
 * annotatable text in both directions. Index-table rather than arithmetic so
 * every offset — including the ones at a chip's edges — answers by lookup.
 */
export interface NotepadAnnotatableProjection {
  /** The block's canonical text with every non-annotatable span removed. */
  text: string;
  /** Canonical index of the nth annotatable character; last entry is the end. */
  canonicalOf: number[];
  /** Annotatable characters before each canonical index (0…length inclusive). */
  keptBefore: number[];
}

export function projectNotepadBlock(
  blockText: string,
): NotepadAnnotatableProjection {
  const excluded = new Array<boolean>(blockText.length).fill(false);
  for (const span of notepadNonAnnotatableSpans(blockText)) {
    for (let index = span.start; index < span.end; index++) {
      excluded[index] = true;
    }
  }

  const kept: string[] = [];
  const canonicalOf: number[] = [];
  const keptBefore: number[] = [];
  for (let index = 0; index < blockText.length; index++) {
    keptBefore.push(kept.length);
    if (excluded[index] === true) continue;
    canonicalOf.push(index);
    kept.push(blockText[index] ?? "");
  }
  keptBefore.push(kept.length);
  // The terminal entry lets an end offset at the very end of the block map
  // without a special case.
  canonicalOf.push(blockText.length);

  return { text: kept.join(""), canonicalOf, keptBefore };
}

/**
 * The canonical span a run of annotatable text occupies. Null when the run is
 * broken by a non-annotatable span — a selection dragged across a chip covers
 * canonical characters the reader never saw, so it has no honest canonical
 * passage and is refused rather than widened onto the chip's XML.
 */
export function canonicalSpanOf(
  projection: NotepadAnnotatableProjection,
  start: number,
  end: number,
): NotepadTextSpan | null {
  if (start < 0 || end < start || end > projection.text.length) return null;
  const canonicalStart = projection.canonicalOf[start];
  if (canonicalStart === undefined) return null;
  if (end === start) return { start: canonicalStart, end: canonicalStart };
  const lastCharacter = projection.canonicalOf[end - 1];
  if (lastCharacter === undefined) return null;
  const canonicalEnd = lastCharacter + 1;
  // Contiguous in canonical text iff nothing was removed inside the run.
  return canonicalEnd - canonicalStart === end - start
    ? { start: canonicalStart, end: canonicalEnd }
    : null;
}

/**
 * The annotatable span a run of canonical text occupies. Null when any of that
 * run is non-annotatable — a passage quoting a chip's own XML exists only in
 * the canonical text, so the rendered view has nowhere to paint it.
 */
export function annotatableSpanOf(
  projection: NotepadAnnotatableProjection,
  start: number,
  end: number,
): NotepadTextSpan | null {
  if (start < 0 || end < start || end >= projection.keptBefore.length) {
    return null;
  }
  const annotatableStart = projection.keptBefore[start];
  const annotatableEnd = projection.keptBefore[end];
  if (annotatableStart === undefined || annotatableEnd === undefined) {
    return null;
  }
  return annotatableEnd - annotatableStart === end - start
    ? { start: annotatableStart, end: annotatableEnd }
    : null;
}

/**
 * Turn a passage selected in the RENDERED view into an anchor stated over the
 * CANONICAL text, so the comment quotes what `cctl notepad get` returns rather
 * than what a renderer happened to display. Chips are mapped through the
 * projection, so a selection after one lands on its true canonical offsets
 * however long the tag it follows; the residual syntax difference is bridged by
 * the same exact-match step re-anchoring uses.
 *
 * Null when the selection has no unambiguous canonical passage — it spanned a
 * chip, the block is gone, or the run occurs more than once near the offsets.
 * Refusing is the point: an approximate projection would put the comment on
 * text the reader did not select.
 */
export function notepadAnchorFromSelection(
  selection: NotepadSelectionAnchor,
  content: string,
  notepadRevision: number,
): NotepadCommentAnchor | null {
  if (selection.endBlock !== undefined) {
    const anchor = projectPassageSelection(selection, content, notepadRevision);
    log.debug(
      anchor === null
        ? "notepad.annotation.selection_refused"
        : "notepad.annotation.selection_projected",
      {
        line: selection.line,
        endLine: selection.endBlock.line,
        notepadRevision,
        quoteLength: selection.quote.length,
      },
    );
    return anchor;
  }
  const blockText = notepadBlockTextAtLine(content, selection.line);
  if (blockText === null) return null;

  const projection = projectNotepadBlock(blockText);
  const match = tryReanchorExact(projection.text, selection);
  if (match.status === "stale") return null;

  const canonical = canonicalSpanOf(projection, match.charStart, match.charEnd);
  if (canonical === null) return null;

  const { start: charStart, end: charEnd } = canonical;
  return {
    sectionId: selection.sectionId,
    headingLabel: selection.headingLabel,
    line: selection.line,
    charStart,
    charEnd,
    quote: blockText.slice(charStart, charEnd),
    prefix: blockText.slice(
      Math.max(0, charStart - NOTEPAD_ANCHOR_CONTEXT_CHARS),
      charStart,
    ),
    suffix: blockText.slice(charEnd, charEnd + NOTEPAD_ANCHOR_CONTEXT_CHARS),
    notepadRevision,
  };
}

function projectPassageSelection(
  selection: NotepadSelectionAnchor,
  content: string,
  notepadRevision: number,
): NotepadCommentAnchor | null {
  if (selection.endBlock === undefined) return null;
  const excluded = notepadNonAnnotatableSpans(content);
  const projection = projectMarkdownPassage(
    content,
    selection.line,
    selection.endBlock.line,
    excluded,
  );
  if (projection === null) return null;
  const passageText = content.slice(
    projection.sourceStart,
    projection.sourceEnd,
  );
  const match = tryReanchorExact(projection.text, selection);
  if (match.status === "stale") return null;
  const start = projection.positions[match.charStart];
  const end = projection.positions[match.charEnd - 1];
  if (start == null || end == null) return null;
  if (excluded.some((span) => span.start < end.end && span.end > start.start))
    return null;
  const charStart = start.start - projection.sourceStart;
  const charEnd = end.end - projection.sourceStart;
  return {
    sectionId: selection.sectionId,
    headingLabel: selection.headingLabel,
    line: selection.line,
    endBlock: selection.endBlock,
    charStart,
    charEnd,
    quote: passageText.slice(charStart, charEnd),
    prefix: passageText.slice(
      Math.max(0, charStart - NOTEPAD_ANCHOR_CONTEXT_CHARS),
      charStart,
    ),
    suffix: passageText.slice(charEnd, charEnd + NOTEPAD_ANCHOR_CONTEXT_CHARS),
    notepadRevision,
  };
}

/**
 * A stored anchor restated over its block's annotatable text — the coordinates
 * the rendered view paints in. Resolution runs first through the one canonical
 * authority every reader shares, so the highlight lands where the agent listing
 * and the stale badge say the passage is; null when that resolution reports
 * stale or when the passage is inside a chip.
 */
export function notepadAnchorInAnnotatableSpace(
  anchor: NotepadCommentAnchor,
  content: string,
): (NotepadTextSpan & { quote?: string }) | null {
  if (anchor.endBlock !== undefined) {
    const resolution = resolveNotepadCommentAnchor(anchor, content);
    if (resolution.state === "stale") return null;
    const excluded = notepadNonAnnotatableSpans(content);
    const projection = projectMarkdownPassage(
      content,
      anchor.line,
      anchor.endBlock.line,
      excluded,
    );
    if (projection === null) return null;
    const sourceStart = projection.sourceStart + resolution.charStart;
    const sourceEnd = projection.sourceStart + resolution.charEnd;
    if (
      excluded.some((span) => span.start < sourceEnd && span.end > sourceStart)
    )
      return null;
    const start = projection.positions.findIndex(
      (position) => position?.start === sourceStart,
    );
    const last = projection.positions.findLastIndex(
      (position) => position?.end === sourceEnd,
    );
    if (start < 0 || last < start) return null;
    const end = last + 1;
    return { start, end, quote: projection.text.slice(start, end) };
  }
  const blockText = notepadBlockTextAtLine(content, anchor.line);
  if (blockText === null) return null;

  const resolution = resolveNotepadCommentAnchor(anchor, content);
  if (resolution.state === "stale") return null;

  return annotatableSpanOf(
    projectNotepadBlock(blockText),
    resolution.charStart,
    resolution.charEnd,
  );
}
