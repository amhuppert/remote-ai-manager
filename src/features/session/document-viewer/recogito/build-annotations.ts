import {
  rangeToSelector,
  type HighlightStyle,
  type HighlightStyleExpression,
  type TextAnnotation,
} from "@recogito/text-annotator";
import {
  findCommentBlock,
  rangeFromBlockOffsets,
  selectAnchoredComments,
} from "../anchor-dom";
import type { ResolvedComment } from "../types";

/**
 * Recogito-coupled glue: convert re-anchored comments into text annotations the
 * annotator can paint, and a status-driven highlight style. Imports the
 * `@recogito/text-annotator` core (browser-only at load), so it is reached ONLY
 * through the SSR-disabled annotator boundary — never the SSR graph.
 *
 * Pending highlights read as cyan (the live accent); sent ones shift to a muted
 * green so the two states are visually distinct (req 6.2). Each is a translucent
 * fill plus a 2px solid underline in the accent, matching the prototype's
 * commented-passage treatment. The literals mirror the design tokens
 * `--cyan`/`--green`/`--green-dim` — recogito paints highlight fills/underlines
 * as raw CSS colors, where a `var(--token)` would not resolve.
 */
const PENDING_HIGHLIGHT: HighlightStyle = {
  fill: "#00e5ff",
  fillOpacity: 0.22,
  underlineStyle: "solid",
  underlineColor: "#00e5ff",
  underlineThickness: 2,
};
const SENT_HIGHLIGHT: HighlightStyle = {
  fill: "#00e676",
  fillOpacity: 0.18,
  underlineStyle: "solid",
  underlineColor: "#00b85c",
  underlineThickness: 2,
};

/** Build text annotations for every comment whose stored quote re-anchored. */
export function commentsToTextAnnotations(
  comments: ResolvedComment[],
  container: HTMLElement,
): TextAnnotation[] {
  const annotations: TextAnnotation[] = [];
  for (const comment of selectAnchoredComments(comments)) {
    if (comment.reanchor.status !== "anchored") continue;
    const block = findCommentBlock(container, comment.anchor);
    if (!block) continue;
    const range = rangeFromBlockOffsets(
      block,
      comment.reanchor.charStart,
      comment.reanchor.charEnd,
    );
    if (!range || range.collapsed) continue;
    const selector = rangeToSelector(range, container);
    annotations.push({
      id: comment.id,
      bodies: [],
      target: { annotation: comment.id, selector: [selector] },
    });
  }
  return annotations;
}

/** A highlight style keyed by each annotation's current comment status. */
export function highlightStyleForComments(
  comments: ResolvedComment[],
): HighlightStyleExpression<TextAnnotation> {
  const statusById = new Map(comments.map((c) => [c.id, c.status]));
  return (annotation: TextAnnotation) =>
    statusById.get(annotation.id) === "sent"
      ? SENT_HIGHLIGHT
      : PENDING_HIGHLIGHT;
}
