"use client";

import { useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { createClientLogger } from "@/lib/logging/client-logger";
import type {
  DocumentComment,
  DocumentRef,
} from "@/lib/document-comments/schemas";
import { tryReanchorExact } from "@/lib/document-comments/anchor";
import { useDocumentCommentsQuery } from "@/lib/document-comments/queries";
import {
  blockAnnotatableText,
  findCommentBlock,
  groupAnchoredComments,
  type GutterGroup,
} from "./anchor-dom";
import type { ResolvedComment } from "./types";

const logger = createClientLogger("document-comments-hook");

/** Shared stable empty list so a no-document hook keeps a constant identity. */
const EMPTY_COMMENTS: DocumentComment[] = [];

/**
 * Resolve each stored comment against the live rendered document by exact-match
 * re-anchoring. For every comment we re-read its block's annotatable text from
 * the rendered DOM (`contentEl`) and run `tryReanchorExact`, so the resulting
 * `reanchor` offsets are valid offsets into the CURRENT rendered text (what the
 * highlight overlay and gutter consume). A comment whose block is gone, or whose
 * quote no longer matches, resolves to `stale` (never relocated — 11.3, 11.4).
 *
 * Pure given the DOM element, so it is jsdom-testable by rendering the real
 * markdown and passing its container. `contentEl` is null while content is still
 * loading; every comment then resolves stale until the document renders.
 */
export function resolveComments(
  comments: readonly DocumentComment[],
  contentEl: HTMLElement | null,
): ResolvedComment[] {
  return comments.map((comment) => {
    const block = contentEl
      ? findCommentBlock(contentEl, comment.anchor)
      : null;
    const blockText = block ? blockAnnotatableText(block) : null;
    const reanchor = tryReanchorExact(blockText, comment.anchor);
    return { ...comment, reanchor, stale: reanchor.status === "stale" };
  });
}

export interface UseDocumentCommentsParams {
  /** The active document, or null when nothing is open. */
  docRef: DocumentRef | null;
  /** The active document's current content (null while loading). */
  content: string | null;
  /**
   * Ref to the rendered content element (or any ancestor containing the stamped
   * blocks). Re-anchoring re-reads block text from here, so it must point at the
   * live render of `content`.
   */
  contentRef: RefObject<HTMLElement | null>;
}

export interface DocumentCommentsState {
  /** All comments for the active document, resolved (anchored or stale). */
  comments: ResolvedComment[];
  /** Total comment count for the active document — drives the header badge (1.4). */
  commentCount: number;
  /** Pending (unsent) comments, for the tray (anchored or stale). */
  pendingComments: ResolvedComment[];
  /** One gutter group per anchored block, for highlighting (excludes stale). */
  anchoredGroups: GutterGroup[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Load, re-anchor, and group the active document's comments for the viewer.
 *
 * Loads the document's comment list (keyed by `docPath`), then re-anchors each
 * comment against the rendered content via an exact-match pass that runs in a
 * layout effect (before paint) whenever the comments or content change — so the
 * exposed comments carry valid rendered-text offsets and an anchored/stale flag.
 * Groups the anchored comments by block for the gutter, and reports the
 * document's total comment count for the header badge.
 */
export function useDocumentComments({
  docRef,
  content,
  contentRef,
}: UseDocumentCommentsParams): DocumentCommentsState {
  const query = useDocumentCommentsQuery(
    docRef?.projectName ?? "",
    docRef?.sessionName ?? "",
    docRef?.docPath ?? null,
  );

  const rawComments = query.data ?? EMPTY_COMMENTS;

  const [comments, setComments] = useState<ResolvedComment[]>([]);

  useLayoutEffect(() => {
    const reanchor = (): void => {
      const resolved = resolveComments(rawComments, contentRef.current);
      setComments(resolved);
      if (resolved.length > 0) {
        const staleCount = resolved.filter((c) => c.stale).length;
        logger.debug("document-comments.reanchor", {
          docPath: docRef?.docPath,
          total: resolved.length,
          anchored: resolved.length - staleCount,
          stale: staleCount,
        });
      }
    };

    reanchor();

    // The canonical document renderer stamps blocks asynchronously (its renderer
    // is loaded behind a deferred boundary and shows a fallback first), so the
    // initial pass can run before any stamped block exists. Re-anchor whenever the
    // rendered subtree changes so comments resolve against the stamped DOM as soon
    // as it appears — and again on later in-place content swaps. Re-anchoring never
    // mutates this subtree (the gutter/highlights live outside it), so this does
    // not feed back into the observer.
    const contentEl = contentRef.current;
    if (!contentEl) return;
    const observer = new MutationObserver(reanchor);
    observer.observe(contentEl, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rawComments, content, contentRef, docRef?.docPath]);

  const pendingComments = useMemo(
    () => comments.filter((c) => c.status === "pending"),
    [comments],
  );

  const anchoredGroups = useMemo(
    () => groupAnchoredComments(comments),
    [comments],
  );

  return {
    comments,
    commentCount: rawComments.length,
    pendingComments,
    anchoredGroups,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
