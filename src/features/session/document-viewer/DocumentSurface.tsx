"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/ui/cn";
import type {
  DocumentComment,
  DocumentRef,
} from "@/lib/document-comments/schemas";
import {
  useCreateDocumentCommentMutation,
  useUpdateDocumentCommentMutation,
  useDeleteDocumentCommentMutation,
} from "@/lib/document-comments/mutations";
import type { DocumentContentErrorKind } from "@/lib/documents/queries";
import type {
  CommentComposerCapability,
  MarkdownAnnotationTarget,
  PersistCommentInput,
} from "@/components/document-viewer/annotation-contract";
import AnnotatedMarkdown from "./AnnotatedMarkdown";
import { documentClipCapability } from "./document-clip";
import CommentCard, { type CommentCardSave } from "./CommentCard";
import PendingCommentsTray from "./PendingCommentsTray";
import { ConversationTargetPicker } from "./ConversationTargetPicker";
import { useDocumentComments } from "./use-document-comments";
import { useConversationTarget } from "./use-conversation-target";
import { useSendDocumentFeedback } from "./use-send-document-feedback";
import { findCommentBlock, rangeFromBlockOffsets } from "./anchor-dom";
import type { ResolvedComment } from "./types";
import {
  useActivateDocument,
  useFeedbackTarget,
  usePendingTrayExpanded,
  useSetFeedbackTarget,
  useTogglePendingTray,
} from "@/stores/session-detail.store";

type AnnotationSurface = typeof AnnotatedMarkdown;

let annotationSurface: AnnotationSurface = AnnotatedMarkdown;

export function _setAnnotationSurfaceForTesting(
  surface: AnnotationSurface,
): void {
  annotationSurface = surface;
}

export function _resetAnnotationSurfaceForTesting(): void {
  annotationSurface = AnnotatedMarkdown;
}

export interface DocumentSurfaceProps {
  docRef: DocumentRef;
  content: string | null;
  isLoading: boolean;
  /** Distinct content-load failure kind, or null when content loaded/loading. */
  contentError?: DocumentContentErrorKind | null;
}

export interface JumpToCommentArgs {
  comments: readonly ResolvedComment[];
  commentId: string;
  docPath: string;
  contentEl: HTMLElement | null;
  activateDocument: (docPath: string) => void;
  openComment: (commentId: string) => void;
}

export function jumpToComment({
  comments,
  commentId,
  docPath,
  contentEl,
  activateDocument,
  openComment,
}: JumpToCommentArgs): void {
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return;

  activateDocument(docPath);
  const block = contentEl ? findCommentBlock(contentEl, comment.anchor) : null;
  if (block) {
    // Instant, not smooth: the comment card positions itself against the
    // passage's rect as it mounts (right after this call). A smooth animation is
    // still in flight at that point, so the card would anchor to the pre-scroll
    // location and end up detached. An instant scroll settles the rect first.
    block.scrollIntoView({ block: "center" });
  }
  openComment(comment.id);
}

function contentErrorMessage(kind: DocumentContentErrorKind): string {
  if (kind === "unavailable") {
    return "This document is outside the session worktree or can no longer be read.";
  }
  if (kind === "invalid") {
    return "This path is not a readable markdown document.";
  }
  return "Could not load this document.";
}

/** Viewport rect of a comment's anchored passage (its exact quoted text), or
 *  null when it does not resolve — a stale comment, or a block/offsets that are
 *  gone from the current render. */
function commentPassageRect(
  contentEl: HTMLElement,
  comment: ResolvedComment,
): DOMRect | null {
  if (comment.reanchor.status !== "anchored") return null;
  const block = findCommentBlock(contentEl, comment.anchor);
  if (!block) return null;
  const range = rangeFromBlockOffsets(
    block,
    comment.reanchor.charStart,
    comment.reanchor.charEnd,
  );
  if (!range || range.collapsed) return null;
  return range.getBoundingClientRect();
}

/**
 * Floating comment card anchored beside its passage. Positioned below the
 * comment's exact passage, left-aligned to its start (matching the selection
 * create popover), or near the top of the viewport when the comment is stale (no
 * in-document passage). Dismisses on outside-click; Escape is handled inside the
 * card itself.
 */
