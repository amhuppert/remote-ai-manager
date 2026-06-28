"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import MarkdownViewer from "@/components/MarkdownViewer";
import type {
  CommentAnchor,
  CommentStatus,
  DocumentRef,
} from "@/lib/document-comments/schemas";
import {
  markdownViewerComponents,
  rehypeStampSourcePosition,
} from "./markdown-components";
import { findCommentBlock, groupAnchoredComments } from "./anchor-dom";
import CommentGutterPin from "./CommentGutterPin";
import CommentPopover from "./CommentPopover";
import RecogitoAnnotatorBoundary from "./recogito/RecogitoAnnotatorBoundary";
import {
  useTextSelectionComment,
  type SelectionDraft,
} from "./use-text-selection-comment";
import type { ResolvedComment } from "./types";

/** What the create flow yields when a selection comment is confirmed. */
export interface CreateCommentInput {
  anchor: CommentAnchor;
  note: string;
  /** true = immediate-send (Add & send); false = queue as pending (Add). */
  send: boolean;
}

export interface AnnotatedMarkdownProps {
  docRef: DocumentRef;
  content: string | null;
  isLoading: boolean;
  /** Comments resolved against the current content (anchored or stale). */
  comments: ResolvedComment[];
  /** Invoked with a comment id when its highlight or gutter marker is clicked. */
  onOpenComment?: (commentId: string) => void;
  /**
   * Invoked when a selection comment is confirmed (queue or immediate-send),
   * carrying the derived single-block anchor, the note, and the send choice.
   */
  onCreateComment?: (input: CreateCommentInput) => void;
}

interface GutterPin {
  key: string;
  top: number;
  status: CommentStatus;
  count: number;
  representativeId: string;
  title: string;
}

/**
 * Measures the vertical position of each anchored comment's block within the
 * scroll container and renders a left-gutter marker there. Lives inside the
 * scroll container (passed as `MarkdownViewer`'s overlay) so markers track their
 * passage on scroll. Re-measures on comment/content change and on resize.
 */
