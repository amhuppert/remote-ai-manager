import type {
  MarkdownAnnotationSource,
  ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";
import { notepadAnchorInAnnotatableSpace } from "@/lib/notepads/annotatable-projection";
import type { ResolvedNotepadCommentThread } from "@/lib/notepads/schemas";

import type { NotepadStampedBlocks } from "./notepad-stamped-blocks";

/**
 * Adapters between the notepad comment store and the annotation seam. Pure and
 * DOM-free: recogito cannot mount under jsdom, so the mapping decisions the
 * review surface makes are pinned here rather than through the annotator.
 */

/** A comment thread plus whether its passage still holds in what is rendered. */
export interface NotepadReviewThread {
  thread: ResolvedNotepadCommentThread;
  stale: boolean;
}

/**
 * The annotations the seam should paint. A thread the CANONICAL resolution
 * already reports stale is withheld rather than handed over: the seam would
 * re-resolve its quote against the rendered text and could land it on a
 * different passage, which is exactly what exact-match anchoring forbids.
 *
 * Offsets are restated in the rendered view's ANNOTATABLE coordinates before
 * they cross the seam. A stored anchor counts canonical characters, which
 * include reference and image tokens the rendering excludes from selectable
 * text; handing those offsets over unchanged would point the seam past the
 * passage by the whole length of every chip above it — routinely further than
 * its bounded search reaches, so the highlight and its gutter marker would
 * simply never resolve.
 *
 * Block identity is restated the same way, from the identity the rendering
 * STAMPED on the anchor's line. A section id is derived from the heading above
 * a block, so renaming that heading restamps every block under it while their
 * text stands unchanged; the seam locates a block by line AND section, so the
 * stored pair would then address a block that is not in the document and a
 * comment on prose nobody touched would paint nowhere. Restating it is a
 * re-identification of the same unchanged passage, not a relocation — the quote
 * and its offsets still have to match exactly, and nothing here can move a
 * comment onto different text.
 *
 * The seam's anchor carries a document revision as an opaque string; a notepad
 * versions by its integer revision, so that is what travels in the field.
 */
export function notepadAnnotationSources(
  threads: readonly ResolvedNotepadCommentThread[],
  content: string,
  stamped: NotepadStampedBlocks,
): MarkdownAnnotationSource[] {
  return threads.flatMap(({ comment, passage }) => {
    if (passage.state === "stale") return [];
    const rendered = notepadAnchorInAnnotatableSpace(comment.anchor, content);
    if (rendered === null) return [];
    const { notepadRevision, ...anchor } = comment.anchor;
    const block = stamped.get(anchor.line);
    const endBlock =
      anchor.endBlock === undefined
        ? undefined
        : {
            ...anchor.endBlock,
            sectionId:
              stamped.get(anchor.endBlock.line)?.sectionId ??
              anchor.endBlock.sectionId,
          };
    return [
      {
        id: comment.id,
        anchor: {
          ...anchor,
          sectionId: block?.sectionId ?? anchor.sectionId,
          headingLabel: block?.headingLabel ?? anchor.headingLabel,
          ...(endBlock === undefined ? {} : { endBlock }),
          charStart: rendered.start,
          charEnd: rendered.end,
          quote: rendered.quote ?? anchor.quote,
          docRevision: String(notepadRevision),
        },
        tone:
          comment.status === "open"
            ? ("active" as const)
            : ("settled" as const),
        accessibleLabel: `Comment on “${passage.quote}”`,
      },
    ];
  });
}

/**
 * Fold the panel's own verdicts back into each thread. Stale wins from any of
 * them: the listing's canonical verdict is what an agent reading the notepad
 * sees, withholding is this panel resolving the anchor against the content it
 * is rendering, and the live verdict is whether a highlight could actually
 * paint. A comment that fails any of the three is not showing the reader its
 * passage, and must never sit there looking anchored with nothing painted.
 *
 * `sources` is the withholding half. A listing fetched before an edit still
 * reports its passage anchored, so it is the projection — recomputed here over
 * the current content — that knows the quote is gone. It is derived in the same
 * render as `threads`, so a thread absent from it was refused, not merely not
 * resolved yet.
 *
 * `documentRendered` gates only the live half. The notepad rendering is
 * deferred (and debounced), so for the first frames the annotated DOM holds no
 * stamped blocks and the live pass reports EVERY comment stale — badging them
 * so would be a lie the reader sees flash on open.
 */
export function withLiveAnchorStates(
  threads: readonly ResolvedNotepadCommentThread[],
  sources: readonly MarkdownAnnotationSource[],
  resolved: readonly ResolvedMarkdownAnnotation[],
  documentRendered: boolean,
): NotepadReviewThread[] {
  const painted = new Set(sources.map((source) => source.id));
  const liveById = new Map(
    resolved.map((annotation) => [annotation.id, annotation]),
  );
  return threads.map((thread) => {
    const live = documentRendered ? liveById.get(thread.comment.id) : undefined;
    return {
      thread,
      stale:
        thread.passage.state === "stale" ||
        !painted.has(thread.comment.id) ||
        live?.anchorState.status === "stale",
    };
  });
}