function CommentCardLayer({
  comment,
  contentRef,
  initiallyEditing,
  onSave,
  onRemove,
  onSendNow,
  onClose,
}: {
  comment: ResolvedComment;
  contentRef: React.RefObject<HTMLDivElement | null>;
  initiallyEditing: boolean;
  onSave: (update: CommentCardSave) => void;
  onRemove: () => void;
  onSendNow: () => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const wrapRef = useRef<HTMLDivElement>(null);

  // Position directly on the DOM node (an external system) so the card snaps
  // beside its passage without a render pass; falls back near the top when the
  // comment is stale and has no in-document passage.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = contentRef.current
      ? commentPassageRect(contentRef.current, comment)
      : null;
    if (rect) {
      // Below the passage, left-aligned to its start (matching the create
      // popover), clamped to stay on-screen; flip above when there isn't room.
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 340));
      const height = el.offsetHeight;
      const below = rect.bottom + 6;
      const top =
        below + height > window.innerHeight - 8
          ? Math.max(8, rect.top - height - 6)
          : below;
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
    } else {
      el.style.top = "80px";
      el.style.left = `${Math.max(8, window.innerWidth / 2 - 160)}px`;
    }
    el.style.visibility = "visible";
  }, [comment, contentRef]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  // Portal to <body>: the card is `position: fixed` against the viewport (snapped
  // beside its passage's viewport rect), but the viewer's ancestor
  // `.conversation-docked-stage` carries a transform (its entrance animation),
  // which would otherwise make it the containing block and offset the card.
  return createPortal(
    <div
      ref={wrapRef}
      className="fixed z-popover"
      style={{ top: 0, left: 0, visibility: "hidden" }}
    >
      <CommentCard
        comment={comment}
        initiallyEditing={initiallyEditing}
        onSave={onSave}
        onRemove={onRemove}
        onSendNow={onSendNow}
        onClose={onClose}
      />
    </div>,
    document.body,
  );
}

/**
 * The full single-document review experience shared by the Docs viewer and the
 * Specs surface: the annotated markdown body (selection→comment + highlights +
 * gutter pins), the per-comment card opened from a highlight/pin, and the
 * pending-comments tray with its conversation target picker. Owns the create,
 * immediate-send, bulk-send, and send-now wiring (8.5) by composing the comment
 * mutations with the target-aware send orchestration. Source-agnostic: the
 * caller supplies `content`/`isLoading`/`contentError` (reference docs load via
 * the content endpoint, specs via the Kiro file query) while comment identity is
 * always the canonical `docRef.docPath`, so the same document carries one shared
 * comment set regardless of surface (req 2.2, 10.4).
 */
