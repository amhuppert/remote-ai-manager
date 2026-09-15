"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import type { CommentAnchor } from "@/lib/document-comments/schemas";
import { deriveAnchorFromSelection, findCommentBlock } from "./anchor-dom";
import { createClientLogger } from "@/lib/logging/client-logger";

const logger = createClientLogger("text-selection-comment");

/** A pending selection: its derived anchor + viewport rect. */
export interface SelectionDraft {
  anchor: CommentAnchor;
  /** Selection bounding rect (viewport coordinates) for popover placement. */
  rect: DOMRect;
  /** Runtime source block used to restore keyboard focus after composition. */
  block: HTMLElement;
  /**
   * The range the selection covers, kept for consumers whose question is about
   * the selection's own DOM ancestry rather than its block — a clip asking
   * whether the passage sits inside a code span, most of all.
   */
  range: Range;
}

function sameAnchor(a: CommentAnchor, b: CommentAnchor): boolean {
  return (
    a.line === b.line &&
    a.sectionId === b.sectionId &&
    a.charStart === b.charStart &&
    a.charEnd === b.charEnd &&
    a.endBlock?.line === b.endBlock?.line &&
    a.endBlock?.sectionId === b.endBlock?.sectionId &&
    a.quote === b.quote
  );
}

/**
 * Bridges in-document text selection to the comment popover. On each completed
 * selection within the rendered content it derives a passage anchor (exact
 * quote + section/heading/line) and exposes it as a draft. A selection that
 * leaves the host or resolves to no annotatable text yields no draft.
 * `clear` dismisses the
 * draft and collapses the selection (cancel / outside-click / after create).
 *
 * Re-deriving the identical selection returns the SAME draft object so opening
 * the affordance/popover (which leaves the text selection intact) does not reset
 * the editor.
 */
export function useTextSelectionComment(
  contentRef: RefObject<HTMLDivElement | null>,
  content: string | null,
): { draft: SelectionDraft | null; clear: () => void } {
  const [draft, setDraft] = useState<SelectionDraft | null>(null);

  useEffect(() => {
    // A selection completes on pointer release (mouse/touch) OR key release
    // (keyboard, e.g. Shift+Arrow) — keyboard selections never fire a pointer
    // event, so both must arm the affordance.
    const onSelectionComplete = (): void => {
      const contentEl = contentRef.current;
      if (!contentEl || content == null) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return;
      }
      const range = selection.getRangeAt(0);
      if (
        !contentEl.contains(range.startContainer) ||
        !contentEl.contains(range.endContainer)
      ) {
        setDraft(null);
        return;
      }
      const anchor = deriveAnchorFromSelection(range, content, contentEl);
      if (!anchor) {
        logger.debug("annotation.selection.rejected", { reason: "unmappable" });
        setDraft(null);
        return;
      }
      const block = findCommentBlock(contentEl, anchor);
      if (block === null) {
        setDraft(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      logger.debug("annotation.selection.derived", {
        line: anchor.line,
        endLine: anchor.endBlock?.line ?? anchor.line,
        quoteLength: anchor.quote.length,
      });
      setDraft((prev) =>
        prev && sameAnchor(prev.anchor, anchor)
          ? prev
          : { anchor, rect, block, range },
      );
    };

    document.addEventListener("pointerup", onSelectionComplete);
    document.addEventListener("keyup", onSelectionComplete);
    return () => {
      document.removeEventListener("pointerup", onSelectionComplete);
      document.removeEventListener("keyup", onSelectionComplete);
    };
  }, [contentRef, content]);

  const clear = useCallback((): void => {
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  return { draft, clear };
}
