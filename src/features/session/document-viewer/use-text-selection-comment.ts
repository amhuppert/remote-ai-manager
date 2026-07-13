"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import type { CommentAnchor } from "@/lib/document-comments/schemas";
import { deriveAnchorFromSelection } from "./anchor-dom";

/** A pending single-block selection: its derived anchor + viewport rect. */
export interface SelectionDraft {
  anchor: CommentAnchor;
  /** Selection bounding rect (viewport coordinates) for popover placement. */
  rect: DOMRect;
}

function sameAnchor(a: CommentAnchor, b: CommentAnchor): boolean {
  return (
    a.line === b.line &&
    a.sectionId === b.sectionId &&
    a.charStart === b.charStart &&
    a.charEnd === b.charEnd &&
    a.quote === b.quote
  );
}

/**
 * Bridges in-document text selection to the comment popover. On each completed
 * selection within the rendered content it derives a single-block anchor (exact
 * quote + section/heading/line) and exposes it as a draft. A selection that
 * spans more than one block — or resolves to no block — yields no draft, so no
 * comment affordance is offered (single-block scope, 5.1). `clear` dismisses the
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
        return;
      }
      const anchor = deriveAnchorFromSelection(range, content);
      if (!anchor) {
        // cross-block / collapsed / unmappable selection — no affordance
        setDraft(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setDraft((prev) =>
        prev && sameAnchor(prev.anchor, anchor) ? prev : { anchor, rect },
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
