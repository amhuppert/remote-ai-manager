"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

import type {
  MarkdownAnnotationSource,
  ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";
import { tryReanchorExact } from "@/lib/document-comments/anchor";

import { blockAnnotatableText, findCommentBlockCandidates } from "./anchor-dom";

type LiveResolution = Pick<ResolvedMarkdownAnnotation, "anchorState" | "block">;

export function resolveLiveMarkdownAnchors<T extends MarkdownAnnotationSource>(
  sources: readonly T[],
  contentEl: HTMLElement | null,
): Array<T & LiveResolution> {
  return sources.map((source) => {
    const matches = (
      contentEl ? findCommentBlockCandidates(contentEl, source.anchor) : []
    ).flatMap((block) => {
      const result = tryReanchorExact(
        blockAnnotatableText(block),
        source.anchor,
      );
      return result.status === "anchored" ? [{ block, result }] : [];
    });
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match === undefined) {
      return {
        ...source,
        anchorState: { status: "stale" } as const,
        block: null,
      };
    }
    const shifted =
      match.result.charStart !== source.anchor.charStart ||
      match.result.charEnd !== source.anchor.charEnd;
    return {
      ...source,
      anchorState: {
        status: shifted ? ("reanchored" as const) : ("anchored" as const),
        charStart: match.result.charStart,
        charEnd: match.result.charEnd,
      },
      block: match.block,
    };
  });
}

export function useLiveMarkdownAnchorResolution<
  T extends MarkdownAnnotationSource,
>(
  sources: readonly T[],
  content: string | null,
  contentRef: RefObject<HTMLElement | null>,
): readonly (T & LiveResolution)[] {
  const [resolved, setResolved] = useState<Array<T & LiveResolution>>(() =>
    resolveLiveMarkdownAnchors(sources, null),
  );

  useLayoutEffect(() => {
    const resolve = (): void => {
      setResolved(resolveLiveMarkdownAnchors(sources, contentRef.current));
    };
    resolve();

    const contentEl = contentRef.current;
    if (contentEl === null) return;
    const observer = new MutationObserver(resolve);
    observer.observe(contentEl, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [sources, content, contentRef]);

  return resolved;
}
