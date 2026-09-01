"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * The clip-source contract between MessageRow and the selection affordance:
 * rows whose message can be referenced (the copy-reference gate) stamp these
 * attributes on their content element; provisional and queued rows stamp
 * nothing, so a selection over them never offers Clip.
 */
export const CLIP_SOURCE_INDEX_ATTR = "data-clip-index";

const CLIP_ROLES = ["user", "assistant", "notice"] as const;
type ClipRole = (typeof CLIP_ROLES)[number];

/** A pending clip: one gated message's selection, mapped and classified. */
export interface TranscriptClipDraft {
  messageIndex: number;
  role: ClipRole;
  timestamp: string | null;
  model: string | null;
  /** The selected text exactly as the user selected it. */
  text: string;
  /**
   * The selection lies within code — the closest pre/code ancestor of the
   * selection's common container — so it lands fenced, not blockquoted (D20).
   */
  isCode: boolean;
  /** Selection bounding rect (viewport coordinates) for trigger placement. */
  rect: DOMRect;
}

function clipContentOf(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(`[${CLIP_SOURCE_INDEX_ATTR}]`) ?? null;
}

function parseRole(value: string | undefined): ClipRole | null {
  return (CLIP_ROLES as readonly string[]).includes(value ?? "")
    ? (value as ClipRole)
    : null;
}

function isWithinCode(range: Range, content: HTMLElement): boolean {
  const common = range.commonAncestorContainer;
  const element = common instanceof Element ? common : common.parentElement;
  const code = element?.closest("pre, code") ?? null;
  return code !== null && content.contains(code);
}

function sameDraft(a: TranscriptClipDraft, b: TranscriptClipDraft): boolean {
  // The rect is part of the identity: a message can contain the same text
  // twice, and selecting the other occurrence must move the trigger there.
  return (
    a.messageIndex === b.messageIndex &&
    a.text === b.text &&
    a.isCode === b.isCode &&
    a.rect.top === b.rect.top &&
    a.rect.left === b.rect.left &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
}

/**
 * Bridges transcript text selection to the floating Clip trigger. On each
 * completed selection — pointerup for mouse/touch AND keyup, because keyboard
 * selections (Shift+Arrow) never fire a pointer event — it maps the selection
 * to exactly one gated message content element and exposes it as a draft. A
 * selection spanning messages, landing outside message content, or over a row
 * without the clip-source contract yields no draft. A collapsed selection
 * dismisses the draft, except when the event comes from the affordance itself
 * (clicking the trigger may collapse the selection before its click handler
 * runs).
 *
 * Mirrors the shape of the document viewer's selection-comment hook — the
 * precedent for keyboard-complete selections and draft identity — without
 * importing across that seam.
 *
 * `within` scopes the listener to one surface root: panes render several
 * transcripts at once, each with its own capture instance, and only the
 * instance whose root contains the selection may claim it — the others would
 * attribute the clip to the wrong conversation.
 */
export function useTranscriptClipSelection(
  within?: RefObject<HTMLElement | null>,
): {
  draft: TranscriptClipDraft | null;
  clear: () => void;
} {
  const [draft, setDraft] = useState<TranscriptClipDraft | null>(null);

  useEffect(() => {
    const onSelectionComplete = (event: Event): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-clip-affordance]")
      ) {
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setDraft(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const start = clipContentOf(range.startContainer);
      const end = clipContentOf(range.endContainer);
      if (start === null || start !== end) {
        setDraft(null);
        return;
      }
      if (within && !within.current?.contains(start)) {
        setDraft(null);
        return;
      }
      const text = selection.toString();
      const messageIndex = Number(start.dataset["clipIndex"]);
      const role = parseRole(start.dataset["clipRole"]);
      if (text.length === 0 || !Number.isInteger(messageIndex) || !role) {
        setDraft(null);
        return;
      }
      const next: TranscriptClipDraft = {
        messageIndex,
        role,
        timestamp: start.dataset["clipTimestamp"] ?? null,
        model: start.dataset["clipModel"] ?? null,
        text,
        isCode: isWithinCode(range, start),
        rect: range.getBoundingClientRect(),
      };
      setDraft((prev) => (prev && sameDraft(prev, next) ? prev : next));
    };

    document.addEventListener("pointerup", onSelectionComplete);
    document.addEventListener("keyup", onSelectionComplete);
    return () => {
      document.removeEventListener("pointerup", onSelectionComplete);
      document.removeEventListener("keyup", onSelectionComplete);
    };
  }, [within]);

  const clear = useCallback((): void => {
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  return { draft, clear };
}
