"use client";

import { useEffect, useId, useRef } from "react";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  isTopOverlay,
  usePushOverlay,
  usePopOverlay,
} from "@/stores/overlay-scope.store";

interface UseOverlayScopeOptions {
  /**
   * When provided, Escape closes this overlay (capture phase, topmost-only).
   * Omit for overlays that already handle their own dismissal — the hook still
   * suppresses background page hotkeys while open.
   */
  onEscape?: () => void;
}

const logger = createClientLogger("hooks/useOverlayScope");

function logOverlayScopeDebug(
  message: string,
  fields: Record<string, unknown>,
): void {
  logger.debug(message, fields);
}

/**
 * Registers an open overlay (modal, drawer, menu, popover) with the global
 * overlay-scope store so `useAppHotkey` suppresses background page hotkeys while
 * any overlay is open. Optionally wires a topmost-only Escape-to-close handler.
 */
export function useOverlayScope(
  open: boolean,
  options?: UseOverlayScopeOptions,
): void {
  const token = useId();
  const pushOverlay = usePushOverlay();
  const popOverlay = usePopOverlay();

  const onEscapeRef = useRef(options?.onEscape);
  useEffect(() => {
    onEscapeRef.current = options?.onEscape;
  });

  useEffect(() => {
    if (!open) return;
    pushOverlay(token);
    logOverlayScopeDebug("overlay.open", { token });
    return () => {
      popOverlay(token);
      logOverlayScopeDebug("overlay.close", { token });
    };
  }, [open, token, pushOverlay, popOverlay]);

  useEffect(() => {
    if (!open) return;
    if (!onEscapeRef.current) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (!isTopOverlay(token)) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      onEscapeRef.current?.();
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () =>
      document.removeEventListener("keydown", handler, { capture: true });
  }, [open, token]);
}