export default function DocumentSurface({
  docRef,
  content,
  isLoading,
  contentError = null,
}: DocumentSurfaceProps): React.JSX.Element {
  const AnnotationSurface = annotationSurface;
  const contentRef = useRef<HTMLDivElement>(null);
  const { annotations, comments, pendingComments } = useDocumentComments({
    docRef,
    content,
    contentRef,
  });

  const createComment = useCreateDocumentCommentMutation(
    docRef.projectName,
    docRef.sessionName,
    docRef.docPath,
  );
  const updateComment = useUpdateDocumentCommentMutation(
    docRef.projectName,
    docRef.sessionName,
    docRef.docPath,
  );
  const deleteComment = useDeleteDocumentCommentMutation(
    docRef.projectName,
    docRef.sessionName,
    docRef.docPath,
  );

  // The chosen target lives in the store so every surface, the tray, and the
  // card share one destination (req 9.4); fall back to the recency default until
  // the user picks one explicitly.
  const chosenTarget = useFeedbackTarget();
  const setFeedbackTarget = useSetFeedbackTarget();
  const { defaultTarget } = useConversationTarget();
  const target = chosenTarget ?? defaultTarget;

  const { sendFeedback, isSending, error, clearError } =
    useSendDocumentFeedback({ docRef, target });

  const trayExpanded = usePendingTrayExpanded();
  const toggleTray = useTogglePendingTray();
  const activateDocument = useActivateDocument();

  // Which comment's card is open, and whether it opened straight into editing.
  // The tray's "Edit" affordance opens in edit mode — it is the only card entry
  // point for a stale comment (no highlight/gutter pin to click), keeping a
  // stale comment editable as well as sendable (11.5).
  const [openCommentId, setOpenCommentId] = useState<string | null>(null);
  const [openInEditMode, setOpenInEditMode] = useState(false);
  const openComment = comments.find((c) => c.id === openCommentId) ?? null;

  const closeComment = useCallback((): void => {
    setOpenCommentId(null);
    setOpenInEditMode(false);
  }, []);

  // Open a comment's card in view mode (e.g. clicking its highlight/gutter pin).
  const handleOpenComment = useCallback((id: string): void => {
    setOpenCommentId(id);
    setOpenInEditMode(false);
  }, []);

  // Open a comment's card straight into editing (the tray's Edit affordance).
  const handleEditComment = useCallback((id: string): void => {
    setOpenCommentId(id);
    setOpenInEditMode(true);
  }, []);

  // Create from a selection: persist the pending comment, then immediately send
  // it when the user chose "Add & send" (5.3, 5.4).
  const handleCreateComment = useCallback(
    async ({
      anchor,
      note,
      delivery,
    }: PersistCommentInput & {
      delivery: "queue" | "send";
    }): Promise<void> => {
      const created = await createComment.mutateAsync({ anchor, note });
      if (delivery === "send") await sendFeedback([created]);
    },
    [createComment, sendFeedback],
  );
  const composer = useMemo<CommentComposerCapability>(
    () => ({ kind: "persist-or-send", submit: handleCreateComment }),
    [handleCreateComment],
  );
  const clip = useMemo(
    () => documentClipCapability(docRef.docPath),
    [docRef.docPath],
  );

  const handleActivateAnnotation = useCallback(
    (target: MarkdownAnnotationTarget): void => {
      const id = target.kind === "annotation" ? target.id : target.ids[0];
      if (id !== undefined) handleOpenComment(id);
    },
    [handleOpenComment],
  );

  const handleSave = useCallback(
    (update: CommentCardSave): void => {
      if (!openComment) return;
      updateComment.mutate({ id: openComment.id, ...update });
      closeComment();
    },
    [openComment, updateComment, closeComment],
  );

  const handleRemoveOpen = useCallback((): void => {
    if (!openComment) return;
    deleteComment.mutate(openComment.id);
    closeComment();
  }, [openComment, deleteComment, closeComment]);

  const handleSendNow = useCallback(async (): Promise<void> => {
    if (!openComment) return;
    const sent = await sendFeedback([openComment]);
    if (sent) closeComment();
  }, [openComment, sendFeedback, closeComment]);

  const handleSendAll = useCallback((): void => {
    void sendFeedback(pendingComments);
  }, [sendFeedback, pendingComments]);

  const handleClear = useCallback((): void => {
    // Pass ONLY pending comments so sent comments are untouched (7.5).
    for (const comment of pendingComments) deleteComment.mutate(comment.id);
  }, [pendingComments, deleteComment]);

  const handleTrayRemove = useCallback(
    (id: string): void => {
      deleteComment.mutate(id);
    },
    [deleteComment],
  );

  const handleJump = useCallback(
    (id: string): void => {
      jumpToComment({
        comments,
        commentId: id,
        docPath: docRef.docPath,
        contentEl: contentRef.current,
        activateDocument,
        openComment: handleOpenComment,
      });
    },
    [comments, activateDocument, docRef.docPath, handleOpenComment],
  );

  if (contentError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-lg text-center font-mono text-[0.78rem] text-text-tertiary">
        {contentErrorMessage(contentError)}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
        <AnnotationSurface
          docRef={docRef}
          content={content}
          isLoading={isLoading}
          annotations={annotations}
          onActivateAnnotation={handleActivateAnnotation}
          composer={composer}
          clip={clip}
        />
      </div>

      {openComment ? (
        <CommentCardLayer
          comment={openComment}
          contentRef={contentRef}
          initiallyEditing={openInEditMode}
          onSave={handleSave}
          onRemove={handleRemoveOpen}
          onSendNow={() => void handleSendNow()}
          onClose={closeComment}
        />
      ) : null}

      {pendingComments.length > 0 ? (
        <div className="flex shrink-0 flex-col border-x-0 border-t border-b-0 border-solid border-cyan-dim bg-[linear-gradient(180deg,var(--bg-raised),var(--bg-base))]">
          <div className="flex items-center gap-sm px-[14px] py-[6px]">
            <span className="shrink-0 font-mono text-[0.66rem] tracking-[0.04em] text-text-tertiary uppercase">
              Send to
            </span>
            <ConversationTargetPicker
              target={target}
              onSelect={setFeedbackTarget}
              docProjectName={docRef.projectName}
            />
            {error ? (
              <button
                type="button"
                onClick={clearError}
                title="Dismiss"
                className={cn(
                  "ml-auto truncate text-left font-mono text-[0.68rem] text-red",
                  "cursor-pointer border-none bg-transparent",
                )}
              >
                {error}
              </button>
            ) : null}
          </div>
          <PendingCommentsTray
            pendingComments={pendingComments}
            expanded={trayExpanded}
            onToggleExpanded={toggleTray}
            onJump={handleJump}
            onOpen={handleEditComment}
            onRemove={handleTrayRemove}
            onClear={handleClear}
            onSendAll={handleSendAll}
          />
        </div>
      ) : null}

      {isSending ? (
        <span className="sr-only" role="status">
          Sending feedback…
        </span>
      ) : null}
    </div>
  );
}

/** Re-export the comment shape callers thread through this surface. */
export type { DocumentComment };
