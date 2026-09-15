import type { ClipSelectionContext } from "@/components/document-viewer/annotation-contract";

/**
 * The canonical Markdown renderer emits a fenced block as a WRAPPING container
 * carrying the source-position stamps, with the `<pre>` (or a highlighter's
 * markup) inside it — so the stamped block a selection resolves to is that
 * container, not the `<pre>`. Asking the block for a `pre` ancestor therefore
 * answers false for every real fenced selection. `pre` stays in the selector
 * for the renderer's un-fenced fallback branch, which stamps the `<pre>` itself.
 */
const CODE_BLOCK_SELECTOR = "[data-markdown-code-block], pre";

/**
 * Whether an annotated selection lies within code, read off the rendered DOM
 * the reader is looking at — a fenced block, or an inline `code` span inside a
 * prose block. Both matter to a clip: the fragment builder fences code so it
 * survives verbatim, and a blockquote would reflow it.
 *
 * The range's common ancestor must lie inside one code region, so a selection
 * continuing from a fenced block into prose is classified as mixed content.
 *
 * Offered as the shared default because every current host renders through the
 * canonical Markdown renderer; a host whose code lives elsewhere in its DOM
 * supplies its own `deriveIsCode`.
 */
export function selectionLiesWithinCode(
  selection: ClipSelectionContext,
): boolean {
  // `commonAncestorContainer` is the deepest node containing BOTH endpoints, so
  // a selection that starts inside a code span and runs out into the prose
  // around it resolves to the paragraph and is correctly not code.
  const node = selection.range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(`${CODE_BLOCK_SELECTOR}, code`) != null;
}
