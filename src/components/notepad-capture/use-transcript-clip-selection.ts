"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { createClientLogger } from "@/lib/logging/client-logger";

const log = createClientLogger("transcript-clip-selection");

/**
 * The clip-source contract between MessageRow and the selection affordance:
 * rows whose message can be referenced (the copy-reference gate) stamp these
 * attributes on their content element; provisional and queued rows stamp
 * nothing, so a selection over them never offers Clip.
 */
export const CLIP_SOURCE_INDEX_ATTR = "data-clip-index";

const CLIP_ROLES = ["user", "assistant", "notice"] as const;
type ClipRole = (typeof CLIP_ROLES)[number];

/** A gated message's selected content and durable attribution. */
export interface TranscriptClipMessageDraft {
  messageIndex: number;
  role: ClipRole;
  timestamp: string | null;
  model: string | null;
  /** The selected text exactly as the user selected it. */
  text: string;
  /**
   * The selected content lies within one code element, so it lands fenced,
   * not blockquoted (D20).
   */
  isCode: boolean;
}

export interface TranscriptClipDraft {
  messages: TranscriptClipMessageDraft[];
  /** Selection bounding rect (viewport coordinates) for trigger placement. */
  rect: DOMRect;
}

function clipContentOf(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  if (element?.closest(CLIP_CHROME_SELECTOR)) return null;
  return (
    element?.closest<HTMLElement>(
      `.message-content, [${CLIP_SOURCE_INDEX_ATTR}]`,
    ) ?? null
  );
}

function parseRole(value: string | undefined): ClipRole | null {
  return (CLIP_ROLES as readonly string[]).includes(value ?? "")
    ? (value as ClipRole)
    : null;
}

function isWithinCode(range: Range, content: HTMLElement): boolean {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let code: Element | null = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    if (node.parentElement?.closest(CLIP_CHROME_SELECTOR)) continue;
    const text = node.textContent ?? "";
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    const selectedText = text.slice(start, end);
    if (selectedText.length === 0) continue;
    const selectedCode = node.parentElement?.closest("pre, code");
    if (!selectedCode && selectedText.trim().length === 0) continue;
    if (!selectedCode || !content.contains(selectedCode)) return false;
    if (code !== null && selectedCode !== code) return false;
    code = selectedCode;
  }
  return code !== null;
}

function sameDraft(a: TranscriptClipDraft, b: TranscriptClipDraft): boolean {
  // The rect is part of the identity: a message can contain the same text
  // twice, and selecting the other occurrence must move the trigger there.
  return (
    a.messages.length === b.messages.length &&
    a.messages.every((message, index) => {
      const other = b.messages[index];
      return (
        other?.messageIndex === message.messageIndex &&
        other.text === message.text &&
        other.isCode === message.isCode &&
        other.role === message.role &&
        other.timestamp === message.timestamp &&
        other.model === message.model
      );
    }) &&
    a.rect.top === b.rect.top &&
    a.rect.left === b.rect.left &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
}

const CLIP_CHROME_SELECTOR =
  'button, [role="button"], [aria-hidden="true"], [hidden], script, style';
const TEXT_BLOCK_SELECTOR =
  "p, pre, h1, h2, h3, h4, h5, h6, blockquote, div, ul, ol";

/** DOM Range text omits paragraph separators; retain them without including controls. */
function selectedContentText(range: Range): string {
  let text = "";
  let separator = 0;
  const visit = (node: Node, inCode: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      if (value.length === 0) return;
      if (!inCode && separator > 0 && value.trim().length === 0) return;
      if (text.length > 0 && separator > 0) {
        const trailingBreaks = text.match(/\n*$/)?.[0].length ?? 0;
        text += "\n".repeat(Math.max(0, separator - trailingBreaks));
      }
      separator = 0;
      text += value;
      return;
    }
    if (node instanceof Element && node.matches(CLIP_CHROME_SELECTOR)) return;
    if (node instanceof Element && node.tagName === "BR") {
      text += "\n";
      return;
    }
    const boundary =
      node instanceof Element
        ? node.matches(TEXT_BLOCK_SELECTOR)
          ? 2
          : node.matches("li, tr")
            ? 1
            : 0
        : 0;
    separator = Math.max(separator, boundary);
    const childInCode =
      inCode || (node instanceof Element && node.matches("pre, code"));
    for (const child of node.childNodes) visit(child, childInCode);
    separator = Math.max(separator, boundary);
  };
  const common = range.commonAncestorContainer;
  const element = common instanceof Element ? common : common.parentElement;
  visit(range.cloneContents(), element?.closest("pre, code") != null);
  return text;
}

function rangeWithin(range: Range, content: HTMLElement): Range {
  const clipped = document.createRange();
  clipped.selectNodeContents(content);
  if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0) {
    clipped.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0) {
    clipped.setEnd(range.endContainer, range.endOffset);
  }
  return clipped;
}

function messagesInRange(
  range: Range,
  start: HTMLElement,
  end: HTMLElement,
): TranscriptClipMessageDraft[] | null {
  const root = start.closest(".conversation");
  let contents = [start];
  if (start !== end) {
    if (root === null || end.closest(".conversation") !== root) return null;
    contents = Array.from(
      root.querySelectorAll<HTMLElement>(".message-content"),
    ).filter(
      (content) =>
        content.closest(".conversation") === root &&
        range.intersectsNode(content),
    );
  }
  const messages: TranscriptClipMessageDraft[] = [];
  for (const content of contents) {
    const index = content.getAttribute(CLIP_SOURCE_INDEX_ATTR);
    const messageIndex =
      index === null || index.trim() === "" ? NaN : Number(index);
    const role = parseRole(content.dataset["clipRole"]);
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || !role)
      return null;
    const clipped = rangeWithin(range, content);
    const isCode = isWithinCode(clipped, content);
    const text = selectedContentText(clipped);
    if (text.length === 0) continue;
    const message: TranscriptClipMessageDraft = {
      messageIndex,
      role,
      timestamp: content.dataset["clipTimestamp"] ?? null,
      model: content.dataset["clipModel"] ?? null,
      text,
      isCode,
    };
    const previous = messages.at(-1);
    if (previous?.messageIndex === messageIndex) {
      previous.text += `\n\n${text}`;
      previous.isCode = false;
      continue;
    }
    messages.push(message);
  }
  return messages.length === 0 ? null : messages;
}

/**
 * Bridges transcript text selection to the floating Clip trigger. On each
 * completed selection — pointerup for mouse/touch AND keyup, because keyboard
 * selections (Shift+Arrow) never fire a pointer event — it maps the selection
 * to the gated message content elements it crosses and exposes them as a draft.
 * Selections across transcript roots, outside message content, or over a row
 * without the clip-source contract yield no draft. A collapsed selection
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
      if (start === null || end === null) {
        setDraft(null);
        return;
      }
      if (
        within &&
        (!within.current?.contains(start) || !within.current.contains(end))
      ) {
        setDraft(null);
        return;
      }
      const messages = messagesInRange(range, start, end);
      if (messages === null) {
        setDraft(null);
        return;
      }
      const next: TranscriptClipDraft = {
        messages,
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
    log.debug("clip.selection_consumed");
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  return { draft, clear };
}
