import {
  rangeToSelector,
  type HighlightStyle,
  type HighlightStyleExpression,
  type TextAnnotation,
} from "@recogito/text-annotator";
import {
  rangeFromBlockOffsets,
  selectRenderableAnnotations,
} from "../anchor-dom";
import type { ResolvedMarkdownAnnotation } from "@/components/document-viewer/annotation-contract";

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
export function markdownAnnotationsToTextAnnotations(
  sources: readonly ResolvedMarkdownAnnotation[],
  container: HTMLElement,
): TextAnnotation[] {
  const annotations: TextAnnotation[] = [];
  for (const source of selectRenderableAnnotations(sources)) {
    if (source.anchorState.status === "stale" || source.block === null)
      continue;
    const range = rangeFromBlockOffsets(
      source.block,
      source.anchorState.charStart,
      source.anchorState.charEnd,
    );
    if (!range || range.collapsed) continue;
    const selector = rangeToSelector(range, container);
    annotations.push({
      id: source.id,
      bodies: [],
      target: { annotation: source.id, selector: [selector] },
    });
  }
  return annotations;
}

/** A highlight style keyed by each annotation's current comment status. */
export function highlightStyleForAnnotations(
  annotations: readonly ResolvedMarkdownAnnotation[],
): HighlightStyleExpression<TextAnnotation> {
  const toneById = new Map(
    annotations.map((annotation) => [annotation.id, annotation.tone]),
  );
  return (annotation: TextAnnotation) =>
    toneById.get(annotation.id) === "settled"
      ? SENT_HIGHLIGHT
      : PENDING_HIGHLIGHT;
}
