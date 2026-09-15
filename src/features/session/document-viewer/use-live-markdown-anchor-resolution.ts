"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

import type {
  MarkdownAnnotationSource,
  ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";
import { tryReanchorExact } from "@/lib/document-comments/anchor";
import {
  CC_LINE_ATTR,
  CC_SECTION_ATTR,
} from "@/components/markdown/markdown-source-map";
import { createClientLogger } from "@/lib/logging/client-logger";

import {
  findCommentPassageCandidates,
  rangesFromCommentPassage,
} from "./anchor-dom";

const logger = createClientLogger("markdown-anchor-resolution");

type LiveResolution = Pick<
  ResolvedMarkdownAnnotation,
  "anchorState" | "block" | "ranges"
>;

export function resolveLiveMarkdownAnchors<T extends MarkdownAnnotationSource>(
  sources: readonly T[],
  contentEl: HTMLElement | null,
): Array<T & LiveResolution> {
  return sources.map((source) => {
    const matches = (
      contentEl ? findCommentPassageCandidates(contentEl, source.anchor) : []
    ).flatMap((passage) => {
      const result = tryReanchorExact(passage.text, source.anchor);
      if (result.status === "stale") return [];
      const ranges = rangesFromCommentPassage(
        passage,
        result.charStart,
        result.charEnd,
      );
      return ranges.length > 0
        ? [{ block: passage.block, result, ranges }]
        : [];
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
      ranges: match.ranges,
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
      const next = resolveLiveMarkdownAnchors(sources, contentRef.current);
      setResolved(next);
      if (sources.length > 0)
        logger.debug("markdown-anchors.resolved", {
          total: sources.length,
          spanningBlocks: sources.filter(
            ({ anchor }) => anchor.endBlock !== undefined,
          ).length,
          stale: next.filter(
            ({ anchorState }) => anchorState.status === "stale",
          ).length,
        });
    };
    resolve();

    const contentEl = contentRef.current;
    if (contentEl === null) return;
    const observer = new MutationObserver(resolve);
    observer.observe(contentEl, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [CC_LINE_ATTR, CC_SECTION_ATTR, "class"],
    });
    return () => observer.disconnect();
  }, [sources, content, contentRef]);

  return resolved;
}
