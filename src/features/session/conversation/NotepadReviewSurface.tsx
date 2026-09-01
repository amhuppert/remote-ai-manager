"use client";

import { forwardRef, useCallback, useMemo, useRef, useState } from "react";

import AnnotatedMarkdown, {
  useLiveMarkdownAnchorResolution,
  type AnnotatedDocumentRenderer,
} from "@/components/document-viewer/AnnotatedMarkdown";
import type {
  CommentComposerCapability,
  MarkdownAnnotationTarget,
  PersistCommentInput,
} from "@/components/document-viewer/annotation-contract";
import { NotepadPreview } from "@/components/notepad/NotepadPreview";
import { notepadAnchorFromSelection } from "@/lib/notepads/annotatable-projection";
import { useCreateNotepadCommentMutation } from "@/lib/notepads/mutations";
import { useNotepadCommentsQuery } from "@/lib/notepads/queries";
import type { NotepadScope } from "@/lib/notepads/schemas";

import NotepadCommentThreads from "./NotepadCommentThreads";
import {
  notepadAnnotationSources,
  withLiveAnchorStates,
} from "./notepad-review-annotations";
import { notepadReviewClipCapability } from "./notepad-review-clip";
import { useNotepadStampedBlocks } from "./notepad-stamped-blocks";

export interface NotepadReviewSurfaceProps {
  notepadId: string;
  notepadName: string;
  notepadScope: NotepadScope;
  /**
   * The project a project-scoped notepad belongs to, for the dispatched
   * reference's display attribute. The panel lists this project's notepads
   * merged with the global ones, so a project-scoped notepad shown here is this
   * project's; a reference resolves by id regardless, so the attribute is
   * display-only.
   */
  projectName: string;
  sessionName: string;
  /** The PERSISTED canonical text — anchors are defined over it, not a draft. */
  content: string;
  /** The revision `content` is, stamped onto anchors created against it. */
  revision: number;
  active: boolean;
}

/**
 * The reason a selection could not become a comment, phrased for the two cases
 * that actually produce it: the selection ran across a chip (whose text is not
 * part of the canonical passage) or the notepad moved on since it was rendered.
 */
const UNANCHORABLE_SELECTION =
  "Couldn't locate that selection in the saved notepad. Selections can't span reference or image chips — try again, or reopen if the notepad just changed.";

/**
 * The annotated document itself. The seam supplies the content and the ref it
 * anchors within; the notepad supplies its own renderer, so the annotated DOM
 * carries reference and image chips rather than their raw canonical tokens.
 *
 * Horizontal padding matches the canonical document adapter's (`px-xl`, stepping
 * to `px-md` below 640px) because the seam's gutter inset is calibrated against
 * it: inset plus this padding is what keeps text clear of the 50px marker
 * gutter. Omitting the left half puts the comment pins on top of the prose.
 */
const NotepadDocument = forwardRef<
  HTMLDivElement,
  { content: string; notepadId: string }
>(function NotepadDocument({ content, notepadId }, ref) {
  return (
    <div className="px-xl py-[20px] max-640:px-md">
      <NotepadPreview ref={ref} notepadId={notepadId} content={content} />
    </div>
  );
});

/**
 * The notepad's review mode: the canonical text rendered through the shared
 * annotation seam, with a persist-only composer that turns a selection into a
 * notepad-owned comment. A synthetic host in the Spec Studio sense — the
 * content, the comment store, and the anchoring are the notepad's, and only the
 * annotation surface is shared.
 *
 * Anchors travel in CANONICAL text coordinates so a comment quotes what `cctl
 * notepad get` returns; the seam derives its selection over rendered text, so
 * every incoming selection is projected onto the canonical block before it is
 * persisted, and a selection with no unambiguous canonical passage is refused.
 */