function CommentGutter({
  comments,
  content,
  contentRef,
  onOpenComment,
}: {
  comments: ResolvedComment[];
  content: string | null;
  contentRef: RefObject<HTMLDivElement | null>;
  onOpenComment?: (commentId: string) => void;
}): React.JSX.Element | null {
  const [pins, setPins] = useState<GutterPin[]>([]);

  useLayoutEffect(() => {
    const measure = (): void => {
      const contentEl = contentRef.current;
      const scrollEl = contentEl?.closest<HTMLElement>(".markdown-viewer");
      if (!contentEl || !scrollEl) {
        setPins([]);
        return;
      }
      const scrollRect = scrollEl.getBoundingClientRect();
      const next: GutterPin[] = [];
      for (const group of groupAnchoredComments(comments)) {
        const block = findCommentBlock(contentEl, {
          line: group.line,
          sectionId: group.sectionId,
        });
        if (!block) continue;
        const top =
          block.getBoundingClientRect().top -
          scrollRect.top +
          scrollEl.scrollTop;
        next.push({
          key: group.key,
          top,
          status: group.status,
          count: group.count,
          representativeId: group.representativeId,
          title:
            group.count > 1
              ? `${group.count} comments on this passage`
              : "1 comment on this passage",
        });
      }
      setPins(next);
    };

    measure();
    const contentEl = contentRef.current;
    if (!contentEl) return;
    const observer = new ResizeObserver(measure);
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [comments, content, contentRef]);

  if (pins.length === 0) return null;

  return (
    <div className="pointer-events-none absolute top-0 left-0 z-[1] h-full w-[50px]">
      {pins.map((pin) => (
        <CommentGutterPin
          key={pin.key}
          top={pin.top}
          status={pin.status}
          count={pin.count}
          title={pin.title}
          onClick={() => onOpenComment?.(pin.representativeId)}
        />
      ))}
    </div>
  );
}

/**
 * The affordance→editor toggle for one selection draft. Kept as its own keyed
 * component so a new selection (new key) resets it back to the affordance
 * without a state-resetting effect.
 */
function SelectionEditor({
  draft,
  clear,
  onCreateComment,
}: {
  draft: SelectionDraft;
  clear: () => void;
  onCreateComment?: (input: CreateCommentInput) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const create = (note: string, send: boolean): void => {
    onCreateComment?.({ anchor: draft.anchor, note, send });
    clear();
  };

  if (open) {
    return (
      <CommentPopover
        quote={draft.anchor.quote}
        onQueue={(note) => create(note, false)}
        onSend={(note) => create(note, true)}
        onCancel={clear}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="inline-flex cursor-pointer items-center gap-[5px] rounded-md border border-solid border-border-default bg-bg-elevated px-[10px] py-[5px] font-mono text-[0.72rem] font-medium text-cyan shadow-menu transition-colors duration-150 ease-[ease] hover:border-cyan hover:bg-bg-raised"
    >
      <span aria-hidden="true" className="text-[0.85rem] leading-none">
        +
      </span>
      Comment
    </button>
  );
}

/**
 * Renders the comment affordance / editor for the current single-block selection
 * draft. Fixed-positioned at the selection (so it escapes the scroll container's
 * clipping) and dismissed on outside-click, on scroll, or after a comment is
 * created. The inner editor is keyed by the draft so a new selection resets it
 * to the affordance.
 */
function SelectionCommentLayer({
  draft,
  clear,
  onCreateComment,
}: {
  draft: SelectionDraft | null;
  clear: () => void;
  onCreateComment?: (input: CreateCommentInput) => void;
}): React.JSX.Element | null {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!draft) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) clear();
    };
    // Dismiss when the document behind the affordance scrolls (its anchor rect
    // goes stale), but NOT when the user scrolls WITHIN the popover itself (e.g.
    // the quote preview's own overflow) — that must leave the editor open.
    const onScroll = (event: Event): void => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      clear();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [draft, clear]);

  if (!draft || typeof document === "undefined") return null;

  const key = `${draft.anchor.line}:${draft.anchor.charStart}:${draft.anchor.charEnd}`;
  // Portal to <body>: the affordance is `position: fixed` against the viewport
  // (placed at the selection's viewport rect), but the viewer's ancestor
  // `.conversation-docked-stage` carries a transform (its entrance animation),
  // which would otherwise make it the containing block and offset the affordance.
  return createPortal(
    <div
      ref={wrapRef}
      className="fixed z-popover"
      style={{ top: draft.rect.bottom + 6, left: draft.rect.left }}
    >
      <SelectionEditor
        key={key}
        draft={draft}
        clear={clear}
        onCreateComment={onCreateComment}
      />
    </div>,
    document.body,
  );
}

/**
 * Comment-enabled markdown renderer shared by the Docs and Specs surfaces:
 * MarkdownViewer (prototype styling + chevron + source-position stamping) with
 * the recogito annotation overlay painting status-styled highlights and a
 * left-gutter marker per anchored comment. Keyed by `docRef.docPath` so the
 * annotator fully re-syncs when the open document changes.
 */
export default function AnnotatedMarkdown({
  docRef,
  content,
  isLoading,
  comments,
  onOpenComment,
  onCreateComment,
}: AnnotatedMarkdownProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const { draft, clear } = useTextSelectionComment(contentRef, content);

  return (
    // This is the document's scroll container. recogito tracks scroll by
    // re-reading its annotatable wrapper's bounding rect, which only changes when
    // that wrapper MOVES — so the scroll must live on an ANCESTOR of the wrapper
    // (here), not on the wrapper or an inner element, or only the comments
    // visible at the initial scroll position ever highlight. The inner
    // `.r6o-annotatable` and `.markdown-viewer` stay content-height and move
    // inside this scroller (which also keeps the document from overflowing the
    // pending-comments tray below it).
    <div key={docRef.docPath} className="min-h-0 flex-1 overflow-y-auto">
      <RecogitoAnnotatorBoundary
        comments={comments}
        onOpenComment={onOpenComment}
        syncSignal={content}
      >
        <MarkdownViewer
          content={content}
          isLoading={isLoading}
          contentRef={contentRef}
          components={markdownViewerComponents}
          rehypePlugins={[rehypeStampSourcePosition]}
          overlay={
            <CommentGutter
              comments={comments}
              content={content}
              contentRef={contentRef}
              onOpenComment={onOpenComment}
            />
          }
        />
      </RecogitoAnnotatorBoundary>
      <SelectionCommentLayer
        draft={draft}
        clear={clear}
        onCreateComment={onCreateComment}
      />
    </div>
  );
}
