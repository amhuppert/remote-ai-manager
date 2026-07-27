"use client";

import { useCallback, useRef } from "react";
import { createClientLogger } from "@/lib/logging/client-logger";

interface FocusReturn {
  readonly element: HTMLElement;
  readonly selectionRange: Range | null;
}

const logger = createClientLogger("opener-focus");

/**
 * Focus-return for dialogs opened from state rather than a Radix trigger.
 * Radix restores focus to its `DialogTrigger`/`AlertDialogTrigger` on close;
 * a fully-controlled dialog has none, so focus falls to <body>, stranding
 * keyboard users at the top of the document. Capture `document.activeElement`
 * when the content mounts and refocus it on close.
 *
 * Call `captureOpener` immediately before opening a state-controlled overlay,
 * then wire it into `onOpenAutoFocus` as a fallback (do not preventDefault
 * there — Radix's initial-focus behaviour still applies). Wire
 * `restoreOpener` into `onCloseAutoFocus`.
 */
export function useOpenerFocus(): {
  captureOpener: () => void;
  restoreOpener: (event: Event) => void;
} {
  const openerRef = useRef<FocusReturn | null>(null);

  const captureOpener = useCallback(() => {
    if (openerRef.current?.element.isConnected) return;

    const active = document.activeElement;
    if (
      !(active instanceof HTMLElement) ||
      active === document.body ||
      active === document.documentElement
    ) {
      openerRef.current = null;
      return;
    }

    const selection = window.getSelection();
    const selectionRange =
      selection?.rangeCount &&
      active.contains(selection.getRangeAt(0).commonAncestorContainer)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    openerRef.current = { element: active, selectionRange };
    logger.debug("focus_return.captured", {
      promptId: active.dataset.ccPromptId ?? null,
      selectionCaptured: selectionRange !== null,
    });
  }, []);

  const restoreOpener = useCallback((event: Event) => {
    const focusReturn = openerRef.current;
    openerRef.current = null;
    if (!focusReturn?.element.isConnected) return;

    event.preventDefault();
    focusReturn.element.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (selection && focusReturn.selectionRange) {
      selection.removeAllRanges();
      selection.addRange(focusReturn.selectionRange);
    }
    logger.debug("focus_return.restored", {
      promptId: focusReturn.element.dataset.ccPromptId ?? null,
      selectionRestored: focusReturn.selectionRange !== null,
    });
  }, []);

  return { captureOpener, restoreOpener };
}