export default function NotepadReviewSurface({
  notepadId,
  notepadName,
  notepadScope,
  projectName,
  sessionName,
  content,
  revision,
  active,
}: NotepadReviewSurfaceProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const commentsQuery = useNotepadCommentsQuery(notepadId, { enabled: active });
  const createComment = useCreateNotepadCommentMutation();

  const threads = useMemo(() => commentsQuery.data ?? [], [commentsQuery.data]);
  // What the rendering stamped on each block, which is both the identity an
  // anchor is restated against and the proof that the deferred notepad
  // rendering has mounted at all — read from the document itself rather than
  // inferred from an annotation resolving, so a lone comment that resolves
  // nowhere still gets a verdict.
  const stampedBlocks = useNotepadStampedBlocks(contentRef, content);
  const annotationSources = useMemo(
    () => notepadAnnotationSources(threads, content, stampedBlocks),
    [threads, content, stampedBlocks],
  );
  const resolvedAnnotations = useLiveMarkdownAnchorResolution(
    annotationSources,
    content,
    contentRef,
  );
  const documentRendered = stampedBlocks.size > 0;
  // The panel's verdict on each comment folds the canonical resolution together
  // with whether the seam could actually paint it, so a thread the reader
  // cannot see highlighted says so rather than looking anchored.
  const reviewThreads = useMemo(
    () =>
      withLiveAnchorStates(
        threads,
        annotationSources,
        resolvedAnnotations,
        documentRendered,
      ),
    [threads, annotationSources, resolvedAnnotations, documentRendered],
  );
  const renderDocument = useMemo<AnnotatedDocumentRenderer>(
    () =>
      forwardRef<HTMLDivElement, { content: string }>(
        function NotepadDocumentForNotepad({ content: documentContent }, ref) {
          return (
            <NotepadDocument
              ref={ref}
              notepadId={notepadId}
              content={documentContent}
            />
          );
        },
      ),
    [notepadId],
  );

  // Which thread a highlight or gutter marker last pointed at. The threads
  // panel is the notepad's whole comment surface, so activating an annotation
  // brings its thread to the reader there rather than opening a second card
  // over the passage.
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const activateAnnotation = useCallback((target: MarkdownAnnotationTarget) => {
    setActiveCommentId(
      target.kind === "annotation" ? target.id : (target.ids[0] ?? null),
    );
  }, []);

  const dispatchRef = useMemo(
    () => ({
      notepadId,
      name: notepadName,
      scope: notepadScope,
      projectName: notepadScope === "project" ? projectName : null,
    }),
    [notepadId, notepadName, notepadScope, projectName],
  );

  // A clip taken while reviewing this notepad points back at it — the same
  // reference the dispatch bar sends, so provenance and dispatch address the
  // notepad identically, by id (R24.1).
  const clip = useMemo(
    () => notepadReviewClipCapability(dispatchRef),
    [dispatchRef],
  );

  const persistComment = createComment.mutateAsync;
  const composer = useMemo<CommentComposerCapability>(
    () => ({
      kind: "persist-only",
      submit: async ({ anchor, note }: PersistCommentInput): Promise<void> => {
        const notepadAnchor = notepadAnchorFromSelection(
          anchor,
          content,
          revision,
        );
        if (notepadAnchor === null) throw new Error(UNANCHORABLE_SELECTION);
        await persistComment({
          notepadId,
          anchor: notepadAnchor,
          body: note,
        });
      },
    }),
    [content, notepadId, persistComment, revision],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
        <AnnotatedMarkdown
          docRef={{
            projectName,
            sessionName,
            docPath: `notepads/${notepadId}.md`,
            title: notepadName,
          }}
          content={content}
          isLoading={commentsQuery.isLoading}
          annotations={resolvedAnnotations}
          onActivateAnnotation={activateAnnotation}
          renderDocument={renderDocument}
          composer={composer}
          clip={clip}
        />
      </div>
      <NotepadCommentThreads
        notepad={dispatchRef}
        threads={reviewThreads}
        isLoading={commentsQuery.isLoading}
        activeCommentId={activeCommentId}
      />
    </div>
  );
}
