"use client";

import { useCallback, useRef } from "react";

/**
 * Focus-return for dialogs opened from state rather than a Radix trigger.
 * Radix restores focus to its `DialogTrigger`/`AlertDialogTrigger` on close;
 * a fully-controlled dialog has none, so focus falls to <body>, stranding
 * keyboard users at the top of the document. Capture `document.activeElement`
 * when the content mounts and refocus it on close.
 *
 * Wire `captureOpener` into `onOpenAutoFocus` (do not preventDefault there —
 * Radix's initial-focus behaviour still applies) and `restoreOpener` into
 * `onCloseAutoFocus`.
 */
export function useOpenerFocus(): {
  captureOpener: () => void;
  restoreOpener: (event: Event) => void;
} {
  const openerRef = useRef<HTMLElement | null>(null);

  const captureOpener = useCallback(() => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }, []);

  const restoreOpener = useCallback((event: Event) => {
    const target = openerRef.current;
    openerRef.current = null;
    if (target?.isConnected) {
      event.preventDefault();
      target.focus();
    }
  }, []);

  return { captureOpener, restoreOpener };
}
