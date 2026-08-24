"use client";

import { useEffect, useMemo, type RefObject } from "react";
import { createClientLogger } from "@/lib/logging/client-logger";
import type {
  DocumentComment,
  DocumentRef,
} from "@/lib/document-comments/schemas";
import { useDocumentCommentsQuery } from "@/lib/document-comments/queries";
import { groupResolvedAnnotations, type GutterGroup } from "./anchor-dom";
import type { ResolvedComment } from "./types";
import {
  resolveLiveMarkdownAnchors,
  useLiveMarkdownAnchorResolution,
} from "./use-live-markdown-anchor-resolution";
import type {
  MarkdownAnnotationSource,
  ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";

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
  return resolveLiveMarkdownAnchors(
    comments.map(documentCommentSource),
    contentEl,
  ).map(resolvedDocumentComment);
}

interface DocumentCommentAnnotationSource
  extends DocumentComment, MarkdownAnnotationSource {}

function documentCommentSource(
  comment: DocumentComment,
): DocumentCommentAnnotationSource {
  return {
    ...comment,
    tone: comment.status === "pending" ? "active" : "settled",
    accessibleLabel: `Comment ${comment.id}`,
  };
}

function resolvedDocumentComment(
  annotation: DocumentCommentAnnotationSource &
    Pick<ResolvedMarkdownAnnotation, "anchorState" | "block">,
): ResolvedComment {
  const reanchor =
    annotation.anchorState.status === "stale"
      ? ({ status: "stale" } as const)
      : {
          status: "anchored" as const,
          charStart: annotation.anchorState.charStart,
          charEnd: annotation.anchorState.charEnd,
        };
  return { ...annotation, reanchor, stale: reanchor.status === "stale" };
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
  annotations: readonly ResolvedMarkdownAnnotation[];
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

  const sources = useMemo(
    () => rawComments.map(documentCommentSource),
    [rawComments],
  );
  const annotations = useLiveMarkdownAnchorResolution(
    sources,
    content,
    contentRef,
  );
  const comments = useMemo(
    () => annotations.map(resolvedDocumentComment),
    [annotations],
  );

  useEffect(() => {
    if (annotations.length === 0) return;
    const stale = annotations.filter(
      ({ anchorState }) => anchorState.status === "stale",
    ).length;
    const reanchored = annotations.filter(
      ({ anchorState }) => anchorState.status === "reanchored",
    ).length;
    logger.debug("document-comments.reanchor", {
      docPath: docRef?.docPath,
      total: annotations.length,
      anchored: annotations.length - stale - reanchored,
      reanchored,
      stale,
    });
  }, [annotations, docRef?.docPath]);

  const pendingComments = useMemo(
    () => comments.filter((c) => c.status === "pending"),
    [comments],
  );

  const anchoredGroups = useMemo(
    () => groupResolvedAnnotations(annotations),
    [annotations],
  );

  return {
    comments,
    annotations,
    commentCount: rawComments.length,
    pendingComments,
    anchoredGroups,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
